const { wrapLayout, toPlainText, escapeHtml } = require('./layout');

function renderStaffInvite({
  recipientName,
  email,
  roleName = 'Administrator',
  temporaryPassword,
  invitedByName = 'A colleague',
  loginUrl,
  appUrl
}) {
  const greeting = recipientName ? `Hello ${escapeHtml(recipientName)},` : 'Hello,';

  const contentHtml = `
    <p style="margin-top: 0;">${greeting}</p>
    <p>${escapeHtml(invitedByName)} has invited you to join the Credit Direct Dev Circle management team with the role <strong>${escapeHtml(roleName)}</strong>.</p>
    <p>Dev Circle is the central platform for developer relations, surveys, cohorts, and engagement tracking across Credit Direct APIs.</p>
    
    <div style="background-color: #F8FAFC; border: 1px solid #CBD5E1; border-radius: 8px; padding: 20px; margin: 24px 0;">
      <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #64748B; margin-bottom: 12px;">
        Your Sign-in Credentials
      </div>
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="font-size: 14px; color: #1E293B;">
        <tr>
          <td style="padding: 4px 16px 4px 0; color: #64748B; font-weight: 500;">Email:</td>
          <td style="padding: 4px 0; font-family: monospace; font-weight: 600;">${escapeHtml(email)}</td>
        </tr>
        <tr>
          <td style="padding: 4px 16px 4px 0; color: #64748B; font-weight: 500;">Temporary Password:</td>
          <td style="padding: 4px 0; font-family: monospace; font-weight: 700; color: #0F172A; background-color: #E2E8F0; padding: 4px 8px; border-radius: 4px;">${escapeHtml(temporaryPassword)}</td>
        </tr>
      </table>
    </div>

    <div style="background-color: #FEF3C7; border-left: 4px solid #F59E0B; padding: 12px 16px; border-radius: 0 6px 6px 0; font-size: 13px; color: #92400E; margin-bottom: 20px;">
      <strong>Security note:</strong> This is a temporary handover password. You will be prompted to set your own private password immediately upon your first sign in.
    </div>
  `;

  const contentText = [
    recipientName ? `Hello ${recipientName},` : 'Hello,',
    '',
    `${invitedByName} has invited you to join the Credit Direct Dev Circle management team with the role: ${roleName}.`,
    '',
    'Your sign-in credentials:',
    `Email: ${email}`,
    `Temporary Password: ${temporaryPassword}`,
    '',
    'SECURITY NOTE: This is a temporary password. You will be prompted to set your own password immediately upon sign in.',
    '',
    `Sign in here: ${loginUrl || `${appUrl}/admin/login`}`
  ].join('\n');

  const actionUrl = loginUrl || `${appUrl}/admin/login`;

  return {
    subject: `You have been invited to Credit Direct Dev Circle`,
    previewText: `Join the Credit Direct Dev Circle admin console as ${roleName}`,
    html: wrapLayout({
      title: `Dev Circle Admin Invitation`,
      previewText: `Join the Credit Direct Dev Circle admin console as ${roleName}`,
      contentHtml,
      actionText: 'Sign In to Set Password',
      actionUrl,
      appUrl
    }),
    text: toPlainText({
      title: `Dev Circle Admin Invitation`,
      contentText,
      actionText: 'Sign In to Set Password',
      actionUrl,
      appUrl
    })
  };
}

module.exports = renderStaffInvite;
