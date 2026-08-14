const crypto = require('crypto');
const config = require('../config');
const { logger } = require('../utils/logger');

// ─── Error handling ─────────────────────────────────────────

// A body that never parsed is the client's mistake, not a server fault.
// This has to be registered right after express.json() to catch its throw.
function jsonSyntaxHandler(err, req, res, next) {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }
  next(err);
}

// Express 5 leaves req.body undefined when nothing was parsed, so a request
// with no body would crash any handler that destructures it. Normalising once
// beats guarding every handler.
function normalizeBody(req, res, next) {
  if (req.body === undefined) req.body = {};
  next();
}

// Every unhandled failure gets an id: the client is told the id, the details
// go to the log. A support report becomes traceable without exposing stack
// traces or query fragments to whoever hit the endpoint.
function errorHandler(err, req, res, next) {
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
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Endpoint not found' });
}

module.exports = { jsonSyntaxHandler, normalizeBody, errorHandler, notFoundHandler };
