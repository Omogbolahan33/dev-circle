const express = require('express');
const db = require('../../db');
const { requirePermission } = require('../../middleware/auth');

const router = express.Router();

// ─── Dashboard ──────────────────────────────────────────────

async function loadDashboard(circleId) {
  // One statement, one RTT. Each arm filters circle_id directly — a CTE of
  // `SELECT ? AS id` hid the predicate and Postgres scanned engagement_history
  // and survey_responses end to end (~900ms) to return twenty rows.
  return db.prepare(`
    SELECT 'status' AS part, api_status AS id, CAST(NULL AS TEXT) AS label, CAST(COUNT(*) AS INTEGER) AS n,
           CAST(NULL AS TEXT) AS name, CAST(NULL AS TEXT) AS email, CAST(NULL AS TEXT) AS ts,
           CAST(NULL AS TEXT) AS extra, CAST(NULL AS TEXT) AS extra2
      FROM users u
      JOIN circle_members cm ON cm.user_id = u.id
     WHERE cm.circle_id = ?
     GROUP BY api_status
    UNION ALL
    SELECT 'new_week', CAST(NULL AS TEXT), CAST(NULL AS TEXT),
           CAST(SUM(CASE WHEN u.created_at > datetime('now', '-7 days') THEN 1 ELSE 0 END) AS INTEGER),
           CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT)
      FROM users u
      JOIN circle_members cm ON cm.user_id = u.id
     WHERE cm.circle_id = ?
    UNION ALL
    SELECT 'surveys', CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(COUNT(*) AS INTEGER),
           CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT),
           CAST(SUM(CASE WHEN sr.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS TEXT),
           CAST(NULL AS TEXT)
      FROM survey_responses sr
      JOIN surveys s ON s.id = sr.survey_id
     WHERE s.circle_id = ?
    UNION ALL
    SELECT 'cohorts', CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(COUNT(*) AS INTEGER),
           CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT)
      FROM cohorts c
     WHERE c.circle_id = ?
    UNION ALL
    SELECT * FROM (
      SELECT 'cohort_row' AS part, c.id AS id, c.color AS label, CAST(COUNT(uc.user_id) AS INTEGER) AS n,
             c.name AS name, CAST(NULL AS TEXT) AS email, CAST(NULL AS TEXT) AS ts,
             CAST(NULL AS TEXT) AS extra, CAST(NULL AS TEXT) AS extra2
      FROM cohorts c
      LEFT JOIN user_cohorts uc ON uc.cohort_id = c.id
      WHERE c.circle_id = ?
      GROUP BY c.id, c.name, c.color
      ORDER BY n DESC
      LIMIT 10
    ) cohort_rows
    UNION ALL
    SELECT * FROM (
      SELECT 'activity' AS part, eh.id AS id, eh.type AS label, CAST(NULL AS INTEGER) AS n,
             u.name AS name, u.email AS email, CAST(eh.created_at AS TEXT) AS ts,
             eh.user_id AS extra, CAST(NULL AS TEXT) AS extra2
      FROM engagement_history eh
      JOIN circle_members cm ON cm.user_id = eh.user_id
      LEFT JOIN users u ON u.id = eh.user_id
      WHERE cm.circle_id = ?
      ORDER BY eh.created_at DESC
      LIMIT 20
    ) activity
    UNION ALL
    SELECT * FROM (
      SELECT 'feedback' AS part, f.id AS id, f.source AS label, CAST(NULL AS INTEGER) AS n,
             u.name AS name, u.email AS email, CAST(f.created_at AS TEXT) AS ts,
             f.status AS extra, f.content AS extra2
      FROM feedback f
      LEFT JOIN users u ON u.id = f.user_id
      WHERE f.circle_id = ? AND f.status = 'open'
      ORDER BY f.created_at DESC
      LIMIT 4
    ) feedback
  `).all(circleId, circleId, circleId, circleId, circleId, circleId, circleId);
}

