const EmailProvider = require('../interface');
const { logger } = require('../../../utils/logger');

// ─── Generic HTTP Email Provider ──────────────────────────────────────
// One provider for whichever REST email API the deployment has a key for,
// configured entirely from the environment rather than from code.
//
// It exists because the shape of "send an email" is nearly the same everywhere
// — POST some JSON to a URL with an API key in a header — and the differences
// between vendors are mostly what they call the four fields. Writing a class
// per vendor to express "they say `html_body` where you say `html`" is a lot of
// files that all do the same thing.
//
// What it covers: the flat-payload APIs. Resend, Postmark, Brevo, MailerSend
// and most smaller services take a single object with recipient, sender,
// subject and body at the top level, and those need nothing but env vars.
//
// What it does not cover, and says so rather than half-working: payloads whose
// structure is not flat. SendGrid nests the recipient inside
// `personalizations[0].to[0].email`; Mailgun takes form encoding rather than
// JSON. Those need a real provider of their own — the interface is small, and
// providers/simpu.js is the worked example.

const TRUE = new Set(['1', 'true', 'yes', 'on']);

class HttpEmailProvider extends EmailProvider {
  constructor(config = {}) {
    super('http', config);

    this.url = config.url || null;
    this.method = (config.method || 'POST').toUpperCase();
    this.apiKey = config.apiKey || null;

    // How the key is presented. The two conventions between them cover almost
    // everything: `Authorization: Bearer <key>`, and a vendor-specific header
    // holding the bare key (Postmark's X-Postmark-Server-Token, Brevo's api-key).
    this.authHeader = config.authHeader || 'Authorization';
    this.authScheme = config.authScheme === '' ? '' : (config.authScheme || 'Bearer');

    // What the vendor calls each of the things we have to send.
    this.fields = {
      to: config.fieldTo || 'to',
      from: config.fieldFrom || 'from',
      subject: config.fieldSubject || 'subject',
      html: config.fieldHtml || 'html',
      text: config.fieldText || 'text',
      replyTo: config.fieldReplyTo || 'reply_to'
    };

    // Some APIs want the sender as "Name <address>", others as the bare
    // address and the name in a separate field they may not have.
    this.fromWithName = config.fromWithName !== false;

    // A recipient as a bare string or as a list. Resend takes either; a few
    // insist on an array.
    this.toAsArray = Boolean(config.toAsArray);

    // Anything else the vendor requires on every send — a template id, a
    // message stream, a domain. Parsed from JSON so it can hold nested values
    // that the flat field mapping cannot express.
    this.extra = config.extra || {};

    // Where the vendor puts the id of the message it just accepted, so a
    // delivery row can carry something that can be looked up on their side.
    this.refPath = config.refPath || 'id';

    this.fromEmail = config.fromEmail || null;
    this.fromName = config.fromName || null;
    this.replyTo = config.replyTo || null;
  }

  isConfigured() {
    return Boolean(this.url && this.apiKey);
  }

  getCapabilities() {
    return {
      html: true,
      // Templates and batching are vendor features this cannot speak to
      // generically. A provider that claimed them would be lying to whatever
      // asked.
      templates: false,
      otp: false,
      batch: false
    };
  }

  // A dotted path into the vendor's response — `id`, `data.id`, `MessageID`.
  static read(body, path) {
    return String(path).split('.').reduce(
      (value, key) => (value && typeof value === 'object' ? value[key] : undefined),
      body
    );
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
        provider: 'http',
        ref: null,
        error: 'Generic email provider not configured (EMAIL_HTTP_URL and EMAIL_HTTP_API_KEY required)'
      };
    }

    if (!to) {
      return { status: 'failed', provider: 'http', ref: null, error: 'Recipient email address ("to") is required' };
    }

    const address = from || this.fromEmail;
    const name = fromName || this.fromName;

    const payload = {
      ...this.extra,
      [this.fields.to]: this.toAsArray ? [].concat(to) : (Array.isArray(to) ? to.join(',') : String(to)),
      [this.fields.from]: this.fromWithName && name ? `${name} <${address}>` : address,
      [this.fields.subject]: subject
    };

    if (html) payload[this.fields.html] = html;
    if (text) payload[this.fields.text] = text;

    const reply = replyTo || this.replyTo;
    if (reply) payload[this.fields.replyTo] = reply;

    try {
      const headers = { 'Content-Type': 'application/json' };
      headers[this.authHeader] = this.authScheme ? `${this.authScheme} ${this.apiKey}` : this.apiKey;

      const res = await fetch(this.url, {
        method: this.method,
        headers,
        body: JSON.stringify(payload)
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        // The vendor's own words where it has any, because "HTTP 422" is not
        // something an operator can act on.
        const message = body?.message || body?.error?.message || body?.error || body?.Message || `HTTP ${res.status}`;
        logger.warn('Email send failed', { provider: 'http', status: res.status, error: message, to });
        return { status: 'failed', provider: 'http', ref: null, error: `Email provider responded: ${message}` };
      }

      const ref = HttpEmailProvider.read(body, this.refPath);
      return { status: 'sent', provider: 'http', ref: ref ? String(ref) : null, error: null };
    } catch (err) {
      logger.error('Email delivery exception', { provider: 'http', error: err.message, to });
      return { status: 'failed', provider: 'http', ref: null, error: err.message };
    }
  }
}

module.exports = HttpEmailProvider;
module.exports.TRUE = TRUE;
