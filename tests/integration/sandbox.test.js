const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

before(h.start);
after(h.stop);

let superToken;
let plainToken;

beforeEach(async () => {
  h.reset();
  h.makeRootCircle();

  const superRole = h.makeRole('Super Admin', ['*']);
  // Everything an admin normally holds, minus the sandbox
  const plainRole = h.makeRole('Admin', ['members.read', 'members.write', 'surveys.read', 'surveys.write', 'blasts.send']);

  const boss = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: superRole });
  const plain = h.makeAdmin({ email: 'plain@creditdirect.ng', roleId: plainRole });

  superToken = await h.loginAdmin(boss.email, boss.password);
  plainToken = await h.loginAdmin(plain.email, plain.password);

  await h.post('/api/admin/sandbox/reset', {}, { token: superToken });
});

const sandbox = opts => ({ ...opts, sandbox: true });

// ─── Who may use it ─────────────────────────────────────────

test('the sandbox needs the sandbox.use permission', async () => {
  const res = await h.get('/api/admin/members', sandbox({ token: plainToken }));

  assert.equal(res.status, 403);
  assert.deepEqual(res.body.required, ['sandbox.use']);
});

test('an anonymous or member caller cannot reach the sandbox', async () => {
  assert.equal((await h.get('/api/admin/members', { sandbox: true })).status, 401);

  const user = h.makeUser();
  const token = await h.loginUser(user.email);
  const res = await h.get('/api/users/profile', sandbox({ token }));

  assert.equal(res.status, 403);
  assert.match(res.body.error, /Credit Direct staff/);
});

test('a request without the header is never sandboxed', async () => {
  const res = await h.get('/api/admin/sandbox', { token: superToken });

  assert.equal(res.status, 200);
  assert.equal(res.body.active, false);
  assert.equal(res.headers.get('x-devcircle-sandbox'), null);
});

// The API docs send the sandbox header on every Try-it-out, including
// GET /health. Liveness must not depend on mirroring a session.
test('health stays up when the sandbox header is on', async () => {
  const withToken = await h.get('/api/health', sandbox({ token: superToken }));
  assert.equal(withToken.status, 200);
  assert.equal(withToken.body.status, 'ok');
  assert.equal(withToken.headers.get('x-devcircle-sandbox'), null);

  const anonymous = await h.get('/api/health', { sandbox: true });
  assert.equal(anonymous.status, 200);
});

// Live Postgres hands Dates and booleans to better-sqlite3. The mirror has
// to reduce them before bind, or every sandboxed request 500s.
test('a Postgres-shaped session can be mirrored into the sqlite sandbox', () => {
  const { mirrorAccess, db } = require('../../src/db/sandbox');
  const admin = h.db.prepare('SELECT * FROM admin_users WHERE email = ?').get('boss@creditdirect.ng');
  const role = h.db.prepare('SELECT * FROM roles WHERE id = ?').get(admin.role_id);
  const session = h.db.prepare('SELECT * FROM sessions WHERE subject_id = ?').get(admin.id);

  assert.doesNotThrow(() => {
    mirrorAccess(db(), {
      admin,
      role: { ...role, is_system: true },
      session: {
        ...session,
        is_admin: true,
        expires_at: new Date(Date.now() + 86400000),
        user_agent: undefined,
        scope: undefined
      }
    });
  });

  const mirrored = db().prepare('SELECT * FROM sessions WHERE token_hash = ?').get(session.token_hash);
  assert.ok(mirrored);
  assert.equal(mirrored.is_admin, 1);
  assert.equal(mirrored.scope, 'full');
});

test('a sandboxed response says so', async () => {
  const res = await h.get('/api/admin/sandbox', sandbox({ token: superToken }));

  assert.equal(res.body.active, true);
  assert.equal(res.headers.get('x-devcircle-sandbox'), 'active');
});

// ─── Isolation, which is the whole point ────────────────────

test('the sandbox comes with people in it, and the live database does not', async () => {
  const inSandbox = await h.get('/api/admin/members', sandbox({ token: superToken }));
  const inLive = await h.get('/api/admin/members', { token: superToken });

  assert.ok(inSandbox.body.members.length >= 5, 'the sandbox is seeded with demo members');
  assert.equal(inLive.body.members.length, 0, 'the live database is untouched by seeding');
});

