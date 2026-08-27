const { wrapLayout, toPlainText, escapeHtml } = require('./layout');

function renderSessionReminder({
  sessionTitle,
  scheduledAt = null,
  sessionTime = null,
  meetingUrl = null,
  recipientName = null,
  appUrl
}) {
  const greeting = recipientName ? `Hello ${escapeHtml(recipientName)},` : 'Hello,';
  const timeDisplay = sessionTime || (scheduledAt ? new Date(scheduledAt).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }) + ' WAT' : null);

  const contentHtml = `
    <p style="margin-top: 0;">${greeting}</p>
    <p>This is a quick reminder that your session is coming up:</p>
    
    <div style="background-color: #F8FAFC; border-left: 4px solid #E6B473; padding: 16px; margin: 20px 0; border-radius: 0 6px 6px 0;">
      <div style="font-size: 16px; font-weight: 700; color: #0F172A; margin-bottom: 6px;">
        ${escapeHtml(sessionTitle)}
      </div>
      ${timeDisplay ? `<div style="font-size: 13px; font-weight: 600; color: #0B5A8A;">⏰ Scheduled for: ${escapeHtml(timeDisplay)}</div>` : ''}
    </div>

    <p>We look forward to seeing you there!</p>
  `;

  const contentText = [
    recipientName ? `Hello ${recipientName},` : 'Hello,',
    '',
    `Reminder: Your session "${sessionTitle}" is starting soon!`,
    timeDisplay ? `Time: ${timeDisplay}` : '',
    '',
    meetingUrl ? `Join link: ${meetingUrl}` : `View details: ${appUrl}/member/sessions.html`
  ].filter(Boolean).join('\n');

  return {
    subject: `Upcoming: ${sessionTitle}`,
    previewText: `Reminder: ${sessionTitle} is starting soon`,
    html: wrapLayout({
      title: `Upcoming: ${sessionTitle}`,
      previewText: `Reminder: ${sessionTitle} is starting soon`,
      contentHtml,
      actionText: meetingUrl ? 'Join Meeting' : 'View in Portal',
      actionUrl: meetingUrl || `${appUrl}/member/sessions.html`,
      appUrl
    }),
    text: toPlainText({
      title: `Upcoming: ${sessionTitle}`,
      contentText,
      actionText: meetingUrl ? 'Join Meeting' : 'View in Portal',
      actionUrl: meetingUrl || `${appUrl}/member/sessions.html`,
      appUrl
    })
  };
}

module.exports = renderSessionReminder;
