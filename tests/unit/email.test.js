const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const emailService = require('../../src/services/email');
const { EmailService } = require('../../src/services/email');
const TermiiEmailProvider = require('../../src/services/email/providers/termii');
const SimpuEmailProvider = require('../../src/services/email/providers/simpu');
const CustomerIoEmailProvider = require('../../src/services/email/providers/customerio');
const SimulatedEmailProvider = require('../../src/services/email/providers/simulated');
const { renderTemplate } = require('../../src/services/email/templates');
const { wrapLayout, toPlainText, escapeHtml } = require('../../src/services/email/templates/layout');

beforeEach(() => {
  emailService.clearSimulatedQueue();
});

// ─── Template & Layout Rendering ─────────────────────────────

test('layout escapes special HTML characters to prevent injection', () => {
  assert.equal(escapeHtml('Hello <script>alert("XSS")</script> & "friends"'),
    'Hello &lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt; &amp; &quot;friends&quot;');
});

test('layout wraps content in Credit Direct brand styling', () => {
  const html = wrapLayout({
    title: 'Welcome to Dev Circle',
    previewText: 'Get started integrating Credit Direct APIs',
    contentHtml: '<p>Welcome aboard!</p>',
    actionText: 'Open Portal',
    actionUrl: 'https://devcircle.creditdirect.ng/portal',
    appUrl: 'https://devcircle.creditdirect.ng'
  });

  assert.ok(html.includes('Credit Direct'), 'must feature Credit Direct brand');
  assert.ok(html.includes('Dev Circle'), 'must feature Dev Circle');
  assert.ok(html.includes('#107EBC'), 'uses denim blue primary brand color');
  assert.ok(html.includes('#E6B473'), 'uses harvest gold accent');
  assert.ok(html.includes('Open Portal'), 'contains action button text');
  assert.ok(html.includes('https://devcircle.creditdirect.ng/portal'), 'contains action button URL');
  assert.ok(html.includes('Notification Preferences'), 'contains notification preferences link');
});

test('toPlainText converts message to readable plain text', () => {
  const text = toPlainText({
    title: 'New Survey Available',
    contentText: 'We would love to get your feedback on our Lending API.',
    actionText: 'Take Survey',
    actionUrl: 'https://devcircle.creditdirect.ng/surveys/s1'
  });

  assert.ok(text.includes('CREDIT DIRECT DEV CIRCLE'));
  assert.ok(text.includes('NEW SURVEY AVAILABLE'));
  assert.ok(text.includes('Take Survey: https://devcircle.creditdirect.ng/surveys/s1'));
});

test('renderTemplate supports survey invitation with details', () => {
  const rendered = renderTemplate('survey_invite', {
    surveyTitle: 'Core Lending API v2 Feedback',
    surveyDescription: 'Tell us how the new webhooks are working for you.',
    timeEstimateMin: 4,
    questionCount: 6,
    surveyUrl: 'https://devcircle.creditdirect.ng/surveys/lending-v2',
    recipientName: 'Chidi'
  });

  assert.equal(rendered.subject, "You're invited: Core Lending API v2 Feedback");
  assert.ok(rendered.html.includes('Hello Chidi,'));
  assert.ok(rendered.html.includes('Core Lending API v2 Feedback'));
  assert.ok(rendered.html.includes('~4 minutes'));
  assert.ok(rendered.html.includes('6 questions'));
  assert.ok(rendered.text.includes('Take Survey: https://devcircle.creditdirect.ng/surveys/lending-v2'));
});

test('renderTemplate supports survey reminder', () => {
  const rendered = renderTemplate('survey_reminder', {
    surveyTitle: 'Identity Verification Integration Survey',
    surveyUrl: 'https://devcircle.creditdirect.ng/surveys/id-v1',
    recipientName: 'Ada'
  });

  assert.equal(rendered.subject, 'Reminder: Identity Verification Integration Survey');
  assert.ok(rendered.html.includes('Ada'));
  assert.ok(rendered.html.includes('Identity Verification Integration Survey'));
  assert.ok(rendered.html.includes('Complete Survey'));
});

