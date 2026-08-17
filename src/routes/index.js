const express = require('express');
const { notFoundHandler } = require('../middleware/errorHandler');

// ─── API router ─────────────────────────────────────────────
// One place that says what the API surface is. Everything mounts under /api,
// so the static frontend and the API can never shadow one another.

const router = express.Router();

router.use('/auth', require('./auth.routes'));
// Answering a survey over its link. The only routes here that take no
// credential at all — see the file for what that changes about them.
router.use('/public', require('./public.routes'));
router.use('/users', require('./users.routes'));
router.use('/feedback', require('./feedback.routes'));
router.use('/admin', require('./admin'));
router.use('/integrations', require('./integrations.routes'));

// Liveness check — deliberately free of business data
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: require('../../package.json').version,
    uptime: Math.round(process.uptime())
  });
});

// An unknown API path answers as JSON rather than falling through to the
// static handler and returning the login page with a 200
router.use(notFoundHandler);

module.exports = router;
