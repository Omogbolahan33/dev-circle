const { test } = require('node:test');
const assert = require('node:assert');

process.env.DEVCIRCLE_QUIET = '1';

const { resolveWorkflow } = require('../../src/services/email/workflows');
const { renderTemplate } = require('../../src/services/email/templates');

// Rendering helper: resolve the workflow then render, returning the email.
function render(message, user = { name: 'Ada Lovelace' }) {
  const { template, subject, templateData } = resolveWorkflow(message, user);
  const rendered = renderTemplate(template, { appUrl: 'https://app.test', ...templateData });
  return { template, subject, ...rendered };
}

test('a session announcement uses the session template, not the survey template', () => {
  // Scheduler files a session announcement under the survey_invites category.
  const email = render({
    category: 'survey_invites',
    source_type: 'session_invite',
    title: 'Scheduled: API Integration Workshop',
    body: 'Hands-on session.',
    action_url: '/member/sessions.html?id=1',
    templateData: { sessionTime: '28 Aug 2026, 14:00 WAT', sessionDescription: 'Hands-on session.' }
  });

  assert.equal(email.template, 'session_invite');
  assert.match(email.subject, /^Invited:/);
  assert.ok(email.html.includes('session'));
  // The session template says "invited to attend ... session", it must not
  // carry survey wording.
  assert.ok(!/take .{0,10}survey|question.{0,5}\d/i.test(email.html));
  assert.ok(!email.html.includes('undefined'));
});

test('a session reminder filed under survey_reminders still uses the session reminder template', () => {
  const email = render({
    category: 'survey_reminders',
    source_type: 'session_reminder',
    title: 'Reminder: API Workshop in 1 hour(s)',
    body: 'Starts soon.',
    action_url: '/member/sessions.html?id=1',
    templateData: { sessionTime: '28 Aug 2026, 14:00 WAT' }
  });

  assert.equal(email.template, 'session_reminder');
  assert.match(email.subject, /^Upcoming:/);
  assert.ok(!email.html.includes('undefined'));
});

test('a survey invitation uses the survey template', () => {
  const email = render({
    category: 'survey_invites',
    source_type: 'survey_invite',
    title: 'Disbursement Webhook Reliability Survey',
    body: 'About 5 minutes.',
    action_url: '/member/survey.html?id=x'
  });

  assert.equal(email.template, 'survey_invite');
  assert.match(email.subject, /^You're invited:/);
  assert.ok(email.html.includes('Disbursement Webhook Reliability Survey'));
  assert.ok(email.html.includes('Ada')); // greeting uses recipient name
});

test('a gift notification never renders "undefined" and names the gift', () => {
  const delivered = render({
    category: 'gift_notifications',
    source_type: 'system',
    title: 'N5,000 Giftcard is on its way',
    body: 'Your reward has been sent.',
    action_url: '/member/gifts.html'
  });
  assert.equal(delivered.template, 'gift_claimed');
  assert.ok(delivered.html.includes('N5,000 Giftcard'));
  assert.ok(!delivered.html.includes('undefined'));

  const claimed = render({
    category: 'gift_notifications',
    source_type: 'system',
    title: 'You claimed N5,000 Giftcard',
    body: 'Soon.',
    templateData: { giftName: 'N5,000 Giftcard', giftValue: 5000, currency: 'NGN' }
  });
  assert.ok(claimed.html.includes('NGN 5,000'));
  assert.ok(!claimed.html.includes('undefined'));
});

test('a feedback reply uses the feedback update template with the team note', () => {
  const email = render({
    category: 'feedback_updates',
    source_type: 'feedback_update',
    title: 'Update on feedback: Sandbox docs were missing…',
    body: 'We added the missing section.',
    action_url: '/member/feedback.html',
    templateData: { feedbackTitle: 'Sandbox docs were missing', feedbackStatus: 'resolved', responseMessage: 'We added the missing section.' }
  });

  assert.equal(email.template, 'feedback_update');
  assert.ok(email.html.includes('We added the missing section.'));
  assert.ok(email.html.includes('resolved'));
  assert.ok(!email.html.includes('undefined'));
});

test('a login code uses the code template and shows the code prominently', () => {
  const email = render({
    category: 'login_code',
    workflow: 'login_code',
    title: '482910 is your Dev Circle sign-in code',
    body: 'Enter 482910 to sign in.',
    templateData: { code: '482910', expiresInMinutes: 10 }
  });

  assert.equal(email.template, 'login_code');
  assert.ok(email.subject.includes('482910'));
  assert.ok(email.html.includes('482910'));
});

test('a broadcast uses the blast template with the announcement body', () => {
  const email = render({
    category: 'platform_updates',
    source_type: 'blast',
    title: 'News from Credit Direct',
    body: 'Big platform update this week.',
    action_url: null
  });

  assert.equal(email.template, 'blast');
  assert.ok(email.html.includes('Big platform update this week.'));
});

test('an explicit workflow wins over a colliding category (login code in a code request)', () => {
  const email = render({
    category: 'platform_updates',
    workflow: 'login_code',
    title: '915342 is your Dev Circle sign-in code',
    body: 'Enter 915342.',
    templateData: { code: '915342' }
  });
  assert.equal(email.template, 'login_code');
});
