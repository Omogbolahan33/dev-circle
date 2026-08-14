const app = require('./app');
const config = require('./config');
const { logger } = require('./utils/logger');
const notifications = require('./services/notifications');
const scheduler = require('./services/scheduler');

// ─── Process entry point ────────────────────────────────────
// Everything that belongs to running a process rather than handling a
// request: the listener, the background jobs, and shutdown.

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

// Finish in-flight requests before exiting, so a deploy does not cut someone
// off mid-survey
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info('Shutting down', { signal });
    scheduler.stop();
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

module.exports = server;
