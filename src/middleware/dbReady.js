const config = require('../config');
const { logger } = require('../utils/logger');

// ─── Nothing queries a database that is not there yet ────────
// On a long-lived server this middleware never does anything: server.js awaits
// db.ready before it listens, so by the time a request exists the schema has
// been applied.
//
// Serverless has no such moment. The handler imports app.js, `ready` is a
// promise that started when src/db was first required, and the request is
// served immediately — racing it. A cold start that received a request before
// the 97-statement schema finished would query a table that did not exist yet
// and answer 500 with `relation "..." does not exist`, which reads like a bug
// in the route rather than a boot that had not finished.
//
// So the request waits. It is a wait exactly once per container: after the
// first, `ready` is already resolved and awaiting it costs a microtask.

let attempt = null;

function reset() {
  attempt = null;
}

// A boot that failed is worth retrying — a pool that was momentarily out of
// connections is the usual reason, and the next invocation may well succeed.
// A boot that failed and is simply repeated forever is not: the message says
// so plainly rather than letting every route invent its own 500.
function dbReady() {
  return async function ensureDbReady(req, res, next) {
    if (!config.isPostgres) return next();

    const db = require('../db');
    if (!db.ready || typeof db.ready.then !== 'function') return next();

    try {
      if (!attempt) attempt = db.ready;
      await attempt;
      return next();
    } catch (err) {
      // Let the next request try again rather than pinning the container to
      // one bad boot.
      attempt = null;
      logger.error('Refusing a request because the database is not ready', {
        path: req.path,
        message: err.message
      });
      return res.status(503).json({
        error: 'The service is still starting up. Try again in a moment.',
        detail: config.isProduction ? undefined : err.message
      });
    }
  };
}

module.exports = { dbReady, reset };
