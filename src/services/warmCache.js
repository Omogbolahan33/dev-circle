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

  // Overview first so a visit during warm is not the 900ms miss the logs show.
  cache.putPage('/dashboard', {
    circleId,
    body: dashboard.presentDashboard(await dashboard.loadDashboard(circleId))
  });

  // One at a time. Warming is background work with nobody waiting on it, so
  // there is nothing to gain from running it in parallel and a pool to lose:
  // each of these fans out further, and together they were taking every
  // connection the container had.
  cache.putPage('/demography', {
    circleId, body: dashboard.presentDemography(await dashboard.loadDemography(circleId))
  });
  cache.putPage('/members', {
    circleId, query: { limit: 20, page: 1 },
    body: await members.loadMemberPage({ page: 1, limit: 20 }, circleId)
  });
  cache.putPage('/cohorts', { circleId, body: await cohorts.loadCohortList(circleId) });
  cache.putPage('/surveys', {
    circleId, body: surveys.presentSurveyList(await surveys.loadSurveyList(circleId))
  });
  cache.putPage('/gifts', { circleId, body: await gifts.loadGiftList(circleId) });
  cache.putPage('/blasts', { circleId, body: await blasts.loadBlastList(circleId) });

  const groups = await views.group('question', { circle_id: circleId });
  const totals = await views.summarise({ circle_id: circleId });
  cache.putPage('/feedback/grouped', {
    circleId,
    query: { group_by: 'question' },
    body: { group_by: 'question', axis: views.axes().find(a => a.key === 'question'), groups, totals }
  });
}

async function warmShared(cache) {
  const db = require('../db');

  // Thunks, not promises: `.all()` starts the query, so a list of started
  // promises runs in parallel however it is awaited.
  const [roles, admins, keys] = await series([
    () => db.prepare(`
      SELECT r.*, COALESCE(a.n, 0) as admin_count
      FROM roles r
      LEFT JOIN (SELECT role_id, COUNT(*) as n FROM admin_users GROUP BY role_id) a
        ON a.role_id = r.id
      ORDER BY r.is_system DESC, r.created_at DESC
    `).all(),
    () => db.prepare(`
      SELECT a.id, a.email, a.name, a.status, a.created_at, a.role_id, r.name as role_name
      FROM admin_users a LEFT JOIN roles r ON r.id = a.role_id
      ORDER BY a.created_at DESC
    `).all(),
    () => db.prepare(`
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

// Thunks, run in order. Same shape as Promise.all at the call site, one
// connection at a time on the wire.
async function series(thunks) {
  const out = [];
  for (const thunk of thunks) out.push(await (typeof thunk === 'function' ? thunk() : thunk));
  return out;
}

// Never two warms at once. Without this a slow warm and the next tick overlap,
// and the fan-out doubles.
let running = null;

async function warm() {
  if (running) return running;

  running = (async () => {
    const cache = require('../middleware/cache');
    const db = require('../db');
    const circles = await db.prepare("SELECT id FROM circles WHERE status = 'active'").all();
    await warmShared(cache);
    for (const circle of circles || []) {
      await warmCircle(cache, circle.id);
    }
    return { circles: (circles || []).length };
  })();

  try {
    return await running;
  } finally {
    running = null;
  }
}

function start(intervalMs = 4 * 60 * 1000) {
  // Nothing to warm on serverless: the container that pays for it is usually
  // frozen before it serves the page, so it is a burst of connections spent on
  // a cache nobody reads.
  if (require('../config').database.pgPool.isServerless) {
    logger.info('Page cache warming disabled (serverless)');
    return null;
  }

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
