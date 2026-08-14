const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const { redact } = require('../server/utils/logger');
const { store } = require('../server/middleware/rateLimit');
const migrations = require('../server/migrations');

before(h.start);
after(h.stop);

beforeEach(() => {
  h.reset();
  h.makeRootCircle();
});

// ─── Log redaction ──────────────────────────────────────────

test('secrets never reach the log, however deeply nested', () => {
  const out = redact({
    email: 'ada@x.ng',
    password: 'correct-horse',
    nested: { hub_token: 'abc.def', api_key: 'dc_live_123' },
    headers: { authorization: 'Bearer xyz' }
  });

  assert.equal(out.email, 'ada@x.ng');
  assert.equal(out.password, '[redacted]');
  assert.equal(out.nested.hub_token, '[redacted]');
  assert.equal(out.nested.api_key, '[redacted]');
  assert.equal(out.headers.authorization, '[redacted]');
});

test('a bulk payload is truncated rather than dumped', () => {
  const out = redact({ note: 'x'.repeat(2000) });
  assert.ok(out.note.length < 600);
  assert.match(out.note, /\[2000 chars\]$/);
});

test('long arrays are summarised', () => {
  const out = redact({ ids: Array.from({ length: 50 }, (_, i) => i) });
  assert.equal(out.ids.length, 21);
  assert.equal(out.ids[20], '…30 more');
});

test('redaction survives a cyclic-looking deep structure without hanging', () => {
  let deep = { value: 'leaf' };
  for (let i = 0; i < 10; i++) deep = { nested: deep };
  assert.doesNotThrow(() => redact(deep));
});

// ─── Request identity ───────────────────────────────────────

test('every response carries a request id for support to quote', async () => {
  const res = await fetch(h.baseUrl() + '/api/health');
  assert.ok(res.headers.get('x-request-id'));
});

test('an upstream request id is honoured rather than replaced', async () => {
  const res = await fetch(h.baseUrl() + '/api/health', {
    headers: { 'x-request-id': 'upstream-123' }
  });
  assert.equal(res.headers.get('x-request-id'), 'upstream-123');
});

// ─── Rate limiting ──────────────────────────────────────────

test('auth endpoints refuse a flood and say when to come back', async () => {
  let last;
  for (let i = 0; i < 25; i++) {
    last = await h.post('/api/auth/login', { email: 'nobody@x.ng', password: 'x' });
  }

  assert.equal(last.status, 429);
  assert.ok(last.body.retry_after_seconds > 0);
});

test('rate limit headers are present on a normal response', async () => {
  const res = await fetch(h.baseUrl() + '/api/health');
  assert.ok(Number(res.headers.get('ratelimit-limit')) > 0);
  assert.ok(res.headers.get('ratelimit-remaining') !== null);
});

test('authenticated callers get their own bucket, not a shared IP one', async () => {
  const first = h.makeUser({ password: 'dev-password' });
  const second = h.makeUser({ password: 'dev-password' });

  const firstToken = await h.loginUser(first.email, 'dev-password');
  const secondToken = await h.loginUser(second.email, 'dev-password');

  store.resetAll();

  // Spend the first member's budget
  for (let i = 0; i < 305; i++) await h.get('/api/users/profile', { token: firstToken });

  const exhausted = await h.get('/api/users/profile', { token: firstToken });
  const other = await h.get('/api/users/profile', { token: secondToken });

  assert.equal(exhausted.status, 429);
  assert.equal(other.status, 200, 'one noisy member must not lock out everyone else');
});

// ─── Error handling ─────────────────────────────────────────

test('malformed JSON reads as a client error, not a server crash', async () => {
  const res = await fetch(h.baseUrl() + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"email": '
  });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /valid JSON/);
});

test('an unknown API path answers with JSON, not the login page', async () => {
  const res = await h.get('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Endpoint not found');
});

test('health reports status without leaking business data', async () => {
  h.makeUser();
  const res = await h.get('/api/health');

  assert.equal(res.body.status, 'ok');
  // The old health endpoint published the member count to anyone who asked
  assert.equal(res.body.users, undefined);
});

// ─── Security headers ───────────────────────────────────────

test('responses carry the baseline security headers', async () => {
  const res = await fetch(h.baseUrl() + '/api/health');

  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-powered-by'), null, 'the server should not advertise its stack');
});

// ─── Migrations ─────────────────────────────────────────────

test('a fresh database ends up fully migrated, and re-running is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devcircle-migrate-'));
  const fresh = new Database(path.join(dir, 'fresh.db'));

  try {
    // The base schema lives in db.js; a bare database needs it before migrating
    fresh.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8')
      .match(/db\.exec\(`([\s\S]*?)`\);/)[1]);

    const firstRun = migrations.run(fresh);
    assert.ok(firstRun.length >= 15);

    const secondRun = migrations.run(fresh);
    assert.equal(secondRun.length, 0, 'migrations must be run-once');

    assert.equal(migrations.status(fresh).pending.length, 0);
  } finally {
    fresh.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration ids are unique and ordered', () => {
  const defined = migrations.define(h.db);
  const ids = defined.map(m => m.id);

  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ids must be in ascending order');
  assert.equal(new Set(ids).size, ids.length, 'two migrations cannot share an id');
});

test('status reports a database that is ahead of the code', () => {
  h.db.prepare('INSERT INTO schema_migrations (id, name) VALUES (999, ?)').run('from_the_future');

  try {
    const { unknown } = migrations.status(h.db);
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].name, 'from_the_future');
  } finally {
    h.db.prepare('DELETE FROM schema_migrations WHERE id = 999').run();
  }
});
