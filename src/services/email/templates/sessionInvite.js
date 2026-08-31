const { wrapLayout, toPlainText, escapeHtml } = require('./layout');

function renderSessionInvite({
  sessionTitle,
  sessionDescription = '',
  scheduledAt = null,
  sessionTime = null,
  meetingUrl = null,
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
  const timeDisplay = sessionTime || (scheduledAt ? new Date(scheduledAt).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }) + ' WAT' : null);

  const contentHtml = `
    <p style="margin-top: 0;">${greeting}</p>
    <p>You're invited to attend an upcoming session on Credit Direct Dev Circle:</p>
    
    <div style="background-color: #F8FAFC; border-left: 4px solid #107EBC; padding: 16px; margin: 20px 0; border-radius: 0 6px 6px 0;">
      <div style="font-size: 16px; font-weight: 700; color: #0F172A; margin-bottom: 6px;">
        ${escapeHtml(sessionTitle)}
      </div>
      ${sessionDescription ? `<div style="font-size: 14px; color: #475569; margin-bottom: 8px;">${escapeHtml(sessionDescription)}</div>` : ''}
      ${timeDisplay ? `<div style="font-size: 13px; font-weight: 600; color: #0B5A8A;">🗓 ${escapeHtml(timeDisplay)}</div>` : ''}
    </div>

    <p>Bring your integration questions, feedback, or ideas — our developer relations and product engineering teams will be there.</p>
  `;

  const contentText = [
    recipientName ? `Hello ${recipientName},` : 'Hello,',
    '',
    `You are invited to attend an upcoming session on Credit Direct Dev Circle:`,
    '',
    `Session: ${sessionTitle}`,
    sessionDescription ? `Description: ${sessionDescription}` : '',
    timeDisplay ? `Time: ${timeDisplay}` : '',
    '',
    'Bring your integration questions, feedback, or ideas — our developer relations and product engineering teams will be there.'
  ].filter(Boolean).join('\n');

  return {
    subject: subjectOverride || `Invited: ${sessionTitle}`,
    previewText: `You're invited to ${sessionTitle}`,
    html: wrapLayout({
      intro,
      outro,
      brand,
      title: subjectOverride || `Invited: ${sessionTitle}`,
      previewText: `You're invited to ${sessionTitle}`,
      contentHtml: bodyHtml || contentHtml,
      actionText: meetingUrl ? 'Join Session' : 'View in Portal',
      actionUrl: meetingUrl || `${appUrl}/member/sessions.html`,
      appUrl
    }),
    text: toPlainText({
      intro,
      outro,
      brand,
      title: subjectOverride || `Invited: ${sessionTitle}`,
      contentText,
      actionText: meetingUrl ? 'Join Session' : 'View in Portal',
      actionUrl: meetingUrl || `${appUrl}/member/sessions.html`,
      appUrl
    })
  };
}

module.exports = renderSessionInvite;
