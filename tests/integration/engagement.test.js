const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const notifications = require('../../src/services/notifications');
const engagement = require('../../src/services/engagement');

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

// Outbound engagement only. Sign-in codes also leave a delivery row, but they
// are transactional and deliberately ignore consent and quiet hours, so they
// would only muddy assertions about who agreed to hear from us.
function deliveriesFor(userId) {
  return h.db.prepare(`
    SELECT channel, status, reason FROM message_deliveries
    WHERE user_id = ? AND source_type != 'system'
  `).all(userId);
}

// ─── Consent ────────────────────────────────────────────────

test('a blast never goes out on a channel the member did not consent to', async () => {
  const consented = h.makeUser();
  const notConsented = h.makeUser();
  h.grantConsent(consented.id, 'email');

  const blast = await h.post('/api/admin/blasts', {
    subject: 'Hello', content: 'body', channel: 'email', target_type: 'all'
  }, { token });
  await h.post(`/api/admin/blasts/${blast.body.blast.id}/send`, {}, { token });

  const sentToConsented = deliveriesFor(consented.id)
    .find(d => d.channel === 'email' && ['sent', 'simulated'].includes(d.status));
  const sentToOther = deliveriesFor(notConsented.id)
    .find(d => d.channel === 'email' && ['sent', 'simulated'].includes(d.status));

  assert.ok(sentToConsented, 'the consenting member should receive it');
  assert.equal(sentToOther, undefined, 'the non-consenting member must not');

  const skip = deliveriesFor(notConsented.id).find(d => d.channel === 'email');
  assert.equal(skip.status, 'skipped');
  assert.match(skip.reason, /consent/i);
});

test('withdrawing consent stops the next send on that channel', async () => {
  const user = h.makeUser();
  h.grantConsent(user.id, 'email');
  const userToken = await h.loginUser(user.email);

  await h.del('/api/users/consent/email', { token: userToken });

  const blast = await h.post('/api/admin/blasts', {
    content: 'body', channel: 'email', target_type: 'all'
  }, { token });
  await h.post(`/api/admin/blasts/${blast.body.blast.id}/send`, {}, { token });

  const email = deliveriesFor(user.id).find(d => d.channel === 'email');
  assert.equal(email.status, 'skipped');
});

test('withdrawing consent also cancels anything already queued on that channel', async () => {
  const user = h.makeUser();
  h.grantConsent(user.id, 'sms');
  const userToken = await h.loginUser(user.email);

  h.db.prepare(`
    INSERT INTO message_deliveries (id, source_type, source_id, user_id, channel, status, reason)
    VALUES (?, 'blast', 'x', ?, 'sms', 'queued', 'quiet_hours')
  `).run(h.uuid(), user.id);

  await h.del('/api/users/consent/sms', { token: userToken });

  const row = h.db.prepare("SELECT status FROM message_deliveries WHERE user_id = ? AND channel = 'sms'")
    .get(user.id);
  assert.equal(row.status, 'skipped');
});

test('the in-portal inbox needs no consent, since it is a pull channel', async () => {
  const user = h.makeUser();

  const blast = await h.post('/api/admin/blasts', {
    subject: 'Notice', content: 'body', channel: 'in_portal', target_type: 'all'
  }, { token });
  await h.post(`/api/admin/blasts/${blast.body.blast.id}/send`, {}, { token });

  const inbox = h.db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ?').get(user.id).c;
  assert.equal(inbox, 1);
});

test('a preferred-channel list narrows delivery within what was consented', async () => {
  const user = h.makeUser({ preferred_channels: ['email'] });
  h.grantConsent(user.id, 'email');
  h.grantConsent(user.id, 'whatsapp');

  const blast = await h.post('/api/admin/blasts', {
    content: 'body', channel: 'whatsapp', target_type: 'all'
  }, { token });
  await h.post(`/api/admin/blasts/${blast.body.blast.id}/send`, {}, { token });

  const whatsapp = deliveriesFor(user.id).find(d => d.channel === 'whatsapp');
  assert.equal(whatsapp.status, 'skipped');
  assert.match(whatsapp.reason, /preferred/i);
});

// ─── Notification preferences ───────────────────────────────

