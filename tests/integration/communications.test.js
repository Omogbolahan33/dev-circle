const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const emailService = require('../../src/services/email');
const templates = require('../../src/services/emailTemplates');

before(h.start);
after(h.stop);

let adminToken, readOnlyToken, circleId;

beforeEach(async () => {
  h.reset();
  circleId = h.makeCircle();
  const boss = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: boss });
  adminToken = await h.loginAdmin(admin.email, admin.password);

  const viewer = h.makeRole('Read Only', ['members.read', 'circles.read']);
  const watcher = h.makeAdmin({ email: 'watcher@creditdirect.ng', roleId: viewer });
  readOnlyToken = await h.loginAdmin(watcher.email, watcher.password);
});

const list = () => h.get('/api/admin/email-templates', { token: adminToken });
const put = (workflow, body, token = adminToken) =>
  h.put(`/api/admin/email-templates/${workflow}`, body, { token });
const preview = (workflow, body = {}, token = adminToken) =>
  h.post(`/api/admin/email-templates/${workflow}/preview`, body, { token });

// ─── What is on offer ────────────────────────────────────────

test('every workflow that sends mail is listed, and none is customised to begin with', async () => {
  const res = await list();
  assert.equal(res.status, 200);

  const keys = res.body.workflows.map(w => w.key).sort();
  assert.deepEqual(keys, [
    'blast', 'feedback_update', 'generic', 'gift_claimed', 'login_code',
    'session_invite', 'session_reminder', 'staff_invite', 'survey_invite', 'survey_reminder'
  ]);

  for (const w of res.body.workflows) {
    assert.equal(w.customised, false, `${w.key} should start untouched`);
    assert.equal(w.override, null);
    assert.ok(w.defaultSubject, `${w.key} should say what it sends today`);
    assert.ok(w.variables.length, `${w.key} should offer variables`);
  }
});

test('the list names the workflows that actually have renderers', async () => {
  // A hardcoded label list is how this drifts: the credentials page used to
  // carry one. These come from the same place the renderer dispatch does.
  const { TEMPLATES } = require('../../src/services/email/templates');
  const res = await list();
  for (const w of res.body.workflows) {
    assert.ok(TEMPLATES[w.key], `${w.key} is offered but nothing renders it`);
  }
});

// ─── Editing ─────────────────────────────────────────────────

