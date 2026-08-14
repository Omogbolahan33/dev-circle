const crypto = require('crypto');
const config = require('../config');

// ─── Structured logging ─────────────────────────────────────
// One line per event. JSON in production so a log shipper can parse it;
// readable text in development so a person can. Every log call goes through
// redaction, because request bodies routinely carry passwords and API keys.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const threshold = LEVELS[process.env.LOG_LEVEL] ??
  (process.env.DEVCIRCLE_QUIET === '1' ? LEVELS.silent : LEVELS.info);

// Field names whose values must never reach a log, wherever they appear
const SECRET_KEYS = new Set([
  'password', 'new_password', 'password_hash', 'token', 'hub_token',
  'api_key', 'apikey', 'authorization', 'x-api-key', 'key', 'key_hash',
  'secret', 'temp_password', 'xlsx_base64', 'csv'
]);

function redact(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.length > 20
      ? [...value.slice(0, 20).map(v => redact(v, depth + 1)), `…${value.length - 20} more`]
      : value.map(v => redact(v, depth + 1));
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SECRET_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }

  // Long strings are almost always payloads; keep the shape, drop the bulk
  if (typeof value === 'string' && value.length > 500) {
    return value.slice(0, 500) + `…[${value.length} chars]`;
  }

  return value;
}

const COLOURS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

function emit(level, message, fields = {}) {
  if (LEVELS[level] < threshold) return;

  const safe = redact(fields);
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;

  if (config.isProduction) {
    stream.write(JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...safe
    }) + '\n');
    return;
  }

  const extras = Object.entries(safe)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');

  stream.write(`${COLOURS[level] || ''}${level.padEnd(5)}${RESET} ${message}${extras ? ' ' + extras : ''}\n`);
}

const logger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
  redact,

  // Bind context once so every line from a request carries the same id
  child(context) {
    return {
      debug: (msg, fields) => emit('debug', msg, { ...context, ...fields }),
      info: (msg, fields) => emit('info', msg, { ...context, ...fields }),
      warn: (msg, fields) => emit('warn', msg, { ...context, ...fields }),
      error: (msg, fields) => emit('error', msg, { ...context, ...fields })
    };
  }
};

// ─── Request logging ────────────────────────────────────────

function requestLogger() {
  return (req, res, next) => {
    // Honour an upstream id so a request can be followed across services
    req.id = req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex');
    res.setHeader('X-Request-Id', req.id);
    req.log = logger.child({ request_id: req.id });

    if (!req.path.startsWith('/api')) return next();

    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;

      // Who did it matters more than what they sent
      const actor = req.admin ? `admin:${req.admin.email}`
        : req.user ? `user:${req.user.id}`
        : req.apiKey ? `apikey:${req.apiKey.name}`
        : 'anonymous';

      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

      emit(level, `${req.method} ${req.path}`, {
        request_id: req.id,
        status: res.statusCode,
        duration_ms: Math.round(ms * 10) / 10,
        actor
      });
    });

    next();
  };
}

module.exports = { logger, requestLogger, redact, LEVELS };
