const { wrapLayout, toPlainText, escapeHtml } = require('./layout');

function renderBlast({
  subject,
  title = null,
  content,
  actionText = null,
  actionUrl = null,
  recipientName = null,
  appUrl
}) {
  const displayTitle = title || subject || 'Announcement from Credit Direct Dev Circle';
  const greeting = recipientName ? `Hello ${escapeHtml(recipientName)},` : '';
  const paragraphs = String(content || '')
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p style="margin: 0 0 16px 0; line-height: 1.6;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

  const contentHtml = `
    ${greeting ? `<p style="margin-top: 0; font-weight: 500;">${greeting}</p>` : ''}
    <div style="font-size: 15px; color: #334155;">
      ${paragraphs || `<p>${escapeHtml(content || '')}</p>`}
    </div>
  `;

  return {
    subject: subject || displayTitle,
    previewText: content ? String(content).slice(0, 100) : displayTitle,
    html: wrapLayout({
      title: displayTitle,
      previewText: content ? String(content).slice(0, 100) : displayTitle,
      contentHtml,
      actionText,
      actionUrl,
      appUrl
    }),
    text: toPlainText({
      title: displayTitle,
      contentText: `${recipientName ? `Hello ${recipientName},\n\n` : ''}${content || ''}`,
      actionText,
      actionUrl,
      appUrl
    })
  };
}

module.exports = renderBlast;