test('a subject is overridden, and reverting puts the default back', async () => {
  const saved = await put('survey_invite', { subject: 'Two minutes on {{survey_title}}?' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.override.subject, 'Two minutes on {{survey_title}}?');

  const after = await list();
  const flow = after.body.workflows.find(w => w.key === 'survey_invite');
  assert.equal(flow.customised, true);

  const shown = await preview('survey_invite');
  assert.match(shown.body.subject, /^Two minutes on /);
  // The headline inside the mail is the same sentence as the subject on it —
  // rewriting one and leaving the other reads as two different emails.
  assert.match(shown.body.html, /<h1[^>]*>\s*Two minutes on /);

  const gone = await h.del('/api/admin/email-templates/survey_invite', { token: adminToken });
  assert.equal(gone.status, 200);

  const back = await preview('survey_invite');
  assert.match(back.body.subject, /^You're invited: /, 'the coded default returns');
});

test('each field falls back on its own', async () => {
  // Setting an intro must not adopt a subject, because the default was never
  // copied into the row — it stays in code and is read from there.
  await put('survey_reminder', { intro: 'A quick nudge from the platform team.' });

  const shown = await preview('survey_reminder');
  assert.match(shown.body.subject, /^Reminder: /, 'the subject is still the coded one');
  assert.ok(shown.body.html.includes('A quick nudge from the platform team.'));
});

test('an override emptied of everything stops being an override', async () => {
  await put('gift_claimed', { subject: 'Your reward is on its way' });
  assert.equal((await list()).body.workflows.find(w => w.key === 'gift_claimed').customised, true);

  const cleared = await put('gift_claimed', { subject: '', intro: '', outro: '', body_html: '' });
  assert.equal(cleared.body.override, null);
  assert.equal((await list()).body.workflows.find(w => w.key === 'gift_claimed').customised, false);
});

test('editing one field leaves the others alone', async () => {
  await put('session_invite', { intro: 'From the events team.', outro: 'See you there.' });
  await put('session_invite', { subject: 'You are invited' });

  const flow = (await list()).body.workflows.find(w => w.key === 'session_invite');
  assert.equal(flow.override.subject, 'You are invited');
  assert.equal(flow.override.intro, 'From the events team.', 'the intro survived a subject edit');
  assert.equal(flow.override.outro, 'See you there.');
});

test('a workflow nobody sends is refused', async () => {
  assert.equal((await put('not_a_workflow', { subject: 'x' })).status, 404);
  assert.equal((await preview('not_a_workflow')).status, 404);
});

test('over-long copy is refused with a reason', async () => {
  const res = await put('blast', { subject: 'x'.repeat(500) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /too long/i);
});

test('changing what a workspace says needs permission to change the workspace', async () => {
  assert.equal((await put('survey_invite', { subject: 'x' }, readOnlyToken)).status, 403);
  assert.equal((await h.get('/api/admin/email-templates', { token: readOnlyToken })).status, 403);
});

// ─── Variables ───────────────────────────────────────────────

test('a variable is filled from the thing being sent', async () => {
  await put('survey_invite', { subject: '{{survey_title}} — {{time_estimate}} minutes' });
  const shown = await preview('survey_invite');
  assert.ok(!shown.body.subject.includes('{{'), shown.body.subject);
  assert.match(shown.body.subject, /minutes$/);
});

test('a variable that does not exist is left visible rather than blanked', async () => {
  // Blanking would turn a typo into a sentence with a hole in it that nobody
  // notices until it has gone out.
  await put('survey_invite', { subject: 'About {{survye_title}}' });
  const shown = await preview('survey_invite');
  assert.equal(shown.body.subject, 'About {{survye_title}}');
});

// ─── An uploaded body ────────────────────────────────────────

test('an uploaded body replaces what the template writes, inside the layout it ships', async () => {
  await put('survey_reminder', { body_html: '<p>Entirely our own words about {{survey_title}}.</p>' });

  const shown = await preview('survey_reminder');
  assert.ok(shown.body.html.includes('Entirely our own words about How is the sandbox'));
  assert.ok(!shown.body.html.includes('Still open'), "the template's own body is gone");
  // The footer is not the author's to remove: it carries the link people use
  // to change what they hear from us.
  assert.match(shown.body.html, /Notification Preferences/);
});

test('script and event handlers are stripped from an uploaded body', async () => {
  const res = await put('generic', {
    body_html: `<p onclick="steal()">Hi</p><script>fetch('//evil.test')</script><a href="javascript:x()">go</a><iframe src="//evil.test"></iframe>`
  });
  assert.equal(res.status, 200);

  const stored = res.body.override.body_html;
  assert.ok(!/<script/i.test(stored), stored);
  assert.ok(!/onclick/i.test(stored), stored);
  assert.ok(!/javascript:/i.test(stored), stored);
  assert.ok(!/<iframe/i.test(stored), stored);
  assert.ok(stored.includes('Hi'), 'the actual copy survives');
});

// ─── What actually goes out ──────────────────────────────────

test('an override reaches a real send, not just the preview', async () => {
  // The preview and the sender have to agree, or the screen is a lie.
  await put('survey_invite', {
    subject: 'A different subject entirely',
    intro: 'A line the platform never wrote.'
  });

  emailService.clearSimulatedQueue();
  await emailService.send({
    to: 'chidi@paystack.africa',
    template: 'survey_invite',
    templateData: { surveyTitle: 'Sandbox friction', surveyUrl: 'https://x.test/s' },
    circleId
  });

  const [sent] = emailService.getSimulatedQueue();
  assert.ok(sent, 'the mail was dispatched');
  assert.equal(sent.subject, 'A different subject entirely');
  assert.ok(sent.html.includes('A line the platform never wrote.'));
});

test('a send with no circle is the platform speaking, unchanged', async () => {
  await put('survey_invite', { subject: 'This circle only' });

  emailService.clearSimulatedQueue();
  await emailService.send({
    to: 'chidi@paystack.africa',
    template: 'survey_invite',
    templateData: { surveyTitle: 'Sandbox friction', surveyUrl: 'https://x.test/s' }
  });

  const [sent] = emailService.getSimulatedQueue();
  assert.match(sent.subject, /^You're invited: /, 'no circle means no override');
});

test("one circle's wording does not leak into another's", async () => {
  const other = h.makeCircle('Merchant Circle', 'merchant-circle');
  await put('survey_invite', { subject: 'Only for the first circle' });

  emailService.clearSimulatedQueue();
  await emailService.send({
    to: 'someone@else.test',
    template: 'survey_invite',
    templateData: { surveyTitle: 'X', surveyUrl: 'https://x.test/s' },
    circleId: other
  });

  const [sent] = emailService.getSimulatedQueue();
  assert.match(sent.subject, /^You're invited: /);
});

// ─── The circle's colours ────────────────────────────────────

test("a circle's brand reaches its mail, even after it has already sent one", async () => {
  // The send path caches a circle's colours. Rebranding has to drop that, or
  // the workspace keeps sending the old look for as long as the cache holds.
  emailService.clearSimulatedQueue();
  await emailService.send({
    to: 'first@paystack.africa',
    template: 'survey_invite',
    templateData: { surveyTitle: 'Before', surveyUrl: 'https://x.test/s' },
    circleId
  });
  assert.ok(emailService.getSimulatedQueue()[0].html.includes('107EBC'), 'the first one is the platform blue');

  await h.put(`/api/admin/circles/${circleId}`,
    { theme: { accent: '#8A2BE2' } }, { token: adminToken });

  emailService.clearSimulatedQueue();
  await emailService.send({
    to: 'chidi@paystack.africa',
    template: 'survey_invite',
    templateData: { surveyTitle: 'Sandbox friction', surveyUrl: 'https://x.test/s' },
    circleId
  });

  const [sent] = emailService.getSimulatedQueue();
  assert.ok(sent.html.includes('8A2BE2'), "the circle's accent is in the mail");
});

test('a pale brand gets dark text on the header rather than white on cream', async () => {
  const { wrapLayout } = require('../../src/services/email/templates/layout');

  const pale = wrapLayout({ title: 'x', contentHtml: '<p>x</p>', brand: { name: 'C', accent: '#F5E6C8' } });
  const deep = wrapLayout({ title: 'x', contentHtml: '<p>x</p>', brand: { name: 'C', accent: '#10263A' } });

  assert.ok(pale.includes('#12203A'), 'dark ink on a pale header');
  assert.ok(deep.includes('#FFFFFF'), 'white ink on a dark header');
});

test('an unbranded circle sends what it always sent', async () => {
  const { wrapLayout } = require('../../src/services/email/templates/layout');
  const plain = wrapLayout({ title: 'x', contentHtml: '<p>x</p>' });

  assert.ok(plain.includes('#107EBC'), 'Denim blue');
  assert.ok(plain.includes('#0B5A8A'), 'and its darker stop');
  assert.ok(plain.includes('Credit Direct'), 'and the organisation');
});
