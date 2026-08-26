const app = require('./app');
const config = require('./config');
const { logger } = require('./utils/logger');
const notifications = require('./services/notifications');
const scheduler = require('./services/scheduler');

// ─── Process entry point ────────────────────────────────────
// Everything that belongs to running a process rather than handling a
// request: the listener, the background jobs, and shutdown.
// In Postgres / Supabase mode we await the pool + schema before listening
// so the first request doesn't hit an uninitialized DB.

async function boot() {
  const db = require('./db');
  if (db.ready && typeof db.ready.then === 'function') {
    try {
      await db.ready;
      if (config.isPostgres) {
        logger.info('Postgres connected', { database: 'postgres' });
        if (config.supabase.configured) {
          logger.info('Supabase configured', { url: config.supabase.url, bucket: config.supabase.storageBucket });
        }
      }
    } catch (err) {
      logger.error('Postgres boot failed — will retry on demand', { message: err.message });
      const diagnosis = require('./db/pg').diagnoseConnectionError(err);
      if (diagnosis) {
        logger.warn('Postgres connection diagnosis', { reason: diagnosis.reason, fix: diagnosis.fix });
      }
      if (config.isProduction) {
        logger.warn('Continuing despite Postgres boot error — check DATABASE_URL and network');
      }
    }
  }

  if (!config.isPostgres) {
    logger.info('Using SQLite', { path: config.dbPath });
    if (config.supabase.configured) {
      logger.info('Supabase Storage configured with SQLite — uploads will use Supabase bucket', { bucket: config.supabase.storageBucket });
    }
  }

  if (config.sandbox.enabled) {
    try { require('./db/sandbox').db(); } catch (err) {
      logger.warn('Sandbox did not open at boot', { message: err.message });
    }
  }

  const server = app.listen(config.port, () => {
    logger.info('Dev Circle API listening', {
      url: `http://localhost:${config.port}`,
      env: config.env,
      database: config.isPostgres ? 'postgres' : 'sqlite',
      uploads: config.uploads.backend
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

  // Fill the page cache so the first console visit is not a Postgres RTT.
  require('./services/warmCache').start();

  // Finish in-flight requests before exiting, so a deploy does not cut someone off mid-survey
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

  return server;
}

const server = boot();

module.exports = server;
