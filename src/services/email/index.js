const config = require('../../config');
const dbContext = require('../../db/context');
const { logger } = require('../../utils/logger');
const { renderTemplate } = require('./templates');
const { resolveWorkflow } = require('./workflows');
const TermiiEmailProvider = require('./providers/termii');
const SimpuEmailProvider = require('./providers/simpu');
const CustomerIoEmailProvider = require('./providers/customerio');
const SimulatedEmailProvider = require('./providers/simulated');

// ─── Email Service ────────────────────────────────────────────────────
// High-level emailing interface for Dev Circle invitations and communications.
//
// Supports external providers (Termii, Simpu, Customer.io) and simulated delivery
// in sandboxes and test suites. Transparently renders branded HTML & plain-text
// templates for surveys, sessions, staff invites, sign-in codes, and blasts.

class EmailService {
  constructor() {
    this.providers = new Map();
    this.simulatedProvider = new SimulatedEmailProvider();

    // Initialise built-in providers
    this.registerProvider('termii', new TermiiEmailProvider(config.email?.termii));
    this.registerProvider('simpu', new SimpuEmailProvider(config.email?.simpu));
    this.registerProvider('customer_io', new CustomerIoEmailProvider(config.delivery));
    this.registerProvider('simulated', this.simulatedProvider);
  }

  /**
   * Registers a provider instance.
   * @param {string} name
   * @param {EmailProvider} provider
   */
  registerProvider(name, provider) {
    this.providers.set(name.toLowerCase(), provider);
  }

  /**
   * Retrieves a registered provider by name.
   * @param {string} name
   * @returns {EmailProvider|null}
   */
  getProvider(name) {
    return this.providers.get(String(name).toLowerCase()) || null;
  }

  /**
   * Determines which provider is active for the current context.
   * Sandbox mode always uses simulated provider.
   * Otherwise respects config.email.provider or falls back in priority order.
   *
   * @returns {EmailProvider}
   */
  getActiveProvider() {
    // 1. Sandbox isolation: never hit third-party APIs from the sandbox
    if (dbContext.inSandbox()) {
      return this.simulatedProvider;
    }

    const preferred = (config.email?.provider || 'auto').toLowerCase();

    // 2. Explicit provider choice
    if (preferred !== 'auto') {
      const p = this.getProvider(preferred);
      if (p && p.isConfigured()) return p;
      if (preferred === 'simulated') return this.simulatedProvider;
      // If preferred is configured but missing credentials, fall through to auto/simulated
    }

    // 3. Auto-detection: Termii -> Simpu -> Customer.io -> Simulated
    const termii = this.getProvider('termii');
    if (termii && termii.isConfigured()) return termii;

    const simpu = this.getProvider('simpu');
    if (simpu && simpu.isConfigured()) return simpu;

    const cio = this.getProvider('customer_io');
    if (cio && cio.isConfigured()) return cio;

    return this.simulatedProvider;
  }

  /**
   * Returns the name of the active provider.
   * @returns {string}
   */
  getActiveProviderName() {
    return this.getActiveProvider().getName();
  }

  /**
   * Returns summary status of all providers.
   * @returns {object}
   */
  getStatus() {
    const active = this.getActiveProvider();
    const providersList = [];

    for (const [name, provider] of this.providers.entries()) {
      providersList.push({
        id: name,
        name: provider.getName(),
        configured: provider.isConfigured(),
        active: provider === active,
        capabilities: provider.getCapabilities()
      });
    }

    return {
      active_provider: active.getName(),
      from_email: config.email?.fromEmail || 'devcircle@creditdirect.ng',
      from_name: config.email?.fromName || 'Credit Direct Dev Circle',
      providers: providersList
    };
  }

