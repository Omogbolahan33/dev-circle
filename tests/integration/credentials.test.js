const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

before(h.start);
after(h.stop);

let superToken;
let readerToken;
let legacyToken;

beforeEach(async () => {
  h.reset();
  h.makeRootCircle();

  const superRole = h.makeRole('Super Admin', ['*']);
  const readerRole = h.makeRole('Credential viewer', ['credentials.read']);
  // The permission that gated key management before credentials.* existed
  const legacyRole = h.makeRole('Integrations', ['integrations.read', 'integrations.write']);

  const boss = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: superRole });
  const reader = h.makeAdmin({ email: 'viewer@creditdirect.ng', roleId: readerRole });
  const legacy = h.makeAdmin({ email: 'ops@creditdirect.ng', roleId: legacyRole });

  superToken = await h.loginAdmin(boss.email, boss.password);
  readerToken = await h.loginAdmin(reader.email, reader.password);
  legacyToken = await h.loginAdmin(legacy.email, legacy.password);
});

const issue = (body, token = superToken) => h.post('/api/admin/api-keys', body, { token });

// ─── Who may manage credentials ─────────────────────────────

test('credentials need a permission, and the 403 says which', async () => {
  const role = h.makeRole('Nothing much', ['members.read']);
  const nobody = h.makeAdmin({ email: 'nobody@creditdirect.ng', roleId: role });
  const token = await h.loginAdmin(nobody.email, nobody.password);

  const res = await h.get('/api/admin/credentials', { token });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body.required, ['credentials.read']);
});

test('a reader can see keys but not issue, edit, rotate or revoke one', async () => {
  const { body } = await issue({ name: 'Landing page', scopes: ['landing_page'] });

  assert.equal((await h.get('/api/admin/api-keys', { token: readerToken })).status, 200);
  assert.equal((await h.get(`/api/admin/api-keys/${body.record.id}`, { token: readerToken })).status, 200);

  assert.equal((await issue({ name: 'x' }, readerToken)).status, 403);
  assert.equal((await h.put(`/api/admin/api-keys/${body.record.id}`, { name: 'x' }, { token: readerToken })).status, 403);
  assert.equal((await h.post(`/api/admin/api-keys/${body.record.id}/rotate`, {}, { token: readerToken })).status, 403);
  assert.equal((await h.del(`/api/admin/api-keys/${body.record.id}`, { token: readerToken })).status, 403);
});

test('a role that could manage keys before credentials.* existed still can', async () => {
  // integrations.write is accepted on the endpoints that predate the split, so
  // upgrading does not quietly take a job away from whoever was doing it
  const created = await issue({ name: 'Landing page', scopes: ['landing_page'] }, legacyToken);
  assert.equal(created.status, 201);

  assert.equal((await h.get('/api/admin/api-keys', { token: legacyToken })).status, 200);
  assert.equal((await h.del(`/api/admin/api-keys/${created.body.record.id}`, { token: legacyToken })).status, 200);
});

test('the migration hands the new permissions to the roles that need them', () => {
  const migration = require('../../src/db/migrations').define(h.db).find(m => m.id === 19);

  h.db.prepare("UPDATE roles SET permissions = ? WHERE name = 'Super Admin'")
    .run(JSON.stringify(['members.read']));

  migration.up();

  const read = name => JSON.parse(h.db.prepare('SELECT permissions FROM roles WHERE name = ?').get(name).permissions);

  const superAdmin = read('Super Admin');
  for (const key of ['credentials.read', 'credentials.write', 'sandbox.use']) {
    assert.ok(superAdmin.includes(key), `Super Admin must gain ${key}`);
  }
  assert.ok(superAdmin.includes('members.read'), 'what it already had must survive');

  // Whoever could manage keys keeps managing keys, but gains no sandbox
  const legacy = read('Integrations');
  assert.ok(legacy.includes('credentials.write'));
  assert.ok(!legacy.includes('sandbox.use'), 'the sandbox is not implied by managing keys');

  // and a role with neither is left alone
  assert.deepEqual(read('Credential viewer'), ['credentials.read']);
});

// ─── Issuing ────────────────────────────────────────────────

test('a key is returned once, and only its hash is kept', async () => {
  const res = await issue({ name: 'Landing page', scopes: ['landing_page'] });

  assert.equal(res.status, 201);
  assert.match(res.body.key, /^dc_[0-9a-f]{8}_[0-9a-f]{48}$/);
  assert.equal(res.body.record.status, 'live');

  const stored = h.db.prepare('SELECT key_hash FROM api_keys WHERE id = ?').get(res.body.record.id);
  assert.notEqual(stored.key_hash, res.body.key);

  // and nothing hands it back afterwards
  const fetched = await h.get(`/api/admin/api-keys/${res.body.record.id}`, { token: superToken });
  assert.equal(JSON.stringify(fetched.body).includes(res.body.key), false);
});

