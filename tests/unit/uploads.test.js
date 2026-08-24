const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the store at a throwaway directory before it is first required
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'devcircle-uploads-'));
process.env.DEVCIRCLE_UPLOAD_DIR = DIR;

const uploads = require('../../src/services/uploads');

after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

// Real signatures, since the whole point is that the bytes decide
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(64).fill(0)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(64).fill(0)]);
const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(64)]);
const b64 = buffer => buffer.toString('base64');

// ─── What a file is ─────────────────────────────────────────
// Everything here follows from one rule: the bytes decide, never the name.

test('an image is stored under a name we generate, not the one it arrived with', async () => {
  const stored = uploads.store(b64(PNG), { kind: 'image' });
  assert.match(stored.path, /^\/uploads\/[a-f0-9]{32}\.png$/);
  assert.equal(stored.mime, 'image/png');
  assert.ok(fs.existsSync(path.join(DIR, path.basename(stored.path))));
});

test('a data URL from a browser is accepted, and its declared type ignored', async () => {
  // The prefix is the uploader's claim; the bytes behind it are the fact
  const stored = uploads.store(`data:image/svg+xml;base64,${b64(PNG)}`, { kind: 'image' });
  assert.equal(stored.mime, 'image/png');
});

test('HTML dressed up as an image is refused', async () => {
  // Served from our own origin under a .png name, this would be stored XSS
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  assert.throws(() => uploads.store(b64(html), { kind: 'image' }), /not an image/i);
});

test('an SVG is refused however it is labelled', async () => {
  // It is a document format that can carry script; there is no version of an
  // uploaded SVG that is only a picture
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.throws(() => uploads.store(b64(svg), { kind: 'image' }), /not an image|scripts/i);
});

test('a font field will not take an image, and an image field will not take a font', async () => {
  assert.throws(() => uploads.store(b64(PNG), { kind: 'font' }), /image, not a font/i);
  assert.throws(() => uploads.store(b64(WOFF2), { kind: 'image' }), /font, not an image/i);
});

test('every accepted image and font format round-trips', async () => {
  assert.equal(uploads.store(b64(JPEG), { kind: 'image' }).mime, 'image/jpeg');
  assert.equal(uploads.store(b64(WOFF2), { kind: 'font' }).mime, 'font/woff2');
});

test('an empty or oversized file is refused', async () => {
  assert.throws(() => uploads.store('', { kind: 'image' }), /No file/i);
  const huge = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
  assert.throws(() => uploads.store(b64(huge), { kind: 'image' }), /limited to/i);
});

// ─── Reading one back ───────────────────────────────────────

test('a stored file is served as what its bytes are', async () => {
  const stored = uploads.store(b64(JPEG), { kind: 'image' });
  const read = uploads.read(path.basename(stored.path));
  assert.equal(read.mime, 'image/jpeg');
  assert.ok(read.buffer.equals(JPEG));
});

test('a name that is not one of ours reaches nothing', async () => {
  // The pattern is what stops a path being traversed out of the directory
  for (const name of [
    '../../../etc/passwd',
    '..%2f..%2f.env',
    'not-a-stored-name.png',
    '/etc/hosts',
    'aaaabbbbccccddddeeeeffff00001111.exe'
  ]) {
    assert.equal(uploads.read(name), null, `${name} must not resolve`);
  }
});

test('a file that was tampered with on disk is not served', async () => {
  // Belt and braces: the signature is checked on the way out as well as in
  const stored = uploads.store(b64(PNG), { kind: 'image' });
  const file = path.join(DIR, path.basename(stored.path));
  fs.writeFileSync(file, Buffer.from('<html>swapped after the fact</html>'));
  assert.equal(uploads.read(path.basename(stored.path)), null);
});

test('an uploaded path is recognisable as one', async () => {
  assert.ok(uploads.isStored('/uploads/0123456789abcdef0123456789abcdef.png'));
  assert.ok(uploads.isStored('/uploads/creditdirect-logo-0123456789ab.png'));
  assert.ok(!uploads.isStored('/uploads/not-a-stored-name.png'));
  assert.ok(!uploads.isStored('https://cdn.example.ng/logo.png'));
  assert.ok(!uploads.isStored('/assets/logo.png'));
});

test('an original filename is kept in the stored name, sanitised', async () => {
  const stored = uploads.store(b64(PNG), { kind: 'image', filename: 'Credit Direct Logo.PNG' });
  assert.match(stored.path, /^\/uploads\/credit-direct-logo-[a-f0-9]{12}\.png$/);
  assert.equal(stored.name, stored.path.split('/').pop());
  assert.ok(uploads.isStored(stored.path));
  const read = uploads.read(stored.name);
  assert.ok(read);
  assert.equal(read.mime, 'image/png');
});