function presentDashboard(rows) {
  const statusBreakdown = [];
  const cohortBreakdown = [];
  const recentActivity = [];
  const openFeedback = [];
  let newThisWeek = 0;
  let surveysSent = 0;
  let surveysCompleted = 0;
  let activeCohorts = 0;

  for (const row of rows || []) {
    if (row.part === 'status') {
      statusBreakdown.push({ api_status: row.id, count: Number(row.n || 0) });
    } else if (row.part === 'new_week') {
      newThisWeek = Number(row.n || 0);
    } else if (row.part === 'surveys') {
      surveysSent = Number(row.n || 0);
      surveysCompleted = Number(row.extra || 0);
    } else if (row.part === 'cohorts') {
      activeCohorts = Number(row.n || 0);
    } else if (row.part === 'cohort_row') {
      cohortBreakdown.push({
        id: row.id, name: row.name, color: row.label, member_count: Number(row.n || 0)
      });
    } else if (row.part === 'activity') {
      recentActivity.push({
        id: row.id, type: row.label, user_id: row.extra,
        user_name: row.name, user_email: row.email, created_at: row.ts
      });
    } else if (row.part === 'feedback') {
      openFeedback.push({
        id: row.id, content: row.extra2, source: row.label, status: row.extra,
        created_at: row.ts, user_name: row.name, user_email: row.email
      });
    }
  }

  const totalMembers = statusBreakdown.reduce((n, r) => n + r.count, 0);
  const engagementRate = surveysSent > 0 ? Math.round((surveysCompleted / surveysSent) * 100) : 0;

  return {
    stats: {
      total_members: totalMembers,
      active_cohorts: activeCohorts,
      engagement_rate: engagementRate,
      surveys_sent: surveysSent,
      surveys_completed: surveysCompleted,
      new_this_week: newThisWeek
    },
    recent_activity: recentActivity,
    cohort_breakdown: cohortBreakdown,
    status_breakdown: statusBreakdown,
    open_feedback: openFeedback
  };
}

// GET /api/admin/dashboard
router.get('/dashboard', requirePermission('members.read'), async (req, res) => {
  const { takePreload } = require('../../middleware/preload');
  res.json(presentDashboard(await takePreload(req, () => loadDashboard(req.circleId))));
});

