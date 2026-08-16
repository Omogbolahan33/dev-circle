const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const cohortRules = require('../../src/services/cohortRules');
const circles = require('../../src/services/circles');

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

// ─── Cohort rule engine ─────────────────────────────────────

test('a rule-based cohort is populated on creation', async () => {
  h.makeUser({ work_sector: 'Fintech', api_status: 'production' });
  h.makeUser({ work_sector: 'Fintech', api_status: 'sandbox' });
  h.makeUser({ work_sector: 'Banking', api_status: 'production' });

  // Previously rules were evaluated only in the browser preview and discarded
  // on save, so this cohort came out empty.
  const res = await h.post('/api/admin/cohorts', {
    name: 'Production Fintech',
    filter_rules: {
      match: 'all',
      rules: [
        { field: 'work_sector', op: 'eq', value: 'Fintech' },
        { field: 'api_status', op: 'eq', value: 'production' }
      ]
    }
  }, { token });

  assert.equal(res.status, 201);
  assert.equal(res.body.sync.added, 1);
});

test('match: any widens the cohort instead of narrowing it', async () => {
  h.makeUser({ work_sector: 'Fintech', api_status: 'sandbox' });
  h.makeUser({ work_sector: 'Banking', api_status: 'production' });
  h.makeUser({ work_sector: 'Lending', api_status: 'sandbox' });

  const res = await h.post('/api/admin/cohorts/preview', {
    filter_rules: {
      match: 'any',
      rules: [
        { field: 'work_sector', op: 'eq', value: 'Fintech' },
        { field: 'api_status', op: 'eq', value: 'production' }
      ]
    }
  }, { token });

  assert.equal(res.body.total, 2);
});

test('JSON array fields match whole values, not substrings', async () => {
  h.makeUser({ api_products: ['lending'] });
  h.makeUser({ api_products: ['lending_beta'] });

  const res = await h.post('/api/admin/cohorts/preview', {
    filter_rules: [{ field: 'api_products', op: 'eq', value: 'lending' }]
  }, { token });

  assert.equal(res.body.total, 1, '"lending" must not match "lending_beta"');
});

