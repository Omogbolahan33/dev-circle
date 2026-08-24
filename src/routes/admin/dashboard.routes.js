const express = require('express');
const db = require('../../db');
const { requirePermission } = require('../../middleware/auth');

const router = express.Router();

// ─── Dashboard ──────────────────────────────────────────────

// GET /api/admin/dashboard
router.get('/dashboard', requirePermission('members.read'), async (req, res) => {
  const count = async sql => Number((await db.prepare(sql).get())?.c || 0);
  const totalMembers = await count('SELECT COUNT(*) as c FROM users');
  const activeCohorts = await count('SELECT COUNT(*) as c FROM cohorts');
  const totalSurveysSent = await count('SELECT COUNT(*) as c FROM survey_responses');
  const completedSurveys = await count("SELECT COUNT(*) as c FROM survey_responses WHERE completed_at IS NOT NULL");
  const engagementRate = totalSurveysSent > 0 ? Math.round((completedSurveys / totalSurveysSent) * 100) : 0;

  const recentActivity = await db.prepare(`
    SELECT eh.*, u.name as user_name, u.email as user_email
    FROM engagement_history eh
    LEFT JOIN users u ON u.id = eh.user_id
    ORDER BY eh.created_at DESC
    LIMIT 20
  `).all();

  const cohortBreakdown = await db.prepare(`
    SELECT c.id, c.name, c.color,
      (SELECT COUNT(*) FROM user_cohorts uc WHERE uc.cohort_id = c.id) as member_count
    FROM cohorts c
    ORDER BY member_count DESC
    LIMIT 10
  `).all();

  const statusBreakdown = await db.prepare(`
    SELECT api_status, COUNT(*) as count FROM users GROUP BY api_status
  `).all();

  const newThisWeek = await count(
    "SELECT COUNT(*) as c FROM users WHERE created_at > datetime('now', '-7 days')"
  );

  res.json({
    stats: {
      total_members: totalMembers,
      active_cohorts: activeCohorts,
      engagement_rate: engagementRate,
      surveys_sent: totalSurveysSent,
      surveys_completed: completedSurveys,
      new_this_week: newThisWeek
    },
    recent_activity: recentActivity,
    cohort_breakdown: cohortBreakdown,
    status_breakdown: statusBreakdown
  });
});

// GET /api/admin/demography
// The blueprint asks for an at-a-glance view of demography, age, and products.
// None of that data existed before; these are the real distributions.
router.get('/demography', requirePermission('members.read'), async (req, res) => {
  const bySector = await db.prepare(`
    SELECT COALESCE(NULLIF(work_sector, ''), 'Unspecified') as label, COUNT(*) as count
    FROM users GROUP BY 1 ORDER BY count DESC
  `).all();

  const byState = await db.prepare(`
    SELECT COALESCE(NULLIF(location_state, ''), 'Unspecified') as label, COUNT(*) as count
    FROM users GROUP BY 1 ORDER BY count DESC LIMIT 15
  `).all();

  const byGender = await db.prepare(`
    SELECT COALESCE(NULLIF(gender, ''), 'Unspecified') as label, COUNT(*) as count
    FROM users GROUP BY 1 ORDER BY count DESC
  `).all();

  const byAge = await db.prepare(`
    SELECT CASE
      WHEN date_of_birth IS NULL THEN 'Unspecified'
      WHEN (julianday('now') - julianday(date_of_birth)) / 365.25 < 25 THEN 'Under 25'
      WHEN (julianday('now') - julianday(date_of_birth)) / 365.25 < 35 THEN '25–34'
      WHEN (julianday('now') - julianday(date_of_birth)) / 365.25 < 45 THEN '35–44'
      ELSE '45+'
    END as label, COUNT(*) as count
    FROM users GROUP BY 1 ORDER BY count DESC
  `).all();

  // api_products is a JSON array, so each member counts once per product
  const byProduct = await db.prepare(`
    SELECT json_each.value as label, COUNT(*) as count
    FROM users, json_each(users.api_products)
    GROUP BY 1 ORDER BY count DESC
  `).all();

  const byApiStatus = await db.prepare('SELECT api_status as label, COUNT(*) as count FROM users GROUP BY 1').all();

  const kyb = await db.prepare(`
    SELECT CASE COALESCE(kyb_completed, 0) WHEN 1 THEN 'Completed' ELSE 'Pending' END as label,
           COUNT(*) as count
    FROM users GROUP BY 1
  `).all();

  const engagementDepth = await db.prepare(`
    SELECT CASE
      WHEN completed = 0 THEN 'Never responded'
      WHEN completed BETWEEN 1 AND 2 THEN '1–2 surveys'
      WHEN completed BETWEEN 3 AND 5 THEN '3–5 surveys'
      ELSE '6+ surveys'
    END as label, COUNT(*) as count
    FROM (
      SELECT u.id, (SELECT COUNT(*) FROM survey_responses sr
                    WHERE sr.user_id = u.id AND sr.completed_at IS NOT NULL) as completed
      FROM users u
    ) GROUP BY 1
  `).all();

  const missing = await db.prepare(`
    SELECT
      SUM(CASE WHEN date_of_birth IS NULL THEN 1 ELSE 0 END) as no_date_of_birth,
      SUM(CASE WHEN gender IS NULL OR gender = '' THEN 1 ELSE 0 END) as no_gender,
      SUM(CASE WHEN location_state IS NULL OR location_state = '' THEN 1 ELSE 0 END) as no_location,
      SUM(CASE WHEN api_products IS NULL OR api_products = '[]' THEN 1 ELSE 0 END) as no_products
    FROM users
  `).get();

  res.json({
    total: Number((await db.prepare('SELECT COUNT(*) as c FROM users').get())?.c || 0),
    work_sector: bySector,
    location_state: byState,
    gender: byGender,
    age_band: byAge,
    api_products: byProduct,
    api_status: byApiStatus,
    kyb: kyb,
    engagement_depth: engagementDepth,
    // Surfaced so nobody reads a chart without knowing the coverage behind it
    data_coverage: missing
  });
});

module.exports = router;
