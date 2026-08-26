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

test('a Credit Direct address is asked for a password, everyone else for their phone digits', async () => {
  const staff = await h.post('/api/auth/identify', { identifier: 'tunde@creditdirect.ng' });
  assert.equal(staff.status, 200);
  assert.equal(staff.body.audience, 'staff');
  assert.equal(staff.body.method, 'password');
  assert.equal(staff.body.sso, false, 'Credit Direct staff do not use Developer Hub SSO');

  for (const identifier of ['ada@paystack.dev', 'ope@fcmb.com.ng']) {
    const res = await h.post('/api/auth/identify', { identifier });
    assert.equal(res.body.method, 'phone_digits', `${identifier} should be asked for their digits`);
    assert.equal(res.body.audience, 'participant');
    assert.equal(res.body.digits, 6);
  }

  const fcmb = await h.post('/api/auth/identify', { identifier: 'ope@fcmb.com' });
  assert.equal(fcmb.body.audience, 'staff');
});

test('a phone number is not accepted as the identifier, because it contains the secret', async () => {
  const res = await h.post('/api/auth/identify', { identifier: '0803 000 0000' });
  assert.equal(res.status, 200);
  assert.equal(res.body.audience, 'participant');
  assert.equal(res.body.method, 'email_required',
    'the last six digits of this very number are the credential');

  h.makeUser({ email: 'ada@example.ng', phone: '+2348030000000' });
  const attempt = await h.post('/api/auth/login', { identifier: '08030000000', digits: '000000' });
  assert.equal(attempt.status, 400);
  assert.match(attempt.body.error, /email address you registered with/);
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

// ─── Participants: the last six digits ──────────────────────

test('a member signs in with their address and the last six digits of their number', async () => {
  h.makeUser({ email: 'ada@example.ng', phone: '+2348030001234' });

  const login = await h.post('/api/auth/login', { identifier: 'ada@example.ng', digits: '001234' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.ok(login.body.token);
  assert.equal(login.body.isAdmin, false);

  const profile = await h.get('/api/users/profile', { token: login.body.token });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.email, 'ada@example.ng');
  assert.equal(profile.body.user.password_hash, undefined, 'password hash must never be returned');
});

test('the digits are counted off the normalised number, however it was written', async () => {
  // 0803 000 1234, +234 803 000 1234 and 8030001234 are one number and one
  // secret. Anything else would give the same person a different credential
  // depending on how they happened to type it the day they registered.
  for (const written of ['0803 000 1234', '+2348030001234', '803-000-1234']) {
    h.reset();
    h.makeRootCircle();
    h.makeUser({ email: 'ada@example.ng', phone: written });

    const login = await h.post('/api/auth/login', { identifier: 'ada@example.ng', digits: '001234' });
    assert.equal(login.status, 200, `${written} should yield the same six digits`);
  }
});

test('spaces and dashes in what they type are ignored', async () => {
  h.makeUser({ email: 'ada@example.ng', phone: '+2348030001234' });

  const login = await h.post('/api/auth/login', { identifier: 'ada@example.ng', digits: '00 12 34' });
  assert.equal(login.status, 200);
});

test('the wrong digits are refused, and say no more than that', async () => {
  h.makeUser({ email: 'ada@example.ng', phone: '+2348030001234' });

  const wrong = await h.post('/api/auth/login', { identifier: 'ada@example.ng', digits: '999999' });
  const ghost = await h.post('/api/auth/login', { identifier: 'ghost@example.ng', digits: '999999' });

  assert.equal(wrong.status, 401);
  assert.equal(ghost.status, 401);
  assert.equal(wrong.body.error, ghost.body.error,
    'a real address and a made-up one must be indistinguishable');
});

test('a member with no phone number cannot sign in, and is not told that is why', async () => {
  // A real state: members arrive through SSO, a spreadsheet and the landing
  // page, and none of those has ever had to carry a number.
  h.makeUser({ email: 'ada@example.ng', phone: null });

  const attempt = await h.post('/api/auth/login', { identifier: 'ada@example.ng', digits: '000000' });
  assert.equal(attempt.status, 401);
  assert.match(attempt.body.error, /do not match an account/,
    '"this address exists but has no number" is worth nothing to them and something to an attacker');
});

test('a partial guess is refused — it is six digits or nothing', async () => {
  h.makeUser({ email: 'ada@example.ng', phone: '+2348030001234' });

  for (const digits of ['1234', '0012345', '', '01234']) {
    const attempt = await h.post('/api/auth/login', { identifier: 'ada@example.ng', digits });
    assert.ok(attempt.status >= 400, `"${digits}" should not open a session`);
  }
});

test('guessing the digits is throttled', async () => {
  h.makeUser({ email: 'ada@example.ng', phone: '+2348030001234' });

  let last;
  for (let i = 0; i < 9; i++) {
    last = await h.post('/api/auth/login', { identifier: 'ada@example.ng', digits: '000000' });
  }
  assert.equal(last.status, 429, 'six digits is a million combinations and no more');

  // …and the throttle holds even once the right answer is offered
  const correct = await h.post('/api/auth/login', { identifier: 'ada@example.ng', digits: '001234' });
  assert.equal(correct.status, 429);
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

  // …and the right credential no longer opens a new one
  const again = await h.post('/api/auth/login', {
    identifier: user.email,
    digits: require('../../src/utils/identity').phoneDigits(
      h.db.prepare('SELECT phone_normalized FROM users WHERE id = ?').get(user.id).phone_normalized
    )
  });
  assert.equal(again.status, 403, 'a suspended account is refused after the credential verifies');
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
  h.makeUser({ email: 'ada@example.ng', phone: '+2348030001234' });

  // A participant has no password. What they type goes to the digit check
  // whichever box the form posted it in, so a stale client sending `password`
  // is answered by the credential they actually hold rather than by a lecture.
  const asPassword = await h.post('/api/auth/login', {
    identifier: 'ada@example.ng', password: '001234'
  });
  assert.equal(asPassword.status, 200, 'the field name is not the credential');

  const wrongSecret = await h.post('/api/auth/login', {
    identifier: 'ada@example.ng', password: 'a-real-password'
  });
  assert.equal(wrongSecret.status, 401);

  // …and staff are never asked for digits: their address goes down the
  // password half, and six digits is not their password.
  const roleId = h.makeRole('super', ['*']);
  h.makeAdmin({ email: 'tunde@creditdirect.ng', roleId, password: 'staff-password' });

  const staffDigits = await h.post('/api/auth/login', {
    identifier: 'tunde@creditdirect.ng', digits: '001234'
  });
  assert.equal(staffDigits.status, 400, 'no password was given');
  assert.match(staffDigits.body.error, /password/i);
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
  const res = await h.post('/api/auth/register', {
    email: 'new@stitch.ng', name: 'New Dev', phone: '0803 000 1234'
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.token, undefined, 'signing in is a separate step');
  assert.equal(res.body.next.method, 'phone_digits');
  assert.equal(res.body.next.digits, 6);

  const login = await h.post('/api/auth/login', { identifier: 'new@stitch.ng', digits: '001234' });
  assert.equal(login.status, 200, 'and the digits they already know are the way in');
});

test('registering without a phone number is refused, because it is half the credential', async () => {
  const res = await h.post('/api/auth/register', { email: 'new@stitch.ng', name: 'New Dev' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /phone number is required/);
  assert.equal(h.db.prepare('SELECT COUNT(*) as n FROM users').get().n, 0,
    'a profile nobody could sign in to should not be created at all');
});

test('a Credit Direct address cannot be self-registered', async () => {
  const res = await h.post('/api/auth/register', { email: 'someone@creditdirect.ng', name: 'Someone' });
  assert.equal(res.status, 400);
});

// ─── Rescuing a member who cannot sign in ───────────────────
// Members arrive through four doors that have never required a phone number:
// Developer Hub SSO, the landing-page ingest, a spreadsheet import, and an
// administrator typing one in. Every one of those produces an account that
// cannot sign in until a number is on it, so there has to be a way to put one
// there.

test('an administrator can give a member the number they sign in with', async () => {
  const user = h.makeUser({ email: 'ada@example.ng', phone: null });

  const before = await h.post('/api/auth/login', { identifier: 'ada@example.ng', digits: '001234' });
  assert.equal(before.status, 401, 'no number means no way in');

  const roleId = h.makeRole('super', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId });
  const adminToken = await h.loginAdmin(admin.email, admin.password);

  const set = await h.put(`/api/admin/members/${user.id}`, { phone: '0803 000 1234' }, { token: adminToken });
  assert.equal(set.status, 200, JSON.stringify(set.body));

  // Normalised on the way in, because the six digits are counted off the E.164
  // form — otherwise what an admin typed and what the member types would have
  // to match character for character.
  const row = h.db.prepare('SELECT phone, phone_normalized FROM users WHERE id = ?').get(user.id);
  assert.equal(row.phone_normalized, '+2348030001234');

  const after = await h.post('/api/auth/login', { identifier: 'ada@example.ng', digits: '001234' });
  assert.equal(after.status, 200, 'and now they are in');
});

test('a number an administrator cannot read is refused rather than stored', async () => {
  const user = h.makeUser({ email: 'ada@example.ng' });
  const roleId = h.makeRole('super', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId });
  const adminToken = await h.loginAdmin(admin.email, admin.password);

  const held = h.db.prepare('SELECT phone_normalized FROM users WHERE id = ?').get(user.id).phone_normalized;

  const refused = await h.put(`/api/admin/members/${user.id}`, { phone: 'call the office' }, { token: adminToken });
  assert.equal(refused.status, 400);

  assert.equal(
    h.db.prepare('SELECT phone_normalized FROM users WHERE id = ?').get(user.id).phone_normalized,
    held,
    'a refusal must not have half-written the change'
  );
});
