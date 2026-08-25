const express = require('express');
const db = require('../../db');
const { requirePermission } = require('../../middleware/auth');

const router = express.Router();

// ─── Dashboard ──────────────────────────────────────────────

// GET /api/admin/dashboard
router.get('/dashboard', requirePermission('members.read'), async (req, res) => {
  const [userRows, surveyRow, recentActivity, cohortBreakdown, openFeedback] = await Promise.all([
    // Status chart is one GROUP BY. Headlines sit next to the survey scan so
    // users are not counted five times as independent statements.
    db.prepare(`
      SELECT api_status, COUNT(*) as count FROM users GROUP BY api_status
    `).all(),
    db.prepare(`
      SELECT
        COUNT(*) as surveys_sent,
        SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) as surveys_completed,
        (SELECT COUNT(*) FROM cohorts) as active_cohorts,
        (SELECT COUNT(*) FROM users) as total_members,
        (SELECT COUNT(*) FROM users WHERE created_at > datetime('now', '-7 days')) as new_this_week
      FROM survey_responses
    `).get(),
    db.prepare(`
      SELECT eh.*, u.name as user_name, u.email as user_email
      FROM engagement_history eh
      LEFT JOIN users u ON u.id = eh.user_id
      ORDER BY eh.created_at DESC
      LIMIT 20
    `).all(),
    db.prepare(`
      SELECT c.id, c.name, c.color, COUNT(uc.user_id) as member_count
      FROM cohorts c
      LEFT JOIN user_cohorts uc ON uc.cohort_id = c.id
      GROUP BY c.id, c.name, c.color
      ORDER BY member_count DESC
      LIMIT 10
    `).all(),
    db.prepare(`
      SELECT f.id, f.content, f.source, f.created_at, f.status,
             u.name as user_name, u.email as user_email
      FROM feedback f
      LEFT JOIN users u ON u.id = f.user_id
      WHERE f.status = 'open'
      ORDER BY f.created_at DESC
      LIMIT 4
    `).all()
  ]);

  const statusBreakdown = (userRows || []).map(r => ({ api_status: r.api_status, count: Number(r.count || 0) }));
  const totalMembers = Number(surveyRow?.total_members || 0);
  const totalSurveysSent = Number(surveyRow?.surveys_sent || 0);
  const completedSurveys = Number(surveyRow?.surveys_completed || 0);
  const engagementRate = totalSurveysSent > 0 ? Math.round((completedSurveys / totalSurveysSent) * 100) : 0;

  res.json({
    stats: {
      total_members: totalMembers,
      active_cohorts: Number(surveyRow?.active_cohorts || 0),
      engagement_rate: engagementRate,
      surveys_sent: totalSurveysSent,
      surveys_completed: completedSurveys,
      new_this_week: Number(surveyRow?.new_this_week || 0)
    },
    recent_activity: recentActivity,
    cohort_breakdown: cohortBreakdown,
    status_breakdown: statusBreakdown,
    open_feedback: openFeedback || []
  });
});

