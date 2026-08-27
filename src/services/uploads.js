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

// A stored object is either the original 32-hex name or a sanitised stem from
// the file the author picked, plus a short hex so two "logo.png"s do not
// collide. The extension is always the one the bytes decided — never the one
// the uploader claimed.
const FILE_NAME = /^(?:[a-f0-9]{32}|[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{12})\.(png|jpg|gif|webp|woff2|woff|ttf|otf)$/;
const FOLDER = /^[a-z0-9_-]+$/;
const PATH_IN_THEME = /\/uploads\/(?:[a-z0-9_-]+\/)*(?:[a-f0-9]{32}|[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{12})\.[a-z0-9]+/g;

function decodeKey(name) {
  const raw = String(name || '');
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// The only names we will read back. Folders are allowed only so a Storage
// `data.path` that includes a prefix can still be fetched under the same key
// the theme stored — never `..`, never anything that is not ours.
function parseStoredKey(name) {
  const raw = decodeKey(name).replace(/^\/+/, '');
  if (!raw || raw.includes('\\') || raw.includes('\0') || raw.includes('..')) return null;
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts.length > 4) return null;
  const file = parts.pop();
  if (!FILE_NAME.test(file)) return null;
  if (parts.some(segment => !FOLDER.test(segment))) return null;
  return parts.length ? `${parts.join('/')}/${file}` : file;
}

function slugStem(originalName) {
  if (!originalName || typeof originalName !== 'string') return '';
  const base = originalName.split(/[/\\]/).pop() || '';
  const stem = base.replace(/\.[^.]+$/, '');
  return stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

function makeStoredName(ext, originalName) {
  const id = crypto.randomBytes(16).toString('hex');
  const stem = slugStem(originalName);
  return stem ? `${stem}-${id.slice(0, 12)}.${ext}` : `${id}.${ext}`;
}

// After a Storage upload, the key Storage reports is what we keep. The name
// we sent is only a fallback for an empty or unexpected response.
function objectKeyFromUpload(data, intended) {
  const reported = data && typeof data.path === 'string' ? data.path : '';
  return parseStoredKey(reported) || parseStoredKey(intended) || intended;
}

function assetResult(key, signature, buffer, by, backend) {
  return {
    path: `/uploads/${key}`,
    name: key.split('/').pop(),
    kind: signature.kind,
    mime: signature.mime,
    bytes: buffer.length,
    uploaded_by: by,
    backend
  };
}

function prepare(base64, { kind = 'image', filename = null } = {}) {
  if (typeof base64 !== 'string' || !base64.trim()) {
    throw new UploadError('No file was sent');
  }

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

  return { buffer, signature, name: makeStoredName(signature.ext, filename) };
}

// ─── Core store (async, handles both backends) ─────────────
// When Supabase Storage is configured (SUPABASE_SERVICE_ROLE_KEY set and
// UPLOAD_BACKEND=supabase or auto) files go to the Supabase bucket instead
// of local disk. The returned path is /uploads/<object key>, and that key
// is whatever Storage stored — so the theme, the /uploads route and the
// object in the bucket name the same file.

async function storeAsync(base64, opts = {}) {
  const { buffer, signature, name } = prepare(base64, opts);
  const by = opts.by || null;

  if (config.uploads.backend === 'supabase' && config.supabase.hasServiceRole) {
    try {
      const supabase = require('../db/supabase');
      const data = await supabase.uploadToSupabase(name, buffer, signature.mime);
      return assetResult(objectKeyFromUpload(data, name), signature, buffer, by, 'supabase');
    } catch (err) {
      try { require('../utils/logger').logger.warn('Supabase upload failed, falling back to disk', { message: err.message }); } catch {}
    }
  }

  ensureDir();
  fs.writeFileSync(path.join(config.uploadDir, name), buffer);
  return assetResult(name, signature, buffer, by, 'local');
}

// Synchronous wrapper for existing call sites (SQLite/local disk).
// Throws if Supabase backend is configured because that requires async.
function store(base64, opts = {}) {
  if (config.uploads.backend === 'supabase' && config.supabase.hasServiceRole) {
    throw new Error('Supabase storage requires async upload: use `await uploads.store(...)`');
  }
  const { buffer, signature, name } = prepare(base64, opts);
  ensureDir();
  fs.writeFileSync(path.join(config.uploadDir, name), buffer);
  return assetResult(name, signature, buffer, opts.by, 'local');
}

// Read one back for serving. The name is checked rather than trusted: it must
// be exactly the shape store() generates, which is what stops "../../.env"
// from ever being joined onto the upload directory.
const STORED_NAME = FILE_NAME;

function read(name) {
  const key = parseStoredKey(name);
  // Local disk is a flat directory — a Storage prefix is not a local path.
  if (!key || key.includes('/')) return null;

  // If Supabase backend is active, try to fetch from Supabase first.
  // This is sync for the Express route; for Supabase we do a sync fallback
  // by checking local disk. The async Supabase fetch is handled by the
  // /uploads/:name route when it awaits. For backward compatibility we keep
  // this sync path for local files.
  const file = path.join(config.uploadDir, key);
  if (!file.startsWith(path.resolve(config.uploadDir) + path.sep) &&
      path.dirname(file) !== path.resolve(config.uploadDir)) {
    return null;
  }

  let buffer;
  try { buffer = fs.readFileSync(file); } catch { return null; }

  const signature = identify(buffer);
  if (!signature) return null;

  return { buffer, mime: signature.mime };
}

// Async read that tries Supabase Storage when configured, then falls back to disk.
async function readAsync(name) {
  const key = parseStoredKey(name);
  if (!key) return null;

  if (config.uploads.backend === 'supabase' && config.supabase.hasServiceRole) {
    try {
      const supabase = require('../db/supabase');
      const buffer = await supabase.downloadFromSupabase(key);
      const signature = identify(buffer);
      if (!signature) return null;
      return { buffer, mime: signature.mime, backend: 'supabase' };
    } catch {
      // Fall through to disk
    }
  }

  return read(key);
}

// Whether a path in a theme is one of ours. Used to tell an uploaded asset
// from an address someone typed, which are held to different rules.
const isStored = value => {
  const s = String(value || '');
  if (!s.startsWith('/uploads/')) return false;
  return Boolean(parseStoredKey(s.slice('/uploads/'.length)));
};

// ─── Sweeping up ────────────────────────────────────────────
// Replacing a logo leaves the old one on disk, and a file uploaded in a
// builder session that was then abandoned is never referenced at all. Neither
// is harmful, but both accumulate, and an upload directory that only ever
// grows is a disk that eventually fills.
//
// Two rules make this safe to run unattended. Only files nothing points at are
// removed — the reference set is read from the database at the moment of the
// sweep, not cached. And a file is spared until it has had time to be
// referenced: someone uploads a logo, then spends twenty minutes writing the
// questions before saving, and a sweep in the middle of that must not delete
// the thing they are about to use.
const GRACE_MS = 24 * 60 * 60 * 1000;

// Every asset path any theme mentions. Themes are JSON, so this reads them as
// text rather than parsing every shape — a path is a path wherever in the
// theme it sits, and a field added later is covered without being listed here.
async function referenced(db) {
  const paths = new Set();
  const collect = row => {
    for (const value of Object.values(row)) {
      if (typeof value !== 'string') continue;
      for (const match of value.matchAll(PATH_IN_THEME)) {
        paths.add(match[0]);
      }
    }
  };

  for (const row of await db.prepare('SELECT theme FROM surveys WHERE theme IS NOT NULL').all()) collect(row);
  for (const row of await db.prepare('SELECT survey_theme FROM circles WHERE survey_theme IS NOT NULL').all()) collect(row);
  // A circle's workspace brand lives in its own theme column; its background
  // imagery and logo must be kept exactly like a survey's.
  for (const row of await db.prepare('SELECT theme FROM circles WHERE theme IS NOT NULL').all()) collect(row);

  return paths;
}

async function sweep(db, { graceMs = GRACE_MS, now = Date.now(), dryRun = false } = {}) {
  let files;
  try { files = fs.readdirSync(config.uploadDir); } catch { return { removed: 0, kept: 0, bytes: 0 }; }

  const inUse = await referenced(db);
  const result = { removed: 0, kept: 0, bytes: 0, files: [] };

  for (const name of files) {
    if (!parseStoredKey(name)) { result.kept++; continue; }

    const full = path.join(config.uploadDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }

    if (inUse.has(`/uploads/${name}`)) { result.kept++; continue; }
    if (now - stat.mtimeMs < graceMs) { result.kept++; continue; }

    result.bytes += stat.size;
    result.files.push(name);
    if (!dryRun) {
      try { fs.unlinkSync(full); } catch { continue; }
    }
    result.removed++;
  }

  return result;
}

module.exports = {
  store, storeAsync, read, readAsync, identify, isStored, sweep, referenced,
  UploadError, SIGNATURES, GRACE_MS,
  parseStoredKey, objectKeyFromUpload, makeStoredName
};