test('renderTemplate supports staff admin invitation with credentials', () => {
  const rendered = renderTemplate('staff_invite', {
    recipientName: 'Tunde Bakare',
    email: 'tunde.b@creditdirect.ng',
    roleName: 'Community Lead',
    temporaryPassword: 'TempPassword123!',
    invitedByName: 'Adaeze Okonkwo',
    loginUrl: 'https://devcircle.creditdirect.ng/admin/login'
  });

  assert.ok(rendered.subject.includes('invited to Credit Direct Dev Circle'));
  assert.ok(rendered.html.includes('Tunde Bakare'));
  assert.ok(rendered.html.includes('Adaeze Okonkwo'));
  assert.ok(rendered.html.includes('Community Lead'));
  assert.ok(rendered.html.includes('tunde.b@creditdirect.ng'));
  assert.ok(rendered.html.includes('TempPassword123!'));
  assert.ok(rendered.html.includes('temporary handover password'));
  assert.ok(rendered.html.includes('Sign In to Set Password'));
});

test('renderTemplate supports one-time sign-in code (OTP)', () => {
  const rendered = renderTemplate('login_code', {
    code: '849201',
    expiresInMinutes: 10
  });

  assert.equal(rendered.subject, '849201 is your Dev Circle sign-in code');
  assert.ok(rendered.html.includes('849201'));
  assert.ok(rendered.html.includes('10 minutes'));
  assert.ok(rendered.text.includes('CODE: 849201'));
});

test('renderTemplate supports session invitations and reminders', () => {
  const invite = renderTemplate('session_invite', {
    sessionTitle: 'Q3 API Office Hours',
    sessionDescription: 'Discussion on instant disbursement endpoints.',
    sessionTime: 'Thursday, 3:00 PM WAT',
    meetingUrl: 'https://meet.google.com/abc-def-ghi'
  });

  assert.equal(invite.subject, 'Invited: Q3 API Office Hours');
  assert.ok(invite.html.includes('Thursday, 3:00 PM WAT'));
  assert.ok(invite.html.includes('https://meet.google.com/abc-def-ghi'));

  const reminder = renderTemplate('session_reminder', {
    sessionTitle: 'Q3 API Office Hours',
    sessionTime: 'Starting in 15 minutes',
    meetingUrl: 'https://meet.google.com/abc-def-ghi'
  });

  assert.equal(reminder.subject, 'Upcoming: Q3 API Office Hours');
  assert.ok(reminder.html.includes('Starting in 15 minutes'));
});

// ─── Provider Implementations ────────────────────────────────

test('SimulatedEmailProvider captures deliveries in memory', async () => {
  const simulated = new SimulatedEmailProvider();
  assert.equal(simulated.isConfigured(), true);
  assert.equal(simulated.getName(), 'simulated');

  const outcome = await simulated.send({
    to: 'dev@example.ng',
    subject: 'Welcome to Dev Circle',
    html: '<p>Welcome!</p>',
    text: 'Welcome!'
  });

  assert.equal(outcome.status, 'simulated');
  assert.equal(outcome.provider, 'simulated');
  assert.match(outcome.ref, /^sim_/);

  assert.equal(simulated.getSent().length, 1);
  assert.equal(simulated.getLast().to, 'dev@example.ng');
  assert.equal(simulated.getLast().subject, 'Welcome to Dev Circle');

  simulated.clear();
  assert.equal(simulated.getSent().length, 0);
});

test('TermiiEmailProvider requires apiKey and emailConfigurationId', async () => {
  const unconfigured = new TermiiEmailProvider({});
  assert.equal(unconfigured.isConfigured(), false);

  const failResult = await unconfigured.send({ to: 'user@example.ng', subject: 'Hi' });
  assert.equal(failResult.status, 'failed');
  assert.match(failResult.error, /TERMII_API_KEY/);

  const configured = new TermiiEmailProvider({
    apiKey: 'test_termii_key',
    emailConfigurationId: 'cfg_123'
  });
  assert.equal(configured.isConfigured(), true);
  assert.equal(configured.getName(), 'termii');
});