test('creating in the sandbox leaves no trace in the live database', async () => {
  const created = await h.post('/api/admin/surveys', {
    title: 'Only in the sandbox',
    questions: [{ type: 'rating', text: 'How is it?' }]
  }, sandbox({ token: superToken }));

  assert.equal(created.status, 201);

  const live = h.db.prepare('SELECT COUNT(*) as c FROM surveys').get().c;
  assert.equal(live, 0, 'a sandbox write must not reach the live database');

  const listed = await h.get('/api/admin/surveys', sandbox({ token: superToken }));
  assert.ok(listed.body.surveys.some(s => s.id === created.body.survey.id), 'but it persists in the sandbox');
});

test('creating in the live database leaves no trace in the sandbox', async () => {
  const created = await h.post('/api/admin/surveys', {
    title: 'Only in production',
    questions: [{ type: 'rating', text: 'How is it?' }]
  }, { token: superToken });

  assert.equal(created.status, 201);

  const inSandbox = await h.get('/api/admin/surveys', sandbox({ token: superToken }));
  assert.equal(inSandbox.body.surveys.some(s => s.title === 'Only in production'), false);
});

test('deleting in the sandbox cannot delete anything real', async () => {
  const cohort = await h.post('/api/admin/cohorts', { name: 'Real cohort' }, { token: superToken });
  assert.equal(cohort.status, 201);

  // The same id does not exist in the sandbox, so the destructive call finds
  // nothing — and the real row is still there afterwards
  const attempt = await h.del(`/api/admin/cohorts/${cohort.body.cohort.id}`, sandbox({ token: superToken }));
  assert.equal(attempt.status, 404);

  const stillThere = h.db.prepare('SELECT COUNT(*) as c FROM cohorts WHERE id = ?').get(cohort.body.cohort.id).c;
  assert.equal(stillThere, 1);
});

// The notification and engagement writers used to hold statements prepared at
// module load, which belong to whichever database existed then. That made every
// sandbox message and every sandbox engagement event land in the live database.
test('messages and engagement raised in the sandbox are written to the sandbox', async () => {
  const members = await h.get('/api/admin/members', sandbox({ token: superToken }));
  const recipient = members.body.members[0];

  const blast = await h.post('/api/admin/blasts', {
    subject: 'Sandbox blast', content: 'Nobody should receive this.',
    channel: 'email', target_type: 'all'
  }, sandbox({ token: superToken }));

  const sent = await h.post(`/api/admin/blasts/${blast.body.blast.id}/send`, {}, sandbox({ token: superToken }));
  assert.equal(sent.status, 200);
  assert.ok(sent.body.recipient_count > 0, 'the sandbox has an audience to send to');

  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM message_deliveries').get().c, 0,
    'not one delivery row may reach the live database');
  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM notifications').get().c, 0,
    'nor one notification');
  assert.equal(h.db.prepare("SELECT COUNT(*) as c FROM engagement_history WHERE type = 'message_sent'").get().c, 0,
    'nor one engagement event');

  const member = await h.get(`/api/admin/members/${recipient.id}`, sandbox({ token: superToken }));
  assert.ok(member.body.deliveries.length > 0, 'the sandbox recorded them instead');
});

test('nothing is dispatched to a provider from the sandbox', async () => {
  const blast = await h.post('/api/admin/blasts', {
    subject: 'Sandbox blast', content: 'Nobody should receive this.',
    channel: 'email', target_type: 'all'
  }, sandbox({ token: superToken }));

  await h.post(`/api/admin/blasts/${blast.body.blast.id}/send`, {}, sandbox({ token: superToken }));

  const deliveries = await h.get(`/api/admin/blasts/${blast.body.blast.id}/deliveries`, sandbox({ token: superToken }));
  const external = deliveries.body.deliveries.filter(d => d.channel !== 'in_portal');

  assert.ok(external.length, 'the demo members consent to email, so there is something to check');
  for (const delivery of external) {
    assert.notEqual(delivery.status, 'sent', 'an external channel must never report a real send');
  }
  assert.ok(external.some(d => d.status === 'simulated' && /Sandbox/.test(d.reason || '')),
    'and the reason says why');
});

// ─── It is still the real API ───────────────────────────────