  /**
   * Dispatches an email, resolving templates and active providers.
   */
  async send({
    to,
    subject = null,
    body = null,
    html = null,
    text = null,
    template = null,
    templateData = {},
    category = 'platform_updates',
    actionText = null,
    actionUrl = null,
    from = null,
    fromName = null,
    replyTo = null,
    templateId = null,
    variables = {},
    metadata = {}
  }) {
    if (!to) {
      throw new Error('EmailService.send() requires a recipient address ("to")');
    }

    let finalSubject = subject;
    let finalHtml = html;
    let finalText = text;

    // Resolve template if specified
    if (template) {
      const rendered = renderTemplate(template, {
        appUrl: config.appUrl,
        title: subject,
        body,
        actionText,
        actionUrl,
        ...templateData
      });

      if (!finalSubject) finalSubject = rendered.subject;
      if (!finalHtml) finalHtml = rendered.html;
      if (!finalText) finalText = rendered.text;
    } else if (!finalHtml && body) {
      // Wrap bare body in standard layout
      const rendered = renderTemplate('generic', {
        appUrl: config.appUrl,
        title: finalSubject || 'Credit Direct Dev Circle',
        body,
        actionText,
        actionUrl
      });
      finalHtml = rendered.html;
      finalText = rendered.text;
    }

    if (!finalSubject) {
      finalSubject = 'Notification from Credit Direct Dev Circle';
    }

    const provider = this.getActiveProvider();

    const result = await provider.send({
      to,
      subject: finalSubject,
      html: finalHtml,
      text: finalText,
      from: from || config.email?.fromEmail,
      fromName: fromName || config.email?.fromName,
      replyTo: replyTo || config.email?.replyTo,
      templateId,
      variables: {
        ...templateData,
        ...variables
      },
      category,
      metadata: {
        ...metadata,
        actionUrl
      }
    });

    return result;
  }

  /**
   * Sends a survey invitation email.
   */
  async sendSurveyInvite({
    to,
    recipientName = null,
    surveyTitle,
    surveyDescription = null,
    timeEstimateMin = 3,
    questionCount = null,
    surveyUrl,
    metadata = {}
  }) {
    return this.send({
      to,
      template: 'survey_invite',
      category: 'survey_invites',
      actionUrl: surveyUrl,
      templateData: {
        recipientName,
        surveyTitle,
        surveyDescription,
        timeEstimateMin,
        questionCount,
        surveyUrl
      },
      metadata
    });
  }

  /**
   * Sends a survey reminder email.
   */
  async sendSurveyReminder({
    to,
    recipientName = null,
    surveyTitle,
    surveyUrl,
    metadata = {}
  }) {
    return this.send({
      to,
      template: 'survey_reminder',
      category: 'survey_reminders',
      actionUrl: surveyUrl,
      templateData: {
        recipientName,
        surveyTitle,
        surveyUrl
      },
      metadata
    });
  }

  /**
   * Sends a session / office hours / workshop invitation.
   */
  async sendSessionInvite({
    to,
    recipientName = null,
    sessionTitle,
    sessionDescription = null,
    scheduledAt = null,
    sessionTime = null,
    meetingUrl = null,
    metadata = {}
  }) {
    return this.send({
      to,
      template: 'session_invite',
      category: 'survey_invites',
      actionUrl: meetingUrl,
      templateData: {
        recipientName,
        sessionTitle,
        sessionDescription,
        scheduledAt,
        sessionTime,
        meetingUrl
      },
      metadata
    });
  }

  /**
   * Sends a session reminder email.
   */
  async sendSessionReminder({
    to,
    recipientName = null,
    sessionTitle,
    scheduledAt = null,
    sessionTime = null,
    meetingUrl = null,
    metadata = {}
  }) {
    return this.send({
      to,
      template: 'session_reminder',
      category: 'survey_reminders',
      actionUrl: meetingUrl,
      templateData: {
        recipientName,
        sessionTitle,
        scheduledAt,
        sessionTime,
        meetingUrl
      },
      metadata
    });
  }

