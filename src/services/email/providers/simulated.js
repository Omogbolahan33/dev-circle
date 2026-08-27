const EmailProvider = require('../interface');
const { uuid } = require('../../../utils/helpers');
const { logger } = require('../../../utils/logger');

// ─── Simulated Email Provider ─────────────────────────────────────────
// Used when no external credentials are configured, in the API sandbox,
// and during automated tests. Keeps an in-memory history so test suites
// can assert on outbound communications without making external network calls.

class SimulatedEmailProvider extends EmailProvider {
  constructor() {
    super('simulated');
    this.sentMessages = [];
  }

  isConfigured() {
    return true;
  }

  getCapabilities() {
    return {
      html: true,
      templates: true,
      otp: true,
      batch: true
    };
  }

  async send(params) {
    const record = {
      id: `sim_${uuid()}`,
      timestamp: new Date().toISOString(),
      to: params.to,
      subject: params.subject,
      html: params.html || null,
      text: params.text || null,
      category: params.category || 'platform_updates',
      templateId: params.templateId || null,
      variables: params.variables || {},
      metadata: params.metadata || {},
      from: params.from || null,
      fromName: params.fromName || null,
      replyTo: params.replyTo || null
    };

    this.sentMessages.push(record);

    logger.debug('Email simulated', {
      to: record.to,
      subject: record.subject,
      category: record.category,
      ref: record.id
    });

    return {
      status: 'simulated',
      provider: 'simulated',
      ref: record.id,
      error: null
    };
  }

  /**
   * Retrieves all simulated emails sent during this session.
   * @returns {Array<object>}
   */
  getSent() {
    return [...this.sentMessages];
  }

  /**
   * Retrieves the most recently simulated email.
   * @returns {object|null}
   */
  getLast() {
    return this.sentMessages[this.sentMessages.length - 1] || null;
  }

  /**
   * Clears the simulated email queue.
   */
  clear() {
    this.sentMessages = [];
  }
}

module.exports = SimulatedEmailProvider;
