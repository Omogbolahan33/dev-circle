const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

// ─── Uploaded brand assets ──────────────────────────────────
// Logos, background images and brand fonts, stored as files and referenced by
// a path the survey theme carries.
//
// Everything here follows from one rule: the bytes decide what a file is, not
// the name it arrived under. A browser upload is attacker-controlled in every
// part — the filename, the extension, the declared type — so the only thing
// worth reading is the content itself. What is written to disk is a name we
// generate, with an extension we choose, and it is served back with a content
// type we decided from the signature rather than from anything the uploader
// said.
//
// The files live outside public/ on purpose. Under the static handler, a file
// called logo.png containing HTML would be served as HTML from our own origin,
// which is a stored cross-site scripting hole with extra steps.

// The signatures we accept, and what each one really is. SVG is deliberately
// absent: it is a document format that can carry script and stylesheets, and
// there is no version of "an uploaded SVG" that is only a picture.
const SIGNATURES = [
  { kind: 'image', ext: 'png',  mime: 'image/png',  magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { kind: 'image', ext: 'jpg',  mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { kind: 'image', ext: 'gif',  mime: 'image/gif',  magic: [...Buffer.from('GIF89a')] },
  { kind: 'image', ext: 'gif',  mime: 'image/gif',  magic: [...Buffer.from('GIF87a')] },
  // WEBP and the font containers are RIFF/sfnt wrappers, checked below where
  // the tag that follows the header is what settles it
  { kind: 'image', ext: 'webp', mime: 'image/webp', magic: [...Buffer.from('RIFF')], at8: 'WEBP' },
  { kind: 'font',  ext: 'woff2', mime: 'font/woff2', magic: [...Buffer.from('wOF2')] },
  { kind: 'font',  ext: 'woff',  mime: 'font/woff',  magic: [...Buffer.from('wOFF')] },
  { kind: 'font',  ext: 'ttf',   mime: 'font/ttf',   magic: [0x00, 0x01, 0x00, 0x00] },
  { kind: 'font',  ext: 'otf',   mime: 'font/otf',   magic: [...Buffer.from('OTTO')] }
];

class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// What these bytes actually are. Returns null when they are not something we
// serve — including the case where they are a perfectly good file of a kind we
// have no business handing to a browser.
function identify(buffer) {
  for (const signature of SIGNATURES) {
    const head = signature.magic;
    if (buffer.length < head.length) continue;
    if (!head.every((byte, i) => buffer[i] === byte)) continue;
    if (signature.at8 && buffer.slice(8, 12).toString('latin1') !== signature.at8) continue;
    return signature;
  }
  return null;
}

function ensureDir() {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

// Store one upload and return what the theme should carry. `kind` is what the
// caller expects — a font field must not accept a JPEG just because a JPEG is
// a valid upload of some other sort.
function store(base64, { kind = 'image', by = null } = {}) {
  if (typeof base64 !== 'string' || !base64.trim()) {
    throw new UploadError('No file was sent');
  }

  // Browsers send data URLs; the prefix is a claim about the type that we
  // ignore in favour of the bytes behind it.
  const payload = base64.includes(',') && base64.slice(0, 64).includes('base64,')
    ? base64.slice(base64.indexOf(',') + 1)
    : base64;

  let buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch {
    throw new UploadError('That file could not be read');
  }

  if (!buffer.length) throw new UploadError('That file is empty');
  if (buffer.length > config.maxUploadBytes) {
    throw new UploadError(
      `Files are limited to ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB`, 413
    );
  }

  const signature = identify(buffer);
  if (!signature) {
    throw new UploadError(
      kind === 'font'
        ? 'That is not a font file. Upload a .woff2, .woff, .ttf or .otf.'
        : 'That is not an image we can use. Upload a PNG, JPEG, GIF or WebP — not an SVG, which can carry scripts.'
    );
  }
  if (signature.kind !== kind) {
    throw new UploadError(
      kind === 'font' ? 'That is an image, not a font' : 'That is a font, not an image'
    );
  }

  ensureDir();

  // The stored name is ours end to end. Nothing the uploader chose reaches the
  // filesystem, so there is no path to traverse and no extension to disagree
  // with the contents.
  const id = crypto.randomBytes(16).toString('hex');
  const name = `${id}.${signature.ext}`;
  fs.writeFileSync(path.join(config.uploadDir, name), buffer);

  return {
    path: `/uploads/${name}`,
    kind: signature.kind,
    mime: signature.mime,
    bytes: buffer.length,
    uploaded_by: by
  };
}

// Read one back for serving. The name is checked rather than trusted: it must
// be exactly the shape store() generates, which is what stops "../../.env"
// from ever being joined onto the upload directory.
const STORED_NAME = /^[a-f0-9]{32}\.(png|jpg|gif|webp|woff2|woff|ttf|otf)$/;

function read(name) {
  if (!STORED_NAME.test(String(name || ''))) return null;

  const file = path.join(config.uploadDir, name);
  // Belt and braces: even with the pattern above, the resolved path must still
  // land inside the directory it is supposed to.
  if (!file.startsWith(path.resolve(config.uploadDir) + path.sep) &&
      path.dirname(file) !== path.resolve(config.uploadDir)) {
    return null;
  }

  let buffer;
  try { buffer = fs.readFileSync(file); } catch { return null; }

  // Served as what the bytes are, never as what the extension claims
  const signature = identify(buffer);
  if (!signature) return null;

  return { buffer, mime: signature.mime };
}

// Whether a path in a theme is one of ours. Used to tell an uploaded asset
// from an address someone typed, which are held to different rules.
const isStored = value => /^\/uploads\/[a-f0-9]{32}\.[a-z0-9]+$/.test(String(value || ''));

module.exports = { store, read, identify, isStored, UploadError, SIGNATURES };
