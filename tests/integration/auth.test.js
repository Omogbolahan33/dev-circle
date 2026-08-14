const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const { signSSOToken } = require('../../src/middleware/auth');

before(h.start);
after(h.stop);

let rootCircle;

beforeEach(() => {
  h.reset();
  rootCircle = h.makeRootCircle();
});

// ─── One sign-in form ───────────────────────────────────────
// Nobody picks "developer" or "Credit Direct" before signing in. They type the
// one identifier they have, and the backend decides what to ask for next.

test('a Credit Direct address is asked for a password, everyone else for a code', async () => {
  const staff = await h.post('/api/auth/identify', { identifier: 'tunde@creditdirect.ng' });
  assert.equal(staff.status, 200);
  assert.equal(staff.body.audience, 'staff');
  assert.equal(staff.body.method, 'password');
  assert.equal(staff.body.sso, false, 'Credit Direct staff do not use Developer Hub SSO');

  for (const identifier of ['ada@paystack.dev', 'ope@fcmb.com.ng', '0803 000 0000']) {
    const res = await h.post('/api/auth/identify', { identifier });
    assert.equal(res.body.method, 'code', `${identifier} should be sent down the code path`);
    assert.equal(res.body.audience, 'participant');
  }

  const fcmb = await h.post('/api/auth/identify', { identifier: 'ope@fcmb.com' });
  assert.equal(fcmb.body.audience, 'staff');
});

test('identify does not say whether an account exists', async () => {
  h.makeUser({ email: 'ada@example.ng' });

  const known = await h.post('/api/auth/identify', { identifier: 'ada@example.ng' });
  const unknown = await h.post('/api/auth/identify', { identifier: 'ghost@example.ng' });

  assert.deepEqual(
    { ...known.body, identifier: null, masked: null },
    { ...unknown.body, identifier: null, masked: null }
  );
});

test('nonsense in the one field is refused before anything is sent', async () => {
  const res = await h.post('/api/auth/identify', { identifier: 'not an identifier' });
  assert.equal(res.status, 400);
});

// ─── Participants: one-time code ────────────────────────────

test('a member signs in with a code sent to their email, and holds no password', async () => {
  const user = h.makeUser({ email: 'ada@example.ng' });

  const requested = await h.post('/api/auth/code/request', { identifier: 'ada@example.ng' });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.channel, 'email');
  assert.equal(requested.body.masked, 'a•••@example.ng');

  const login = await h.post('/api/auth/code/verify', {
    identifier: 'ada@example.ng', code: requested.body.dev_code
  });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);

  const profile = await h.get('/api/users/profile', { token: login.body.token });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.email, 'ada@example.ng');
  assert.equal(profile.body.user.password_hash, undefined, 'password hash must never be returned');

  // The stored code is a hash, exactly like a session token
  const row = h.db.prepare('SELECT code_hash FROM login_codes WHERE user_id = ?').get(user.id);
  assert.notEqual(row.code_hash, requested.body.dev_code);
  assert.equal(row.code_hash.length, 64);
});

test('a member signs in by phone, however they write the number', async () => {
  h.makeUser({ email: 'ada@example.ng', phone: '+2348030000000' });

  const requested = await h.post('/api/auth/code/request', { identifier: '0803 000 0000' });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.channel, 'sms');

  const login = await h.post('/api/auth/code/verify', {
    identifier: '08030000000', code: requested.body.dev_code
  });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
});

test('asking for a code says nothing about whether the account exists', async () => {
  h.makeUser({ email: 'ada@example.ng' });

  const known = await h.post('/api/auth/code/request', { identifier: 'ada@example.ng' });
  const unknown = await h.post('/api/auth/code/request', { identifier: 'ghost@example.ng' });

  assert.equal(known.status, unknown.status);
  assert.equal(unknown.body.sent, true);
  assert.equal(unknown.body.dev_code, undefined, 'nothing was issued, so there is no code to hand back');

  // …and a made-up code for a made-up address gets the same answer as a wrong
  // code for a real one
  const bad = await h.post('/api/auth/code/verify', { identifier: 'ghost@example.ng', code: '000000' });
  assert.equal(bad.status, 401);
});

test('a code works once', async () => {
  h.makeUser({ email: 'ada@example.ng' });
  const { body } = await h.post('/api/auth/code/request', { identifier: 'ada@example.ng' });

  const first = await h.post('/api/auth/code/verify', { identifier: 'ada@example.ng', code: body.dev_code });
  const second = await h.post('/api/auth/code/verify', { identifier: 'ada@example.ng', code: body.dev_code });

  assert.equal(first.status, 200);
  assert.equal(second.status, 401, 'a replayed code must not open a second session');
});

test('asking for a new code retires the old one', async () => {
  h.makeUser({ email: 'ada@example.ng' });

  const first = await h.post('/api/auth/code/request', { identifier: 'ada@example.ng' });
  const second = await h.post('/api/auth/code/request', { identifier: 'ada@example.ng' });

  const stale = await h.post('/api/auth/code/verify', { identifier: 'ada@example.ng', code: first.body.dev_code });
  assert.equal(stale.status, 401);

  const fresh = await h.post('/api/auth/code/verify', { identifier: 'ada@example.ng', code: second.body.dev_code });
  assert.equal(fresh.status, 200);
});

