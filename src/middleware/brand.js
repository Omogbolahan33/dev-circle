const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');

// ─── The platform's name, put into the pages ─────────────────
// The product name used to be written into 72 files by hand, which is the
// reason it could not be changed: renaming it meant finding 147 strings, and a
// second deployment could not be branded at all. Pages and the two shell
// scripts now write {{brand.product}} and this puts the configured value there
// on the way out.
//
// It is deliberately not a template engine. There are six names, they resolve
// to strings, and anything else written between braces is left exactly as the
// author typed it — a page that says {{something}} for its own reasons is not
// silently blanked.

// A brand value is operator configuration, not user input, but it lands in two
// different contexts: HTML in the pages, and HTML built inside JavaScript
// template literals in shell.js. Rather than escape per context — and get it
// wrong once — the characters that could end a string or open a tag in either
// are removed when the value is read. No name needs them.
function sanitize(value) {
  return String(value ?? '').replace(/[<>"'`\\]/g, '').replace(/\$\{/g, '').trim();
}

// The mark in the chrome. It is the one token that is markup rather than a
// name, so it is built here rather than sanitized.
//
// Credit Direct's lockup is a single flat ink, and one ink cannot serve both
// themes: the Denim blue reads at 4.44:1 on the light sidebar but only 3.84:1
// on the dark one, which is the default and the sign-in panel. So both
// variants are emitted and CSS shows whichever the current theme calls for —
// the same reason Credit Direct publishes a white version of its own logo.
// See public/assets/brand/NOTICE.txt.
const LOCKUP =
  '<img src="/assets/brand/creditdirect.svg" alt="{alt}" class="brand-logo-img brand-logo-on-light">' +
  '<img src="/assets/brand/creditdirect-white.svg" alt="" aria-hidden="true" class="brand-logo-img brand-logo-on-dark">';

function mark() {
  const alt = sanitize(config.brand.full);

  // An operator who supplied their own logo gets theirs, and owns the question
  // of whether it reads on both themes.
  const logo = sanitize(config.brand.logoUrl);
  if (logo) return `<img src="${logo}" alt="${alt}" class="brand-logo-img">`;

  // The shipped artwork is Credit Direct's, so it stands only while this is
  // Credit Direct's deployment. Renamed, the mark steps aside for the name
  // rather than putting somebody else's logo above their sign-in form.
  if (sanitize(config.brand.organisation) === 'Credit Direct') {
    return LOCKUP.replace('{alt}', alt);
  }
  return sanitize(config.brand.product);
}

const TOKENS = new Map([
  ['brand.mark', mark()],
  ['brand.product', sanitize(config.brand.product)],
  ['brand.organisation', sanitize(config.brand.organisation)],
  ['brand.full', sanitize(config.brand.full)],
  ['brand.legal', sanitize(config.brand.legal)],
  ['brand.website', sanitize(config.brand.website)],
  // The same address as it is read rather than as it is dialled.
  ['brand.domain', sanitize(config.brand.website).replace(/^https?:\/\//i, '').replace(/\/$/, '')],
  ['brand.logo', sanitize(config.brand.logoUrl)]
]);

const TOKEN_PATTERN = /\{\{([a-z.]+)\}\}/gi;

function substitute(text) {
  return text.replace(TOKEN_PATTERN, (whole, name) => {
    const value = TOKENS.get(name);
    return value === undefined ? whole : value;
  });
}

// path -> { mtimeMs, size, body, etag } for a file that carries tokens, or
// { mtimeMs, size, passthrough: true } for one that does not. Keyed on mtime
// and size so an edit in development is picked up without a restart.
const cache = new Map();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// Resolve a URL path inside the public directory, or null if it escapes it.
// express.static does this for what it serves; this handler serves some of the
// same files and has to be exactly as careful.
function resolve(publicDir, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0')) return null;

  const full = path.resolve(publicDir, '.' + path.posix.normalize(decoded));
  const within = full === publicDir || full.startsWith(publicDir + path.sep);
  return within ? full : null;
}

// The file a request means: the path itself, or — matching the static
// handler's `extensions: ['html']` — the .html beside it.
function fileFor(publicDir, urlPath) {
  const direct = resolve(publicDir, urlPath);
  if (!direct) return null;

  const ext = path.extname(direct).toLowerCase();
  if (ext) return TYPES[ext] ? direct : null;

  // No extension. A directory means the index inside it — "/" is the sign-in
  // page, and missing that was the whole of what this handler existed for —
  // and anything else means the .html beside it, which is what the static
  // handler's `extensions: ['html']` would have served.
  try {
    if (fs.statSync(direct).isDirectory()) return path.join(direct, 'index.html');
  } catch { /* nothing there; the .html guess below is still worth making */ }

  return direct + '.html';
}

function read(file) {
  let stat;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) return null;
  } catch { return null; }

  const held = cache.get(file);
  if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size) return held;

  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.includes('{{')) {
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, passthrough: true };
    cache.set(file, entry);
    return entry;
  }

  const body = Buffer.from(substitute(raw), 'utf8');
  const entry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    body,
    etag: '"' + crypto.createHash('sha1').update(body).digest('base64') + '"'
  };
  cache.set(file, entry);
  return entry;
}

function send(res, file, entry) {
  const type = TYPES[path.extname(file).toLowerCase()] || TYPES['.html'];
  res.setHeader('Content-Type', type);
  res.setHeader('ETag', entry.etag);
  // Substituted at serve time, so it must be revalidated rather than held.
  res.setHeader('Cache-Control', 'no-cache');
  res.send(entry.body);
}

// Serve one page by absolute path, for the routes that reach for a file
// directly instead of going through the static handler. Falls back to
// sendFile when the page carries no tokens, so nothing changes for those.
function sendPage(res, file) {
  const entry = read(file);
  if (!entry || entry.passthrough) return res.sendFile(file);
  send(res, file, entry);
}

// Sits in front of express.static. A file with no tokens in it is handed
// straight on, so only pages that actually name the brand are served from
// here and everything else keeps the static handler's own behaviour.
function brandedStatic(publicDir) {
  const root = path.resolve(publicDir);

  return function brandMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const file = fileFor(root, req.path);
    if (!file) return next();

    const entry = read(file);
    if (!entry || entry.passthrough) return next();

    if (req.headers['if-none-match'] === entry.etag) {
      res.setHeader('ETag', entry.etag);
      return res.status(304).end();
    }

    send(res, file, entry);
  };
}

module.exports = { brandedStatic, sendPage, substitute, sanitize, TOKENS };
