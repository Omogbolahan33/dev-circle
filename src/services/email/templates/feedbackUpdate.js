const { wrapLayout, toPlainText, escapeHtml } = require('./layout');

function renderFeedbackUpdate({
  feedbackTitle,
  feedbackStatus = null,
  responseMessage = null,
  recipientName = null,
  feedbackUrl = null,
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
    <p>There is an update on feedback you submitted to Credit Direct Dev Circle:</p>

    <div style="background-color: #F8FAFC; border-left: 4px solid #107EBC; padding: 16px; margin: 20px 0; border-radius: 0 6px 6px 0;">
      <div style="font-size: 15px; font-weight: 700; color: #0F172A; margin-bottom: 6px;">
        "${escapeHtml(feedbackTitle)}"
      </div>
      ${feedbackStatus ? `<div style="font-size: 13px; color: #64748B;">Status: <strong style="color: #0F172A; text-transform: capitalize;">${escapeHtml(feedbackStatus)}</strong></div>` : ''}
    </div>

    ${responseMessage ? `
      <div style="background-color: #F1F5F9; border-radius: 6px; padding: 14px; margin-bottom: 20px; font-size: 14px; color: #334155; line-height: 1.5;">
        <strong>Response from team:</strong><br>
        ${escapeHtml(responseMessage)}
      </div>
    ` : ''}

    <p>Thank you for helping us identify issues and improve the developer experience.</p>
  `;

  const contentText = [
    recipientName ? `Hello ${recipientName},` : 'Hello,',
    '',
    `There is an update on feedback you submitted to Credit Direct Dev Circle: "${feedbackTitle}"`,
    feedbackStatus ? `Status: ${feedbackStatus}` : '',
    responseMessage ? `Response: ${responseMessage}` : '',
    '',
    'Thank you for helping us improve the developer experience.',
    feedbackUrl ? `View feedback: ${feedbackUrl}` : ''
  ].filter(Boolean).join('\n');

  return {
    subject: subjectOverride || `Update on feedback: ${feedbackTitle}`,
    previewText: `Feedback update: ${feedbackTitle}`,
    html: wrapLayout({
      intro,
      outro,
      brand,
      title: subjectOverride || 'Feedback Update',
      previewText: `Update on: ${feedbackTitle}`,
      contentHtml: bodyHtml || contentHtml,
      actionText: feedbackUrl ? 'View Feedback' : null,
      actionUrl: feedbackUrl,
      appUrl
    }),
    text: toPlainText({
      intro,
      outro,
      brand,
      title: subjectOverride || 'Feedback Update',
      contentText,
      actionText: feedbackUrl ? 'View Feedback' : null,
      actionUrl: feedbackUrl,
      appUrl
    })
  };
}

module.exports = renderFeedbackUpdate;
