const express = require('express');
const { beginAuth, requireAuth, requireAdmin } = require('../../middleware/auth');
const { circleContext } = require('../../middleware/circleContext');
const { preload, circleHint } = require('../../middleware/preload');
const { rememberGet } = require('../../middleware/cache');

const dashboard = require('./dashboard.routes');
const members = require('./members.routes');
const cohorts = require('./cohorts.routes');
const surveys = require('./surveys.routes');
const roles = require('./roles.routes');
const feedback = require('./feedback.routes');
const credentials = require('./credentials.routes');
const views = require('../../services/feedbackViews');
const gifts = require('./gifts.routes');
const blasts = require('./blasts.routes');
const db = require('../../db');

// ─── Admin API ──────────────────────────────────────────────
// Authentication and admin status are the floor, applied once here. Each
// sub-router then declares the capability its routes need, so a role is a
// real access boundary rather than a label.

const router = express.Router();

// Start the session JOIN immediately. List GETs below fire their page query
// on a second pool connection so the two RTTs overlap.
router.use(beginAuth);

function withCircle(fn) {
  return preload(req => {
    const id = circleHint(req);
    return id ? fn(req, id) : null;
  });
}

router.get('/dashboard', withCircle((_req, id) => dashboard.loadDashboard(id)));
router.get('/demography', withCircle((_req, id) => dashboard.loadDemography(id)));
router.get('/members', withCircle((req, id) => members.loadMemberPage(req.query, id)));
router.get('/cohorts', withCircle((_req, id) => cohorts.loadCohortList(id)));
router.get('/surveys', withCircle((_req, id) => surveys.loadSurveyList(id)));
router.get('/gifts', withCircle((_req, id) => gifts.loadGiftList(id)));
router.get('/blasts', withCircle((_req, id) => blasts.loadBlastList(id)));
router.get('/feedback/grouped', withCircle((req, id) => {
  const query = { ...req.query, circle_id: id };
  const axis = req.query.group_by || 'question';
  return Promise.all([views.group(axis, query), views.summarise(query)])
    .then(([groups, totals]) => ({ groups, totals, axis }));
}));
router.get('/roles', preload(() => db.prepare(`
  SELECT r.*, COALESCE(a.n, 0) as admin_count
  FROM roles r
  LEFT JOIN (SELECT role_id, COUNT(*) as n FROM admin_users GROUP BY role_id) a
    ON a.role_id = r.id
  ORDER BY r.is_system DESC, r.created_at DESC
`).all()));
router.get('/admins', preload(() => db.prepare(`
  SELECT a.id, a.email, a.name, a.status, a.created_at, a.role_id, r.name as role_name
  FROM admin_users a LEFT JOIN roles r ON r.id = a.role_id
  ORDER BY a.created_at DESC
`).all()));
router.get('/credentials', preload(() => db.prepare(`
  SELECT id, name, prefix, permissions, last_used_at, expires_at, revoked_at, created_at, created_by
  FROM api_keys
`).all()));
router.get('/api-keys', preload(() => db.prepare(`
  SELECT id, name, prefix, permissions, last_used_at, expires_at, revoked_at, created_at, created_by
  FROM api_keys ORDER BY created_at DESC
`).all()));
router.get('/integration-events', preload(req => {
  const { source, processed, limit = 50 } = req.query;
  const where = ['1=1'];
  const params = [];
  if (source) { where.push('source = ?'); params.push(source); }
  if (processed !== undefined && processed !== '') {
    where.push('processed = ?'); params.push(parseInt(processed, 10));
  }
  return db.prepare(`
    SELECT id, source, event_type, payload, processed, created_at, error
    FROM integration_events
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params, Math.min(200, parseInt(limit, 10) || 50));
}));

// Authentication, admin status, then the circle being worked in — which is
// what decides both the data in scope and the permissions that apply.
router.use(requireAuth, requireAdmin, circleContext, rememberGet);

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
router.use('/', require('./communications.routes'));

module.exports = router;