test('scopes are validated, and a wildcard cannot masquerade as a narrow key', async () => {
  assert.equal((await issue({ name: 'x', scopes: ['billing'] })).status, 400);
  assert.equal((await issue({ name: 'x', scopes: [] })).status, 201, 'an empty list falls back to events');

  const both = await issue({ name: 'x', scopes: ['*', 'feex'] });
  assert.equal(both.status, 400);
  assert.match(both.body.error, /already covers every endpoint/);
});

test('an expiry in the past is refused, and a date is accepted', async () => {
  assert.equal((await issue({ name: 'x', expires_at: '2020-01-01' })).status, 400);

  const res = await issue({ name: 'x', expires_at: '2030-06-30' });
  assert.equal(res.status, 201);
  assert.equal(res.body.record.expires_at, '2030-06-30 23:59:59');
});

test('an issued key actually authenticates, within its scope', async () => {
  const { body } = await issue({ name: 'Feex', scopes: ['feex'] });

  const allowed = await h.post('/api/integrations/feex/webhook',
    { ticket_id: 'T1', user_email: 'nobody@example.ng' }, { apiKey: body.key });
  assert.notEqual(allowed.status, 401);
  assert.notEqual(allowed.status, 403);

  const denied = await h.post('/api/integrations/landing-page/ingest',
    { email: 'x@y.ng', name: 'X' }, { apiKey: body.key });
  assert.equal(denied.status, 403);
});

// ─── Editing ────────────────────────────────────────────────

test('narrowing a live key takes effect on its next request', async () => {
  const { body } = await issue({ name: 'Wide', scopes: ['*'] });

  const before = await h.post('/api/integrations/landing-page/ingest',
    { email: 'first@y.ng', name: 'First' }, { apiKey: body.key });
  assert.equal(before.status, 201);

  await h.put(`/api/admin/api-keys/${body.record.id}`, { scopes: ['feex'] }, { token: superToken });

  const after = await h.post('/api/integrations/landing-page/ingest',
    { email: 'second@y.ng', name: 'Second' }, { apiKey: body.key });
  assert.equal(after.status, 403, 'the key must lose the scope immediately');
});

test('a revoked key cannot be edited', async () => {
  const { body } = await issue({ name: 'Old' });
  await h.del(`/api/admin/api-keys/${body.record.id}`, { token: superToken });

  const res = await h.put(`/api/admin/api-keys/${body.record.id}`, { name: 'New' }, { token: superToken });
  assert.equal(res.status, 409);
});

// ─── Rotating ───────────────────────────────────────────────

test('rotating issues a replacement and kills the old key immediately', async () => {
  const first = await issue({ name: 'Landing page', scopes: ['landing_page'] });

  const rotated = await h.post(`/api/admin/api-keys/${first.body.record.id}/rotate`,
    { grace_hours: 0 }, { token: superToken });

  assert.equal(rotated.status, 201);
  assert.notEqual(rotated.body.key, first.body.key);
  assert.deepEqual(rotated.body.scopes, ['landing_page'], 'the replacement carries the same scopes');
  assert.equal(rotated.body.replaced.status, 'revoked');

  const withOld = await h.post('/api/integrations/landing-page/ingest',
    { email: 'a@y.ng', name: 'A' }, { apiKey: first.body.key });
  assert.equal(withOld.status, 401);

  const withNew = await h.post('/api/integrations/landing-page/ingest',
    { email: 'b@y.ng', name: 'B' }, { apiKey: rotated.body.key });
  assert.equal(withNew.status, 201);
});

test('a grace period keeps both keys working until the old one lapses', async () => {
  const first = await issue({ name: 'Landing page', scopes: ['landing_page'] });

  const rotated = await h.post(`/api/admin/api-keys/${first.body.record.id}/rotate`,
    { grace_hours: 24 }, { token: superToken });

  assert.equal(rotated.status, 201);
  assert.equal(rotated.body.replaced.status, 'live', 'the old key stays usable during the grace period');
  assert.ok(rotated.body.replaced.expires_at, 'and gains a deadline it cannot outlive');

  // Both work right now — which is the whole point: the integration can be
  // moved across without a window where neither key is valid.
  const oldStillWorks = await h.post('/api/integrations/landing-page/ingest',
    { email: 'a@y.ng', name: 'A' }, { apiKey: first.body.key });
  assert.equal(oldStillWorks.status, 201);

  const newWorks = await h.post('/api/integrations/landing-page/ingest',
    { email: 'b@y.ng', name: 'B' }, { apiKey: rotated.body.key });
  assert.equal(newWorks.status, 201);

  // Wind the deadline back and the old one is refused without anybody acting
  h.db.prepare("UPDATE api_keys SET expires_at = datetime('now', '-1 hour') WHERE id = ?")
    .run(first.body.record.id);

  const lapsed = await h.post('/api/integrations/landing-page/ingest',
    { email: 'c@y.ng', name: 'C' }, { apiKey: first.body.key });
  assert.equal(lapsed.status, 401);
});