test('turning a category off stops those messages', async () => {
  const user = h.makeUser();
  h.grantConsent(user.id, 'email');
  const userToken = await h.loginUser(user.email);

  await h.put('/api/users/notification-preferences',
    { categories: { survey_invites: false } }, { token: userToken });

  const fresh = h.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const { allowed } = notifications.resolveChannels(fresh, ['in_portal', 'email'], 'survey_invites');
  assert.deepEqual(allowed, []);
});

test('a mandatory category cannot be switched off', async () => {
  const user = h.makeUser();
  const userToken = await h.loginUser(user.email);

  const res = await h.put('/api/users/notification-preferences',
    { categories: { feedback_updates: false } }, { token: userToken });

  const category = res.body.categories.find(c => c.key === 'feedback_updates');
  assert.equal(category.enabled, true);
  assert.equal(category.locked, true);
});

test('an unknown category is rejected', async () => {
  const user = h.makeUser();
  const userToken = await h.loginUser(user.email);

  const res = await h.put('/api/users/notification-preferences',
    { categories: { spam_me: true } }, { token: userToken });
  assert.equal(res.status, 400);
});

test('quiet hours defer a send rather than dropping it', () => {
  // A window covering the whole day, so the assertion does not depend on
  // what time the suite happens to run
  const user = h.makeUser({ preferred_channels: [] });
  h.grantConsent(user.id, 'email');

  h.db.prepare("UPDATE users SET quiet_hours_start = '00:00', quiet_hours_end = '23:59' WHERE id = ?")
    .run(user.id);
  const fresh = h.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);

  assert.equal(notifications.inQuietHours(fresh), true);

  const { allowed, skipped } = notifications.resolveChannels(fresh, ['in_portal', 'email'], 'platform_updates');
  assert.deepEqual(allowed, ['in_portal'], 'the inbox is never held back');
  assert.equal(skipped.find(s => s.channel === 'email').deferred, true);
});

// ─── Engagement history ─────────────────────────────────────

test('a blast is recorded as a message, not as a survey invitation', async () => {
  const user = h.makeUser();

  const blast = await h.post('/api/admin/blasts', {
    content: 'body', channel: 'in_portal', target_type: 'all'
  }, { token });
  await h.post(`/api/admin/blasts/${blast.body.blast.id}/send`, {}, { token });

  const types = h.db.prepare('SELECT type FROM engagement_history WHERE user_id = ?')
    .all(user.id).map(r => r.type);

  assert.ok(types.includes('message_sent'));
  assert.ok(!types.includes('survey_invited'), 'blasts used to corrupt history as survey invitations');
});

// ─── Streaks ────────────────────────────────────────────────

test('a streak counts a day once, however many actions it holds', () => {
  const user = h.makeUser();

  engagement.record(user.id, 'survey_completed');
  engagement.record(user.id, 'feedback_submitted');
  engagement.record(user.id, 'gift_claimed');

  const row = h.db.prepare('SELECT engagement_streak FROM users WHERE id = ?').get(user.id);
  assert.equal(row.engagement_streak, 1);
});

test('a streak advances on a later day', () => {
  const user = h.makeUser();

  engagement.record(user.id, 'survey_completed');
  h.db.prepare("UPDATE users SET last_engagement_at = datetime('now', '-2 days') WHERE id = ?").run(user.id);
  engagement.record(user.id, 'survey_completed');

  const row = h.db.prepare('SELECT engagement_streak, best_streak FROM users WHERE id = ?').get(user.id);
  assert.equal(row.engagement_streak, 2);
  assert.equal(row.best_streak, 2);
});

test('a lapsed streak resets instead of climbing forever', () => {
  const user = h.makeUser({ engagement_streak: 9 });
  h.db.prepare("UPDATE users SET last_engagement_at = datetime('now', '-90 days'), best_streak = 9 WHERE id = ?")
    .run(user.id);

  engagement.record(user.id, 'survey_completed');

  const row = h.db.prepare('SELECT engagement_streak, best_streak FROM users WHERE id = ?').get(user.id);
  assert.equal(row.engagement_streak, 1, 'the streak restarts after a long gap');
  assert.equal(row.best_streak, 9, 'the personal best is kept');
});

