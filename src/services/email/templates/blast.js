const { wrapLayout, toPlainText, escapeHtml } = require('./layout');

function renderBlast({
  subject,
  title = null,
  content,
  actionText = null,
  actionUrl = null,
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
  const displayTitle = title || subject || `Announcement from Credit Direct Dev Circle`;
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
    subject: subjectOverride || subject || displayTitle,
    previewText: content ? String(content).slice(0, 100) : displayTitle,
    html: wrapLayout({
      intro,
      outro,
      brand,
      title: subjectOverride || displayTitle,
      previewText: content ? String(content).slice(0, 100) : displayTitle,
      contentHtml: bodyHtml || contentHtml,
      actionText,
      actionUrl,
      appUrl
    }),
    text: toPlainText({
      intro,
      outro,
      brand,
      title: subjectOverride || displayTitle,
      contentText: `${recipientName ? `Hello ${recipientName},\n\n` : ''}${content || ''}`,
      actionText,
      actionUrl,
      appUrl
    })
  };
}

module.exports = renderBlast;
