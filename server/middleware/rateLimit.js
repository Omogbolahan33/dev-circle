const crypto = require('crypto');
const { logger } = require('../utils/logger');

// ─── Rate limiting ──────────────────────────────────────────
// A fixed-window counter kept in memory. That is the right size for a
// single-instance deployment; behind more than one instance this needs to
// move to Redis, which is why the store is isolated behind one interface.

class MemoryStore {
  constructor() {
    this.hits = new Map();

    // Sweep expired windows so the map cannot grow without bound
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.hits) {
        if (now > entry.resetAt) this.hits.delete(key);
      }
    }, 60_000);
    timer.unref();
  }

  increment(key, windowMs) {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || now > entry.resetAt) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.hits.set(key, fresh);
      return fresh;
    }

    entry.count++;
    return entry;
  }

  reset(key) {
    this.hits.delete(key);
  }

  // Used by the test suite so one test's requests cannot exhaust the next
  // test's budget; never called in normal operation.
  resetAll() {
    this.hits.clear();
  }
}

const store = new MemoryStore();

// Identify the caller as precisely as we can: one busy integration should not
// exhaust everyone else's budget, and members behind a shared corporate NAT
// should not exhaust each other's.
//
// Limiters mount ahead of the auth middleware, so req.user is not populated
// yet. The credential itself is the next best identifier — hashed, so raw
// tokens never end up as map keys or in a rate-limit log line.
function defaultKey(req) {
  if (req.admin) return `admin:${req.admin.id}`;
  if (req.user) return `user:${req.user.id}`;
  if (req.apiKey) return `apikey:${req.apiKey.id}`;

  const credential = req.headers['x-api-key'] ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);

  if (credential) {
    return 'cred:' + crypto.createHash('sha256').update(credential).digest('hex').slice(0, 16);
  }

  return `ip:${req.ip}`;
}

function rateLimit({
  windowMs = 60_000,
  max = 120,
  name = 'api',
  keyFn = defaultKey,
  skip = () => false
} = {}) {
  return (req, res, next) => {
    if (skip(req)) return next();

    const key = `${name}:${keyFn(req)}`;
    const entry = store.increment(key, windowMs);
    const remaining = Math.max(0, max - entry.count);
    const resetSeconds = Math.ceil((entry.resetAt - Date.now()) / 1000);

    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', resetSeconds);

    if (entry.count > max) {
      res.setHeader('Retry-After', resetSeconds);

      // Logged so a burst is visible in operations rather than only to the caller
      logger.warn('Rate limit exceeded', {
        limiter: name, key, count: entry.count, limit: max, path: req.path
      });

      return res.status(429).json({
        error: 'Too many requests. Slow down and try again shortly.',
        retry_after_seconds: resetSeconds
      });
    }

    next();
  };
}

module.exports = { rateLimit, store, defaultKey };
