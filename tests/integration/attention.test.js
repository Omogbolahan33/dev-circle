const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

before(h.start);
after(h.stop);

let adminToken;
let circleId;

beforeEach(async () => {
  h.reset();
  circleId = h.makeCircle();
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: role });
  adminToken = await h.loginAdmin(admin.email, admin.password);
});

const attention = (token = adminToken, headers) =>
  h.get('/api/admin/attention', { token, headers });

// ─── What is waiting on somebody ────────────────────────────
// The bell in the console. What it reports is work somebody has to *decide* on
// — not a count of members, which is a number rather than a queue.

test('nothing waiting is an empty list, not a zero', async () => {
  const res = await attention();

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, [], 'a queue at zero is left out entirely');
  assert.equal(res.body.total, 0);
});

async function anApplicationWaiting() {
  const form = await h.post('/api/admin/onboarding', {
    name: 'Intake',
    status: 'active',
    questions: [
      { type: 'text', text: 'Name', required: true, format: 'none', maps_to: 'name' },
      { type: 'text', text: 'Email', required: true, format: 'email', maps_to: 'email' },
      { type: 'text', text: 'Phone', required: true, format: 'phone', maps_to: 'phone' }
    ]
  }, { token: adminToken });

  const token = form.body.form.public_token;
  const started = await h.post(`/api/onboarding/${token}/start`, {});
  const ids = Object.fromEntries(started.body.form.questions.map(q => [q.text, q.id]));

  await h.post(`/api/onboarding/${token}/submit`, {
    session_key: started.body.session_key,
    answers: {
      [ids.Name]: 'Ada Obi',
      [ids.Email]: 'ada@zilla.ng',
      [ids.Phone]: '08031112222'
    }
  });

  return form.body.form;
}

test('an onboarding application waiting on a decision is what the bell rings about', async () => {
  await anApplicationWaiting();

  const res = await attention();
  const onboarding = res.body.items.find(i => i.key === 'onboarding');

  assert.ok(onboarding, 'the queue should be reported');
  assert.equal(onboarding.count, 1);
  assert.equal(onboarding.label, 'onboarding application', 'singular for one');
  assert.equal(onboarding.href, '/admin/onboarding-applications.html');
  assert.equal(res.body.total, 1);
});

test('deciding on it clears the bell', async () => {
  await anApplicationWaiting();

  const queue = await h.get('/api/admin/onboarding-applications?status=pending', { token: adminToken });
  await h.post(`/api/admin/onboarding-applications/${queue.body.applications[0].id}/approve`,
    {}, { token: adminToken });

  const res = await attention();
  assert.equal(res.body.total, 0, 'approved is not waiting');
});

test('it counts only the circle being worked in', async () => {
  await anApplicationWaiting();
  const other = h.makeCircle('Lending Circle', 'lending');

  const here = await attention();
  const there = await attention(adminToken, { 'X-Circle-Id': other });

  assert.equal(here.body.total, 1);
  assert.equal(there.body.total, 0, 'another workspace has its own queue and its own bell');
});

test('it reports only what the role could actually act on', async () => {
  await anApplicationWaiting();

  // Somebody who can read feedback and nothing about onboarding. A count they
  // cannot open is a badge they can never clear.
  const roleId = h.makeRole('Feedback only', ['feedback.read']);
  const staff = h.makeAdmin({ email: 'reader@creditdirect.ng', roleId });
  const token = await h.loginAdmin(staff.email, staff.password);

  const res = await attention(token);
  assert.equal(res.status, 200);
  assert.ok(!res.body.items.some(i => i.key === 'onboarding'),
    'the onboarding queue is invisible to a role that cannot open it');
});

test('a role that could act on none of it is refused rather than answered emptily', async () => {
  const roleId = h.makeRole('Members only', ['members.read']);
  const staff = h.makeAdmin({ email: 'members@creditdirect.ng', roleId });
  const token = await h.loginAdmin(staff.email, staff.password);

  assert.equal((await attention(token)).status, 403);
});

test('open feedback is waiting too, and says how many', async () => {
  const user = h.makeUser();
  for (let i = 0; i < 3; i++) {
    h.db.prepare(`
      INSERT INTO feedback (id, user_id, type, content, status, source, circle_id)
      VALUES (?, ?, 'self_initiated', ?, 'open', 'dev_circle', ?)
    `).run(h.uuid(), user.id, `Something ${i}`, circleId);
  }

  const res = await attention();
  const feedback = res.body.items.find(i => i.key === 'feedback');

  assert.equal(feedback.count, 3);
  assert.equal(feedback.label, 'open pieces of feedback', 'plural for three');
});

test('the total is what the bell shows, across every queue', async () => {
  await anApplicationWaiting();
  const user = h.makeUser();
  h.db.prepare(`
    INSERT INTO feedback (id, user_id, type, content, status, source, circle_id)
    VALUES (?, ?, 'self_initiated', 'Hello', 'open', 'dev_circle', ?)
  `).run(h.uuid(), user.id, circleId);

  const res = await attention();
  assert.equal(res.body.total, 2);
  assert.equal(res.body.items.length, 2);
});
