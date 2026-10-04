const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  scrubBuffer, sniffKind, scrubSite, scrubStaged, listImages, readTiff, describe, imageKind, isUnsupportedImage,
} = require('../lib/images');
const { getDefaultConfig } = require('../lib/config');
const { jpeg, png, webp, pngTypes, webpTypes, JPEG_PARTS } = require('./image-samples');

// A test run started from a git hook inherits the hook's index. The git
// commands below must act on the temporary repositories only.
for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE']) delete process.env[name];

/** The orientation and GPS flag of the EXIF segment in a JPEG, or null when it has none */
function jpegExif(buffer) {
  const at = buffer.indexOf(Buffer.from('Exif\0\0', 'latin1'));
  return at === -1 ? null : readTiff(buffer.subarray(at + 6));
}

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hugo-validator-img-'));
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo(files) {
  const root = makeTree(files);
  git(root, 'init', '-q');
  return root;
}

// ------------------------------------------------------------------- JPEG

test('JPEG: EXIF, GPS, XMP, IPTC, comment and trailing data go; picture and colour profile stay', () => {
  const dirty = jpeg({ orientation: 1, gps: true, extras: true });
  const { buffer, removed } = scrubBuffer(dirty);

  assert.deepStrictEqual(removed, ['EXIF with GPS', 'XMP', 'IPTC', 'comment', 'data after the end of the image']);
  assert.ok(buffer.equals(jpeg()), 'what is left is exactly the image without metadata');
  for (const part of ['jfif', 'icc', 'quantisation', 'scan']) {
    assert.notStrictEqual(buffer.indexOf(JPEG_PARTS[part]), -1, `${part} segment is kept byte for byte`);
  }
  assert.strictEqual(jpegExif(buffer), null);
});

test('JPEG: a rotated picture keeps its orientation and nothing else', () => {
  const { buffer, removed } = scrubBuffer(jpeg({ orientation: 6, gps: true }));
  assert.deepStrictEqual(removed, ['EXIF with GPS']);
  assert.deepStrictEqual(jpegExif(buffer), { orientation: 6, gps: false });
  assert.strictEqual(buffer.indexOf(Buffer.from('II', 'latin1')), -1, 'the original EXIF block is gone');
});

test('JPEG: cleaning is repeatable, and a clean image is returned untouched', () => {
  const once = scrubBuffer(jpeg({ orientation: 6, gps: true, extras: true })).buffer;
  const twice = scrubBuffer(once);
  assert.deepStrictEqual(twice.removed, []);
  assert.strictEqual(twice.buffer, once, 'the same buffer, not a copy');

  const clean = jpeg();
  assert.strictEqual(scrubBuffer(clean).buffer, clean);
});

test('JPEG: a damaged file is refused, not guessed at', () => {
  assert.throws(() => scrubBuffer(Buffer.from('not an image')), /not a JPEG, PNG or WebP file/);
  const cut = jpeg({ orientation: 1 }).subarray(0, 30);
  assert.throws(() => scrubBuffer(cut), /JPEG/);
});

// -------------------------------------------------------------------- PNG

test('PNG: EXIF, text, XMP, timestamp and trailing data go; picture and colour profile stay', () => {
  const { buffer, removed } = scrubBuffer(png({ orientation: 1, extras: true }));
  assert.deepStrictEqual(removed, ['EXIF with GPS', 'text', 'XMP', 'timestamp', 'data after the end of the image']);
  assert.deepStrictEqual(pngTypes(buffer), ['IHDR', 'iCCP', 'IDAT', 'IEND']);
  assert.ok(buffer.equals(png()));
});

test('PNG: a rotated picture keeps an orientation-only EXIF chunk, and cleaning is repeatable', () => {
  const { buffer, removed } = scrubBuffer(png({ orientation: 3 }));
  assert.deepStrictEqual(removed, ['EXIF with GPS']);
  assert.deepStrictEqual(pngTypes(buffer), ['IHDR', 'iCCP', 'eXIf', 'IDAT', 'IEND']);
  const exifAt = buffer.indexOf(Buffer.from('eXIf', 'latin1'));
  assert.deepStrictEqual(readTiff(buffer.subarray(exifAt + 4)), { orientation: 3, gps: false });
  assert.deepStrictEqual(scrubBuffer(buffer).removed, []);
});