test('a stale streak is zeroed when the member next looks at their profile', async () => {
  const user = h.makeUser({ engagement_streak: 7 });
  h.db.prepare("UPDATE users SET last_engagement_at = datetime('now', '-120 days') WHERE id = ?").run(user.id);

  const userToken = await h.loginUser(user.email);
  const res = await h.get('/api/users/profile', { token: userToken });

  assert.equal(res.body.stats.streak, 0);
});

// ─── Gifts ──────────────────────────────────────────────────

function makeGift({ minSurveys = 0, minStreak = 0, stock = null } = {}) {
  const id = h.uuid();
  h.db.prepare(`
    INSERT INTO gifts (id, name, value, currency, target_cohort_ids, stock,
                       min_surveys_completed, min_streak, active)
    VALUES (?, 'Airtime', 5000, 'NGN', '[]', ?, ?, ?, 1)
  `).run(id, stock, minSurveys, minStreak);
  return id;
}

test('a gift below the requirement is listed as locked with the reason', async () => {
  const user = h.makeUser();
  makeGift({ minSurveys: 2 });
  const userToken = await h.loginUser(user.email);

  const res = await h.get('/api/users/gifts', { token: userToken });
  assert.equal(res.body.available.length, 0);
  assert.equal(res.body.locked.length, 1);
  assert.match(res.body.locked[0].requirements[0], /2 more survey/);
});

test('claiming a locked gift is refused', async () => {
  const user = h.makeUser();
  const giftId = makeGift({ minStreak: 5 });
  const userToken = await h.loginUser(user.email);

  const res = await h.post(`/api/users/gifts/${giftId}/claim`, {}, { token: userToken });
  assert.equal(res.status, 403);
});

test('a gift can only be claimed once', async () => {
  const user = h.makeUser();
  const giftId = makeGift();
  const userToken = await h.loginUser(user.email);

  const first = await h.post(`/api/users/gifts/${giftId}/claim`, {}, { token: userToken });
  const second = await h.post(`/api/users/gifts/${giftId}/claim`, {}, { token: userToken });

  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM user_gifts').get().c, 1);
});

test('a claim is written to the ledger and to engagement history', async () => {
  const user = h.makeUser();
  const giftId = makeGift();
  const userToken = await h.loginUser(user.email);

  await h.post(`/api/users/gifts/${giftId}/claim`, {}, { token: userToken });

  // The claim used to be a toast in the browser with no server call at all
  const claim = h.db.prepare('SELECT * FROM user_gifts WHERE user_id = ? AND gift_id = ?')
    .get(user.id, giftId);
  assert.ok(claim);

  const logged = h.db.prepare("SELECT COUNT(*) as c FROM engagement_history WHERE user_id = ? AND type = 'gift_claimed'")
    .get(user.id).c;
  assert.equal(logged, 1);
});

test('a gift out of stock cannot be claimed', async () => {
  const first = h.makeUser();
  const second = h.makeUser();
  const giftId = makeGift({ stock: 1 });

  const firstToken = await h.loginUser(first.email);
  const secondToken = await h.loginUser(second.email);

  assert.equal((await h.post(`/api/users/gifts/${giftId}/claim`, {}, { token: firstToken })).status, 201);
  assert.equal((await h.post(`/api/users/gifts/${giftId}/claim`, {}, { token: secondToken })).status, 409);
});

test('a gift targeted at a cohort is invisible to everyone else', async () => {
  const member = h.makeUser();
  const outsider = h.makeUser();

  const cohortId = h.uuid();
  h.db.prepare("INSERT INTO cohorts (id, name, type) VALUES (?, 'VIP', 'custom')").run(cohortId);
  h.db.prepare('INSERT INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)').run(member.id, cohortId);

  const giftId = h.uuid();
  h.db.prepare(`
    INSERT INTO gifts (id, name, value, currency, target_cohort_ids, active)
    VALUES (?, 'VIP gift', 1000, 'NGN', ?, 1)
  `).run(giftId, JSON.stringify([cohortId]));

  const memberToken = await h.loginUser(member.email);
  const outsiderToken = await h.loginUser(outsider.email);

  assert.equal((await h.get('/api/users/gifts', { token: memberToken })).body.available.length, 1);
  assert.equal((await h.get('/api/users/gifts', { token: outsiderToken })).body.available.length, 0);

  const refused = await h.post(`/api/users/gifts/${giftId}/claim`, {}, { token: outsiderToken });
  assert.equal(refused.status, 403);
});
