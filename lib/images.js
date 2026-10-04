const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

// Formats whose metadata can be removed without touching the picture data.
const SCRUBBABLE = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp' };
// Formats that routinely carry metadata and that this module cannot rewrite.
const UNSUPPORTED = new Set(['.heic', '.heif', '.avif', '.tif', '.tiff']);
// Never image sources of the site itself.
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'public', 'resources', 'hugo-validator']);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');
const TIFF_ORIENTATION = 0x0112;
const TIFF_GPS = 0x8825;

/**
 * Read the first directory of a TIFF block (the body of an EXIF segment).
 * Returns the orientation (1-8, or null) and whether a GPS directory is linked.
 * Unreadable input yields { orientation: null, gps: false }.
 */
function readTiff(tiff) {
  const result = { orientation: null, gps: false };
  if (tiff.length < 14) return result;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return result;
  const le = order === 'II';
  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) return result;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return result;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    const tag = u16(entry);
    if (tag === TIFF_GPS) result.gps = true;
    if (tag === TIFF_ORIENTATION) {
      const value = u16(entry + 8);
      if (value >= 1 && value <= 8) result.orientation = value;
    }
  }
  return result;
}

/**
 * A TIFF block that holds the orientation and nothing else.
 */
function orientationTiff(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // offset of the first directory
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(TIFF_ORIENTATION, 10);
  tiff.writeUInt16BE(3, 12); // type SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(orientation, 18);
  return tiff; // bytes 20-25 stay zero: value padding and "no next directory"
}

/**
 * What an EXIF block is replaced with: nothing, or an orientation-only block
 * when the picture is stored rotated. Dropping the orientation would turn
 * such a picture sideways.
 */
function replacementTiff(tiff) {
  const { orientation, gps } = readTiff(tiff);
  return {
    tiff: orientation && orientation !== 1 ? orientationTiff(orientation) : null,
    label: gps ? 'EXIF with GPS' : 'EXIF',
  };
}

function jpegSegment(marker, payload) {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/**
 * Offset just past the end-of-image marker, or -1 when the scan data is
 * truncated. `start` is the offset of the first start-of-scan marker.
 */
function jpegEnd(buf, start) {
  let p = start;
  while (p + 1 < buf.length) {
    if (buf[p] !== 0xff) return -1;
    const marker = buf[p + 1];
    if (marker === 0xff) { p++; continue; } // fill byte
    if (marker === 0xd9) return p + 2;
    if (p + 4 > buf.length) return -1;
    p += 2 + buf.readUInt16BE(p + 2);
    if (marker !== 0xda) continue;
    // Entropy-coded data: runs until a marker that is not a stuffed zero or a restart
    for (;;) {
      p = buf.indexOf(0xff, p);
      if (p === -1 || p + 1 >= buf.length) return -1;
      const next = buf[p + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { p += 2; continue; }
      if (next === 0xff) { p++; continue; }
      break;
    }
  }
  return -1;
}

function scrubJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG file');
  const out = [buf.subarray(0, 2)];
  const removed = [];
  let i = 2;

  for (;;) {
    if (i + 2 > buf.length) throw new Error('JPEG ends before the picture data');
    if (buf[i] !== 0xff) throw new Error('JPEG segment marker expected');
    const marker = buf[i + 1];
    if (marker === 0xff) { out.push(buf.subarray(i, i + 1)); i++; continue; } // fill byte
    if (marker === 0xda || marker === 0xd9) break;
    if (i + 4 > buf.length) throw new Error('JPEG ends inside a segment');
    const length = buf.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > buf.length) throw new Error('JPEG segment length is wrong');
    const segment = buf.subarray(i, i + 2 + length);
    const payload = buf.subarray(i + 4, i + 2 + length);
    i += 2 + length;

    const startsWith = (text) => payload.subarray(0, text.length).toString('latin1') === text;

    if (marker === 0xe1 && startsWith('Exif\0\0')) {
      const { tiff, label } = replacementTiff(payload.subarray(6));
      const replacement = tiff ? jpegSegment(0xe1, Buffer.concat([EXIF_HEADER, tiff])) : null;
      if (replacement && replacement.equals(segment)) {
        out.push(segment); // already orientation only
      } else {
        if (replacement) out.push(replacement);
        removed.push(label);
      }
    } else if (marker === 0xe1 && startsWith('http://ns.adobe.com/x')) {
      removed.push('XMP');
    } else if (marker === 0xe2 && startsWith('ICC_PROFILE\0')) {
      out.push(segment); // colour profile
    } else if (marker === 0xed) {
      removed.push('IPTC');
    } else if (marker === 0xfe) {
      removed.push('comment');
    } else if (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) {
      // Application data other than JFIF (APP0) and Adobe colour (APP14)
      removed.push(`APP${marker - 0xe0} data`);
    } else {
      out.push(segment);
    }
  }

  const end = jpegEnd(buf, i);
  if (end !== -1 && end < buf.length) {
    out.push(buf.subarray(i, end));
    removed.push('data after the end of the image');
  } else {
    out.push(buf.subarray(i));
  }

  return finish(buf, out, removed);
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const frame = Buffer.alloc(body.length + 8);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(zlib.crc32(body), body.length + 4);
  return frame;
}

function scrubPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file');
  const out = [buf.subarray(0, 8)];
  const removed = [];
  let i = 8;
  let ended = false;

  while (i < buf.length) {
    if (i + 12 > buf.length) throw new Error('PNG ends inside a chunk');
    const length = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (i + 12 + length > buf.length) throw new Error('PNG chunk length is wrong');
    const chunk = buf.subarray(i, i + 12 + length);
    const data = buf.subarray(i + 8, i + 8 + length);
    i += 12 + length;

    if (type === 'eXIf') {
      const { tiff, label } = replacementTiff(data);
      const replacement = tiff ? pngChunk('eXIf', tiff) : null;
      if (replacement && replacement.equals(chunk)) {
        out.push(chunk);
      } else {
        if (replacement) out.push(replacement);
        removed.push(label);
      }
    } else if (type === 'iTXt' && data.toString('latin1', 0, 17) === 'XML:com.adobe.xmp') {
      removed.push('XMP');
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      removed.push('text');
    } else if (type === 'tIME') {
      removed.push('timestamp');
    } else {
      out.push(chunk);
    }

    if (type === 'IEND') { ended = true; break; }
  }

  if (!ended) throw new Error('PNG has no end chunk');
  if (i < buf.length) removed.push('data after the end of the image');

  return finish(buf, out, removed);
}

function scrubWebp(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    throw new Error('not a WebP file');
  }
  const chunks = [];
  const removed = [];
  let keptExif = false;
  let i = 12;

  while (i < buf.length) {
    if (i + 8 > buf.length) throw new Error('WebP ends inside a chunk');
    const type = buf.toString('latin1', i, i + 4);
    const length = buf.readUInt32LE(i + 4);
    const padded = length + (length % 2);
    if (i + 8 + length > buf.length) throw new Error('WebP chunk length is wrong');
    const chunk = buf.subarray(i, Math.min(i + 8 + padded, buf.length));
    const data = buf.subarray(i + 8, i + 8 + length);
    i += 8 + padded;

    if (type === 'EXIF') {
      const prefixed = data.subarray(0, 6).equals(EXIF_HEADER);
      const { tiff, label } = replacementTiff(prefixed ? data.subarray(6) : data);
      if (tiff && tiff.equals(data)) {
        chunks.push({ type, chunk });
        keptExif = true;
      } else {
        if (tiff) {
          const head = Buffer.alloc(8);
          head.write('EXIF', 0, 'latin1');
          head.writeUInt32LE(tiff.length, 4);
          chunks.push({ type, chunk: Buffer.concat([head, tiff]) });
          keptExif = true;
        }
        removed.push(label);
      }
    } else if (type === 'XMP ') {
      removed.push('XMP');
    } else {
      chunks.push({ type, chunk });
    }
  }

  if (removed.length === 0) return { buffer: buf, removed };

  const body = chunks.map(({ type, chunk }) => {
    if (type !== 'VP8X') return chunk;
    // Clear the "has EXIF" and "has XMP" flags to match what is left
    const copy = Buffer.from(chunk);
    copy[8] &= keptExif ? ~0x04 : ~(0x04 | 0x08);
    return copy;
  });
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  header.write('WEBP', 8, 'latin1');
  return { buffer: Buffer.concat([header, ...body]), removed };
}

