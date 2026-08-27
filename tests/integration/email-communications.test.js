const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const emailService = require('../../src/services/email');
const loginCodes = require('../../src/services/loginCodes');

before(h.start);
after(h.stop);

let adminToken;
let superRole;

beforeEach(async () => {
  h.reset();
  emailService.clearSimulatedQueue();
  h.makeRootCircle();

  superRole = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'superadmin@creditdirect.ng', roleId: superRole });
  adminToken = await h.loginAdmin(admin.email, admin.password);
});

// ─── Survey Invitations via Email ───────────────────────────

test('survey invite endpoint dispatches email invitation when channel includes email', async () => {
  const user = h.makeUser({ email: 'partner.dev@example.ng', name: 'Partner Dev' });
  h.grantConsent(user.id, 'email');

  // Create an active survey configured for email engagement
  const surveyRes = await h.post('/api/admin/surveys', {
    title: 'Disbursement Webhook Reliability Survey',
    description: 'Help us improve webhook delivery SLAs.',
    status: 'active',
    engagement_mode: 'email',
    target_type: 'all',
    questions: [
      { type: 'rating', text: 'How satisfied are you with webhook latency?' }
    ]
  }, { token: adminToken });

  assert.equal(surveyRes.status, 201);
  const surveyId = surveyRes.body.survey.id;
  emailService.clearSimulatedQueue();

  // Invite audience
  const inviteRes = await h.post(`/api/admin/surveys/${surveyId}/invite`, {}, { token: adminToken });
  assert.equal(inviteRes.status, 200);
  assert.equal(inviteRes.body.invited, 1);

  // Assert email was captured by the emailing interface
  const queue = emailService.getSimulatedQueue();
  const sentEmail = queue.find(m => m.to === 'partner.dev@example.ng');
  assert.ok(sentEmail, 'Survey invitation email must be dispatched');
  assert.equal(sentEmail.category, 'survey_invites');
  assert.ok(sentEmail.subject.includes('Disbursement Webhook Reliability Survey'));
  assert.ok(sentEmail.html.includes('Partner Dev'));
  assert.ok(sentEmail.html.includes(surveyId));

  // Delivery log in DB must reflect delivery attempt
  const delivery = h.db.prepare(
    "SELECT * FROM message_deliveries WHERE user_id = ? AND channel = 'email'"
  ).get(user.id);
  assert.ok(delivery);
  assert.ok(['sent', 'simulated'].includes(delivery.status));
});

test('survey remind endpoint dispatches reminder email', async () => {
  const user = h.makeUser({ email: 'remind.dev@example.ng', name: 'Remind Dev' });
  h.grantConsent(user.id, 'email');

  const surveyRes = await h.post('/api/admin/surveys', {
    title: 'Remindable Survey',
    status: 'active',
    engagement_mode: 'email',
    target_type: 'all',
    questions: [{ type: 'rating', text: 'Any feedback?' }]
  }, { token: adminToken });

  assert.equal(surveyRes.status, 201);
  const surveyId = surveyRes.body.survey.id;

  // First invite
  await h.post(`/api/admin/surveys/${surveyId}/invite`, {}, { token: adminToken });
  emailService.clearSimulatedQueue();

  // Remind
  const remindRes = await h.post(`/api/admin/surveys/${surveyId}/remind`, {}, { token: adminToken });
  assert.equal(remindRes.status, 200);

  const queue = emailService.getSimulatedQueue();
  const sentReminder = queue.find(m => m.to === 'remind.dev@example.ng');
  assert.ok(sentReminder, 'Survey reminder email must be dispatched');
  assert.equal(sentReminder.category, 'survey_reminders');
  assert.ok(sentReminder.subject.includes('Remindable Survey'));
});

// ─── Session Invitations via Email ──────────────────────────

