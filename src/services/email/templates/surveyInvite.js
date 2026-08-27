const { wrapLayout, toPlainText, escapeHtml } = require('./layout');

function renderSurveyInvite({
  surveyTitle,
  surveyDescription = '',
  timeEstimateMin = 3,
  questionCount = null,
  surveyUrl,
  recipientName = null,
  appUrl
}) {
  const greeting = recipientName ? `Hello ${escapeHtml(recipientName)},` : 'Hello,';
  const timeText = timeEstimateMin ? `~${timeEstimateMin} minute${timeEstimateMin === 1 ? '' : 's'}` : null;
  const countText = questionCount ? `${questionCount} question${questionCount === 1 ? '' : 's'}` : null;
  const metaBadge = [timeText, countText].filter(Boolean).join(' &middot; ');

  const contentHtml = `
    <p style="margin-top: 0;">${greeting}</p>
    <p>You have been invited to participate in a survey on Credit Direct Dev Circle:</p>
    
    <div style="background-color: #F8FAFC; border-left: 4px solid #107EBC; padding: 16px; margin: 20px 0; border-radius: 0 6px 6px 0;">
      <div style="font-size: 16px; font-weight: 700; color: #0F172A; margin-bottom: 6px;">
        ${escapeHtml(surveyTitle)}
      </div>
      ${surveyDescription ? `<div style="font-size: 14px; color: #475569; margin-bottom: 8px;">${escapeHtml(surveyDescription)}</div>` : ''}
      ${metaBadge ? `<div style="font-size: 12px; font-weight: 600; color: #107EBC;">${metaBadge}</div>` : ''}
    </div>

    <p>Your feedback directly shapes our APIs, documentation, and tooling for developers across Africa.</p>
  `;

  const contentText = [
    recipientName ? `Hello ${recipientName},` : 'Hello,',
    '',
    'You have been invited to participate in a survey on Credit Direct Dev Circle:',
    '',
    `Survey: ${surveyTitle}`,
    surveyDescription ? `Description: ${surveyDescription}` : '',
    metaBadge ? `Details: ${metaBadge.replace(/&middot;/g, '·')}` : '',
    '',
    'Your feedback directly shapes our APIs, documentation, and tooling for developers across Africa.'
  ].filter(Boolean).join('\n');

  return {
    subject: `You're invited: ${surveyTitle}`,
    previewText: `Share your feedback on ${surveyTitle}`,
    html: wrapLayout({
      title: `You're invited: ${surveyTitle}`,
      previewText: `Share your feedback on ${surveyTitle}`,
      contentHtml,
      actionText: 'Take Survey',
      actionUrl: surveyUrl,
      appUrl
    }),
    text: toPlainText({
      title: `You're invited: ${surveyTitle}`,
      contentText,
      actionText: 'Take Survey',
      actionUrl: surveyUrl,
      appUrl
    })
  };
}

module.exports = renderSurveyInvite;