test('derived fields work: surveys completed', async () => {
  const active = h.makeUser();
  const quiet = h.makeUser();

  const surveyId = h.uuid();
  h.db.prepare(`INSERT INTO surveys (id, title, questions, status) VALUES (?, 'S', '[]', 'active')`)
    .run(surveyId);
  for (let i = 0; i < 3; i++) {
    h.db.prepare(`
      INSERT INTO survey_responses (id, survey_id, user_id, completed_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(h.uuid(), surveyId, active.id);
  }

  const res = await h.post('/api/admin/cohorts/preview', {
    filter_rules: [{ field: 'surveys_completed', op: 'gte', value: 3 }]
  }, { token });

  assert.equal(res.body.total, 1);
  assert.equal(res.body.members[0].id, active.id);
  assert.notEqual(res.body.members[0].id, quiet.id);
});

test('"is not" keeps members whose value is unset', async () => {
  h.makeUser({ work_sector: 'Fintech' });
  h.makeUser({ work_sector: null });

  const res = await h.post('/api/admin/cohorts/preview', {
    filter_rules: [{ field: 'work_sector', op: 'neq', value: 'Fintech' }]
  }, { token });

  // NULL != 'Fintech' is NULL in SQL, which would silently drop this member
  assert.equal(res.body.total, 1);
});

test('an unknown field is rejected rather than silently ignored', async () => {
  const res = await h.post('/api/admin/cohorts/preview', {
    filter_rules: [{ field: 'shoe_size', op: 'eq', value: '42' }]
  }, { token });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /shoe_size/);
});

test('a cohort cannot be saved with rules the engine cannot evaluate', async () => {
  const res = await h.post('/api/admin/cohorts', {
    name: 'Broken', filter_rules: [{ field: 'engagement_streak', op: 'gte', value: 'many' }]
  }, { token });

  assert.equal(res.status, 400);
  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM cohorts').get().c, 0);
});

test('an auto-sync cohort drops members who no longer qualify', async () => {
  const user = h.makeUser({ api_status: 'sandbox' });

  const created = await h.post('/api/admin/cohorts', {
    name: 'Sandbox', auto_sync: true,
    filter_rules: [{ field: 'api_status', op: 'eq', value: 'sandbox' }]
  }, { token });

  assert.equal(created.body.sync.added, 1);

  h.db.prepare("UPDATE users SET api_status = 'production' WHERE id = ?").run(user.id);
  const resync = await h.post(`/api/admin/cohorts/${created.body.cohort.id}/sync`, {}, { token });

  assert.equal(resync.body.removed, 1);
  assert.equal(resync.body.total, 0);
});

test('a manual cohort keeps hand-added members when its rules are re-run', async () => {
  const sandboxUser = h.makeUser({ api_status: 'sandbox' });
  const productionUser = h.makeUser({ api_status: 'production' });

  const created = await h.post('/api/admin/cohorts', {
    name: 'Sandbox plus a guest', auto_sync: false,
    filter_rules: [{ field: 'api_status', op: 'eq', value: 'sandbox' }]
  }, { token });

  await h.post(`/api/admin/cohorts/${created.body.cohort.id}/members`,
    { user_ids: [productionUser.id] }, { token });

  const resync = await h.post(`/api/admin/cohorts/${created.body.cohort.id}/sync`, {}, { token });
  assert.equal(resync.body.removed, 0, 'a manual addition must not be undone by a sync');

  const members = h.db.prepare('SELECT user_id FROM user_cohorts WHERE cohort_id = ?')
    .all(created.body.cohort.id).map(r => r.user_id);
  assert.ok(members.includes(productionUser.id));
  assert.ok(members.includes(sandboxUser.id));
});

// ─── Circles ────────────────────────────────────────────────

test('a circle is a workspace, so its membership is its own', async () => {
  const inDev = h.makeUser();
  const outsider = h.makeUser();

  // Nothing is drawn from a parent, because there is no parent — circles are
  // peers, and this was the rule that made them read as a feature inside one.
  const merchant = await h.post('/api/admin/circles', { name: 'Merchant Circle' }, { token });
  assert.equal(merchant.status, 201);

  const res = await h.post(`/api/admin/circles/${merchant.body.circle.id}/members`,
    { user_ids: [inDev.id, outsider.id] }, { token });

  assert.equal(res.body.added, 2);
  assert.deepEqual(res.body.rejected, []);
});

test('one account, several workspaces', async () => {
  const user = h.makeUser();
  const merchant = await h.post('/api/admin/circles', { name: 'Merchant Circle' }, { token });
  await h.post(`/api/admin/circles/${merchant.body.circle.id}/members`, { user_ids: [user.id] }, { token });

  const circles = require('../../src/services/circles').forUser(user.id);
  assert.equal(circles.length, 2, 'the same person, in two workspaces');
});

test('leaving one workspace has no bearing on the others', async () => {
  const user = h.makeUser();
  const merchant = await h.post('/api/admin/circles', { name: 'Merchant Circle' }, { token });
  await h.post(`/api/admin/circles/${merchant.body.circle.id}/members`, { user_ids: [user.id] }, { token });

  await h.del(`/api/admin/circles/${merchant.body.circle.id}/members/${user.id}`, { token });

  const circles = require('../../src/services/circles').forUser(user.id);
  assert.equal(circles.length, 1);
  assert.equal(circles[0].id, rootCircle, 'still in the circle they started in');
});

test('a cohort slices one workspace and never reaches into another', async () => {
  const here = h.makeUser({ work_sector: 'Fintech' });

  const merchant = await h.post('/api/admin/circles', { name: 'Merchant Circle' }, { token });
  const there = h.makeUser({ work_sector: 'Fintech' });
  await h.post(`/api/admin/circles/${merchant.body.circle.id}/members`, { user_ids: [there.id] }, { token });
  h.db.prepare('DELETE FROM circle_members WHERE user_id = ? AND circle_id = ?').run(there.id, rootCircle);

  // Made in Dev Circle, so it can only ever hold Dev Circle members
  const cohort = await h.post('/api/admin/cohorts', {
    name: 'Fintech', filter_rules: [{ field: 'work_sector', op: 'eq', value: 'Fintech' }]
  }, { token });

  assert.equal(cohort.body.sync.added, 1, 'the identical member in the other workspace is not in scope');

  const members = h.db.prepare('SELECT user_id FROM user_cohorts WHERE cohort_id = ?')
    .all(cohort.body.cohort.id).map(r => r.user_id);
  assert.deepEqual(members, [here.id]);
});

test('the last remaining circle cannot be archived', async () => {
  // Archiving it would leave nowhere to work
  const res = await h.del(`/api/admin/circles/${rootCircle}`, { token });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /only active circle/);
});

test('a circle can be archived once another exists', async () => {
  const merchant = await h.post('/api/admin/circles', { name: 'Merchant Circle' }, { token });
  const res = await h.del(`/api/admin/circles/${merchant.body.circle.id}`, { token });
  assert.equal(res.status, 200);
});

test('only staff who span circles may create one', async () => {
  const role = h.makeRole('Circle Admin', ['*']);
  const scoped = h.makeAdmin({
    email: 'scoped@creditdirect.ng', roleId: role, global: false, circleId: rootCircle
  });
  const scopedToken = await h.loginAdmin(scoped.email, scoped.password);

  const res = await h.post('/api/admin/circles', { name: 'Unauthorised Circle' }, { token: scopedToken });
  assert.equal(res.status, 403);
});

test('naming a circle you cannot reach is refused, not quietly answered', async () => {
  const merchant = await h.post('/api/admin/circles', { name: 'Merchant Circle' }, { token });

  const role = h.makeRole('Dev Only', ['members.read']);
  const scoped = h.makeAdmin({
    email: 'devonly@creditdirect.ng', roleId: role, global: false, circleId: rootCircle
  });
  const scopedToken = await h.loginAdmin(scoped.email, scoped.password);

  const res = await h.call('GET', '/api/admin/members', {
    token: scopedToken, headers: { 'X-Circle-Id': merchant.body.circle.id }
  });

  // Answering with a different circle's data would be the leak this prevents
  assert.equal(res.status, 403);
  assert.match(res.body.error, /do not have access/);
});

test('a survey belongs to one workspace and is invisible outside it', async () => {
  const inside = h.makeUser();
  const outside = h.makeUser();
  circles.join(inside.id);
  circles.join(outside.id);

  const other = await h.post('/api/admin/circles', { name: 'Merchant Circle' }, { token });
  await h.post(`/api/admin/circles/${other.body.circle.id}/members`, { user_ids: [inside.id] }, { token });
  const sub = other;

  const survey = await h.post('/api/admin/surveys', {
    title: 'Private survey', questions: [{ type: 'text', text: 'thoughts?' }],
    circle_id: sub.body.circle.id, target_type: 'all'
  }, { token });
  await h.put(`/api/admin/surveys/${survey.body.survey.id}`, { status: 'active' }, { token });

  const insideToken = await h.loginUser(inside.email);
  const outsideToken = await h.loginUser(outside.email);

  const seenByInside = await h.get('/api/users/surveys', { token: insideToken });
  const seenByOutside = await h.get('/api/users/surveys', { token: outsideToken });

  assert.equal(seenByInside.body.surveys.length, 1);
  assert.equal(seenByOutside.body.surveys.length, 0);
});
