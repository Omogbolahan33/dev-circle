const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const vocabularies = require('../../src/services/vocabularies');

before(h.start);
after(h.stop);

let token;
let circleId;

beforeEach(async () => {
  h.reset();
  circleId = h.makeRootCircle();
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: role });
  token = await h.loginAdmin(admin.email, admin.password);
});

// ─── The answers with a fixed set ───────────────────────────
// These lists shipped hard-coded in three places, and the point of moving them
// is not that they are now in one place — it is that they can be changed
// without a deploy. Nigeria added a state once. A circle that starts
// onboarding insurers wants Insurance in the list this afternoon.

test('the lists that ship are the ones offered until somebody says otherwise', async () => {
  const res = await h.get('/api/admin/options', { token });
  assert.equal(res.status, 200);

  const byField = Object.fromEntries(res.body.fields.map(f => [f.field, f]));

  assert.equal(byField.location_state.options.length, 37, 'thirty-six states and the FCT');
  assert.ok(byField.location_state.options.includes('Lagos'));
  assert.ok(byField.location_state.options.includes('Federal Capital Territory'));
  assert.equal(byField.location_state.customised, false);

  assert.ok(byField.gender.options.includes('Female'));
  assert.ok(byField.work_sector.options.includes('Fintech'));

  // A company name is whatever somebody types, and offering a "standard list
  // of companies" would be offering a wrong one.
  assert.equal(byField.company, undefined);
});

test('a list can be changed without a deploy, and the builder asks the new one', async () => {
  const set = await h.put('/api/admin/options/work_sector', {
    options: ['Fintech', 'Insurance', 'Agritech', 'Other']
  }, { token });

  assert.equal(set.status, 200);
  assert.deepEqual(set.body.options, ['Fintech', 'Insurance', 'Agritech', 'Other']);
  assert.equal(set.body.customised, true);

  // The form builder reads the same lists, so a question tagged as a sector
  // offers what this circle asks rather than what shipped.
  const schema = await h.get('/api/admin/onboarding/schema', { token });
  const field = schema.body.fields.find(f => f.value === 'work_sector');
  assert.deepEqual(field.options, ['Fintech', 'Insurance', 'Agritech', 'Other']);
});

test('order is content, and it is kept', async () => {
  // A list of states is alphabetical so somebody can find their own, and
  // "Other" belongs last. Sorting these on the way in would be an opinion.
  const wanted = ['Zamfara', 'Abia', 'Other'];
  const set = await h.put('/api/admin/options/location_state', { options: wanted }, { token });
  assert.deepEqual(set.body.options, wanted);
});

test('blanks and repeats are dropped rather than refused', async () => {
  // Two identical options in a dropdown is a fault in the list, not a choice,
  // and it would split a cohort in two.
  const set = await h.put('/api/admin/options/gender', {
    options: ['  Female  ', 'female', '', '   ', 'Male']
  }, { token });

  assert.deepEqual(set.body.options, ['Female', 'Male']);
});

test('an empty list is refused, because a question with no answers is broken', async () => {
  const res = await h.put('/api/admin/options/gender', { options: [] }, { token });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at least one option/i);
});

test('a field with no fixed set of answers has no list to set', async () => {
  const res = await h.put('/api/admin/options/company', { options: ['Paystack'] }, { token });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /no list of answers/i);
});

test('resetting follows the default onwards rather than freezing a copy of it', async () => {
  await h.put('/api/admin/options/work_sector', { options: ['Only this'] }, { token });

  const reset = await h.del('/api/admin/options/work_sector', { token });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.customised, false);
  assert.deepEqual(reset.body.options, vocabularies.shipped('work_sector'));

  // The row is gone, not rewritten with today's default — which is what makes
  // "back to standard" keep meaning that after the standard list changes.
  const rows = h.db.prepare('SELECT COUNT(*) as n FROM option_lists WHERE circle_id = ? AND field = ?')
    .get(circleId, 'work_sector').n;
  assert.equal(Number(rows), 0);
});

test('one circle changing a list does not change it for another', async () => {
  const other = h.makeCircle('Partner Circle', 'partner');

  await h.put('/api/admin/options/gender', { options: ['Yes', 'No'] }, { token });

  const mine = await vocabularies.listFor('gender', circleId);
  const theirs = await vocabularies.listFor('gender', other);

  assert.deepEqual(mine, ['Yes', 'No']);
  assert.deepEqual(theirs, vocabularies.shipped('gender'), 'a peer workspace keeps its own');
});

test('changing a list does not touch answers already collected', async () => {
  // The whole reason this is safe to edit: a member who said "Lending" last
  // month still said it after Lending leaves the list.
  const user = h.makeUser({ email: 'ada@example.ng', work_sector: 'Lending' });

  await h.put('/api/admin/options/work_sector', { options: ['Fintech', 'Other'] }, { token });

  const stored = h.db.prepare('SELECT work_sector FROM users WHERE id = ?').get(user.id);
  assert.equal(stored.work_sector, 'Lending');
});

test('the shipped lists are handed out as copies, not as the originals', async () => {
  // A caller edits what it is given — the builder fills a question's options
  // from this and the author then rewrites one. Handing out the module's own
  // array would change the default for every circle in the process.
  const first = vocabularies.shipped('gender');
  first.push('Tampered');

  assert.ok(!vocabularies.shipped('gender').includes('Tampered'));
});
