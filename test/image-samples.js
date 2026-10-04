// Hand-built image files for the metadata tests. They are structurally valid
// containers with a few bytes of stand-in picture data, small enough to read.
const zlib = require('zlib');

/** A little-endian TIFF block with the given directory entries: [tag, shortValue] */
function tiff(entries) {
  const block = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
  block.write('II', 0, 'latin1');
  block.writeUInt16LE(42, 2);
  block.writeUInt32LE(8, 4);
  block.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, value], index) => {
    const at = 10 + index * 12;
    block.writeUInt16LE(tag, at);
    block.writeUInt16LE(3, at + 2);
    block.writeUInt32LE(1, at + 4);
    block.writeUInt16LE(value, at + 8);
  });
  return block;
}

const ORIENTATION = 0x0112;
const GPS = 0x8825;
const MAKE = 0x010f;

function segment(marker, payload) {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, Buffer.from(payload)]);
}

const text = (value) => Buffer.from(value, 'latin1');

const JPEG_PARTS = {
  soi: Buffer.from([0xff, 0xd8]),
  jfif: segment(0xe0, text('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
  icc: segment(0xe2, text('ICC_PROFILE\0\x01\x01profile-bytes')),
  quantisation: segment(0xdb, Buffer.alloc(65, 1)),
  // Scan header, then entropy data with a stuffed 0xFF and a restart marker
  scan: Buffer.concat([segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])]),
  eoi: Buffer.from([0xff, 0xd9]),
};

/**
 * @param {object} options
 * @param {number|null} [options.orientation] EXIF orientation, null = no EXIF segment
 * @param {boolean} [options.gps]
 * @param {boolean} [options.extras] XMP, IPTC, a comment and trailing bytes
 */
function jpeg({ orientation = null, gps = false, extras = false } = {}) {
  const parts = [JPEG_PARTS.soi, JPEG_PARTS.jfif];
  if (orientation !== null) {
    const entries = [[MAKE, 1], [ORIENTATION, orientation]];
    if (gps) entries.push([GPS, 100]);
    parts.push(segment(0xe1, Buffer.concat([text('Exif\0\0'), tiff(entries)])));
  }
  if (extras) {
    parts.push(segment(0xe1, text('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')));
    parts.push(segment(0xed, text('Photoshop 3.0\08BIM')));
    parts.push(segment(0xfe, text('made with a camera')));
  }
  parts.push(JPEG_PARTS.icc, JPEG_PARTS.quantisation, JPEG_PARTS.scan, JPEG_PARTS.eoi);
  if (extras) parts.push(text('trailing preview image'));
  return Buffer.concat(parts);
}

function pngChunk(type, data) {
  const body = Buffer.concat([text(type), Buffer.from(data)]);
  const frame = Buffer.alloc(body.length + 8);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(zlib.crc32(body), body.length + 4);
  return frame;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {object} options
 * @param {number|null} [options.orientation] eXIf orientation, null = no eXIf chunk
 * @param {boolean} [options.extras] text, XMP, a timestamp and trailing bytes
 */
function png({ orientation = null, extras = false } = {}) {
  const parts = [PNG_SIGNATURE, pngChunk('IHDR', Buffer.alloc(13, 1)), pngChunk('iCCP', text('profile\0\0bytes'))];
  if (orientation !== null) parts.push(pngChunk('eXIf', tiff([[MAKE, 1], [ORIENTATION, orientation], [GPS, 100]])));
  if (extras) {
    parts.push(pngChunk('tEXt', text('Software\0Screenshot Tool')));
    parts.push(pngChunk('iTXt', text('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>')));
    parts.push(pngChunk('tIME', Buffer.from([7, 234, 10, 3, 12, 0, 0])));
  }
  parts.push(pngChunk('IDAT', text('pixels')), pngChunk('IEND', Buffer.alloc(0)));
  if (extras) parts.push(text('trailing'));
  return Buffer.concat(parts);
}

/** Chunk types of a PNG, in order */
function pngTypes(buffer) {
  const types = [];
  for (let at = 8; at < buffer.length; at += 12 + buffer.readUInt32BE(at)) types.push(buffer.toString('latin1', at + 4, at + 8));
  return types;
}

function riffChunk(type, data) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, Buffer.from(data), Buffer.alloc(data.length % 2)]);
}

/**
 * An extended-format WebP with a colour profile.
 * @param {object} options
 * @param {number|null} [options.orientation] null = no EXIF chunk
 * @param {boolean} [options.xmp]
 */
function webp({ orientation = null, xmp = false } = {}) {
  const flags = 0x20 | (orientation !== null ? 0x08 : 0) | (xmp ? 0x04 : 0);
  const chunks = [
    riffChunk('VP8X', Buffer.from([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    riffChunk('ICCP', text('profile')), // odd length: exercises the padding byte
    riffChunk('VP8 ', text('pixels')),
  ];
  if (orientation !== null) chunks.push(riffChunk('EXIF', tiff([[ORIENTATION, orientation], [GPS, 100]])));
  if (xmp) chunks.push(riffChunk('XMP ', text('<x:xmpmeta/>')));
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/** Chunk types of a WebP, in order */
function webpTypes(buffer) {
  const types = [];
  for (let at = 12; at < buffer.length;) {
    const length = buffer.readUInt32LE(at + 4);
    types.push(buffer.toString('latin1', at, at + 4));
    at += 8 + length + (length % 2);
  }
  return types;
}

module.exports = { jpeg, png, webp, pngTypes, webpTypes, JPEG_PARTS };