function finish(buf, out, removed) {
  return removed.length === 0 ? { buffer: buf, removed } : { buffer: Buffer.concat(out), removed };
}

/**
 * The format of an image, read from its first bytes. File names lie: a JPEG
 * saved as .png is still a JPEG.
 * @returns {'jpeg'|'png'|'webp'|null}
 */
function sniffKind(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Remove metadata from an image held in memory.
 * @param {Buffer} buf
 * @returns {{buffer: Buffer, removed: string[]}} `removed` is empty when the image was already clean
 */
function scrubBuffer(buf) {
  switch (sniffKind(buf)) {
    case 'jpeg': return scrubJpeg(buf);
    case 'png': return scrubPng(buf);
    case 'webp': return scrubWebp(buf);
    default: throw new Error('not a JPEG, PNG or WebP file');
  }
}

function imageKind(file) {
  return SCRUBBABLE[path.extname(file).toLowerCase()] || null;
}

function isUnsupportedImage(file) {
  return UNSUPPORTED.has(path.extname(file).toLowerCase());
}

/**
 * 'EXIF with GPS, text (x3), timestamp'
 */
function describe(removed) {
  const counts = new Map();
  for (const label of removed) counts.set(label, (counts.get(label) || 0) + 1);
  return [...counts].map(([label, count]) => (count > 1 ? `${label} (x${count})` : label)).join(', ');
}

function excluder(config) {
  const { globToRegex } = require('./validate'); // required here: validate.js requires this module
  const patterns = ((config.images && config.images.exclude) || []).map(globToRegex);
  return (file) => patterns.some((pattern) => pattern.test(file));
}

/**
 * Every image of the site this module looks at, relative to `root`.
 */
function listImages(config, root = process.cwd()) {
  const excluded = excluder(config);
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(relative);
      } else if (entry.isFile() && (imageKind(relative) || isUnsupportedImage(relative)) && !excluded(relative)) {
        found.push(relative);
      }
    }
  };
  walk('');
  return found.sort();
}

function writeInPlace(file, buffer) {
  const temporary = `${file}.hugo-validator-tmp`;
  fs.writeFileSync(temporary, buffer, { mode: fs.statSync(file).mode });
  fs.renameSync(temporary, file);
}

/**
 * Check or clean every image of the site.
 * @returns {{checked: number, findings: {file: string, removed: string[]}[], problems: string[]}}
 */
function scrubSite(config, { write = false, root = process.cwd() } = {}) {
  const findings = [];
  const problems = [];
  const files = listImages(config, root);
  for (const file of files) {
    if (!imageKind(file)) continue; // unsupported formats only matter when they are being committed
    try {
      const full = path.join(root, file);
      const { buffer, removed } = scrubBuffer(fs.readFileSync(full));
      if (removed.length === 0) continue;
      if (write) writeInPlace(full, buffer);
      findings.push({ file, removed });
    } catch (error) {
      problems.push(`${file}: ${error.message}`);
    }
  }
  return { checked: files.filter(imageKind).length, findings, problems };
}

function git(args, root, options = {}) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 512 * 1024 * 1024, ...options });
}

function gitPaths(args, root) {
  return git(args, root).toString('utf8').split('\0').filter(Boolean);
}

/**
 * Clean the images that are staged for commit, and stage the cleaned files.
 * Decisions are made on the staged content, not on the working tree.
 * @returns {{checked: number, findings: {file: string, removed: string[]}[], problems: string[]}}
 */
