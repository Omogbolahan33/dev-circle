const { wrapLayout, toPlainText, escapeHtml } = require('./layout');

function renderSurveyReminder({
  surveyTitle,
  surveyUrl,
  recipientName = null,
  appUrl
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
    'We value your perspective as a developer integrating Credit Direct services. Taking a few moments to complete this survey helps us improve the platform for you.'
  ].join('\n');

  return {
    subject: `Reminder: ${surveyTitle}`,
    previewText: `Don't forget to share your feedback on ${surveyTitle}`,
    html: wrapLayout({
      title: `Reminder: ${surveyTitle}`,
      previewText: `Don't forget to complete: ${surveyTitle}`,
      contentHtml,
      actionText: 'Complete Survey',
      actionUrl: surveyUrl,
      appUrl
    }),
    text: toPlainText({
      title: `Reminder: ${surveyTitle}`,
      contentText,
      actionText: 'Complete Survey',
      actionUrl: surveyUrl,
      appUrl
    })
  };
}

module.exports = renderSurveyReminder;
