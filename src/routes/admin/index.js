const express = require('express');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const { circleContext } = require('../../middleware/circleContext');

// ─── Admin API ──────────────────────────────────────────────
// Authentication and admin status are the floor, applied once here. Each
// sub-router then declares the capability its routes need, so a role is a
// real access boundary rather than a label.

const router = express.Router();

// Authentication, admin status, then the circle being worked in — which is
// what decides both the data in scope and the permissions that apply.
router.use(requireAuth, requireAdmin, circleContext);

// Circles, sessions and the API reference mount first: their paths would
// otherwise be caught by the parameterised routes in the resource routers below.
router.use('/circles', require('./circles.routes'));
router.use('/sessions', require('./sessions.routes'));
router.use('/docs', require('./docs.routes'));
router.use('/', require('./questions.routes'));
router.use('/sandbox', require('./sandbox.routes'));

router.use('/', require('./dashboard.routes'));
router.use('/', require('./members.routes'));
router.use('/', require('./cohorts.routes'));
router.use('/', require('./surveys.routes'));
router.use('/', require('./onboarding.routes'));
router.use('/', require('./uploads.routes'));
router.use('/', require('./blasts.routes'));
router.use('/', require('./gifts.routes'));
router.use('/', require('./roles.routes'));
router.use('/', require('./feedback.routes'));
router.use('/', require('./integrations.routes'));
router.use('/', require('./credentials.routes'));

module.exports = router;