test('PNG: a damaged file is refused', () => {
  const noEnd = png().subarray(0, png().length - 12);
  assert.throws(() => scrubBuffer(noEnd), /no end chunk/);
});

// ------------------------------------------------------------------- WebP

test('WebP: EXIF and XMP go, the flags and the file size are corrected', () => {
  const { buffer, removed } = scrubBuffer(webp({ orientation: 1, xmp: true }));
  assert.deepStrictEqual(removed, ['EXIF with GPS', 'XMP']);
  assert.deepStrictEqual(webpTypes(buffer), ['VP8X', 'ICCP', 'VP8 ']);
  assert.ok(buffer.equals(webp()), 'identical to the same image built without metadata');
  assert.strictEqual(buffer.readUInt32LE(4), buffer.length - 8);
});

test('WebP: a rotated picture keeps an orientation-only EXIF chunk, and cleaning is repeatable', () => {
  const { buffer, removed } = scrubBuffer(webp({ orientation: 8, xmp: true }));
  assert.deepStrictEqual(removed, ['EXIF with GPS', 'XMP']);
  assert.deepStrictEqual(webpTypes(buffer), ['VP8X', 'ICCP', 'VP8 ', 'EXIF']);
  assert.strictEqual(buffer[20] & 0x0c, 0x08, 'EXIF flag kept, XMP flag cleared');
  assert.strictEqual(buffer[20] & 0x20, 0x20, 'colour profile flag untouched');
  assert.deepStrictEqual(scrubBuffer(buffer).removed, []);
});

// ---------------------------------------------------------------- helpers

test('describe groups repeated labels', () => {
  assert.strictEqual(describe(['EXIF with GPS', 'text', 'text', 'text', 'timestamp']), 'EXIF with GPS, text (x3), timestamp');
});

test('the format is read from the content, so a JPEG named .png is cleaned as a JPEG', () => {
  assert.strictEqual(sniffKind(jpeg()), 'jpeg');
  assert.strictEqual(sniffKind(png()), 'png');
  assert.strictEqual(sniffKind(webp()), 'webp');
  assert.strictEqual(sniffKind(Buffer.from('GIF89a')), null);

  const root = makeTree({ 'static/card.png': jpeg({ orientation: 1, gps: true }) });
  const result = scrubSite(getDefaultConfig(), { root, write: true });
  assert.deepStrictEqual(result.problems, []);
  assert.deepStrictEqual(result.findings, [{ file: 'static/card.png', removed: ['EXIF with GPS'] }]);
  assert.ok(fs.readFileSync(path.join(root, 'static/card.png')).equals(jpeg()));
});

test('file types: what can be cleaned, and what is refused at commit', () => {
  assert.strictEqual(imageKind('a/Photo.JPG'), 'jpeg');
  assert.strictEqual(imageKind('a/shot.png'), 'png');
  assert.strictEqual(imageKind('a/pic.webp'), 'webp');
  assert.strictEqual(imageKind('a/icon.svg'), null);
  assert.ok(isUnsupportedImage('IMG_0001.HEIC'));
  assert.ok(!isUnsupportedImage('anim.gif'));
});

// ------------------------------------------------------------- whole site

test('scrubSite: check mode reports and writes nothing; write mode cleans; excludes and build output are left alone', () => {
  const dirty = jpeg({ orientation: 1, gps: true });
  const root = makeTree({
    'static/photo.jpg': dirty,
    'static/clean.png': png(),
    'content/post/shot.png': png({ extras: true }),
    'static/keep/original.jpg': dirty,
    'public/photo.jpg': dirty,
    'node_modules/pkg/logo.jpg': dirty,
    'static/broken.jpg': 'not an image',
  });
  const config = { ...getDefaultConfig(), images: { scrubMetadata: true, exclude: ['static/keep/**'] } };

  assert.deepStrictEqual(listImages(config, root), ['content/post/shot.png', 'static/broken.jpg', 'static/clean.png', 'static/photo.jpg']);

  const check = scrubSite(config, { root });
  assert.strictEqual(check.checked, 4);
  assert.deepStrictEqual(check.findings.map(f => f.file), ['content/post/shot.png', 'static/photo.jpg']);
  assert.deepStrictEqual(check.problems, ['static/broken.jpg: not a JPEG, PNG or WebP file']);
  assert.ok(fs.readFileSync(path.join(root, 'static/photo.jpg')).equals(dirty), 'check mode must not write');

  const write = scrubSite(config, { root, write: true });
  assert.strictEqual(write.findings.length, 2);
  assert.ok(fs.readFileSync(path.join(root, 'static/photo.jpg')).equals(jpeg()));
  assert.ok(fs.readFileSync(path.join(root, 'content/post/shot.png')).equals(png()));
  assert.ok(fs.readFileSync(path.join(root, 'static/keep/original.jpg')).equals(dirty), 'excluded file untouched');
  assert.ok(fs.readFileSync(path.join(root, 'public/photo.jpg')).equals(dirty), 'build output untouched');
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'static')).sort(), ['broken.jpg', 'clean.png', 'keep', 'photo.jpg'], 'no temporary file left');

  assert.deepStrictEqual(scrubSite(config, { root }).findings, []);
});

