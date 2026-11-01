const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers');

beforeEach(async () => { await h.start(); });
after(() => { h.stop(); });

// ─── Phone: a sign-in credential, not a contact detail ──────
// Its last four digits are half of what a participant signs in with, so once a
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

  // And they can still sign in with the original four digits.
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

test('saved profile fields are loaded again from the authenticated profile session', async () => {
  const user = h.makeUser({ email: 'reopen-profile@example.ng' });
  const token = await h.loginUser(user.email);
  const saved = await h.put('/api/users/profile', {
    company: 'Updated Company', age_group: '35 - 44',
    products: ['Mobile App', 'Yield', 'BNPL'], employment: 'Student',
    preferred_research: 'User interviews'
  }, { token });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const reopened = await h.get('/api/users/profile', { token });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.user.company, 'Updated Company');
  assert.equal(reopened.body.user.age_group, '35 - 44');
  assert.deepEqual(reopened.body.user.products, ['Mobile App', 'Yield', 'BNPL']);
  assert.equal(reopened.body.user.segment, 'Power Tester');
  assert.equal(reopened.body.user.employment, 'Student');
  assert.equal(reopened.body.user.preferred_research, 'User interviews');
});

test('participant segment is derived from products and cannot be supplied by the member', async () => {
  const user = h.makeUser({ email: 'segment@example.ng', products: ['Mobile App'] });
  const token = await h.loginUser(user.email);

  const twoProducts = await h.put('/api/users/profile', {
    products: ['Mobile App', 'Yield'], segment: 'Power Tester'
  }, { token });
  assert.equal(twoProducts.status, 200, JSON.stringify(twoProducts.body));
  assert.equal(h.db.prepare('SELECT segment FROM users WHERE id = ?').get(user.id).segment, 'Multi-Product');

  const noProducts = await h.put('/api/users/profile', {
    products: [], segment: 'Single Product'
  }, { token });
  assert.equal(noProducts.status, 200, JSON.stringify(noProducts.body));
  assert.equal(h.db.prepare('SELECT segment FROM users WHERE id = ?').get(user.id).segment, 'General / App');

  const segmentOnly = await h.put('/api/users/profile', { segment: 'Power Tester' }, { token });
  assert.equal(segmentOnly.status, 400, 'segment is not a writable profile field');
  assert.equal(h.db.prepare('SELECT segment FROM users WHERE id = ?').get(user.id).segment, 'General / App');
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

test('location and preferred research are dropdown vocabularies, not free text', async () => {
  const user = h.makeUser({ email: 'dropdowns@example.ng' });
  const token = await h.loginUser(user.email);
  const profile = await h.get('/api/users/profile', { token });
  assert.ok(profile.body.location_options.includes('Lagos'));
  assert.ok(profile.body.preferred_research_options.includes('Product testing'));
  assert.ok(profile.body.preferred_research_options.includes('User interviews'));
  const fieldOptions = Object.fromEntries(profile.body.profile_field_catalog.map(field => [field.key, field.values]));
  assert.deepEqual(fieldOptions.age_group.map(option => option.value),
    ['18 - 24', '25 - 34', '35 - 44', '45 - 54', '55 - 64']);
  assert.ok(fieldOptions.work_sector.some(option => option.value === 'Fintech'));
  assert.ok(fieldOptions.gender.some(option => option.value === 'female'));

  const badLocation = await h.put('/api/users/profile', { location_state: 'Somewhere' }, { token });
  assert.equal(badLocation.status, 400);
  const badResearch = await h.put('/api/users/profile', { preferred_research: 'Free text value' }, { token });
  assert.equal(badResearch.status, 400);

  const saved = await h.put('/api/users/profile', {
    location_state: 'Lagos', preferred_research: 'User interviews'
  }, { token });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const row = h.db.prepare('SELECT location_state, preferred_research FROM users WHERE id = ?').get(user.id);
  assert.deepEqual(row, { location_state: 'Lagos', preferred_research: 'User interviews' });
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
