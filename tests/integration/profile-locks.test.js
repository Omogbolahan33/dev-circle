const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers');

beforeEach(async () => { await h.start(); });
after(() => { h.stop(); });

// ─── Phone: a sign-in credential, not a contact detail ──────
// Its last six digits are half of what a participant signs in with, so once a
// number is on the account the member may not move it to a different number.

test('a member cannot change their phone number after registration', async () => {
  const user = h.makeUser({ email: 'ada@example.ng', phone: '0803 111 1234' });
  const token = await h.loginUser(user.email);

  const held = h.db.prepare('SELECT phone_normalized FROM users WHERE id = ?').get(user.id).phone_normalized;

  const res = await h.put('/api/users/profile', { phone: '0809 999 9999' }, { token });
  assert.equal(res.status, 403, 'a different number is refused');
  assert.match(res.body.error, /cannot be changed after registration/);
  assert.equal(res.body.field, 'phone');

  // The refusal must not have half-written the change.
  const after = h.db.prepare('SELECT phone_normalized FROM users WHERE id = ?').get(user.id);
  assert.equal(after.phone_normalized, held, 'credential unchanged');

  // And they can still sign in with the original six digits.
  const stillIn = await h.post('/api/auth/login', {
    identifier: user.email,
    digits: require('../../src/utils/identity').phoneDigits(held)
  });
  assert.equal(stillIn.status, 200);
});

test('re-sending the same number in a different spelling is accepted', async () => {
  const user = h.makeUser({ email: 'bisi@example.ng', phone: '+2348030001234' });
  const token = await h.loginUser(user.email);

  // Same number, national format instead of E.164.
  const res = await h.put('/api/users/profile', { phone: '0803 000 1234' }, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const row = h.db.prepare('SELECT phone, phone_normalized FROM users WHERE id = ?').get(user.id);
  assert.equal(row.phone_normalized, '+2348030001234', 'the canonical credential never moved');
  assert.equal(row.phone, '0803 000 1234', 'the display spelling may be updated');
});

test('an account with no number can set one exactly once', async () => {
  // Arrives the way Developer Hub SSO leaves an account: no number, unable to
  // sign in by digits until one is on file.
  const user = h.makeUser({ email: 'chidi@example.ng', phone: null });
  h.db.prepare('UPDATE users SET phone_normalized = NULL WHERE id = ?').run(user.id);

  // No number means the phone-digits sign-in is impossible, so mint a session
  // the way SSO arrival does.
  const auth = require('../../src/middleware/auth');
  const token = await auth.createSession(user.id, false, { issuedVia: 'test' });

  const set = await h.put('/api/users/profile', { phone: '0803 222 3456' }, { token });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const row = h.db.prepare('SELECT phone_normalized FROM users WHERE id = ?').get(user.id);
  assert.equal(row.phone_normalized, '+2348032223456');

  // A second attempt, now moving the number, is locked.
  const again = await h.put('/api/users/profile', { phone: '0803 999 0000' }, { token });
  assert.equal(again.status, 403);
});

// ─── API products: the one integration fact a member self-declares ──

test('a member can record the API products they build against', async () => {
  const user = h.makeUser({ email: 'deji@example.ng' });
  const token = await h.loginUser(user.email);

  const res = await h.put('/api/users/profile', { api_products: ['payments', 'lending'] }, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.user.api_products.sort(), ['lending', 'payments']);

  // Duplicates are collapsed.
  const dup = await h.put('/api/users/profile', { api_products: ['payments', 'payments'] }, { token });
  assert.equal(dup.status, 200);
  assert.deepEqual(dup.body.user.api_products, ['payments']);
});

test('unknown product families are rejected without a half-write', async () => {
  const user = h.makeUser({ email: 'eni@example.ng' });
  const token = await h.loginUser(user.email);

  const held = h.db.prepare('SELECT api_products FROM users WHERE id = ?').get(user.id).api_products;
  const res = await h.put('/api/users/profile', { api_products: ['payments', 'mortgages'] }, { token });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown API product/);
  assert.equal(
    h.db.prepare('SELECT api_products FROM users WHERE id = ?').get(user.id).api_products,
    held
  );
});

test('the profile response advertises the product catalog and members cannot self-declare stage or KYB', async () => {
  const user = h.makeUser({ email: 'funmi@example.ng' });
  const token = await h.loginUser(user.email);

  const profile = await h.get('/api/users/profile', { token });
  assert.equal(profile.status, 200);
  assert.ok(Array.isArray(profile.body.product_catalog));
  const keys = profile.body.product_catalog.map(p => p.key);
  for (const p of ['payments', 'lending', 'identity', 'credit_scoring']) {
    assert.ok(keys.includes(p), `catalog lists ${p}`);
  }
  assert.ok(profile.body.product_catalog.every(p => typeof p.label === 'string' && p.label.length));

  // Even if a client posts these keys, the member route has no handler for
  // them — they cannot promote themselves to production or mark KYB done.
  const before = h.db.prepare('SELECT api_status, kyb_completed FROM users WHERE id = ?').get(user.id);
  await h.put('/api/users/profile', { api_status: 'production', kyb_completed: 1 }, { token });
  const after = h.db.prepare('SELECT api_status, kyb_completed FROM users WHERE id = ?').get(user.id);
  assert.deepEqual(after, before, 'stage and KYB are untouched');
});
