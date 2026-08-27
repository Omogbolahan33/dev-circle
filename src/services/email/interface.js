// ─── Email Provider Interface ─────────────────────────────────────────
// Base class contract that all email service providers implement.
// Guarantees consistent argument structure, return types, and error handling.

class EmailProvider {
  /**
   * @param {string} name - Internal unique provider identifier (e.g. 'termii', 'simpu', 'customer_io', 'simulated')
   * @param {object} [options] - Provider-specific configuration options
   */
  constructor(name, options = {}) {
    if (!name) throw new Error('EmailProvider requires a provider name');
    this.name = name;
    this.options = options;
  }

  /**
   * Returns whether this provider has the required configuration/secrets in the environment.
   * @returns {boolean}
   */
  isConfigured() {
    throw new Error(`isConfigured() must be implemented by provider ${this.name}`);
  }

  /**
   * Returns the provider identifier.
   * @returns {string}
   */
  getName() {
    return this.name;
  }

  /**
   * Returns provider capabilities and metadata.
   * @returns {object}
   */
  getCapabilities() {
    return {
      html: true,
      templates: false,
      otp: false,
      batch: false
    };
  }

  /**
   * Sends an email via the provider.
   * 
   * @param {object} params
   * @param {string} params.to - Recipient email address
   * @param {string} params.subject - Email subject line
   * @param {string} [params.html] - HTML body
   * @param {string} [params.text] - Plain text body
   * @param {string} [params.from] - Sender email address
   * @param {string} [params.fromName] - Sender display name
   * @param {string} [params.replyTo] - Reply-To address
   * @param {string} [params.templateId] - External template identifier if supported
   * @param {object} [params.variables] - Template dynamic variables / merge tags
   * @param {string} [params.category] - Category of communication (e.g. 'survey_invites', 'staff_invite')
   * @param {object} [params.metadata] - Additional contextual data (sourceType, sourceId, referenceId)
   * 
   * @returns {Promise<{ status: 'sent' | 'simulated' | 'failed', provider: string, ref: string | null, error: string | null }>}
   */
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
    throw new Error(`send() must be implemented by provider ${this.name}`);
  }
}

module.exports = EmailProvider;