// ---------------------------------------------------------- staged images

test('scrubStaged: a staged image is cleaned in the index and in the working tree', () => {
  const root = makeRepo({ 'static/photo.jpg': jpeg({ orientation: 6, gps: true }), 'static/notes.txt': 'text' });
  git(root, 'add', '-A');

  const result = scrubStaged(getDefaultConfig(), { root });
  assert.deepStrictEqual(result.problems, []);
  assert.strictEqual(result.checked, 1);
  assert.deepStrictEqual(result.findings, [{ file: 'static/photo.jpg', removed: ['EXIF with GPS'] }]);

  const staged = git(root, 'show', ':static/photo.jpg');
  assert.deepStrictEqual(jpegExif(staged), { orientation: 6, gps: false });
  assert.ok(fs.readFileSync(path.join(root, 'static/photo.jpg')).equals(staged), 'working tree matches the index');
  assert.strictEqual(git(root, 'diff', '--name-only').toString(), '', 'nothing is left unstaged');

  assert.deepStrictEqual(scrubStaged(getDefaultConfig(), { root }).findings, [], 'a second run finds nothing');
});

test('scrubStaged: only staged files are touched', () => {
  const dirty = jpeg({ orientation: 1, gps: true });
  const root = makeRepo({ 'static/staged.jpg': dirty, 'static/not-staged.jpg': dirty });
  git(root, 'add', 'static/staged.jpg');

  const result = scrubStaged(getDefaultConfig(), { root });
  assert.deepStrictEqual(result.findings.map(f => f.file), ['static/staged.jpg']);
  assert.ok(fs.readFileSync(path.join(root, 'static/not-staged.jpg')).equals(dirty));
});

test('scrubStaged: a partly staged image is refused and left exactly as it was', () => {
  const stagedVersion = jpeg({ orientation: 1, gps: true });
  const root = makeRepo({ 'static/photo.jpg': stagedVersion });
  git(root, 'add', '-A');
  const workingVersion = jpeg({ orientation: 1, gps: true, extras: true });
  fs.writeFileSync(path.join(root, 'static/photo.jpg'), workingVersion);

  const result = scrubStaged(getDefaultConfig(), { root });
  assert.deepStrictEqual(result.findings, []);
  assert.strictEqual(result.problems.length, 1);
  assert.match(result.problems[0], /static\/photo\.jpg: carries EXIF with GPS, and has changes that are not staged/);
  assert.ok(git(root, 'show', ':static/photo.jpg').equals(stagedVersion), 'index untouched');
  assert.ok(fs.readFileSync(path.join(root, 'static/photo.jpg')).equals(workingVersion), 'working tree untouched');
});

test('scrubStaged: a format that cannot be cleaned blocks the commit unless excluded', () => {
  const root = makeRepo({ 'static/IMG_0001.heic': 'heic bytes', 'static/photo.jpg': jpeg() });
  git(root, 'add', '-A');

  const refused = scrubStaged(getDefaultConfig(), { root });
  assert.strictEqual(refused.problems.length, 1);
  assert.match(refused.problems[0], /IMG_0001\.heic: HEIC metadata cannot be removed here/);

  const config = { ...getDefaultConfig(), images: { scrubMetadata: true, exclude: ['static/*.heic'] } };
  assert.deepStrictEqual(scrubStaged(config, { root }).problems, []);
});