function scrubStaged(config, { root = process.cwd() } = {}) {
  const excluded = excluder(config);
  const staged = gitPaths(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], root)
    .filter((file) => !excluded(file));
  const partlyStaged = new Set(gitPaths(['diff', '--name-only', '-z'], root));
  const findings = [];
  const problems = [];
  let checked = 0;

  for (const file of staged) {
    if (isUnsupportedImage(file)) {
      problems.push(`${file}: ${path.extname(file).slice(1).toUpperCase()} metadata cannot be removed here. ` +
        'Convert the image to JPEG, PNG or WebP, or list it under images.exclude');
      continue;
    }
    if (!imageKind(file)) continue;
    checked++;
    try {
      const { buffer, removed } = scrubBuffer(git(['show', `:${file}`], root));
      if (removed.length === 0) continue;
      if (partlyStaged.has(file)) {
        problems.push(`${file}: carries ${describe(removed)}, and has changes that are not staged. ` +
          'Stage or stash the rest of the file, then commit again');
        continue;
      }
      writeInPlace(path.join(root, file), buffer);
      git(['add', '--', file], root, { stdio: ['ignore', 'pipe', 'pipe'] });
      findings.push({ file, removed });
    } catch (error) {
      problems.push(`${file}: ${error.message}`);
    }
  }
  return { checked, findings, problems };
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The image step of `validate`. Inside a pre-commit hook it cleans the staged
 * images; anywhere else it only reports.
 * @returns {boolean} false when validation must fail
 */
function runImagesStep(config, { staged = false, root = process.cwd() } = {}) {
  const result = staged ? scrubStaged(config, { root }) : scrubSite(config, { root });
  const list = (verb) => {
    for (const { file, removed } of result.findings) console.log(`   ${file}: ${verb} ${describe(removed)}`);
  };

  if (result.problems.length > 0) {
    console.log(`❌ images: ${plural(result.problems.length, 'image')} could not be handled`);
    for (const problem of result.problems) console.log(`   ${problem}`);
  }

  if (staged) {
    if (result.findings.length > 0) {
      console.log(`🧹 images: removed metadata from ${plural(result.findings.length, 'staged image')}`);
      list('removed');
    } else if (result.problems.length === 0 && result.checked > 0) {
      console.log(`✅ images: no metadata in ${plural(result.checked, 'staged image')}`);
    }
    return result.problems.length === 0;
  }

  if (result.findings.length > 0) {
    console.log(`❌ images: ${plural(result.findings.length, 'image')} ${result.findings.length === 1 ? 'carries' : 'carry'} metadata`);
    list('carries');
    console.log('   Remove it with: npx --no hugo-validator scrub-images');
    return false;
  }
  if (result.problems.length === 0) {
    console.log(`✅ images: no metadata in ${plural(result.checked, 'image')}`);
  }
  return result.problems.length === 0;
}

/**
 * The `scrub-images` command.
 * @returns {number} exit code
 */
function scrubImages(options = {}) {
  const { loadConfig } = require('./config');
  const config = loadConfig();
  const result = scrubSite(config, { write: !options.check });

  for (const { file, removed } of result.findings) {
    console.log(`${file}: ${options.check ? 'carries' : 'removed'} ${describe(removed)}`);
  }
  for (const problem of result.problems) console.error(`${problem}`);

  if (result.findings.length === 0) {
    console.log(`✅ No metadata in ${plural(result.checked, 'image')}`);
  } else if (options.check) {
    console.log(`❌ ${plural(result.findings.length, 'image')} of ${result.checked} ${result.findings.length === 1 ? 'carries' : 'carry'} metadata`);
  } else {
    console.log(`🧹 Removed metadata from ${plural(result.findings.length, 'image')} of ${result.checked}`);
  }

  if (result.problems.length > 0) return 1;
  return options.check && result.findings.length > 0 ? 1 : 0;
}

module.exports = {
  scrubImages,
  runImagesStep,
  // Exported for unit tests
  scrubBuffer,
  sniffKind,
  scrubSite,
  scrubStaged,
  listImages,
  readTiff,
  orientationTiff,
  describe,
  imageKind,
  isUnsupportedImage,
};
