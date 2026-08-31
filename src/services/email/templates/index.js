const renderSurveyInvite = require('./surveyInvite');
const renderSurveyReminder = require('./surveyReminder');
const renderSessionInvite = require('./sessionInvite');
const renderSessionReminder = require('./sessionReminder');
const renderStaffInvite = require('./staffInvite');
const renderLoginCode = require('./loginCode');
const renderBlast = require('./blast');
const renderGiftClaimed = require('./giftClaimed');
const renderFeedbackUpdate = require('./feedbackUpdate');
const renderGeneric = require('./generic');

const TEMPLATES = {
  survey_invite: renderSurveyInvite,
  survey_invites: renderSurveyInvite,
  survey_reminder: renderSurveyReminder,
  survey_reminders: renderSurveyReminder,
  session_invite: renderSessionInvite,
  session_reminder: renderSessionReminder,
  staff_invite: renderStaffInvite,
  login_code: renderLoginCode,
  blast: renderBlast,
  gift_claimed: renderGiftClaimed,
  gift_notifications: renderGiftClaimed,
  feedback_update: renderFeedbackUpdate,
  feedback_updates: renderFeedbackUpdate,
  platform_updates: renderGeneric,
  generic: renderGeneric
};

// ─── Rendering one ───────────────────────────────────────────
// `overrides` is what a circle has typed for this workflow, already filled in
// (see services/emailTemplates.js), and `brand` is that circle's colours. Both
// are optional and both default to nothing, so every existing caller keeps the
// behaviour it had: the template renders itself, in Credit Direct's colours.
function renderTemplate(name, data = {}, { overrides = null, brand = null } = {}) {
  const renderer = TEMPLATES[name] || renderGeneric;
  if (!overrides && !brand) return renderer(data);

  return renderer({
    ...data,
    intro: overrides?.intro || null,
    outro: overrides?.outro || null,
    bodyHtml: overrides?.body_html || null,
    subjectOverride: overrides?.subject || null,
    brand: brand || null
  });
}

module.exports = {
  renderTemplate,
  TEMPLATES
};