// GET /api/admin/demography
// The blueprint asks for an at-a-glance view of demography, age, and products.
// None of that data existed before; these are the real distributions.
router.get('/demography', requirePermission('members.read'), async (req, res) => {
  // Aggregations stay in SQL. Shipping every member row to Node to GROUP BY
  // is the plan that gets worse as the base grows; UNION ALL is one round-trip
  // and the same JSON the page already reads.
  const rows = await db.prepare(`
    SELECT 'work_sector' as axis, COALESCE(NULLIF(work_sector, ''), 'Unspecified') as label, COUNT(*) as count
      FROM users GROUP BY 2
    UNION ALL
    SELECT 'location_state', COALESCE(NULLIF(location_state, ''), 'Unspecified'), COUNT(*)
      FROM users GROUP BY 2
    UNION ALL
    SELECT 'gender', COALESCE(NULLIF(gender, ''), 'Unspecified'), COUNT(*)
      FROM users GROUP BY 2
    UNION ALL
    SELECT 'api_status', api_status, COUNT(*)
      FROM users GROUP BY 2
    UNION ALL
    SELECT 'kyb', CASE WHEN CAST(kyb_completed AS TEXT) IN ('1', 'true', 't') THEN 'Completed' ELSE 'Pending' END, COUNT(*)
      FROM users GROUP BY 2
    UNION ALL
    SELECT 'age_band', CASE
        WHEN date_of_birth IS NULL OR date_of_birth = '' THEN 'Unspecified'
        WHEN (julianday('now') - julianday(date_of_birth)) / 365.25 < 25 THEN 'Under 25'
        WHEN (julianday('now') - julianday(date_of_birth)) / 365.25 < 35 THEN '25–34'
        WHEN (julianday('now') - julianday(date_of_birth)) / 365.25 < 45 THEN '35–44'
        ELSE '45+'
      END, COUNT(*)
      FROM users GROUP BY 2
    UNION ALL
    SELECT 'api_products', json_each.value, COUNT(*)
      FROM users, json_each(users.api_products)
      WHERE COALESCE(json_each.value, '') != ''
      GROUP BY 2
    UNION ALL
    SELECT 'engagement_depth', CASE
        WHEN completed = 0 THEN 'Never responded'
        WHEN completed BETWEEN 1 AND 2 THEN '1–2 surveys'
        WHEN completed BETWEEN 3 AND 5 THEN '3–5 surveys'
        ELSE '6+ surveys'
      END, COUNT(*)
      FROM (
        SELECT u.id, COUNT(sr.id) as completed
        FROM users u
        LEFT JOIN survey_responses sr ON sr.user_id = u.id AND sr.completed_at IS NOT NULL
        GROUP BY u.id
      ) depths
      GROUP BY 2
    UNION ALL
    SELECT 'streak_band', CASE
        WHEN COALESCE(engagement_streak, 0) = 0 THEN 'None'
        WHEN engagement_streak <= 3 THEN '1–3 days'
        WHEN engagement_streak <= 7 THEN '4–7 days'
        WHEN engagement_streak <= 14 THEN '8–14 days'
        ELSE '15+ days'
      END, COUNT(*)
      FROM users GROUP BY 2
    UNION ALL
    SELECT 'preferred_channels', json_each.value, COUNT(*)
      FROM users, json_each(users.preferred_channels)
      WHERE COALESCE(json_each.value, '') != ''
      GROUP BY 2
    UNION ALL
    SELECT 'preferred_days', json_each.value, COUNT(*)
      FROM users, json_each(users.preferred_days)
      WHERE COALESCE(json_each.value, '') != ''
      GROUP BY 2
    UNION ALL
    SELECT 'coverage', 'total', COUNT(*) FROM users
    UNION ALL
    SELECT 'coverage', 'no_date_of_birth',
           SUM(CASE WHEN date_of_birth IS NULL OR date_of_birth = '' THEN 1 ELSE 0 END) FROM users
    UNION ALL
    SELECT 'coverage', 'no_gender',
           SUM(CASE WHEN gender IS NULL OR gender = '' THEN 1 ELSE 0 END) FROM users
    UNION ALL
    SELECT 'coverage', 'no_location',
           SUM(CASE WHEN location_state IS NULL OR location_state = '' THEN 1 ELSE 0 END) FROM users
    UNION ALL
    SELECT 'coverage', 'no_products',
           SUM(CASE WHEN api_products IS NULL OR api_products = '' OR api_products = '[]' THEN 1 ELSE 0 END) FROM users
  `).all();

  const buckets = new Map();
  for (const row of rows || []) {
    const list = buckets.get(row.axis) || [];
    list.push({ label: row.label, count: Number(row.count || 0) });
    buckets.set(row.axis, list);
  }

  const ranked = axis => (buckets.get(axis) || []).sort((a, b) => b.count - a.count);
  const coverage = Object.fromEntries((buckets.get('coverage') || []).map(r => [r.label, r.count]));

  res.json({
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
  });
});

module.exports = router;
