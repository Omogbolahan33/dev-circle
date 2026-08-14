const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const scheduler = require('../server/services/scheduler');
const circles = require('../server/services/circles');

before(h.start);
after(h.stop);

let token;

beforeEach(async () => {
  h.reset();
  h.makeRootCircle();
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@cd.ng', roleId: role });
  token = await h.loginAdmin(admin.email, admin.password);
});

// Build a UTC timestamp landing on a given WAT weekday and hour
function nextWatSlot(weekday, watHour) {
  const target = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  const when = new Date(Date.now() + 24 * 3600 * 1000);
  while (new Date(when.getTime() + 3600 * 1000).getUTCDay() !== target) {
    when.setUTCDate(when.getUTCDate() + 1);
  }
  when.setUTCHours(watHour - 1, 0, 0, 0);
  return when.toISOString().replace('T', ' ').slice(0, 19);
}

// ─── Availability ───────────────────────────────────────────

test('a session on a day the member did not pick is flagged as unavailable', async () => {
  const free = h.makeUser({ preferred_days: ['Mon', 'Wed'], preferred_time_start: '09:00', preferred_time_end: '17:00' });
  const busy = h.makeUser({ preferred_days: ['Tue'], preferred_time_start: '09:00', preferred_time_end: '17:00' });
  circles.joinRoot(free.id);
  circles.joinRoot(busy.id);

  const res = await h.post('/api/admin/sessions', {
    title: 'Monday review', scheduled_for: nextWatSlot('Mon', 11), target_type: 'all'
  }, { token });

  assert.equal(res.status, 201);
  // Preferred days were stored and read by nothing before scheduling existed
  assert.equal(res.body.preview.available.length, 1);
  assert.equal(res.body.preview.unavailable.length, 1);
  assert.match(res.body.preview.unavailable[0].reason, /Mon/);
});

test('a session outside the member time window is flagged', async () => {
  const user = h.makeUser({ preferred_days: [], preferred_time_start: '09:00', preferred_time_end: '12:00' });
  circles.joinRoot(user.id);

  const res = await h.post('/api/admin/sessions', {
    title: 'Late session', scheduled_for: nextWatSlot('Wed', 20), target_type: 'all'
  }, { token });

  assert.equal(res.body.preview.unavailable.length, 1);
  assert.match(res.body.preview.unavailable[0].reason, /window/);
});

test('a member with no stated availability is treated as available', async () => {
  const user = h.makeUser({ preferred_days: [], preferred_time_start: '00:00', preferred_time_end: '23:59' });
  circles.joinRoot(user.id);

  const res = await h.post('/api/admin/sessions', {
    title: 'Anytime', scheduled_for: nextWatSlot('Sat', 15), target_type: 'all'
  }, { token });

  assert.equal(res.body.preview.available.length, 1);
});

// ─── Dispatch ───────────────────────────────────────────────

test('announcing a session reaches its audience once', async () => {
  const user = h.makeUser();
  circles.joinRoot(user.id);

  const session = await h.post('/api/admin/sessions', {
    title: 'Roadmap', scheduled_for: nextWatSlot('Wed', 11),
    target_type: 'all', channels: ['in_portal']
  }, { token });

  const first = await h.post(`/api/admin/sessions/${session.body.session.id}/announce`, {}, { token });
  assert.equal(first.status, 200);
  assert.equal(first.body.delivered, 1);

  const second = await h.post(`/api/admin/sessions/${session.body.session.id}/announce`, {}, { token });
  assert.equal(second.status, 409, 'announcing twice must not double-notify');

  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ?').get(user.id).c, 1);
});

test('a due reminder fires exactly once however often the scheduler ticks', async () => {
  const user = h.makeUser();
  circles.joinRoot(user.id);

  // 30 minutes out with a 45-minute reminder: the window is already open
  const when = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  await h.post('/api/admin/sessions', {
    title: 'Imminent', scheduled_for: when, target_type: 'all',
    channels: ['in_portal'], reminder_offsets: [45]
  }, { token });

  const first = await scheduler.runDueReminders();
  const second = await scheduler.runDueReminders();

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ?').get(user.id).c, 1);
});

