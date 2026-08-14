const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const cohortRules = require('../server/services/cohortRules');
const circles = require('../server/services/circles');

before(h.start);
after(h.stop);

let token;
let rootCircle;

beforeEach(async () => {
  h.reset();
  rootCircle = h.makeRootCircle();
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@cd.ng', roleId: role });
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

test('a sub-circle can only draw members from its parent', async () => {
  const inRoot = h.makeUser();
  const outsider = h.makeUser();

  circles.joinRoot(inRoot.id); // outsider deliberately left out

  const sub = await h.post('/api/admin/circles', { name: 'Lending Partners' }, { token });
  assert.equal(sub.status, 201);

  const res = await h.post(`/api/admin/circles/${sub.body.circle.id}/members`,
    { user_ids: [inRoot.id, outsider.id] }, { token });

  assert.equal(res.body.added, 1);
  assert.equal(res.body.rejected.length, 1);
  assert.match(res.body.rejected[0].reason, /parent circle/);
});

test('a cohort in a sub-circle cannot reach outside that circle', async () => {
  const inner = h.makeUser({ work_sector: 'Fintech' });
  const outer = h.makeUser({ work_sector: 'Fintech' });
  circles.joinRoot(inner.id);
  circles.joinRoot(outer.id);

  const sub = await h.post('/api/admin/circles', { name: 'Inner' }, { token });
  await h.post(`/api/admin/circles/${sub.body.circle.id}/members`, { user_ids: [inner.id] }, { token });

  const cohort = await h.post('/api/admin/cohorts', {
    name: 'Fintech in Inner',
    circle_id: sub.body.circle.id,
    filter_rules: [{ field: 'work_sector', op: 'eq', value: 'Fintech' }]
  }, { token });

  // Both members match the rule; only the one inside the circle may join
  assert.equal(cohort.body.sync.added, 1);
});

test('removing someone from a circle removes them from its sub-circles too', async () => {
  const user = h.makeUser();
  circles.joinRoot(user.id);

  const sub = await h.post('/api/admin/circles', { name: 'Nested' }, { token });
  await h.post(`/api/admin/circles/${sub.body.circle.id}/members`, { user_ids: [user.id] }, { token });

  await h.del(`/api/admin/circles/${rootCircle}/members/${user.id}`, { token });

  const remaining = h.db.prepare('SELECT COUNT(*) as c FROM circle_members WHERE user_id = ?').get(user.id).c;
  assert.equal(remaining, 0);
});

test('the root circle cannot be archived', async () => {
  const res = await h.del(`/api/admin/circles/${rootCircle}`, { token });
  assert.equal(res.status, 400);
});

test('circles cannot be nested more than one level below the root', async () => {
  const parent = await h.post('/api/admin/circles', { name: 'Parent' }, { token });
  const grandchild = await h.post('/api/admin/circles',
    { name: 'Child', parent_id: parent.body.circle.id }, { token });

  assert.equal(grandchild.status, 400);
  assert.match(grandchild.body.error, /nested/);
});

test('a circle with active sub-circles cannot be archived', async () => {
  const parent = await h.post('/api/admin/circles', { name: 'Parent' }, { token });

  // Inserted directly, since the API refuses to nest this deep
  h.db.prepare(`
    INSERT INTO circles (id, name, slug, parent_id) VALUES (?, 'Child', 'child', ?)
  `).run(h.uuid(), parent.body.circle.id);

  const res = await h.del(`/api/admin/circles/${parent.body.circle.id}`, { token });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /sub-circle/);
});

test('a survey scoped to a sub-circle is invisible to everyone else', async () => {
  const inside = h.makeUser({ password: 'dev-password' });
  const outside = h.makeUser({ password: 'dev-password' });
  circles.joinRoot(inside.id);
  circles.joinRoot(outside.id);

  const sub = await h.post('/api/admin/circles', { name: 'Private' }, { token });
  await h.post(`/api/admin/circles/${sub.body.circle.id}/members`, { user_ids: [inside.id] }, { token });

  const survey = await h.post('/api/admin/surveys', {
    title: 'Private survey', questions: [{ type: 'text', text: 'thoughts?' }],
    circle_id: sub.body.circle.id, target_type: 'all'
  }, { token });
  await h.put(`/api/admin/surveys/${survey.body.survey.id}`, { status: 'active' }, { token });

  const insideToken = await h.loginUser(inside.email, 'dev-password');
  const outsideToken = await h.loginUser(outside.email, 'dev-password');

  const seenByInside = await h.get('/api/users/surveys', { token: insideToken });
  const seenByOutside = await h.get('/api/users/surveys', { token: outsideToken });

  assert.equal(seenByInside.body.surveys.length, 1);
  assert.equal(seenByOutside.body.surveys.length, 0);
});
