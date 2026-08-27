// ─── Email Layout & Branding ──────────────────────────────────────────
// Responsive HTML email wrapper and plain text converter grounded in
// the Credit Direct brand system.

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wraps content in a responsive, cross-client email template.
 * Uses Credit Direct brand tokens:
 * - Primary: Denim blue (#107EBC)
 * - Dark blue: #0B5A8A
 * - Accent: Harvest gold (#E6B473)
 * - Text: #1E293B (slate-800) / #64748B (slate-500)
 * - Canvas: #F8FAFC (slate-50)
 */
function wrapLayout({
  title,
  previewText = '',
  contentHtml,
  actionText = null,
  actionUrl = null,
  footerNote = null,
  appUrl = 'https://devcircle.creditdirect.ng',
  supportEmail = 'devrelations@creditdirect.ng'
}) {
  const safeTitle = escapeHtml(title || 'Credit Direct Dev Circle');
  const safePreview = escapeHtml(previewText || title || '');

  const actionBlock = (actionText && actionUrl) ? `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 28px 0 20px 0;">
      <tr>
        <td align="left">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${escapeHtml(actionUrl)}" style="height:44px;v-text-anchor:middle;width:200px;" arcsize="14%" stroke="f" fillcolor="#107EBC">
            <w:anchorlock/>
            <center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:bold;">${escapeHtml(actionText)}</center>
          </v:roundrect>
          <![endif]-->
          <a href="${escapeHtml(actionUrl)}" target="_blank" style="background-color: #107EBC; border-radius: 6px; color: #FFFFFF; display: inline-block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; line-height: 44px; text-align: center; text-decoration: none; padding: 0 28px; -webkit-text-size-adjust: none; mso-hide: all; box-shadow: 0 1px 2px rgba(16, 126, 188, 0.2);">
            ${escapeHtml(actionText)} &rarr;
          </a>
        </td>
      </tr>
    </table>
    <div style="font-size: 12px; color: #64748B; word-break: break-all; margin-bottom: 16px;">
      Or copy this link into your browser: <br>
      <a href="${escapeHtml(actionUrl)}" style="color: #107EBC; text-decoration: underline;">${escapeHtml(actionUrl)}</a>
    </div>
  ` : '';

  const safeFooterNote = footerNote
    ? `<div style="padding-top: 14px; border-top: 1px solid #E2E8F0; font-size: 12px; color: #64748B; line-height: 1.5;">${escapeHtml(footerNote)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${safeTitle}</title>
  <!--[if mso]>
  <style type="text/css">
    table, td, div, p, a, span { font-family: Arial, sans-serif !important; }
  </style>
  <![endif]-->
  <style type="text/css">
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; max-width: 100% !important; border-radius: 0 !important; }
      .email-padding { padding: 24px 20px !important; }
      .email-header { padding: 20px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #F1F5F9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; color: #1E293B;">
  <!-- Preheader text for inbox preview -->
  <div style="display: none; font-size: 1px; color: #F1F5F9; line-height: 1px; max-height: 0px; max-width: 0px; opacity: 0; overflow: hidden; mso-hide: all;">
    ${safePreview}
  </div>

  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F1F5F9; padding: 32px 0;">
    <tr>
      <td align="center">
        <!-- Main Email Container -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" class="email-container" style="max-width: 580px; background-color: #FFFFFF; border-radius: 10px; overflow: hidden; border: 1px solid #E2E8F0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);">

          <!-- Header Banner -->
          <tr>
            <td class="email-header" style="background: linear-gradient(135deg, #0B5A8A 0%, #107EBC 100%); padding: 28px 32px; border-bottom: 3px solid #E6B473;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <div style="font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #E6B473; margin-bottom: 4px;">
                      Credit Direct
                    </div>
                    <div style="font-size: 22px; font-weight: 800; color: #FFFFFF; letter-spacing: -0.02em;">
                      Dev Circle
                    </div>
                  </td>
                  <td align="right" style="vertical-align: middle;">
                    <span style="display: inline-block; background-color: rgba(255, 255, 255, 0.15); color: #FFFFFF; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 9999px; letter-spacing: 0.04em;">
                      Developer Ecosystem
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Body -->
          <tr>
            <td class="email-padding" style="padding: 36px 32px 28px 32px;">
              <h1 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #0F172A; line-height: 1.35; letter-spacing: -0.01em;">
                ${safeTitle}
              </h1>

              <div style="font-size: 15px; line-height: 1.6; color: #334155;">
                ${contentHtml}
              </div>

              ${actionBlock}
              ${safeFooterNote}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F8FAFC; padding: 24px 32px; border-top: 1px solid #E2E8F0; font-size: 12px; color: #64748B; line-height: 1.6;">
              <div style="margin-bottom: 8px;">
                <strong>Credit Direct Dev Circle</strong> &middot; Engagement and feedback for developers integrating Credit Direct APIs.
              </div>
              <div style="margin-bottom: 8px;">
                You are receiving this email because you are a registered participant or administrator in the Credit Direct developer community.
              </div>
              <div style="font-size: 11px; color: #94A3B8;">
                <a href="${escapeHtml(appUrl)}/member/notifications.html" style="color: #107EBC; text-decoration: underline;">Notification Preferences</a> &middot;
                <a href="${escapeHtml(appUrl)}" style="color: #107EBC; text-decoration: underline;">Portal</a> &middot;
                <a href="mailto:${escapeHtml(supportEmail)}" style="color: #107EBC; text-decoration: underline;">Support</a>
              </div>
              <div style="margin-top: 12px; font-size: 11px; color: #94A3B8;">
                &copy; ${new Date().getFullYear()} Credit Direct Limited. All rights reserved.
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Converts formatted text / HTML blocks into clean plain text.
 */
function toPlainText({ title, contentText, actionText = null, actionUrl = null, footerNote = null, appUrl = 'https://devcircle.creditdirect.ng' }) {
  const lines = [
    'CREDIT DIRECT DEV CIRCLE',
    '========================',
    '',
    title ? title.toUpperCase() : '',
    '',
    contentText || '',
    ''
  ];

  if (actionText && actionUrl) {
    lines.push(`${actionText}: ${actionUrl}`, '');
  }

  if (footerNote) {
    lines.push(footerNote, '');
  }

  lines.push(
    '----------------------------------------',
    'Credit Direct Dev Circle — Developer Ecosystem',
    `Manage preferences: ${appUrl}/member/notifications.html`,
    `Visit portal: ${appUrl}`,
    `© ${new Date().getFullYear()} Credit Direct Limited.`
  );

  return lines.filter(line => line !== null && line !== undefined).join('\n');
}

module.exports = {
  wrapLayout,
  toPlainText,
  escapeHtml
};