test('permissions are enforced inside the sandbox exactly as outside', async () => {
  const role = h.makeRole('Sandbox viewer', ['sandbox.use', 'members.read']);
  const viewer = h.makeAdmin({ email: 'viewer@creditdirect.ng', roleId: role });
  const token = await h.loginAdmin(viewer.email, viewer.password);

  assert.equal((await h.get('/api/admin/members', sandbox({ token }))).status, 200);

  const denied = await h.post('/api/admin/surveys',
    { title: 'x', questions: [] }, sandbox({ token }));
  assert.equal(denied.status, 403, 'the sandbox is not a way around a permission');
});

test('validation and conflicts behave the same, because it is the same code', async () => {
  const bad = await h.post('/api/admin/surveys', { title: 'No questions' }, sandbox({ token: superToken }));
  assert.equal(bad.status, 400, 'a bad request is still a bad request');

  const blast = await h.post('/api/admin/blasts', {
    content: 'Once only.', channel: 'in_portal', target_type: 'all'
  }, sandbox({ token: superToken }));

  assert.equal((await h.post(`/api/admin/blasts/${blast.body.blast.id}/send`, {}, sandbox({ token: superToken }))).status, 200);

  const again = await h.post(`/api/admin/blasts/${blast.body.blast.id}/send`, {}, sandbox({ token: superToken }));
  assert.equal(again.status, 409, 'and a conflict is still a conflict');
});

test('a live session works in the sandbox without signing in again', async () => {
  const me = await h.get('/api/auth/me', sandbox({ token: superToken }));

  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'boss@creditdirect.ng');
  assert.deepEqual(me.body.permissions, ['*'], 'same account, same role, different data');
});

test('a role change takes effect in the sandbox on the next request', async () => {
  const narrow = h.makeRole('Narrowed', ['sandbox.use', 'members.read']);
  const colleague = h.makeAdmin({ email: 'ada@creditdirect.ng', roleId: narrow });
  const token = await h.loginAdmin(colleague.email, colleague.password);

  assert.equal((await h.get('/api/admin/members', sandbox({ token }))).status, 200);

  // Widen the role in the live database; the sandbox mirror must follow
  const wide = h.db.prepare("SELECT id FROM roles WHERE name = 'Super Admin'").get().id;
  h.db.prepare('UPDATE roles SET permissions = ? WHERE id = ?')
    .run(JSON.stringify(['sandbox.use', 'members.read', 'surveys.write']), narrow);
  assert.ok(wide);

  const now = await h.post('/api/admin/surveys',
    { title: 'Now allowed', questions: [] }, sandbox({ token }));
  assert.equal(now.status, 201, 'the mirrored role must reflect the live one');
});

// ─── Lifecycle ──────────────────────────────────────────────

test('resetting throws away what was created and restores the demo data', async () => {
  const created = await h.post('/api/admin/surveys', {
    title: 'Will not survive', questions: [{ type: 'rating', text: 'How is it?' }]
  }, sandbox({ token: superToken }));
  assert.equal(created.status, 201);

  const reset = await h.post('/api/admin/sandbox/reset', {}, sandbox({ token: superToken }));
  assert.equal(reset.status, 200);
  assert.ok(reset.body.counts.users >= 5, 'the demo data comes back');

  const after = await h.get('/api/admin/surveys', sandbox({ token: superToken }));
  assert.equal(after.body.surveys.some(s => s.id === created.body.survey.id), false);
});

test('a reset sent against live data still resets the sandbox, and only the sandbox', async () => {
  h.makeUser();
  const before = h.db.prepare('SELECT COUNT(*) as c FROM users').get().c;

  const reset = await h.post('/api/admin/sandbox/reset', {}, { token: superToken });
  assert.equal(reset.status, 200);

  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM users').get().c, before,
    'the live member base must be untouched by a sandbox reset');
  assert.ok(reset.body.counts.users >= 5);
});

test('resetting needs the sandbox permission', async () => {
  const res = await h.post('/api/admin/sandbox/reset', {}, { token: plainToken });
  assert.equal(res.status, 403);
});

test('status reports what is in the sandbox', async () => {
  const { body } = await h.get('/api/admin/sandbox', sandbox({ token: superToken }));

  assert.equal(body.enabled, true);
  assert.equal(body.header, 'X-Devcircle-Sandbox');
  assert.ok(body.counts.users >= 5);
  assert.ok(body.counts.surveys >= 1);
  assert.ok(body.seeded_at, 'it says when the data was built');
});
