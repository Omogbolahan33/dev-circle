const express = require('express');
const { requireAuth, requireAdmin } = require('../../middleware/auth');

// ─── Admin API ──────────────────────────────────────────────
// Authentication and admin status are the floor, applied once here. Each
// sub-router then declares the capability its routes need, so a role is a
// real access boundary rather than a label.

const router = express.Router();

router.use(requireAuth, requireAdmin);

// Circles, sessions and the API reference mount first: their paths would
// otherwise be caught by the parameterised routes in the resource routers below.
router.use('/circles', require('./circles.routes'));
router.use('/sessions', require('./sessions.routes'));
router.use('/docs', require('./docs.routes'));
router.use('/sandbox', require('./sandbox.routes'));

router.use('/', require('./dashboard.routes'));
router.use('/', require('./members.routes'));
router.use('/', require('./cohorts.routes'));
router.use('/', require('./surveys.routes'));
router.use('/', require('./blasts.routes'));
router.use('/', require('./gifts.routes'));
router.use('/', require('./roles.routes'));
router.use('/', require('./feedback.routes'));
router.use('/', require('./integrations.routes'));
router.use('/', require('./credentials.routes'));

module.exports = router;
