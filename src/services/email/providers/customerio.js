const EmailProvider = require('../interface');
const { logger } = require('../../../utils/logger');

// ─── Customer.io Email Provider ───────────────────────────────────────
// Dispatches outbound transactional emails via Customer.io API triggers.
// Maintained for backward-compatibility with existing platform blueprints.

class CustomerIoEmailProvider extends EmailProvider {
  constructor(config = {}) {
    super('customer_io', config);
    this.siteId = config.siteId || process.env.CUSTOMERIO_SITE_ID || null;
    this.apiKey = config.apiKey || process.env.CUSTOMERIO_API_KEY || null;
    this.baseUrl = (config.baseUrl || 'https://api.customer.io/v1').replace(/\/+$/, '');
  }

  isConfigured() {
    return Boolean(this.siteId && this.apiKey);
  }

  getCapabilities() {
    return {
      html: true,
      templates: true,
      otp: false,
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
        provider: 'customer_io',
        ref: null,
        error: 'Customer.io credentials not configured (CUSTOMERIO_SITE_ID and CUSTOMERIO_API_KEY required)'
      };
    }

    if (!to) {
      return { status: 'failed', provider: 'customer_io', ref: null, error: 'Recipient email address ("to") is required' };
    }

    try {
      const endpoint = `${this.baseUrl}/send/triggers`;
      const transactionalMessageId = templateId || category || 'platform_updates';

      const payload = {
        transactional_message_id: transactionalMessageId,
        identifiers: { email: to },
        to,
        message_data: {
          title: subject,
          subject,
          body: text || html || '',
          html,
          action_url: metadata?.actionUrl || null,
          ...variables
        }
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const errMsg = data?.meta?.error || data?.message || `HTTP ${res.status}`;
        logger.warn('Customer.io email send failed', { status: res.status, error: errMsg, to });
        return { status: 'failed', provider: 'customer_io', ref: null, error: `Customer.io responded: ${errMsg}` };
      }

      const ref = data.delivery_id || data.id || null;
      return { status: 'sent', provider: 'customer_io', ref, error: null };
    } catch (err) {
      logger.error('Customer.io email delivery exception', { error: err.message, to });
      return { status: 'failed', provider: 'customer_io', ref: null, error: err.message };
    }
  }
}

module.exports = CustomerIoEmailProvider;
