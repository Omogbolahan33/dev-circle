const { wrapLayout, toPlainText, escapeHtml } = require('./layout');

function renderGeneric({
  title,
  body,
  htmlContent = null,
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
  const displayTitle = title || `Notification from Credit Direct Dev Circle`;
  const greeting = recipientName ? `Hello ${escapeHtml(recipientName)},` : '';

  const paragraphs = htmlContent || String(body || '')
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p style="margin: 0 0 16px 0; line-height: 1.6;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

  const contentHtml = `
    ${greeting ? `<p style="margin-top: 0; font-weight: 500;">${greeting}</p>` : ''}
    <div style="font-size: 15px; color: #334155;">
      ${paragraphs || `<p>${escapeHtml(body || '')}</p>`}
    </div>
  `;

  return {
    subject: subjectOverride || displayTitle,
    previewText: body ? String(body).slice(0, 100) : displayTitle,
    html: wrapLayout({
      intro,
      outro,
      brand,
      title: subjectOverride || displayTitle,
      previewText: body ? String(body).slice(0, 100) : displayTitle,
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
      contentText: `${recipientName ? `Hello ${recipientName},\n\n` : ''}${body || ''}`,
      actionText,
      actionUrl,
      appUrl
    })
  };
}

module.exports = renderGeneric;
