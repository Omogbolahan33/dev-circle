const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const { logger, requestLogger } = require('./utils/logger');
const { rateLimit } = require('./middleware/rateLimit');

// Initialize database (runs schema creation and migrations)
require('./db');

const notifications = require('./services/notifications');
const scheduler = require('./services/scheduler');

const app = express();

// Rate limiting and IP-based throttling need the real client address when
// running behind a proxy or load balancer.
app.set('trust proxy', config.isProduction ? 1 : false);
app.disable('x-powered-by');

// ─── Middleware ──────────────────────────────────────────────
app.use(cors({
  origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Express 5 leaves req.body undefined when no JSON body was parsed, so a
// request sent without a body (or without a JSON content type) would crash
// any handler that destructures it. Normalising once here beats guarding
// every handler.
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Malformed JSON should read as a client error, not a 500
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }
  next(err);
});

// Baseline security headers. The frontend is served from this same origin and
// uses inline scripts, so the CSP allows 'unsafe-inline' for scripts/styles
// while still blocking third-party origins and framing.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' https://fonts.gstatic.com",
    "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "connect-src 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  if (config.isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..')));

app.use(requestLogger());

// ─── Rate limits ────────────────────────────────────────────
// Tightest on the surfaces an attacker probes first, looser on ordinary
// authenticated traffic so real use is never the thing that trips it.

app.use('/api/auth', rateLimit({ name: 'auth', windowMs: 60_000, max: 20 }));
app.use('/api/integrations', rateLimit({ name: 'integrations', windowMs: 60_000, max: 300 }));
app.use('/api', rateLimit({ name: 'api', windowMs: 60_000, max: 300 }));

// ─── Routes ─────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/feedback', require('./routes/feedback'));
// Circles and sessions mount ahead of the main admin router so their paths
// are not swallowed by its parameterised routes.
app.use('/api/admin/circles', require('./routes/admin-circles'));
app.use('/api/admin/sessions', require('./routes/admin-sessions'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/integrations', require('./routes/integrations'));

// Liveness check — deliberately free of business data
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: require('../package.json').version, uptime: Math.round(process.uptime()) });
});

// Catch-all: serve login.html for SPA routes
app.get('/{*path}', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.sendFile(path.join(__dirname, '..', 'login.html'));
});

// ─── Error handling ─────────────────────────────────────────
// Every unhandled failure gets an id: the client is told the id, the details
// go to the log. That makes a support report traceable without exposing
// stack traces or query fragments to whoever hit the endpoint.
app.use((err, req, res, next) => {
  const errorId = crypto.randomBytes(6).toString('hex');

  logger.error('Unhandled error', {
    error_id: errorId,
    request_id: req.id,
    method: req.method,
    path: req.path,
    message: err.message,
    stack: err.stack
  });

  if (res.headersSent) return next(err);

  res.status(500).json({
    error: 'Something went wrong on our end.',
    error_id: errorId,
    ...(config.isProduction ? {} : { detail: err.message })
  });
});

// ─── Start ──────────────────────────────────────────────────
if (require.main === module) {
  const server = app.listen(config.port, () => {
    logger.info('Dev Circle API listening', {
      url: `http://localhost:${config.port}`,
      env: config.env
    });

    if (!config.delivery.enabled) {
      logger.warn('No Customer.io credentials configured — email, WhatsApp and SMS ' +
        'deliveries are recorded as "simulated" rather than reported as sent');
    }
  });

  // Release messages that were held back by members' quiet hours
  notifications.startDrain();

  // Fire due session reminders, nudge stale surveys, close past sessions
  scheduler.start();

  // Finish in-flight requests before exiting, so a deploy does not cut
  // someone off mid-survey
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logger.info('Shutting down', { signal });
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }

  process.on('unhandledRejection', reason => {
    logger.error('Unhandled promise rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined
    });
  });
}

module.exports = app;
