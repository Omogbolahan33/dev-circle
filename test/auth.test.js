const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { signSSOToken } = require('../server/middleware/auth');

before(h.start);
after(h.stop);

let rootCircle;

beforeEach(() => {
  h.reset();
  rootCircle = h.makeRootCircle();
});

// ─── Password auth ──────────────────────────────────────────

test('a member can sign in and read their own profile', async () => {
  const user = h.makeUser({ email: 'ada@example.ng', password: 'correct-horse' });

  const login = await h.post('/api/auth/login', { email: user.email, password: 'correct-horse' });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);

  const profile = await h.get('/api/users/profile', { token: login.body.token });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.email, 'ada@example.ng');
  assert.equal(profile.body.user.password_hash, undefined, 'password hash must never be returned');
});

test('a wrong password is rejected', async () => {
  const user = h.makeUser({ password: 'correct-horse' });
  const res = await h.post('/api/auth/login', { email: user.email, password: 'wrong' });
  assert.equal(res.status, 401);
});

test('an unknown email and a wrong password give the same answer', async () => {
  const user = h.makeUser({ password: 'correct-horse' });
  const wrongPassword = await h.post('/api/auth/login', { email: user.email, password: 'nope' });
  const noSuchUser = await h.post('/api/auth/login', { email: 'ghost@example.ng', password: 'nope' });

  // Otherwise the endpoint becomes a registration oracle
  assert.equal(wrongPassword.status, noSuchUser.status);
  assert.deepEqual(wrongPassword.body, noSuchUser.body);
});

test('a deactivated member cannot sign in, and their live sessions end', async () => {
  const user = h.makeUser({ password: 'correct-horse' });
  const token = await h.loginUser(user.email, 'correct-horse');

  const roleId = h.makeRole('super', ['*']);
  const admin = h.makeAdmin({ email: 'boss@cd.ng', roleId });
  const adminToken = await h.loginAdmin(admin.email, admin.password);

  await h.put(`/api/admin/members/${user.id}`, { status: 'suspended' }, { token: adminToken });

  const afterDeactivation = await h.get('/api/users/profile', { token });
  assert.equal(afterDeactivation.status, 401, 'the existing session must stop working immediately');

  const login = await h.post('/api/auth/login', { email: user.email, password: 'correct-horse' });
  assert.equal(login.status, 403);
});

test('repeated failures are throttled', async () => {
  const user = h.makeUser({ password: 'correct-horse' });

  let last;
  for (let i = 0; i < 10; i++) {
    last = await h.post('/api/auth/login', { email: user.email, password: 'wrong' });
  }
  assert.equal(last.status, 429);
});

test('sessions survive a restart because they are stored, not held in memory', async () => {
  const user = h.makeUser({ password: 'correct-horse' });
  const token = await h.loginUser(user.email, 'correct-horse');

  const stored = h.db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
  assert.equal(stored, 1);

  // The raw token must not be recoverable from the database
  const row = h.db.prepare('SELECT token_hash FROM sessions').get();
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash.length, 64);
});

test('logging out invalidates the token', async () => {
  const user = h.makeUser({ password: 'correct-horse' });
  const token = await h.loginUser(user.email, 'correct-horse');

  await h.post('/api/auth/logout', {}, { token });

  const res = await h.get('/api/users/profile', { token });
  assert.equal(res.status, 401);
});

// ─── Developer Hub SSO ──────────────────────────────────────

test('SSO rejects a token that is not signed', async () => {
  h.makeUser({ email: 'ada@example.ng' });
  h.db.prepare('UPDATE users SET dev_hub_user_id = ? WHERE email = ?').run('hub_ada', 'ada@example.ng');

  // The old behaviour: knowing the hub id was enough to be issued a session
  const res = await h.post('/api/auth/sso/exchange', {
    hub_token: 'anything', dev_hub_user_id: 'hub_ada'
  });
  assert.equal(res.status, 401);
});

test('SSO rejects a tampered payload carrying a valid signature', async () => {
  h.makeUser({ email: 'ada@example.ng' });
  h.db.prepare('UPDATE users SET dev_hub_user_id = ? WHERE email = ?').run('hub_ada', 'ada@example.ng');

  const legit = signSSOToken({ sub: 'hub_someone_else', iat: Math.floor(Date.now() / 1000) });
  const signature = legit.split('.')[1];
  const forgedBody = Buffer.from(JSON.stringify({ sub: 'hub_ada', iat: Math.floor(Date.now() / 1000) }))
    .toString('base64url');

  const res = await h.post('/api/auth/sso/exchange', { hub_token: `${forgedBody}.${signature}` });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /Signature/);
});

test('SSO rejects a stale token', async () => {
  h.makeUser({ email: 'ada@example.ng' });
  h.db.prepare('UPDATE users SET dev_hub_user_id = ? WHERE email = ?').run('hub_ada', 'ada@example.ng');

  const old = signSSOToken({ sub: 'hub_ada', iat: Math.floor(Date.now() / 1000) - 3600 });
  const res = await h.post('/api/auth/sso/exchange', { hub_token: old });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /expired/i);
});

test('SSO accepts a properly signed token and uses the subject from the payload', async () => {
  const user = h.makeUser({ email: 'ada@example.ng' });
  h.db.prepare('UPDATE users SET dev_hub_user_id = ? WHERE id = ?').run('hub_ada', user.id);

  const token = signSSOToken({ sub: 'hub_ada', iat: Math.floor(Date.now() / 1000) });
  const res = await h.post('/api/auth/sso/exchange', { hub_token: token });

  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'ada@example.ng');
});

test('SSO provisions a profile for a verified Hub developer who has none', async () => {
  const token = signSSOToken({
    sub: 'hub_new', email: 'newcomer@example.ng', name: 'New Comer',
    iat: Math.floor(Date.now() / 1000)
  });

  const res = await h.post('/api/auth/sso/exchange', { hub_token: token });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'newcomer@example.ng');

  // and joins the root circle like any other member
  const circles = h.db.prepare('SELECT circle_id FROM circle_members WHERE user_id = ?')
    .all(res.body.user.id);
  assert.deepEqual(circles.map(c => c.circle_id), [rootCircle]);
});
