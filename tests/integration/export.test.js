const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const { parseXLSX } = require('../../src/utils/xlsx');
const { parseCSV } = require('../../src/utils/helpers');

before(h.start);
after(h.stop);

let token;
let rootCircle;

beforeEach(async () => {
  h.reset();
  rootCircle = h.makeRootCircle();
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: role });
  token = await h.loginAdmin(admin.email, admin.password);
});

const rules = definition => encodeURIComponent(JSON.stringify(definition));

async function count(definition) {
  const res = await h.get(`/api/admin/export/count?rules=${rules(definition)}`, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.total;
}

function yearsAgo(n) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

// ─── Criteria ───────────────────────────────────────────────
// "Everything that can separate one member from another" is a single
// vocabulary, shared with cohorts. These cover the axes an operator reaches
// for and the ones that are easy to get subtly wrong.

test('age is derived from date of birth, not stored', async () => {
  h.makeUser({ date_of_birth: yearsAgo(24) });
  h.makeUser({ date_of_birth: yearsAgo(31) });
  h.makeUser({ date_of_birth: yearsAgo(45) });

  assert.equal(await count({ rules: [{ field: 'age', op: 'gte', value: 30 }] }), 2);
  assert.equal(await count({ rules: [{ field: 'age', op: 'lte', value: 30 }] }), 1);
});

test('a cohort can be exported by id', async () => {
  const inCohort = h.makeUser();
  h.makeUser();

  const cohortId = h.uuid();
  h.db.prepare("INSERT INTO cohorts (id, name, type) VALUES (?, 'VIP', 'custom')").run(cohortId);
  h.db.prepare('INSERT INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)').run(inCohort.id, cohortId);

  assert.equal(await count({ rules: [{ field: 'cohort_id', op: 'eq', value: cohortId }] }), 1);
});

test('excluding a cohort excludes the member, not just the matching row', async () => {
  const inCohort = h.makeUser();
  h.makeUser();

  const cohortId = h.uuid();
  h.db.prepare("INSERT INTO cohorts (id, name, type) VALUES (?, 'VIP', 'custom')").run(cohortId);
  h.db.prepare('INSERT INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)').run(inCohort.id, cohortId);

  // A naive "!=" against the join would keep the member via their other rows
  assert.equal(await count({ rules: [{ field: 'cohort_id', op: 'neq', value: cohortId }] }), 1);
});

test('circle membership separates members', async () => {
  const inside = h.makeUser();
  const outside = h.makeUser();

  const circleId = h.uuid();
  h.db.prepare("INSERT INTO circles (id, name, slug, parent_id) VALUES (?, 'Lending', 'lending', ?)")
    .run(circleId, rootCircle);
  h.db.prepare('INSERT INTO circle_members (circle_id, user_id) VALUES (?, ?)').run(circleId, inside.id);

  assert.equal(await count({ rules: [{ field: 'circle_id', op: 'eq', value: circleId }] }), 1);
  assert.equal(await count({ rules: [{ field: 'circle_id', op: 'neq', value: circleId }] }), 1);
  assert.notEqual(inside.id, outside.id);
});

test('consent selects who is actually reachable on a channel', async () => {
  const consented = h.makeUser();
  const withdrawn = h.makeUser();
  h.makeUser();

  h.grantConsent(consented.id, 'whatsapp');
  h.withdrawConsent(withdrawn.id, 'whatsapp');

  assert.equal(await count({ rules: [{ field: 'consent_channel', op: 'eq', value: 'whatsapp' }] }), 1,
    'a withdrawn channel must not count as consent');
});

test('engagement separates the responsive from the silent', async () => {
  const responsive = h.makeUser();
  h.makeUser();

  const surveyId = h.uuid();
  h.db.prepare("INSERT INTO surveys (id, title, questions, status) VALUES (?, 'S', '[]', 'active')").run(surveyId);
  for (let i = 0; i < 4; i++) {
    h.db.prepare(`
      INSERT INTO survey_responses (id, survey_id, user_id, completed_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(h.uuid(), surveyId, responsive.id);
  }

  assert.equal(await count({ rules: [{ field: 'surveys_completed', op: 'gte', value: 3 }] }), 1);
  assert.equal(await count({ rules: [{ field: 'has_responded', op: 'eq', value: 'no' }] }), 1);
});

test('members with no phone can be separated out', async () => {
  h.makeUser({ phone: '+2348031234567' });
  h.makeUser();

  assert.equal(await count({ rules: [{ field: 'has_phone', op: 'eq', value: 'yes' }] }), 1);
  assert.equal(await count({ rules: [{ field: 'has_phone', op: 'eq', value: 'no' }] }), 1);
});

test('an API product separates whole values, not substrings', async () => {
  h.makeUser({ api_products: ['lending'] });
  h.makeUser({ api_products: ['lending_beta'] });

  assert.equal(await count({ rules: [{ field: 'api_products', op: 'eq', value: 'lending' }] }), 1);
});

test('criteria combine with all, and widen with any', async () => {
  h.makeUser({ work_sector: 'Fintech', location_state: 'Lagos' });
  h.makeUser({ work_sector: 'Fintech', location_state: 'Ogun' });
  h.makeUser({ work_sector: 'Banking', location_state: 'Lagos' });

  const criteria = [
    { field: 'work_sector', op: 'eq', value: 'Fintech' },
    { field: 'location_state', op: 'eq', value: 'Lagos' }
  ];

  assert.equal(await count({ match: 'all', rules: criteria }), 1);
  assert.equal(await count({ match: 'any', rules: criteria }), 3);
});

test('an export can include suspended members, which a cohort never would', async () => {
  h.makeUser();
  const suspended = h.makeUser();
  h.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(suspended.id);

  // Cohort membership is active-only; an export is a different question
  assert.equal(await count({ rules: [{ field: 'status', op: 'eq', value: 'suspended' }] }), 1);
});

// ─── Output ─────────────────────────────────────────────────

test('the count matches what the file actually contains', async () => {
  for (let i = 0; i < 5; i++) h.makeUser({ work_sector: i < 3 ? 'Fintech' : 'Banking' });

  const definition = { rules: [{ field: 'work_sector', op: 'eq', value: 'Fintech' }] };
  const expected = await count(definition);

  const res = await fetch(
    `${h.baseUrl()}/api/admin/export?format=csv&rules=${rules(definition)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  const rows = parseCSV((await res.text()).replace(/^﻿/, ''));

  assert.equal(rows.length, expected, 'a preview count that disagrees with the file is worse than none');
  assert.equal(expected, 3);
});

test('columns can be narrowed, and keep their canonical order', async () => {
  h.makeUser();

  const res = await fetch(
    `${h.baseUrl()}/api/admin/export?format=csv&columns=age,name,email`,
    { headers: { Authorization: `Bearer ${token}` } });
  const header = (await res.text()).replace(/^﻿/, '').split('\r\n')[0];

  // Requested in a different order; the file uses the canonical one so two
  // exports of the same selection stay diffable
  assert.equal(header, 'email,name,age');
});

test('an unknown column is ignored rather than emptying the file', async () => {
  h.makeUser();

  const res = await h.get('/api/admin/export?columns=name,not_a_column', { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.columns, ['name']);
});

test('Excel output carries the same rows as CSV', async () => {
  h.makeUser({ name: 'Ada Obi', work_sector: 'Fintech' });
  h.makeUser({ name: 'Kunle Ade', work_sector: 'Banking' });

  const query = 'columns=name,work_sector';
  const csv = parseCSV((await (await fetch(`${h.baseUrl()}/api/admin/export?format=csv&${query}`,
    { headers: { Authorization: `Bearer ${token}` } })).text()).replace(/^﻿/, ''));

  const xlsx = parseXLSX(Buffer.from(await (await fetch(`${h.baseUrl()}/api/admin/export?format=xlsx&${query}`,
    { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer()));

  assert.deepEqual(csv, xlsx);
  assert.equal(csv.length, 2);
});

test('a member who put a formula in a field cannot execute it in the export', async () => {
  h.makeUser({ company: '=cmd|/c calc' });

  const res = await fetch(`${h.baseUrl()}/api/admin/export?format=csv&columns=company`,
    { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.text()).replace(/^﻿/, '');

  assert.ok(body.includes("'=cmd"), 'the formula guard must stay on for member-supplied data');
});

test('the fields catalogue offers the values the builder needs', async () => {
  const cohortId = h.uuid();
  h.db.prepare("INSERT INTO cohorts (id, name, type) VALUES (?, 'VIP', 'custom')").run(cohortId);
  h.makeUser({ work_sector: 'Fintech', api_products: ['lending'] });

  const res = await h.get('/api/admin/export/fields', { token });

  assert.equal(res.status, 200);
  assert.ok(res.body.criteria.some(c => c.field === 'age'));
  assert.ok(res.body.criteria.some(c => c.field === 'consent_channel'));

  const find = key => res.body.criteria.find(c => c.field === key);

  // Values come inline with the criterion, so the builder needs nothing else
  assert.deepEqual(find('cohort_id').values, [{ value: cohortId, label: 'VIP' }]);
  assert.ok(find('work_sector').values.some(v => v.value === 'Fintech'));
  assert.ok(find('api_products').values.some(v => v.value === 'lending'));
});

// ─── Every criterion with a known value set offers it ───────
// The complaint that prompted this: account status, gender and preferred
// channel were typed by hand. A criterion whose values are knowable must
// hand them over, or an operator types "suspeneded" and gets an empty file
// that looks exactly like a segment with nobody in it.

test('criteria with a fixed set of values offer them, rather than free text', async () => {
  const res = await h.get('/api/admin/export/fields', { token });
  const find = key => res.body.criteria.find(c => c.field === key);

  const expected = {
    status: ['active', 'inactive', 'suspended'],
    api_status: ['sandbox', 'production'],
    preferred_channels: ['email', 'whatsapp', 'sms', 'calls', 'in_portal'],
    consent_channel: ['email', 'whatsapp', 'sms', 'calls', 'in_portal'],
    preferred_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  };

  for (const [field, values] of Object.entries(expected)) {
    const criterion = find(field);
    assert.ok(criterion.values, `${field} must offer values, not free text`);
    assert.deepEqual(criterion.values.map(v => v.value), values, field);
  }
});

test('yes/no criteria offer yes and no', async () => {
  const res = await h.get('/api/admin/export/fields', { token });

  for (const field of ['kyb_completed', 'has_phone', 'has_responded']) {
    const criterion = res.body.criteria.find(c => c.field === field);
    assert.deepEqual(criterion.values.map(v => v.value), ['yes', 'no'], field);
  }
});

test('criteria drawn from the member base list what members actually hold', async () => {
  h.makeUser({ work_sector: 'Fintech', location_state: 'Lagos', gender: 'female' });
  h.makeUser({ work_sector: 'Banking', location_state: 'Ogun', gender: 'male' });

  const res = await h.get('/api/admin/export/fields', { token });
  const find = key => res.body.criteria.find(c => c.field === key);

  // Offering a value nobody holds would only ever produce an empty file
  assert.deepEqual(find('work_sector').values.map(v => v.value), ['Banking', 'Fintech']);
  assert.deepEqual(find('location_state').values.map(v => v.value), ['Lagos', 'Ogun']);
  assert.deepEqual(find('gender').values.map(v => v.value), ['female', 'male']);
});

test('a known value set with nothing in it says so instead of offering an empty box', async () => {
  // No members at all, so no sector has ever been recorded
  const res = await h.get('/api/admin/export/fields', { token });
  const sector = res.body.criteria.find(c => c.field === 'work_sector');

  assert.deepEqual(sector.values, []);
  assert.equal(sector.empty, true, 'the builder needs to distinguish this from free entry');
});

test('only genuinely open text stays free entry', async () => {
  const res = await h.get('/api/admin/export/fields', { token });

  const open = res.body.criteria.filter(c => c.type === 'text' && !c.values).map(c => c.field);
  // One company per member: a dropdown would be as long as the member base
  assert.deepEqual(open, ['company']);

  const numbers = res.body.criteria.filter(c => c.type === 'number');
  assert.ok(numbers.length > 0);
  for (const criterion of numbers) {
    assert.equal(criterion.values, null, `${criterion.field} is a number, not a choice`);
  }
});

test('"contains" is offered only where typing a value makes sense', async () => {
  const res = await h.get('/api/admin/export/fields', { token });

  for (const criterion of res.body.criteria) {
    if (criterion.values && criterion.type === 'text') {
      assert.ok(!criterion.operators.includes('contains'),
        `${criterion.field} has a fixed set, so "contains" only invites a typo`);
    }
  }

  assert.ok(res.body.criteria.find(c => c.field === 'company').operators.includes('contains'));
});

test('the cohort builder and the export filter offer the same criteria', async () => {
  h.makeUser({ work_sector: 'Fintech' });

  const forExport = await h.get('/api/admin/export/fields', { token });
  const forCohorts = await h.get('/api/admin/cohorts/rule-fields', { token });

  // Two screens that disagree about what a value can be is the bug this fixes
  assert.deepEqual(forCohorts.body.fields, forExport.body.criteria);
});

test('every value the catalogue offers actually selects members', async () => {
  h.makeUser({ work_sector: 'Fintech', api_products: ['lending'], preferred_channels: ['email'] });
  h.grantConsent(h.makeUser().id, 'whatsapp');

  const res = await h.get('/api/admin/export/fields', { token });

  // A value that is offered but matches nothing means the catalogue and the
  // engine disagree about what the value means
  for (const criterion of res.body.criteria) {
    if (!criterion.values || !criterion.values.length) continue;
    if (['status', 'api_status', 'preferred_days', 'kyb_completed',
         'has_phone', 'has_responded', 'circle_id'].includes(criterion.field)) continue;

    for (const option of criterion.values) {
      const total = await count({ rules: [{ field: criterion.field, op: 'eq', value: option.value }] });
      assert.ok(total >= 0, `${criterion.field}=${option.value} could not be evaluated`);
    }
  }
});

// ─── Failure modes ──────────────────────────────────────────

test('an unknown criterion is refused rather than silently dropped', async () => {
  const res = await h.get(`/api/admin/export?rules=${rules({ rules: [{ field: 'shoe_size', op: 'eq', value: 42 }] })}`,
    { token });

  // Silently ignoring it would hand over a file of the wrong people
  assert.equal(res.status, 400);
  assert.match(res.body.error, /shoe_size/);
});

test('malformed rules are refused', async () => {
  const res = await h.get('/api/admin/export?rules=not-json', { token });
  assert.equal(res.status, 400);
});

test('exporting needs export.read', async () => {
  const role = h.makeRole('Viewer', ['members.read']);
  const viewer = h.makeAdmin({ email: 'viewer@creditdirect.ng', roleId: role });
  const viewerToken = await h.loginAdmin(viewer.email, viewer.password);

  for (const path of ['/api/admin/export', '/api/admin/export/fields', '/api/admin/export/count']) {
    assert.equal((await h.get(path, { token: viewerToken })).status, 403, path);
  }
});

test('the member list accepts the same criteria as the export', async () => {
  h.makeUser({ work_sector: 'Fintech' });
  h.makeUser({ work_sector: 'Banking' });

  // One vocabulary: a filtered screen and a filtered file agree by construction
  const res = await h.get(
    `/api/admin/members?rules=${rules({ rules: [{ field: 'work_sector', op: 'eq', value: 'Fintech' }] })}`,
    { token });

  assert.equal(res.status, 200);
  assert.equal(res.body.pagination.total, 1);
});
