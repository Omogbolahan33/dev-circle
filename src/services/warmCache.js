const { logger } = require('../utils/logger');
const { parseJSON } = require('../utils/helpers');
const { PERMISSIONS } = require('../middleware/auth');

// Load the pages the console opens first, so a cold visit is a cache hit
// instead of a Postgres RTT. Auth still runs; this only fills page bodies.

function groupedPermissions() {
  const grouped = {};
  for (const p of PERMISSIONS) {
    (grouped[p.group] = grouped[p.group] || []).push(p);
  }
  return { permissions: PERMISSIONS, grouped };
}

async function warmCircle(cache, circleId) {
  const dashboard = require('../routes/admin/dashboard.routes');
  const members = require('../routes/admin/members.routes');
  const cohorts = require('../routes/admin/cohorts.routes');
  const surveys = require('../routes/admin/surveys.routes');
  const gifts = require('../routes/admin/gifts.routes');
  const blasts = require('../routes/admin/blasts.routes');
  const views = require('./feedbackViews');

  const [dash, demo, memberPage, cohortList, surveyRows, giftList, blastList, grouped] =
    await Promise.all([
      dashboard.loadDashboard(circleId).then(dashboard.presentDashboard),
      dashboard.loadDemography(circleId).then(dashboard.presentDemography),
      members.loadMemberPage({ page: 1, limit: 20 }, circleId),
      cohorts.loadCohortList(circleId),
      surveys.loadSurveyList(circleId).then(surveys.presentSurveyList),
      gifts.loadGiftList(circleId),
      blasts.loadBlastList(circleId),
      Promise.all([
        views.group('question', { circle_id: circleId }),
        views.summarise({ circle_id: circleId })
      ]).then(([groups, totals]) => ({
        group_by: 'question',
        axis: views.axes().find(a => a.key === 'question'),
        groups,
        totals
      }))
    ]);

  cache.putPage('/dashboard', { circleId, body: dash });
  cache.putPage('/demography', { circleId, body: demo });
  cache.putPage('/members', { circleId, query: { limit: 20, page: 1 }, body: memberPage });
  cache.putPage('/cohorts', { circleId, body: cohortList });
  cache.putPage('/surveys', { circleId, body: surveyRows });
  cache.putPage('/gifts', { circleId, body: giftList });
  cache.putPage('/blasts', { circleId, body: blastList });
  cache.putPage('/feedback/grouped', { circleId, query: { group_by: 'question' }, body: grouped });
}

async function warmShared(cache) {
  const db = require('../db');

  const [roles, admins, keys] = await Promise.all([
    db.prepare(`
      SELECT r.*, COALESCE(a.n, 0) as admin_count
      FROM roles r
      LEFT JOIN (SELECT role_id, COUNT(*) as n FROM admin_users GROUP BY role_id) a
        ON a.role_id = r.id
      ORDER BY r.is_system DESC, r.created_at DESC
    `).all(),
    db.prepare(`
      SELECT a.id, a.email, a.name, a.status, a.created_at, a.role_id, r.name as role_name
      FROM admin_users a LEFT JOIN roles r ON r.id = a.role_id
      ORDER BY a.created_at DESC
    `).all(),
    db.prepare(`
      SELECT id, name, prefix, permissions, last_used_at, expires_at, revoked_at, created_at, created_by
      FROM api_keys ORDER BY created_at DESC
    `).all()
  ]);

  cache.putPage('/permissions', { body: groupedPermissions() });
  cache.putPage('/roles', {
    body: { roles: (roles || []).map(r => ({ ...r, permissions: parseJSON(r.permissions, []) })) }
  });
  cache.putPage('/admins', { body: { admins: admins || [] } });

  const shaped = (keys || []).map(row => ({
    ...row,
    permissions: parseJSON(row.permissions, []),
    status: row.revoked_at
      ? 'revoked'
      : (row.expires_at && new Date(String(row.expires_at).replace(' ', 'T')) <= new Date()
        ? 'expired'
        : 'live')
  }));

  cache.putPage('/api-keys', {
    body: { keys: shaped, scopes: require('../routes/admin/credentials.routes').SCOPES }
  });
}

async function warm() {
  const cache = require('../middleware/cache');
  const db = require('../db');
  const circles = await db.prepare("SELECT id FROM circles WHERE status = 'active'").all();
  await warmShared(cache);
  for (const circle of circles || []) {
    await warmCircle(cache, circle.id);
  }
  return { circles: (circles || []).length };
}

function start(intervalMs = 4 * 60 * 1000) {
  const run = () => warm().then(info => {
    logger.info('Warmed page cache', info);
  }).catch(err => {
    logger.warn('Page cache warm failed', { message: err.message });
  });
  run();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { warm, start };
