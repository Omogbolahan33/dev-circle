const EmailProvider = require('../interface');
const { logger } = require('../../../utils/logger');
const { brand } = require('../../../config');

// ─── Simpu Email Provider ─────────────────────────────────────────────
// Dispatches outbound emails via Simpu's customer communication platform.
// Simpu provides modern omnichannel messaging and transactional email APIs.
//
// Endpoint: POST https://api.simpu.co/email/send

class SimpuEmailProvider extends EmailProvider {
  constructor(config = {}) {
    super('simpu', config);
    this.apiKey = config.apiKey || process.env.SIMPU_API_KEY || null;
    this.senderId = config.senderId || process.env.SIMPU_SENDER_ID || process.env.EMAIL_FROM || 'devcircle@creditdirect.ng';
    this.fromName = config.fromName || process.env.SIMPU_FROM_NAME || process.env.EMAIL_FROM_NAME || `${brand.full}`;
    this.baseUrl = (config.baseUrl || process.env.SIMPU_BASE_URL || 'https://api.simpu.co').replace(/\/+$/, '');
    this.replyTo = config.replyTo || process.env.EMAIL_REPLY_TO || 'devrelations@creditdirect.ng';
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  getCapabilities() {
    return {
      html: true,
      templates: true,
      otp: false,
      batch: true
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
        provider: 'simpu',
        ref: null,
        error: 'Simpu credentials not configured (SIMPU_API_KEY required)'
      };
    }

    if (!to) {
      return { status: 'failed', provider: 'simpu', ref: null, error: 'Recipient email address ("to") is required' };
    }

    try {
      const endpoint = `${this.baseUrl}/email/send`;
      const recipientList = Array.isArray(to) ? to.join(',') : String(to);

      const payload = {
        recipients: recipientList,
        sender_id: from || this.senderId,
        from_name: fromName || this.fromName,
        subject,
        content: html || text || '',
        reply_to: replyTo || this.replyTo
      };

      if (metadata?.referenceId || metadata?.notificationId) {
        payload.external_ref = String(metadata.referenceId || metadata.notificationId);
      }

      if (templateId) {
        payload.template_id = templateId;
      }

      if (variables && Object.keys(variables).length > 0) {
        payload.personalisation = [
          {
            to: Array.isArray(to) ? to[0] : to,
            substitutions: variables
          }
        ];
      }

      const authHeader = this.apiKey.startsWith('Bearer ') ? this.apiKey : `Bearer ${this.apiKey}`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const errMsg = data?.message || data?.error || `HTTP ${res.status}`;
        logger.warn('Simpu email send failed', { status: res.status, error: errMsg, to });
        return { status: 'failed', provider: 'simpu', ref: null, error: `Simpu responded: ${errMsg}` };
      }

      const ref = data.data?.id || data.id || data.external_ref || 'simpu_sent';
      return { status: 'sent', provider: 'simpu', ref, error: null };
    } catch (err) {
      logger.error('Simpu email delivery exception', { error: err.message, to });
      return { status: 'failed', provider: 'simpu', ref: null, error: err.message };
    }
  }
}

module.exports = SimpuEmailProvider;