test('a reminder whose window closed long ago is not sent late', async () => {
  const user = h.makeUser();
  circles.joinRoot(user.id);

  // Session is 10 minutes out, reminder was due a day before it — that moment
  // passed hours ago and a late reminder is worse than none
  const when = new Date(Date.now() + 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  await h.post('/api/admin/sessions', {
    title: 'Stale reminder', scheduled_for: when, target_type: 'all',
    channels: ['in_portal'], reminder_offsets: [1440]
  }, { token });

  const fired = await scheduler.runDueReminders();
  assert.equal(fired.length, 0);
});

test('moving a session lets its reminders fire again against the new time', async () => {
  const user = h.makeUser();
  circles.joinRoot(user.id);

  const when = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const session = await h.post('/api/admin/sessions', {
    title: 'Moving target', scheduled_for: when, target_type: 'all',
    channels: ['in_portal'], reminder_offsets: [45]
  }, { token });

  await scheduler.runDueReminders();
  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM session_dispatches').get().c, 1);

  const moved = new Date(Date.now() + 40 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  await h.put(`/api/admin/sessions/${session.body.session.id}`, { scheduled_for: moved }, { token });

  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM session_dispatches').get().c, 0);
  const refired = await scheduler.runDueReminders();
  assert.equal(refired.length, 1);
});

test('cancelling an announced session tells the people who were invited', async () => {
  const user = h.makeUser();
  circles.joinRoot(user.id);

  const session = await h.post('/api/admin/sessions', {
    title: 'Doomed', scheduled_for: nextWatSlot('Wed', 11),
    target_type: 'all', channels: ['in_portal']
  }, { token });
  await h.post(`/api/admin/sessions/${session.body.session.id}/announce`, {}, { token });

  const res = await h.del(`/api/admin/sessions/${session.body.session.id}`, { token });
  assert.equal(res.body.notified, 1);

  const titles = h.db.prepare('SELECT title FROM notifications WHERE user_id = ?').all(user.id)
    .map(r => r.title);
  assert.ok(titles.some(t => t.startsWith('Cancelled:')));
});

test('a session scoped to a sub-circle only reaches that circle', async () => {
  const inside = h.makeUser();
  const outside = h.makeUser();
  circles.joinRoot(inside.id);
  circles.joinRoot(outside.id);

  const sub = await h.post('/api/admin/circles', { name: 'Early Access' }, { token });
  await h.post(`/api/admin/circles/${sub.body.circle.id}/members`, { user_ids: [inside.id] }, { token });

  const session = await h.post('/api/admin/sessions', {
    title: 'Preview', scheduled_for: nextWatSlot('Wed', 11),
    circle_id: sub.body.circle.id, target_type: 'circle',
    target_ids: [sub.body.circle.id], channels: ['in_portal']
  }, { token });

  const announced = await h.post(`/api/admin/sessions/${session.body.session.id}/announce`, {}, { token });
  assert.equal(announced.body.recipients, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ?').get(outside.id).c, 0);
});

test('a member sees their upcoming sessions with clashes flagged', async () => {
  const user = h.makeUser({ password: 'dev-password', preferred_days: ['Mon'] });
  circles.joinRoot(user.id);

  await h.post('/api/admin/sessions', {
    title: 'Thursday thing', scheduled_for: nextWatSlot('Thu', 11), target_type: 'all'
  }, { token });

  const userToken = await h.loginUser(user.email, 'dev-password');
  const res = await h.get('/api/users/sessions', { token: userToken });

  assert.equal(res.body.sessions.length, 1);
  assert.equal(res.body.sessions[0].clashes_with_availability, true);
});

test('an invalid schedule is refused', async () => {
  const res = await h.post('/api/admin/sessions',
    { title: 'Nonsense', scheduled_for: 'next tuesday-ish' }, { token });
  assert.equal(res.status, 400);
});

test('a survey reminder nudges only members who have not responded, once', async () => {
  const pending = h.makeUser();
  const responded = h.makeUser();
  circles.joinRoot(pending.id);
  circles.joinRoot(responded.id);

  const survey = await h.post('/api/admin/surveys', {
    title: 'Docs feedback', questions: [{ type: 'text', text: 'thoughts?' }],
    reminder_after_days: 3, engagement_mode: 'in_portal'
  }, { token });
  const surveyId = survey.body.survey.id;
  await h.put(`/api/admin/surveys/${surveyId}`, { status: 'active' }, { token });

  h.db.prepare(`
    INSERT INTO survey_responses (id, survey_id, user_id, created_at)
    VALUES (?, ?, ?, datetime('now', '-5 days'))
  `).run(h.uuid(), surveyId, pending.id);
  h.db.prepare(`
    INSERT INTO survey_responses (id, survey_id, user_id, created_at, completed_at)
    VALUES (?, ?, ?, datetime('now', '-5 days'), datetime('now', '-4 days'))
  `).run(h.uuid(), surveyId, responded.id);

  const first = await scheduler.runSurveyReminders();
  assert.deepEqual(first, [{ survey: 'Docs feedback', reminded: 1 }]);

  const second = await scheduler.runSurveyReminders();
  assert.deepEqual(second, [], 'a member is nudged once, not on every tick');

  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ?').get(responded.id).c, 0);
});

test('sessions that have finished are closed out', async () => {
  const past = new Date(Date.now() - 3 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  h.db.prepare(`
    INSERT INTO scheduled_sessions (id, title, type, scheduled_for, duration_min, status)
    VALUES (?, 'Done', 'info', ?, 30, 'announced')
  `).run(h.uuid(), past);

  assert.equal(scheduler.closePastSessions(), 1);
  assert.equal(h.db.prepare('SELECT status FROM scheduled_sessions').get().status, 'completed');
});