test('TermiiEmailProvider correctly calls fetch for templated email', async () => {
  let capturedUrl = null;
  let capturedHeaders = null;
  let capturedBody = null;

  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ message_id: 'termii_msg_999' })
    };
  };

  try {
    const provider = new TermiiEmailProvider({
      apiKey: 'termii_sec_xyz',
      emailConfigurationId: 'config_456',
      baseUrl: 'https://api.ng.termii.com'
    });

    const res = await provider.send({
      to: 'chidi@paystack.africa',
      subject: 'Dev Circle Update',
      text: 'Here is your update',
      templateId: 'tpl_survey_1'
    });

    assert.equal(res.status, 'sent');
    assert.equal(res.provider, 'termii');
    assert.equal(res.ref, 'termii_msg_999');
    assert.equal(capturedUrl, 'https://api.ng.termii.com/api/templates/send-email');
    assert.equal(capturedBody.api_key, 'termii_sec_xyz');
    assert.equal(capturedBody.email, 'chidi@paystack.africa');
    assert.equal(capturedBody.email_configuration_id, 'config_456');
    assert.equal(capturedBody.template_id, 'tpl_survey_1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('TermiiEmailProvider handles OTP token endpoint for login codes', async () => {
  let capturedUrl = null;
  let capturedBody = null;

  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ pinId: 'pin_789' })
    };
  };

  try {
    const provider = new TermiiEmailProvider({
      apiKey: 'termii_key_1',
      emailConfigurationId: 'config_1'
    });

    const res = await provider.send({
      to: 'user@paystack.africa',
      subject: 'Your code',
      category: 'login_code',
      variables: { code: '123456' }
    });

    assert.equal(res.status, 'sent');
    assert.equal(res.ref, 'pin_789');
    assert.equal(capturedUrl, 'https://api.ng.termii.com/api/email/otp/send');
    assert.equal(capturedBody.email_address, 'user@paystack.africa');
    assert.equal(capturedBody.code, '123456');
  } finally {
    global.fetch = originalFetch;
  }
});

test('SimpuEmailProvider requires apiKey', async () => {
  const unconfigured = new SimpuEmailProvider({});
  assert.equal(unconfigured.isConfigured(), false);

  const failResult = await unconfigured.send({ to: 'user@example.ng', subject: 'Hi' });
  assert.equal(failResult.status, 'failed');
  assert.match(failResult.error, /SIMPU_API_KEY/);

  const configured = new SimpuEmailProvider({ apiKey: 'simpu_live_key' });
  assert.equal(configured.isConfigured(), true);
  assert.equal(configured.getName(), 'simpu');
});

test('SimpuEmailProvider formats request according to Simpu Email API specification', async () => {
  let capturedUrl = null;
  let capturedHeaders = null;
  let capturedBody = null;

  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 201,
      json: async () => ({ status: 'success', data: { id: 'simpu_tx_123' } })
    };
  };

  try {
    const provider = new SimpuEmailProvider({
      apiKey: 'simpu_secret_key',
      senderId: 'noreply@creditdirect.ng',
      fromName: 'Credit Direct Dev Circle',
      baseUrl: 'https://api.simpu.co'
    });

    const res = await provider.send({
      to: 'ada@flutterwave.com',
      subject: "You're invited: Lending API Survey",
      html: '<h1>Survey Invitation</h1>',
      text: 'Survey Invitation',
      metadata: { referenceId: 'ref_abc_1' }
    });

    assert.equal(res.status, 'sent');
    assert.equal(res.provider, 'simpu');
    assert.equal(res.ref, 'simpu_tx_123');
    assert.equal(capturedUrl, 'https://api.simpu.co/email/send');
    assert.equal(capturedHeaders.Authorization, 'Bearer simpu_secret_key');
    assert.equal(capturedBody.recipients, 'ada@flutterwave.com');
    assert.equal(capturedBody.sender_id, 'noreply@creditdirect.ng');
    assert.equal(capturedBody.from_name, 'Credit Direct Dev Circle');
    assert.equal(capturedBody.content, '<h1>Survey Invitation</h1>');
    assert.equal(capturedBody.external_ref, 'ref_abc_1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('SimpuEmailProvider captures API error responses properly', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Invalid API key provided' })
  });

  try {
    const provider = new SimpuEmailProvider({ apiKey: 'bad_key' });
    const res = await provider.send({ to: 'test@example.ng', subject: 'Test' });

    assert.equal(res.status, 'failed');
    assert.equal(res.provider, 'simpu');
    assert.match(res.error, /Invalid API key/);
  } finally {
    global.fetch = originalFetch;
  }
});