test('a filename that is only punctuation falls back to a generated name', async () => {
  const stored = uploads.store(b64(PNG), { kind: 'image', filename: '...png' });
  assert.match(stored.path, /^\/uploads\/[a-f0-9]{32}\.png$/);
});

test('Storage reports the object key we keep, not the name we happened to send', () => {
  const intended = 'creditdirect-logo-0123456789ab.png';
  assert.equal(
    uploads.objectKeyFromUpload({ path: intended }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png'),
    intended
  );
  assert.equal(
    uploads.objectKeyFromUpload({ path: 'brand/' + intended }, intended),
    'brand/' + intended
  );
  assert.equal(
    uploads.objectKeyFromUpload({ path: 'uploads/' + intended, fullPath: 'uploads/uploads/' + intended }, intended),
    'uploads/' + intended,
    'data.path is the key; fullPath (bucket + key) is ignored'
  );
  assert.equal(
    uploads.objectKeyFromUpload({ path: '../etc/passwd' }, intended),
    intended
  );
});

// ─── Sweeping up ────────────────────────────────────────────
// Replacing a logo leaves the old one behind, and a file uploaded into a
// survey that was never saved is referenced by nothing at all.

// A stand-in for the database: the sweep only ever reads themes out of it
function themeStore(themes) {
  return {
    prepare(sql) {
      const column = /survey_theme/.test(sql) ? 'survey_theme' : 'theme';
      return { all: () => themes.filter(t => t.column === column).map(t => ({ [column]: t.json })) };
    }
  };
}

const ancient = { now: Date.now() + 48 * 60 * 60 * 1000 };

test('a file nothing points at is removed', async () => {
  const orphan = uploads.store(b64(PNG), { kind: 'image' });
  const db = themeStore([]);

  const result = await uploads.sweep(db, ancient);
  assert.ok(result.removed >= 1);
  assert.equal(fs.existsSync(path.join(DIR, path.basename(orphan.path))), false);
});

test('a file a survey still uses is kept', async () => {
  const kept = uploads.store(b64(PNG), { kind: 'image' });
  const db = themeStore([
    { column: 'theme', json: JSON.stringify({ logo_url: kept.path, accent: '#107ebc' }) }
  ]);

  await uploads.sweep(db, ancient);
  assert.ok(fs.existsSync(path.join(DIR, path.basename(kept.path))), 'still referenced');
});

test('a file a circle default uses is kept', async () => {
  const kept = uploads.store(b64(PNG), { kind: 'image' });
  const db = themeStore([
    { column: 'survey_theme', json: JSON.stringify({ background_image: kept.path }) }
  ]);

  await uploads.sweep(db, ancient);
  assert.ok(fs.existsSync(path.join(DIR, path.basename(kept.path))));
});

test('a fresh upload is spared, because it may be on its way into a theme', async () => {
  // Someone uploads a logo, then spends twenty minutes writing the questions.
  // A sweep in the middle of that must not delete what they are about to use.
  const fresh = uploads.store(b64(PNG), { kind: 'image' });

  const result = await uploads.sweep(themeStore([]), { now: Date.now() });
  assert.ok(fs.existsSync(path.join(DIR, path.basename(fresh.path))));
  assert.ok(result.kept >= 1);
});

test('a named upload a survey still uses is kept', async () => {
  const kept = uploads.store(b64(PNG), { kind: 'image', filename: 'workspace-mark.png' });
  const db = themeStore([
    { column: 'theme', json: JSON.stringify({ logo_url: kept.path }) }
  ]);

  await uploads.sweep(db, ancient);
  assert.ok(fs.existsSync(path.join(DIR, kept.name)), 'still referenced under its stored name');
});

test('a brand font is found wherever in a theme it sits', async () => {
  // Read as text rather than by walking known fields, so a theme field added
  // later is covered without this needing to be edited
  const font = uploads.store(b64(WOFF2), { kind: 'font' });
  const db = themeStore([
    { column: 'theme', json: JSON.stringify({ font: 'brand', brand_font: font.path }) }
  ]);

  assert.ok((await uploads.referenced(db)).has(font.path));
  await uploads.sweep(db, ancient);
  assert.ok(fs.existsSync(path.join(DIR, path.basename(font.path))));
});

test('a dry run reports without deleting', async () => {
  const orphan = uploads.store(b64(PNG), { kind: 'image' });
  const result = await uploads.sweep(themeStore([]), { ...ancient, dryRun: true });

  assert.ok(result.removed >= 1);
  assert.ok(result.bytes > 0);
  assert.ok(fs.existsSync(path.join(DIR, path.basename(orphan.path))), 'nothing was actually removed');
});