test('guessing burns the code rather than leaving it open', async () => {
  h.makeUser({ email: 'ada@example.ng' });
  const { body } = await h.post('/api/auth/code/request', { identifier: 'ada@example.ng' });

  // Six digits has no depth to spare, so wrong guesses are counted
  for (let i = 0; i < 5; i++) {
    await h.post('/api/auth/code/verify', { identifier: 'ada@example.ng', code: '000001' });
  }

  const withRealCode = await h.post('/api/auth/code/verify', {
    identifier: 'ada@example.ng', code: body.dev_code
  });
  assert.equal(withRealCode.status, 401, 'the code should be dead, even for the right guess');
});

test('a flood of code requests for one identifier is refused', async () => {
  h.makeUser({ email: 'ada@example.ng' });

  let last;
  for (let i = 0; i < 6; i++) {
    last = await h.post('/api/auth/code/request', { identifier: 'ada@example.ng' });
  }
  assert.equal(last.status, 429, 'nobody should be able to use this to flood an inbox');
});

test('a deactivated member cannot sign in, and their live sessions end', async () => {
  const user = h.makeUser({ email: 'ada@example.ng' });
  const token = await h.loginUser(user.email);

  const roleId = h.makeRole('super', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId });
  const adminToken = await h.loginAdmin(admin.email, admin.password);

  await h.put(`/api/admin/members/${user.id}`, { status: 'suspended' }, { token: adminToken });

  const afterDeactivation = await h.get('/api/users/profile', { token });
  assert.equal(afterDeactivation.status, 401, 'the existing session must stop working immediately');

  const requested = await h.post('/api/auth/code/request', { identifier: user.email });
  assert.equal(requested.body.dev_code, undefined, 'no code is issued to a suspended account');
});

// ─── Staff: password ────────────────────────────────────────

test('staff sign in with a password on the same form', async () => {
  const roleId = h.makeRole('super', ['*']);
  const admin = h.makeAdmin({ email: 'tunde@creditdirect.ng', roleId });

  const login = await h.post('/api/auth/login', { identifier: admin.email, password: admin.password });
  assert.equal(login.status, 200);
  assert.equal(login.body.isAdmin, true);
  assert.deepEqual(login.body.permissions, ['*']);
  assert.equal(login.body.admin.password_hash, undefined);

  const me = await h.get('/api/auth/me', { token: login.body.token });
  assert.equal(me.body.isAdmin, true);
});

test('a wrong password is rejected, and says no more than that', async () => {
  const roleId = h.makeRole('super', ['*']);
  const admin = h.makeAdmin({ email: 'tunde@creditdirect.ng', roleId });

  const wrongPassword = await h.post('/api/auth/login', { identifier: admin.email, password: 'nope' });
  const noSuchStaff = await h.post('/api/auth/login', { identifier: 'ghost@creditdirect.ng', password: 'nope' });

  assert.equal(wrongPassword.status, 401);
  // Otherwise the endpoint becomes a staff directory
  assert.equal(wrongPassword.status, noSuchStaff.status);
  assert.deepEqual(wrongPassword.body, noSuchStaff.body);
});

test('repeated failures are throttled', async () => {
  const roleId = h.makeRole('super', ['*']);
  const admin = h.makeAdmin({ email: 'tunde@creditdirect.ng', roleId });

  let last;
  for (let i = 0; i < 10; i++) {
    last = await h.post('/api/auth/login', { identifier: admin.email, password: 'wrong' });
  }
  assert.equal(last.status, 429);
});

test('the two halves of the form do not cross over', async () => {
  h.makeUser({ email: 'ada@example.ng' });

  // A participant has no password to be asked for…
  const participantPassword = await h.post('/api/auth/login', {
    identifier: 'ada@example.ng', password: 'anything'
  });
  assert.equal(participantPassword.status, 400);
  assert.equal(participantPassword.body.method, 'code');

  // …and staff are not sent codes
  const staffCode = await h.post('/api/auth/code/request', { identifier: 'tunde@creditdirect.ng' });
  assert.equal(staffCode.status, 400);
  assert.equal(staffCode.body.method, 'password');
});

test('sessions survive a restart because they are stored, not held in memory', async () => {
  const user = h.makeUser();
  const token = await h.loginUser(user.email);

  const stored = h.db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
  assert.equal(stored, 1);

  // The raw token must not be recoverable from the database
  const row = h.db.prepare('SELECT token_hash FROM sessions').get();
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash.length, 64);
});

test('logging out invalidates the token', async () => {
  const user = h.makeUser();
  const token = await h.loginUser(user.email);

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

test('SSO does not provision a Credit Direct address as a participant', async () => {
  const token = signSSOToken({
    sub: 'hub_staff', email: 'tunde@creditdirect.ng', name: 'Tunde Bakare',
    iat: Math.floor(Date.now() / 1000)
  });

  // Otherwise it would create a profile whose owner is sent down the password
  // path at the door and can never get in
  const res = await h.post('/api/auth/sso/exchange', { hub_token: token });
  assert.equal(res.status, 404);
  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM users').get().c, 0);
});

// ─── Registration ───────────────────────────────────────────

test('registering creates a profile but hands back no session', async () => {
  const res = await h.post('/api/auth/register', { email: 'new@stitch.ng', name: 'New Dev' });

  assert.equal(res.status, 201);
  assert.equal(res.body.token, undefined, 'the code sent to that address is what proves it is theirs');
  assert.equal(res.body.next.method, 'code');

  const login = await h.loginUser('new@stitch.ng');
  assert.ok(login, 'and that code is the way in');
});

test('a Credit Direct address cannot be self-registered', async () => {
  const res = await h.post('/api/auth/register', { email: 'someone@creditdirect.ng', name: 'Someone' });
  assert.equal(res.status, 400);
});