  /**
   * Sends a staff administrator invitation email with temporary password.
   */
  async sendStaffInvite({
    to,
    recipientName,
    roleName,
    temporaryPassword,
    invitedByName,
    loginUrl = null,
    metadata = {}
  }) {
    return this.send({
      to,
      template: 'staff_invite',
      category: 'staff_invite',
      actionUrl: loginUrl || `${config.appUrl}/admin/login`,
      templateData: {
        recipientName,
        email: to,
        roleName,
        temporaryPassword,
        invitedByName,
        loginUrl: loginUrl || `${config.appUrl}/admin/login`
      },
      metadata
    });
  }

  /**
   * Sends a participant one-time sign-in code (OTP).
   */
  async sendLoginCode({
    to,
    recipientName = null,
    code,
    expiresInMinutes = 10,
    metadata = {}
  }) {
    return this.send({
      to,
      template: 'login_code',
      category: 'login_code',
      templateData: {
        code,
        recipientName,
        expiresInMinutes
      },
      variables: { code },
      metadata
    });
  }

  /**
   * Sends a broadcast announcement email.
   */
  async sendBlast({
    to,
    recipientName = null,
    subject,
    title = null,
    content,
    actionText = null,
    actionUrl = null,
    metadata = {}
  }) {
    return this.send({
      to,
      subject,
      template: 'blast',
      category: 'platform_updates',
      actionText,
      actionUrl,
      templateData: {
        subject,
        title,
        content,
        recipientName,
        actionText,
        actionUrl
      },
      metadata
    });
  }

  /**
   * Adapts a notification dispatch (from the notifications service) into a
   * branded email. The template and its data are resolved in one place —
   * workflows.js — so a session announcement uses the session template (not
   * the survey one), a gift email never renders "undefined", and a sign-in
   * code uses the code template, regardless of which category the caller used.
   */
  async sendNotificationEmail({ user, message }) {
    const to = message.to || user.email;
    if (!to) {
      return { status: 'failed', ref: null, error: 'No email address on file for user' };
    }

    const { template, subject, templateData } = resolveWorkflow(message, user);

    return this.send({
      to,
      subject,
      template,
      templateData,
      category: message.category || 'platform_updates',
      actionUrl: message.action_url,
      metadata: {
        notificationId: message.notification_id,
        userId: user.id,
        workflow: message.workflow || null
      }
    });
  }

  /**
   * Sends a test email to verify credentials and connectivity.
   */
  async sendTestEmail({ to, providerName = null }) {
    const provider = providerName
      ? this.getProvider(providerName)
      : this.getActiveProvider();

    if (!provider) {
      return { status: 'failed', error: `Unknown provider "${providerName}"` };
    }

    if (!provider.isConfigured() && provider.getName() !== 'simulated') {
      return {
        status: 'failed',
        error: `Provider "${provider.getName()}" is not configured with credentials`
      };
    }

    const testTime = new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
    const rendered = renderTemplate('generic', {
      appUrl: config.appUrl,
      title: 'Dev Circle — Email Interface Test',
      body: `This is a test communication sent via provider: ${provider.getName().toUpperCase()} at ${testTime} WAT.\n\n` +
            'If you received this message, the email interface and provider credentials are configured and 100% operational.',
      actionText: 'Open Dev Circle Portal',
      actionUrl: config.appUrl
    });

    const result = await provider.send({
      to,
      subject: `[Test] Dev Circle Email Delivery (${provider.getName()})`,
      html: rendered.html,
      text: rendered.text,
      from: config.email?.fromEmail,
      fromName: config.email?.fromName,
      category: 'platform_updates',
      metadata: { isTest: true }
    });

    return {
      ...result,
      provider: provider.getName()
    };
  }

  /**
   * Access the simulated queue (for testing)
   */
  getSimulatedQueue() {
    return this.simulatedProvider.getSent();
  }

  clearSimulatedQueue() {
    this.simulatedProvider.clear();
  }
}

// Export singleton instance
const emailService = new EmailService();
module.exports = emailService;
module.exports.EmailService = EmailService;