// GET /api/admin/demography
// The blueprint asks for an at-a-glance view of demography, age, and products.
// None of that data existed before; these are the real distributions.
async function loadDemography(circleId) {
  // Aggregations stay in SQL. Shipping every member row to Node to GROUP BY
  // is the plan that gets worse as the base grows; UNION ALL is one round-trip
  // and the same JSON the page already reads.
  // Age is computed once in the CTE — the previous plan ran julianday twice
  // per member, per UNION arm.
  return db.prepare(`
    WITH scoped AS (
      SELECT u.id, u.work_sector, u.location_state, u.gender, u.api_status,
             u.kyb_completed, u.api_products, u.engagement_streak,
             u.preferred_channels, u.preferred_days, u.date_of_birth,
             CASE
               WHEN u.date_of_birth IS NULL OR u.date_of_birth = '' THEN 'Unspecified'
               WHEN (julianday('now') - julianday(u.date_of_birth)) / 365.25 < 25 THEN 'Under 25'
               WHEN (julianday('now') - julianday(u.date_of_birth)) / 365.25 < 35 THEN '25–34'
               WHEN (julianday('now') - julianday(u.date_of_birth)) / 365.25 < 45 THEN '35–44'
               ELSE '45+'
             END as age_band
      FROM users u
      JOIN circle_members cm ON cm.user_id = u.id
      WHERE cm.circle_id = ?
    ),
    completed AS (
      SELECT sr.user_id, COUNT(*) as completed
      FROM survey_responses sr
      JOIN scoped s ON s.id = sr.user_id
      WHERE sr.completed_at IS NOT NULL
      GROUP BY sr.user_id
    )
    SELECT 'work_sector' as axis, COALESCE(NULLIF(work_sector, ''), 'Unspecified') as label, COUNT(*) as count
      FROM scoped GROUP BY 2
    UNION ALL
    SELECT 'location_state', COALESCE(NULLIF(location_state, ''), 'Unspecified'), COUNT(*)
      FROM scoped GROUP BY 2
    UNION ALL
    SELECT 'gender', COALESCE(NULLIF(gender, ''), 'Unspecified'), COUNT(*)
      FROM scoped GROUP BY 2
    UNION ALL
    SELECT 'api_status', api_status, COUNT(*)
      FROM scoped GROUP BY 2
    UNION ALL
    SELECT 'kyb', CASE WHEN CAST(kyb_completed AS TEXT) IN ('1', 'true', 't') THEN 'Completed' ELSE 'Pending' END, COUNT(*)
      FROM scoped GROUP BY 2
    UNION ALL
    SELECT 'age_band', age_band, COUNT(*)
      FROM scoped GROUP BY 2
    UNION ALL
    SELECT 'api_products', json_each.value, COUNT(*)
      FROM scoped, json_each(scoped.api_products)
      WHERE COALESCE(json_each.value, '') != ''
      GROUP BY 2
    UNION ALL
    SELECT 'engagement_depth', CASE
        WHEN COALESCE(c.completed, 0) = 0 THEN 'Never responded'
        WHEN c.completed BETWEEN 1 AND 2 THEN '1–2 surveys'
        WHEN c.completed BETWEEN 3 AND 5 THEN '3–5 surveys'
        ELSE '6+ surveys'
      END, COUNT(*)
      FROM scoped s
      LEFT JOIN completed c ON c.user_id = s.id
      GROUP BY 2
    UNION ALL
    SELECT 'streak_band', CASE
        WHEN COALESCE(engagement_streak, 0) = 0 THEN 'None'
        WHEN engagement_streak <= 3 THEN '1–3 days'
        WHEN engagement_streak <= 7 THEN '4–7 days'
        WHEN engagement_streak <= 14 THEN '8–14 days'
        ELSE '15+ days'
      END, COUNT(*)
      FROM scoped GROUP BY 2
    UNION ALL
    SELECT 'preferred_channels', json_each.value, COUNT(*)
      FROM scoped, json_each(scoped.preferred_channels)
      WHERE COALESCE(json_each.value, '') != ''
      GROUP BY 2
    UNION ALL
    SELECT 'preferred_days', json_each.value, COUNT(*)
      FROM scoped, json_each(scoped.preferred_days)
      WHERE COALESCE(json_each.value, '') != ''
      GROUP BY 2
    UNION ALL
    SELECT 'coverage', 'total', COUNT(*) FROM scoped
    UNION ALL
    SELECT 'coverage', 'no_date_of_birth',
           SUM(CASE WHEN date_of_birth IS NULL OR date_of_birth = '' THEN 1 ELSE 0 END) FROM scoped
    UNION ALL
    SELECT 'coverage', 'no_gender',
           SUM(CASE WHEN gender IS NULL OR gender = '' THEN 1 ELSE 0 END) FROM scoped
    UNION ALL
    SELECT 'coverage', 'no_location',
           SUM(CASE WHEN location_state IS NULL OR location_state = '' THEN 1 ELSE 0 END) FROM scoped
    UNION ALL
    SELECT 'coverage', 'no_products',
           SUM(CASE WHEN api_products IS NULL OR api_products = '' OR api_products = '[]' THEN 1 ELSE 0 END) FROM scoped
  `).all(circleId);
}

function presentDemography(rows) {
  const buckets = new Map();
  for (const row of rows || []) {
    const list = buckets.get(row.axis) || [];
    list.push({ label: row.label, count: Number(row.count || 0) });
    buckets.set(row.axis, list);
  }

  const ranked = axis => (buckets.get(axis) || []).sort((a, b) => b.count - a.count);
  const coverage = Object.fromEntries((buckets.get('coverage') || []).map(r => [r.label, r.count]));

  return {
    total: Number(coverage.total || 0),
    work_sector: ranked('work_sector'),
    location_state: ranked('location_state').slice(0, 15),
    gender: ranked('gender'),
    age_band: ranked('age_band'),
    api_products: ranked('api_products'),
    api_status: ranked('api_status'),
    kyb: ranked('kyb'),
    engagement_depth: ranked('engagement_depth'),
    streak_band: ranked('streak_band'),
    preferred_channels: ranked('preferred_channels'),
    preferred_days: ranked('preferred_days'),
    data_coverage: {
      no_date_of_birth: Number(coverage.no_date_of_birth || 0),
      no_gender: Number(coverage.no_gender || 0),
      no_location: Number(coverage.no_location || 0),
      no_products: Number(coverage.no_products || 0)
    }
  };
}

router.get('/demography', requirePermission('members.read'), async (req, res) => {
  const { takePreload } = require('../../middleware/preload');
  res.json(presentDemography(await takePreload(req, () => loadDemography(req.circleId))));
});

module.exports = router;
module.exports.loadDashboard = loadDashboard;
module.exports.loadDemography = loadDemography;
module.exports.presentDashboard = presentDashboard;
module.exports.presentDemography = presentDemography;