test('an out-of-range grace period is refused', async () => {
  const { body } = await issue({ name: 'x' });

  for (const grace_hours of [-1, 721, 'soon']) {
    const res = await h.post(`/api/admin/api-keys/${body.record.id}/rotate`, { grace_hours }, { token: superToken });
    assert.equal(res.status, 400, `grace_hours ${grace_hours} should be refused`);
  }
});

test('an already revoked key cannot be rotated', async () => {
  const { body } = await issue({ name: 'x' });
  await h.del(`/api/admin/api-keys/${body.record.id}`, { token: superToken });

  const res = await h.post(`/api/admin/api-keys/${body.record.id}/rotate`, {}, { token: superToken });
  assert.equal(res.status, 409);
});

// ─── Reading the state of things ────────────────────────────

test('status is derived, so a lapsed key does not read as live', async () => {
  const live = await issue({ name: 'Live' });
  const expiring = await issue({ name: 'Expiring' });
  const revoked = await issue({ name: 'Revoked' });

  h.db.prepare("UPDATE api_keys SET expires_at = datetime('now', '-1 day') WHERE id = ?")
    .run(expiring.body.record.id);
  await h.del(`/api/admin/api-keys/${revoked.body.record.id}`, { token: superToken });

  const { body } = await h.get('/api/admin/api-keys', { token: superToken });
  const status = id => body.keys.find(k => k.id === id).status;

  assert.equal(status(live.body.record.id), 'live');
  assert.equal(status(expiring.body.record.id), 'expired');
  assert.equal(status(revoked.body.record.id), 'revoked');

  const filtered = await h.get('/api/admin/api-keys?status=live', { token: superToken });
  assert.deepEqual(filtered.body.keys.map(k => k.id), [live.body.record.id]);
});

test('the credentials overview reports providers without handing back a secret', async () => {
  const { status, body } = await h.get('/api/admin/credentials', { token: superToken });
  assert.equal(status, 200);

  const ids = body.providers.map(p => p.id);
  assert.deepEqual(ids.sort(), ['customer_io', 'dev_hub_sso', 'simpu', 'sms', 'termii', 'whatsapp']);

  for (const provider of body.providers) {
    assert.equal(typeof provider.configured, 'boolean');
    assert.ok(provider.env.length, 'every provider says where its credential comes from');
  }

  // The suite runs with a known SSO secret set; it must be reported as present
  // and never echoed.
  const sso = body.providers.find(p => p.id === 'dev_hub_sso');
  assert.equal(sso.configured, true);
  assert.equal(JSON.stringify(body).includes('test-sso-secret'), false, 'no secret may appear in the response');

  // Overview includes email service status
  assert.ok(body.email);
  assert.equal(typeof body.email.active_provider, 'string');
});

test('test-email endpoint requires credentials.write permission', async () => {
  const denied = await h.post('/api/admin/credentials/test-email', { to: 'test@creditdirect.ng' }, { token: readerToken });
  assert.equal(denied.status, 403);

  const missingTo = await h.post('/api/admin/credentials/test-email', {}, { token: superToken });
  assert.equal(missingTo.status, 400);

  const allowed = await h.post('/api/admin/credentials/test-email', { to: 'test@creditdirect.ng' }, { token: superToken });
  assert.equal(allowed.status, 200);
  assert.match(allowed.body.message, /Test email dispatched/);
});

test('the overview counts a key nobody has ever used', async () => {
  const used = await issue({ name: 'Used', scopes: ['feex'] });
  await issue({ name: 'Never used' });

  await h.post('/api/integrations/feex/webhook',
    { ticket_id: 'T1', user_email: 'nobody@example.ng' }, { apiKey: used.body.key });

  const { body } = await h.get('/api/admin/credentials', { token: superToken });
  assert.equal(body.keys.total, 2);
  assert.equal(body.keys.live, 2);
  assert.equal(body.keys.never_used, 1);
  assert.ok(body.keys.last_used_at, 'the most recent use of any key is reported');
});

test('every scope in the catalogue names the endpoints it unlocks', async () => {
  const { body } = await h.get('/api/admin/credentials', { token: superToken });

  assert.ok(body.scopes.length >= 5);
  for (const scope of body.scopes) {
    assert.ok(scope.label && scope.description, `${scope.key} needs a label and a description`);
    assert.ok(scope.endpoints.length, `${scope.key} must say what it opens`);
  }
});
