const { wrapLayout, toPlainText, escapeHtml } = require('./layout');

function renderGiftClaimed({
  giftName,
  giftValue = null,
  currency = 'NGN',
  recipientName = null,
  appUrl
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
    'Thank you for being an active part of Credit Direct Dev Circle!'
  ].filter(Boolean).join('\n');

  return {
    subject: `Gift claimed: ${giftName}`,
    previewText: `Your claim for ${giftName} has been received`,
    html: wrapLayout({
      title: `Reward Claim: ${giftName}`,
      previewText: `Your claim for ${giftName} has been received`,
      contentHtml,
      actionText: 'View Your Profile & Rewards',
      actionUrl: `${appUrl}/member/profile.html`,
      appUrl
    }),
    text: toPlainText({
      title: `Reward Claim: ${giftName}`,
      contentText,
      actionText: 'View Your Profile & Rewards',
      actionUrl: `${appUrl}/member/profile.html`,
      appUrl
    })
  };
}

module.exports = renderGiftClaimed;
