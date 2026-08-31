const { wrapLayout, toPlainText, escapeHtml } = require('./layout');

function renderSurveyReminder({
  surveyTitle,
  surveyUrl,
  recipientName = null,
  appUrl,
  // Set by services/emailTemplates.js when this circle has overridden the
  // wording. Every one is null unless somebody has actually typed something,
  // which is what keeps an untouched workflow rendering exactly this code.
  intro = null,
  outro = null,
  bodyHtml = null,
  subjectOverride = null,
  brand = null
}) {
  const greeting = recipientName ? `Hello ${escapeHtml(recipientName)},` : 'Hello,';

  const contentHtml = `
    <p style="margin-top: 0;">${greeting}</p>
    <p>This is a quick reminder that you were invited to share your input on <strong>${escapeHtml(surveyTitle)}</strong>.</p>
    <p>We value your perspective as a developer integrating Credit Direct services. Taking a few moments to complete this survey helps us improve the platform for you.</p>
  `;

  const contentText = [
    recipientName ? `Hello ${recipientName},` : 'Hello,',
    '',
    `This is a quick reminder that you were invited to share your input on: ${surveyTitle}.`,
    '',
    `We value your perspective as a developer integrating Credit Direct services. Taking a few moments to complete this survey helps us improve the platform for you.`
  ].join('\n');

  return {
    subject: subjectOverride || `Reminder: ${surveyTitle}`,
    previewText: `Don't forget to share your feedback on ${surveyTitle}`,
    html: wrapLayout({
      intro,
      outro,
      brand,
      title: subjectOverride || `Reminder: ${surveyTitle}`,
      previewText: `Don't forget to complete: ${surveyTitle}`,
      contentHtml: bodyHtml || contentHtml,
      actionText: 'Complete Survey',
      actionUrl: surveyUrl,
      appUrl
    }),
    text: toPlainText({
      intro,
      outro,
      brand,
      title: subjectOverride || `Reminder: ${surveyTitle}`,
      contentText,
      actionText: 'Complete Survey',
      actionUrl: surveyUrl,
      appUrl
    })
  };
}

module.exports = renderSurveyReminder;
