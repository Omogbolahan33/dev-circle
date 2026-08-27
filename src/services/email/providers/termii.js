const EmailProvider = require('../interface');
const { logger } = require('../../../utils/logger');

// ─── Termii Email Provider ───────────────────────────────────────────
// Dispatches outbound emails via Termii's Messaging & Email APIs.
// Termii is widely used across African fintech and banking ecosystems.
//
// Supports:
// - Email Product Notification API: POST /api/templates/send-email
// - Email Token / OTP API: POST /api/email/otp/send
// - Generic / Direct email payload support

class TermiiEmailProvider extends EmailProvider {
  constructor(config = {}) {
    super('termii', config);
    this.apiKey = config.apiKey || process.env.TERMII_API_KEY || null;
    this.emailConfigurationId = config.emailConfigurationId || process.env.TERMII_EMAIL_CONFIGURATION_ID || null;
    this.baseUrl = (config.baseUrl || process.env.TERMII_BASE_URL || 'https://api.ng.termii.com').replace(/\/+$/, '');
    this.defaultTemplateId = config.templateId || process.env.TERMII_TEMPLATE_ID || null;
  }

  isConfigured() {
    return Boolean(this.apiKey && this.emailConfigurationId);
  }

  getCapabilities() {
    return {
      html: true,
      templates: true,
      otp: true,
      batch: false
    };
  }

  async send({
    to,
    subject,
    html = null,
    text = null,
    from = null,
    fromName = null,
    replyTo = null,
    templateId = null,
    variables = {},
    category = 'platform_updates',
    metadata = {}
  }) {
    if (!this.isConfigured()) {
      return {
        status: 'failed',
        provider: 'termii',
        ref: null,
        error: 'Termii credentials not configured (TERMII_API_KEY and TERMII_EMAIL_CONFIGURATION_ID required)'
      };
    }

    if (!to) {
      return { status: 'failed', provider: 'termii', ref: null, error: 'Recipient email address ("to") is required' };
    }

    try {
      // 1. If an OTP / sign-in code is specifically provided or category is login_code
      if ((category === 'login_code' || variables?.code) && variables?.code) {
        const otpEndpoint = `${this.baseUrl}/api/email/otp/send`;
        const otpPayload = {
          api_key: this.apiKey,
          email_address: to,
          code: String(variables.code),
          email_configuration_id: this.emailConfigurationId
        };

        const res = await fetch(otpEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(otpPayload)
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const errMsg = data?.message || data?.error || `HTTP ${res.status}`;
          logger.warn('Termii OTP send failed', { status: res.status, error: errMsg, to });
          return { status: 'failed', provider: 'termii', ref: null, error: `Termii responded: ${errMsg}` };
        }

        const ref = data.message_id || data.pinId || data.id || null;
        return { status: 'sent', provider: 'termii', ref, error: null };
      }

      // 2. Product notifications / templated send
      // Termii /api/templates/send-email requires:
      // api_key, email, subject, email_configuration_id, template_id, variables
      const resolvedTemplateId = templateId || this.defaultTemplateId;
      const sendEndpoint = resolvedTemplateId
        ? `${this.baseUrl}/api/templates/send-email`
        : `${this.baseUrl}/api/email/send`;

      const mergedVariables = {
        title: subject,
        subject,
        body: text || html || '',
        message: text || html || '',
        content: html || text || '',
        ...variables
      };

      const payload = {
        api_key: this.apiKey,
        email: to,
        subject,
        email_configuration_id: this.emailConfigurationId,
        ...(resolvedTemplateId ? { template_id: resolvedTemplateId } : {}),
        variables: mergedVariables,
        // Include fallback raw content if endpoint accepts direct message
        content: html || text || ''
      };

      const res = await fetch(sendEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const errMsg = data?.message || data?.error || `HTTP ${res.status}`;
        logger.warn('Termii email send failed', { status: res.status, error: errMsg, to });
        return { status: 'failed', provider: 'termii', ref: null, error: `Termii responded: ${errMsg}` };
      }

      const ref = data.message_id || data.id || data.reference || null;
      return { status: 'sent', provider: 'termii', ref, error: null };
    } catch (err) {
      logger.error('Termii email delivery exception', { error: err.message, to });
      return { status: 'failed', provider: 'termii', ref: null, error: err.message };
    }
  }
}

module.exports = TermiiEmailProvider;
