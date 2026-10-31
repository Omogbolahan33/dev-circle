const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

before(h.start);
after(h.stop);

let token;

beforeEach(async () => {
  h.reset();
  h.makeRootCircle();
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: role });
  token = await h.loginAdmin(admin.email, admin.password);
});

test('demography returns every breakdown without error', async () => {
  h.makeUser({
    work_sector: 'Fintech', location_state: 'Lagos', gender: 'female',
    age_group: '25 - 34', products: ['Mobile App', 'Mobile App', 'Yield'],
    segment: 'Multi-Product', employment: 'Entrepreneur', preferred_research: 'User interviews',
    date_of_birth: null, api_products: ['lending', 'payments'], kyb_completed: 1
  });
  h.makeUser({
    work_sector: '', location_state: null, gender: null,
    age_group: null, products: [], segment: null, employment: null, preferred_research: null,
    date_of_birth: null, api_products: [], kyb_completed: 0
  });

  const res = await h.get('/api/admin/demography', { token });
  assert.equal(res.status, 200, res.body?.error || JSON.stringify(res.body));
  assert.equal(res.body.total, 2);
  assert.ok(res.body.work_sector.some(r => r.label === 'Fintech'));
  assert.ok(res.body.age_group.some(r => r.label === '25 - 34'));
  assert.deepEqual(res.body.age_band, res.body.age_group, 'legacy age_band remains an alias of the profile age group');
  assert.ok(res.body.gender.some(r => r.label === 'female'));
  assert.equal(res.body.products.find(r => r.label === 'Mobile App')?.count, 1, 'count each member once per selected product');
  assert.ok(res.body.api_products.some(r => r.label === 'lending'));
  assert.ok(res.body.segment.some(r => r.label === 'Multi-Product'));
  assert.ok(res.body.employment.some(r => r.label === 'Entrepreneur'));
  assert.ok(res.body.preferred_research.some(r => r.label === 'User interviews'));
  assert.ok(res.body.kyb.some(r => r.label === 'Completed'));
  assert.ok(res.body.engagement_depth.some(r => r.label === 'Never responded'));
  assert.equal(Number(res.body.data_coverage.no_age_group), 1);
  assert.equal(Number(res.body.data_coverage.no_gender), 1);
  assert.equal(Number(res.body.data_coverage.no_products), 1);
  assert.equal(Number(res.body.data_coverage.no_api_products), 1);
  assert.equal(Number(res.body.data_coverage.no_segment), 1);
  assert.equal(Number(res.body.data_coverage.no_employment), 1);
  assert.equal(Number(res.body.data_coverage.no_preferred_research), 1);
});

test('the dashboard headlines load', async () => {
  h.makeUser();
  const res = await h.get('/api/admin/dashboard', { token });
  assert.equal(res.status, 200, res.body?.error || JSON.stringify(res.body));
  assert.equal(res.body.stats.total_members, 1);
  assert.ok(Number.isInteger(res.body.stats.new_this_week));
  assert.ok(Array.isArray(res.body.cohort_breakdown));
});

test('the member list loads cohorts in one pass', async () => {
  const user = h.makeUser({ name: 'Ada Obi' });
  const listed = await h.get('/api/admin/members', { token });
  assert.equal(listed.status, 200, listed.body?.error || JSON.stringify(listed.body));
  const row = listed.body.members.find(m => m.id === user.id);
  assert.ok(row);
  assert.ok(Array.isArray(row.cohorts));
  assert.equal(Number(row.surveys_completed), 0);
});
