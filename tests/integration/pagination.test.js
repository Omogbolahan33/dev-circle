const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const engagementService = require('../../src/services/engagement');

before(h.start);
after(h.stop);

beforeEach(() => {
  h.reset();
  h.makeRootCircle();
});

// ─── Paging the lists that only grow ────────────────────────
// A member's history, their feedback, their inbox and the inbound event log
// have one thing in common: nothing deletes from them. Each used to take a
// `limit` and nothing else, so the cap was not the size of a page — it was the
// end of what existed as far as any caller could tell. These tests are about
// the row past the cap being reachable rather than gone.

async function giveHistory(userId, count) {
  for (let i = 0; i < count; i++) {
    await engagementService.log(userId, 'survey_completed', { metadata: { n: i } });
  }
}

test('a member can walk past the first page of their own history', async () => {
  const user = h.makeUser({ email: 'ada@example.ng' });
  await giveHistory(user.id, 12);
  const token = await h.loginUser(user.email);

  const first = await h.get('/api/users/engagement?limit=5&page=1', { token });
  assert.equal(first.status, 200);
  assert.equal(first.body.history.length, 5);
  assert.equal(first.body.pagination.total, 12);
  assert.equal(first.body.pagination.pages, 3);
  assert.equal(first.body.pagination.has_more, true);

  const last = await h.get('/api/users/engagement?limit=5&page=3', { token });
  assert.equal(last.body.history.length, 2, 'the tail page is short, not empty');
  assert.equal(last.body.pagination.has_more, false, 'and says it is the end');
});

test('walking the pages sees every event exactly once', async () => {
  // The bug this guards is the one paginate() already carried a note about:
  // an offset computed from the requested limit rather than the clamped one
  // skips or repeats whole blocks of rows.
  const user = h.makeUser({ email: 'ada@example.ng' });
  await giveHistory(user.id, 25);
  const token = await h.loginUser(user.email);

  const seen = [];
  for (let page = 1; page <= 4; page++) {
    const res = await h.get(`/api/users/engagement?limit=7&page=${page}`, { token });
    seen.push(...res.body.history.map(e => e.id));
  }

  assert.equal(seen.length, 25, 'every event was returned');
  assert.equal(new Set(seen).size, 25, 'and none of them twice');
});

test('asking for more than the cap is clamped rather than refused', async () => {
  const user = h.makeUser({ email: 'ada@example.ng' });
  await giveHistory(user.id, 3);
  const token = await h.loginUser(user.email);

  const res = await h.get('/api/users/engagement?limit=5000', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.pagination.limit, 200, 'this feed caps at 200, not the usual 100');
});

test('a type filter pages over what it matches, not over everything', async () => {
  const user = h.makeUser({ email: 'ada@example.ng' });
  await giveHistory(user.id, 6);
  await engagementService.log(user.id, 'feedback_submitted', {});
  const token = await h.loginUser(user.email);

  const res = await h.get('/api/users/engagement?type=feedback_submitted&limit=5', { token });
  assert.equal(res.body.history.length, 1);
  assert.equal(res.body.pagination.total, 1,
    'the total is the filtered set — otherwise the button offers a page that is not there');
});

test('an empty history is on no page at all', async () => {
  const user = h.makeUser({ email: 'ada@example.ng' });
  const token = await h.loginUser(user.email);

  const res = await h.get('/api/users/engagement', { token });
  assert.deepEqual(res.body.history, []);
  assert.equal(res.body.pagination.total, 0);
  assert.equal(res.body.pagination.pages, 0, 'zero pages rather than one empty one');
  assert.equal(res.body.pagination.has_more, false);
});

test('a member can walk past the first page of their own feedback', async () => {
  const user = h.makeUser({ email: 'ada@example.ng' });
  const token = await h.loginUser(user.email);

  for (let i = 0; i < 7; i++) {
    await h.post('/api/feedback', { content: `Something about the sandbox, number ${i}` }, { token });
  }

  const first = await h.get('/api/feedback?limit=3&page=1', { token });
  assert.equal(first.body.feedback.length, 3);
  assert.equal(first.body.pagination.total, 7);
  assert.equal(first.body.pagination.has_more, true);

  const third = await h.get('/api/feedback?limit=3&page=3', { token });
  assert.equal(third.body.feedback.length, 1);
  assert.equal(third.body.pagination.has_more, false);
  assert.ok(first.body.categories, 'the category list still comes with every page');
});

test('the inbox pages, and the unread badge counts the whole of it', async () => {
  const user = h.makeUser({ email: 'ada@example.ng' });
  const token = await h.loginUser(user.email);

  // Written straight in: notify() weighs consent, quiet hours and category
  // preferences, none of which this test is about.
  for (let i = 0; i < 9; i++) {
    h.db.prepare(`
      INSERT INTO notifications (id, user_id, category, title, body)
      VALUES (?, ?, 'survey_invites', ?, 'Something happened.')
    `).run(`note-${i}`, user.id, `Notice ${i}`);
  }

  const res = await h.get('/api/users/notifications?limit=4&page=1', { token });
  assert.equal(res.body.notifications.length, 4);
  assert.equal(res.body.pagination.total, 9);
  assert.equal(res.body.unread_count, 9,
    'the badge is about the inbox, not about the page — they are different numbers');
});

test('the inbound event log pages for an administrator', async () => {
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: role });
  const token = await h.loginAdmin(admin.email, admin.password);

  for (let i = 0; i < 8; i++) {
    h.db.prepare(`
      INSERT INTO integration_events (id, source, event_type, payload, processed)
      VALUES (?, 'customer_io', 'first_sandbox_call', '{}', 1)
    `).run(`ev-${i}`);
  }

  const first = await h.get('/api/admin/integration-events?limit=3&page=1', { token });
  assert.equal(first.status, 200);
  assert.equal(first.body.events.length, 3);
  assert.equal(first.body.pagination.total, 8);
  assert.equal(first.body.pagination.has_more, true);

  const last = await h.get('/api/admin/integration-events?limit=3&page=3', { token });
  assert.equal(last.body.events.length, 2);
  assert.equal(last.body.pagination.has_more, false);
});

test('the admin feedback inbox pages, and its source totals do not', async () => {
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: role });
  const adminToken = await h.loginAdmin(admin.email, admin.password);

  const user = h.makeUser({ email: 'ada@example.ng' });
  const userToken = await h.loginUser(user.email);
  for (let i = 0; i < 5; i++) {
    await h.post('/api/feedback', { content: `Raised item number ${i}` }, { token: userToken });
  }

  const res = await h.get('/api/admin/feedback?limit=2&page=1', { token: adminToken });
  assert.equal(res.body.feedback.length, 2);
  assert.equal(res.body.pagination.total, 5);
  assert.equal(res.body.pagination.has_more, true);

  // The chips carry counts for the whole circle; a page of two must not make
  // the filter say there are only two.
  const devCircle = (res.body.sources || []).find(s => s.source === 'dev_circle');
  assert.equal(devCircle && devCircle.count, 5);
});