// ─── High-Level EmailService ─────────────────────────────────

test('EmailService dispatches survey invite and logs to simulated queue when no provider keys set', async () => {
  const result = await emailService.sendSurveyInvite({
    to: 'developer@creditdirect.ng',
    recipientName: 'Emeka',
    surveyTitle: 'Partner API Usability',
    surveyDescription: 'Help us test the new webhook payloads.',
    timeEstimateMin: 5,
    questionCount: 8,
    surveyUrl: 'https://devcircle.creditdirect.ng/surveys/partner-api'
  });

  assert.equal(result.status, 'simulated');
  assert.match(result.ref, /^sim_/);

  const sent = emailService.getSimulatedQueue();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'developer@creditdirect.ng');
  assert.equal(sent[0].category, 'survey_invites');
  assert.ok(sent[0].html.includes('Partner API Usability'));
  assert.ok(sent[0].html.includes('Emeka'));
});

test('EmailService dispatches staff invitation email', async () => {
  const result = await emailService.sendStaffInvite({
    to: 'newadmin@creditdirect.ng',
    recipientName: 'Kehinde',
    roleName: 'CDL Rep',
    temporaryPassword: 'TempSecPassword123!',
    invitedByName: 'Adaeze Okonkwo'
  });

  assert.equal(result.status, 'simulated');
  const sent = emailService.getSimulatedQueue();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].html.includes('Kehinde'));
  assert.ok(sent[0].html.includes('TempSecPassword123!'));
  assert.ok(sent[0].html.includes('CDL Rep'));
  assert.equal(sent[0].category, 'staff_invite');
});

test('EmailService dispatches login code email', async () => {
  const result = await emailService.sendLoginCode({
    to: 'member@paystack.dev',
    code: '938102',
    expiresInMinutes: 15
  });

  assert.equal(result.status, 'simulated');
  const sent = emailService.getSimulatedQueue();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'member@paystack.dev');
  assert.ok(sent[0].html.includes('938102'));
  assert.ok(sent[0].html.includes('15 minutes'));
  assert.equal(sent[0].category, 'login_code');
});

test('EmailService dispatches blast announcement email', async () => {
  const result = await emailService.sendBlast({
    to: 'all@fintech.ng',
    subject: 'Scheduled Maintenance',
    content: 'Our core lending sandbox will be undergoing maintenance this Saturday.',
    actionText: 'Check Status Page',
    actionUrl: 'https://status.creditdirect.ng'
  });

  assert.equal(result.status, 'simulated');
  const sent = emailService.getSimulatedQueue();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Scheduled Maintenance');
  assert.ok(sent[0].html.includes('Check Status Page'));
});

test('EmailService reports status with all registered providers', () => {
  const status = emailService.getStatus();
  assert.ok(status.active_provider);
  assert.ok(Array.isArray(status.providers));

  const providerIds = status.providers.map(p => p.id);
  assert.ok(providerIds.includes('termii'));
  assert.ok(providerIds.includes('simpu'));
  assert.ok(providerIds.includes('customer_io'));
  assert.ok(providerIds.includes('simulated'));
});
