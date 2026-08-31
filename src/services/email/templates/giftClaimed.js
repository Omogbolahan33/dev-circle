const { wrapLayout, toPlainText, escapeHtml } = require('./layout');

function renderGiftClaimed({
  giftName,
  giftValue = null,
  currency = 'NGN',
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
  const valDisplay = giftValue ? `${currency} ${Number(giftValue).toLocaleString()}` : null;

  const contentHtml = `
    <p style="margin-top: 0;">${greeting}</p>
    <p>Your reward claim for <strong>${escapeHtml(giftName)}</strong> has been received!</p>

    <div style="background-color: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 8px; padding: 18px; margin: 20px 0;">
      <div style="font-size: 16px; font-weight: 700; color: #166534;">🎉 Reward Claimed: ${escapeHtml(giftName)}</div>
      ${valDisplay ? `<div style="font-size: 14px; font-weight: 600; color: #15803D; margin-top: 4px;">Value: ${escapeHtml(valDisplay)}</div>` : ''}
    </div>

    <p>A member of our developer relations team will process your claim and deliver your reward shortly. Thank you for being an active part of Dev Circle!</p>
  `;

  const contentText = [
    recipientName ? `Hello ${recipientName},` : 'Hello,',
    '',
    `Your reward claim for "${giftName}" has been received!`,
    valDisplay ? `Value: ${valDisplay}` : '',
    '',
    'A member of our developer relations team will process your claim and deliver your reward shortly.',
    '',
    `Thank you for being an active part of Credit Direct Dev Circle!`
  ].filter(Boolean).join('\n');

  return {
    subject: subjectOverride || `Gift claimed: ${giftName}`,
    previewText: `Your claim for ${giftName} has been received`,
    html: wrapLayout({
      intro,
      outro,
      brand,
      title: subjectOverride || `Reward Claim: ${giftName}`,
      previewText: `Your claim for ${giftName} has been received`,
      contentHtml: bodyHtml || contentHtml,
      actionText: 'View Your Profile & Rewards',
      actionUrl: `${appUrl}/member/profile.html`,
      appUrl
    }),
    text: toPlainText({
      intro,
      outro,
      brand,
      title: subjectOverride || `Reward Claim: ${giftName}`,
      contentText,
      actionText: 'View Your Profile & Rewards',
      actionUrl: `${appUrl}/member/profile.html`,
      appUrl
    })
  };
}

module.exports = renderGiftClaimed;
