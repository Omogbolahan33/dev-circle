const { wrapLayout, toPlainText, escapeHtml, brand } = require('./layout');

function renderLoginCode({
  code,
  expiresInMinutes = 10,
  recipientName = null,
  appUrl
}) {
  const greeting = recipientName ? `Hello ${escapeHtml(recipientName)},` : 'Hello,';

  const contentHtml = `
    <p style="margin-top: 0;">${greeting}</p>
    <p>Use the one-time verification code below to sign in to your ${brand.product} account:</p>
    
    <div style="text-align: center; margin: 30px 0;">
      <div style="display: inline-block; background-color: #F8FAFC; border: 2px dashed #107EBC; border-radius: 8px; padding: 18px 36px; font-family: 'JetBrains Mono', monospace, Courier; font-size: 32px; font-weight: 800; letter-spacing: 0.25em; color: #0B5A8A;">
        ${escapeHtml(code)}
      </div>
      <div style="margin-top: 10px; font-size: 13px; color: #64748B;">
        Expires in <strong>${expiresInMinutes} minutes</strong>
      </div>
    </div>

    <p style="font-size: 13px; color: #64748B; line-height: 1.5;">
      If you did not request this sign-in code, someone else may have typed your email address by mistake. Your account is secure and no action is required.
    </p>
  `;

  const contentText = [
    recipientName ? `Hello ${recipientName},` : 'Hello,',
    '',
    `Use the one-time verification code below to sign in to your ${brand.product} account:`,
    '',
    `     CODE: ${code}`,
    '',
    `This code expires in ${expiresInMinutes} minutes.`,
    '',
    'If you did not request this code, you can safely ignore this email.'
  ].join('\n');

  return {
    subject: `${code} is your ${brand.product} sign-in code`,
    previewText: `${code} is your verification code for ${brand.full}`,
    html: wrapLayout({
      title: `${brand.product} Sign-In Code`,
      previewText: `${code} is your verification code`,
      contentHtml,
      appUrl
    }),
    text: toPlainText({
      title: `${brand.product} Sign-In Code`,
      contentText,
      appUrl
    })
  };
}

module.exports = renderLoginCode;
