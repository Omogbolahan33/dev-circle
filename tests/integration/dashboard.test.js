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
    date_of_birth: '1994-01-01', api_products: ['lending', 'payments'], kyb_completed: 1
  });
  h.makeUser({
    work_sector: '', location_state: null, gender: null,
    date_of_birth: null, api_products: [], kyb_completed: 0
  });

  const res = await h.get('/api/admin/demography', { token });
  assert.equal(res.status, 200, res.body?.error || JSON.stringify(res.body));
  assert.equal(res.body.total, 2);
  assert.ok(res.body.work_sector.some(r => r.label === 'Fintech'));
  assert.ok(res.body.age_band.some(r => r.label === '25–34' || r.label === 'Under 25' || r.label === 'Unspecified'));
  assert.ok(res.body.api_products.some(r => r.label === 'lending'));
  assert.ok(res.body.kyb.some(r => r.label === 'Completed'));
  assert.ok(res.body.engagement_depth.some(r => r.label === 'Never responded'));
  assert.equal(Number(res.body.data_coverage.no_date_of_birth), 1);
});

test('the dashboard headlines load', async () => {
  h.makeUser();
  const res = await h.get('/api/admin/dashboard', { token });
  assert.equal(res.status, 200, res.body?.error || JSON.stringify(res.body));
  assert.equal(res.body.stats.total_members, 1);
  assert.ok(Number.isInteger(res.body.stats.new_this_week));
});
