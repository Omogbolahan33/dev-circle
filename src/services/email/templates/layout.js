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
// ─── A circle's own colours, in the mail ─────────────────────
// The console paints itself with a circle's brand; an invite from that circle
// arriving in Denim blue would be the odd one out. Only what a circle actually
// sets is honoured — accent and logo — and everything derived from it (the
// darker header stop, the text that sits on it) is computed rather than asked
// for, because a circle chooses one colour, not a palette.
//
// With no brand passed, every value below resolves to the literal that used to
// be written into the markup, so an unbranded circle's mail is unchanged.

const DEFAULT_BRAND = {
  name: 'Dev Circle',
  organisation: 'Credit Direct',
  accent: '#107EBC',
  accentDeep: '#0B5A8A',
  gold: '#E6B473',
  logoUrl: null
};

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
}

function normalizeHex(value) {
  const rgb = hexToRgb(value);
  if (!rgb) return null;
  return '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// The second stop of the header gradient. Mixed toward black rather than
// picked, so any accent gets a header that reads as one colour.
function darken(hex, amount) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return '#' + rgb.map(c => Math.round(c * (1 - amount)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// White or near-black on the header, decided by the colour rather than assumed.
// A circle that brands itself in pale gold would otherwise get white on cream.
function inkOn(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#FFFFFF';
  const [r, g, b] = rgb.map(c => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.45 ? '#12203A' : '#FFFFFF';
}

// "Credit Direct Dev Circle", but not "Kuda Kuda Engineering" — a circle whose
// name already carries the organisation is not introduced twice.
function fullName(b) {
  return b.organisation && !b.name.toLowerCase().includes(b.organisation.toLowerCase())
    ? `${b.organisation} ${b.name}`
    : b.name;
}

function resolveBrand(brand) {
  if (!brand) return DEFAULT_BRAND;
  const accent = normalizeHex(brand.accent) || DEFAULT_BRAND.accent;
  return {
    name: brand.name || DEFAULT_BRAND.name,
    organisation: brand.organisation || DEFAULT_BRAND.organisation,
    accent,
    // Keep the shipped pairing exactly when the accent is the shipped one, so
    // an unbranded mail is byte-for-byte what it always was.
    accentDeep: accent === DEFAULT_BRAND.accent ? DEFAULT_BRAND.accentDeep : darken(accent, 0.3),
    gold: DEFAULT_BRAND.gold,
    logoUrl: brand.logoUrl || null
  };
}

// An admin's own words, above and below what the template says. Plain text,
// paragraph per line — never markup, because this is typed into a form.
function paragraphs(copy, colour) {
  const text = String(copy || '').trim();
  if (!text) return '';
  return text.split(/\n{2,}|\n/).map(line => line.trim()).filter(Boolean)
    .map(line => `<p style="color: ${colour};">${escapeHtml(line)}</p>`).join('\n');
}

function wrapLayout({
  title,
  previewText = '',
  contentHtml,
  // An administrator's own words, wrapped around what the template says.
  intro = null,
  outro = null,
  actionText = null,
  actionUrl = null,
  footerNote = null,
  appUrl = 'https://devcircle.creditdirect.ng',
  supportEmail = 'devrelations@creditdirect.ng',
  brand = null
}) {
  const b = resolveBrand(brand);
  const headerInk = inkOn(b.accent);
  const [ar, ag, ab] = hexToRgb(b.accent) || [16, 126, 188];

  const safeTitle = escapeHtml(title || 'Credit Direct Dev Circle');
  const safePreview = escapeHtml(previewText || title || '');
  const introHtml = paragraphs(intro, '#334155');
  const outroCopy = paragraphs(outro, '#475569');
  const outroBlock = outroCopy
    ? `\n              <div style="font-size: 15px; line-height: 1.6; color: #475569;">${outroCopy}</div>`
    : '';

  const actionBlock = (actionText && actionUrl) ? `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 28px 0 20px 0;">
      <tr>
        <td align="left">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${escapeHtml(actionUrl)}" style="height:44px;v-text-anchor:middle;width:200px;" arcsize="14%" stroke="f" fillcolor="${b.accent}">
            <w:anchorlock/>
            <center style="color:${headerInk === '#FFFFFF' ? '#ffffff' : headerInk};font-family:sans-serif;font-size:15px;font-weight:bold;">${escapeHtml(actionText)}</center>
          </v:roundrect>
          <![endif]-->
          <a href="${escapeHtml(actionUrl)}" target="_blank" style="background-color: ${b.accent}; border-radius: 6px; color: ${headerInk}; display: inline-block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; line-height: 44px; text-align: center; text-decoration: none; padding: 0 28px; -webkit-text-size-adjust: none; mso-hide: all; box-shadow: 0 1px 2px rgba(${ar}, ${ag}, ${ab}, 0.2);">
            ${escapeHtml(actionText)} &rarr;
          </a>
        </td>
      </tr>
    </table>
    <div style="font-size: 12px; color: #64748B; word-break: break-all; margin-bottom: 16px;">
      Or copy this link into your browser: <br>
      <a href="${escapeHtml(actionUrl)}" style="color: ${b.accent}; text-decoration: underline;">${escapeHtml(actionUrl)}</a>
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
            <td class="email-header" style="background: linear-gradient(135deg, ${b.accentDeep} 0%, ${b.accent} 100%); padding: 28px 32px; border-bottom: 3px solid ${b.gold};">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    ${b.logoUrl ? `<img src="${escapeHtml(b.logoUrl)}" alt="${escapeHtml(b.name)}" height="30" style="height:30px;width:auto;display:block;border:0;">` : `<div style="font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: ${b.gold}; margin-bottom: 4px;">
                      ${escapeHtml(b.organisation)}
                    </div>
                    <div style="font-size: 22px; font-weight: 800; color: ${headerInk}; letter-spacing: -0.02em;">
                      ${escapeHtml(b.name)}
                    </div>`}
                  </td>
                  <td align="right" style="vertical-align: middle;">
                    <span style="display: inline-block; background-color: rgba(255, 255, 255, 0.15); color: ${headerInk}; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 9999px; letter-spacing: 0.04em;">
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
                ${introHtml}${contentHtml}
              </div>

              ${actionBlock}${outroBlock}
              ${safeFooterNote}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F8FAFC; padding: 24px 32px; border-top: 1px solid #E2E8F0; font-size: 12px; color: #64748B; line-height: 1.6;">
              <div style="margin-bottom: 8px;">
                <strong>${escapeHtml(fullName(b))}</strong> &middot; Engagement and feedback for developers integrating ${escapeHtml(b.organisation)} APIs.
              </div>
              <div style="margin-bottom: 8px;">
                You are receiving this email because you are a registered participant or administrator in the ${escapeHtml(b.organisation)} developer community.
              </div>
              <div style="font-size: 11px; color: #94A3B8;">
                <a href="${escapeHtml(appUrl)}/member/notifications.html" style="color: #107EBC; text-decoration: underline;">Notification Preferences</a> &middot;
                <a href="${escapeHtml(appUrl)}" style="color: #107EBC; text-decoration: underline;">Portal</a> &middot;
                <a href="mailto:${escapeHtml(supportEmail)}" style="color: #107EBC; text-decoration: underline;">Support</a>
              </div>
              <div style="margin-top: 12px; font-size: 11px; color: #94A3B8;">
                &copy; ${new Date().getFullYear()} ${escapeHtml(b.organisation)} Limited. All rights reserved.
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
function toPlainText({ title, contentText, intro = null, outro = null, actionText = null, actionUrl = null, footerNote = null, appUrl = 'https://devcircle.creditdirect.ng', brand = null }) {
  const b = resolveBrand(brand);
  const banner = fullName(b).toUpperCase();
  const introText = String(intro || '').trim();
  const outroText = String(outro || '').trim();

  const lines = [
    banner,
    '='.repeat(banner.length),
    '',
    title ? title.toUpperCase() : '',
    ''
  ];

  if (introText) lines.push(introText, '');

  lines.push(contentText || '', '');

  if (actionText && actionUrl) {
    lines.push(`${actionText}: ${actionUrl}`, '');
  }

  if (outroText) lines.push(outroText, '');

  if (footerNote) {
    lines.push(footerNote, '');
  }

  lines.push(
    '----------------------------------------',
    `${b.organisation} ${b.name} — Developer Ecosystem`,
    `Manage preferences: ${appUrl}/member/notifications.html`,
    `Visit portal: ${appUrl}`,
    `© ${new Date().getFullYear()} ${b.organisation} Limited.`
  );

  return lines.filter(line => line !== null && line !== undefined).join('\n');
}

module.exports = {
  wrapLayout,
  toPlainText,
  escapeHtml
};