test('session announcement dispatches session invite email', async () => {
  const user = h.makeUser({ email: 'workshop.dev@example.ng' });
  h.grantConsent(user.id, 'email');

  const futureTime = new Date(Date.now() + 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const sessionRes = await h.post('/api/admin/sessions', {
    title: 'API Integration Workshop',
    description: 'Hands-on session building with Credit Direct SDKs',
    scheduled_for: futureTime,
    channels: ['email'],
    target_type: 'all',
    meeting_url: 'https://meet.google.com/test-workshop'
  }, { token: adminToken });

  assert.equal(sessionRes.status, 201);
  const sessionId = sessionRes.body.session.id;
  emailService.clearSimulatedQueue();

  const announceRes = await h.post(`/api/admin/sessions/${sessionId}/announce`, {}, { token: adminToken });
  assert.equal(announceRes.status, 200);

  const queue = emailService.getSimulatedQueue();
  const sentInvite = queue.find(m => m.to === 'workshop.dev@example.ng');
  assert.ok(sentInvite, 'Session invitation email must be dispatched');
  assert.ok(sentInvite.subject.includes('API Integration Workshop'));
});

// ─── Staff Admin Invitations & Password Change ──────────────

test('staff invitation emails colleague with temporary password and forces password change', async () => {
  emailService.clearSimulatedQueue();

  // 1. Invite a new staff administrator
  const inviteRes = await h.post('/api/admin/admins/invite', {
    email: 'newlead@creditdirect.ng',
    name: 'New DevRel Lead',
    role_id: superRole
  }, { token: adminToken });

  assert.equal(inviteRes.status, 201);
  assert.equal(inviteRes.body.invited, true);
  assert.equal(inviteRes.body.admin.must_change_password, 1);

  // 2. Verify invitation email was dispatched
  const queue = emailService.getSimulatedQueue();
  const inviteEmail = queue.find(m => m.to === 'newlead@creditdirect.ng');
  assert.ok(inviteEmail, 'Invitation email must be sent');
  assert.equal(inviteEmail.category, 'staff_invite');
  assert.ok(inviteEmail.html.includes('New DevRel Lead'));
  assert.ok(inviteEmail.html.includes('Temporary Password:'));

  // Extract temporary password from the email
  const tempPasswordMatch = inviteEmail.html.match(/Temporary Password:<\/td>\s*<td[^>]*>([^<]+)<\/td>/i);
  assert.ok(tempPasswordMatch, 'Email must contain temporary password');
  const tempPassword = tempPasswordMatch[1].trim();

  // 3. New staff signs in with temporary password
  const loginRes = await h.post('/api/auth/login', {
    identifier: 'newlead@creditdirect.ng',
    password: tempPassword
  });

  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.body.must_change_password, true);
  const staffToken = loginRes.body.token;

  // 4. Session scope is restricted to password_change
  // Trying to access general admin endpoints must be rejected with 403 must_change_password
  const blockedAccess = await h.get('/api/admin/roles', { token: staffToken });
  assert.equal(blockedAccess.status, 403);
  assert.equal(blockedAccess.body.must_change_password, true);

  // 5. Staff updates their password
  const changeRes = await h.post('/api/auth/password', {
    new_password: 'MyNewSecretPassword456!'
  }, { token: staffToken });

  assert.equal(changeRes.status, 200);
  assert.match(changeRes.body.message, /Password updated/);

  // 6. Session is now upgraded to 'full' scope; admin endpoints succeed
  const allowedAccess = await h.get('/api/admin/roles', { token: staffToken });
  assert.equal(allowedAccess.status, 200);

  // 7. Verification that must_change_password was cleared in the database
  const adminRow = h.db.prepare('SELECT must_change_password FROM admin_users WHERE email = ?')
    .get('newlead@creditdirect.ng');
  assert.equal(adminRow.must_change_password, 0);
});

test('staff reinvite resends invitation with new temporary password', async () => {
  const inviteRes = await h.post('/api/admin/admins/invite', {
    email: 'toreinvite@creditdirect.ng',
    name: 'To Reinvite',
    role_id: superRole
  }, { token: adminToken });

  assert.equal(inviteRes.status, 201);
  const adminId = inviteRes.body.admin.id;
  emailService.clearSimulatedQueue();

  // Reinvite
  const reinviteRes = await h.post(`/api/admin/admins/${adminId}/reinvite`, {}, { token: adminToken });
  assert.equal(reinviteRes.status, 200);
  assert.match(reinviteRes.body.message, /Invitation resent/);

  const queue = emailService.getSimulatedQueue();
  const reinviteEmail = queue.find(m => m.to === 'toreinvite@creditdirect.ng');
  assert.ok(reinviteEmail, 'Reinvitation email must be dispatched');
});

// ─── Sign-in Code via Email ─────────────────────────────────

test('login code deliver dispatches email with verification OTP', async () => {
  const user = h.makeUser({ email: 'codereceiver@example.ng' });
  emailService.clearSimulatedQueue();

  const identity = {
    type: 'email',
    value: 'codereceiver@example.ng',
    channel: 'email',
    audience: 'participant'
  };

  const deliveryResult = await loginCodes.deliver(user, identity, '748291');
  assert.equal(deliveryResult.status, 'simulated');

  const queue = emailService.getSimulatedQueue();
  const otpEmail = queue.find(m => m.to === 'codereceiver@example.ng');
  assert.ok(otpEmail);
  assert.ok(otpEmail.html.includes('748291'));
  assert.ok(otpEmail.subject.includes('748291'));
});
