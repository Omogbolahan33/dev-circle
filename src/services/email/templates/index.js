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

function renderTemplate(name, data = {}) {
  const renderer = TEMPLATES[name] || renderGeneric;
  return renderer(data);
}

module.exports = {
  renderTemplate,
  TEMPLATES
};
