const express = require('express');
const db = require('../../db');
const { requirePermission } = require('../../middleware/auth');

const router = express.Router();

// ─── Dashboard ──────────────────────────────────────────────

// GET /api/admin/dashboard
router.get('/dashboard', requirePermission('members.read'), async (req, res) => {
  const count = async sql => Number((await db.prepare(sql).get())?.c || 0);

  const [
    totalMembers, activeCohorts, totalSurveysSent, completedSurveys, newThisWeek,
    recentActivity, cohortBreakdown, statusBreakdown
  ] = await Promise.all([
    count('SELECT COUNT(*) as c FROM users'),
    count('SELECT COUNT(*) as c FROM cohorts'),
    count('SELECT COUNT(*) as c FROM survey_responses'),
    count("SELECT COUNT(*) as c FROM survey_responses WHERE completed_at IS NOT NULL"),
    count("SELECT COUNT(*) as c FROM users WHERE created_at > datetime('now', '-7 days')"),
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
      SELECT api_status, COUNT(*) as count FROM users GROUP BY api_status
    `).all()
  ]);

  const engagementRate = totalSurveysSent > 0 ? Math.round((completedSurveys / totalSurveysSent) * 100) : 0;

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
  const [
    bySector, byState, byGender, byAge, byProduct, byApiStatus, kyb,
    engagementDepth, missing, totalRow
  ] = await Promise.all([
    db.prepare(`
      SELECT COALESCE(NULLIF(work_sector, ''), 'Unspecified') as label, COUNT(*) as count
      FROM users GROUP BY 1 ORDER BY count DESC
    `).all(),
    db.prepare(`
      SELECT COALESCE(NULLIF(location_state, ''), 'Unspecified') as label, COUNT(*) as count
      FROM users GROUP BY 1 ORDER BY count DESC LIMIT 15
    `).all(),
    db.prepare(`
      SELECT COALESCE(NULLIF(gender, ''), 'Unspecified') as label, COUNT(*) as count
      FROM users GROUP BY 1 ORDER BY count DESC
    `).all(),
    db.prepare(`
      SELECT CASE
        WHEN date_of_birth IS NULL THEN 'Unspecified'
        WHEN (julianday('now') - julianday(date_of_birth)) / 365.25 < 25 THEN 'Under 25'
        WHEN (julianday('now') - julianday(date_of_birth)) / 365.25 < 35 THEN '25–34'
        WHEN (julianday('now') - julianday(date_of_birth)) / 365.25 < 45 THEN '35–44'
        ELSE '45+'
      END as label, COUNT(*) as count
      FROM users GROUP BY 1 ORDER BY count DESC
    `).all(),
    db.prepare(`
      SELECT json_each.value as label, COUNT(*) as count
      FROM users, json_each(users.api_products)
      GROUP BY 1 ORDER BY count DESC
    `).all(),
    db.prepare('SELECT api_status as label, COUNT(*) as count FROM users GROUP BY 1').all(),
    db.prepare(`
      SELECT CASE COALESCE(kyb_completed, 0) WHEN 1 THEN 'Completed' ELSE 'Pending' END as label,
             COUNT(*) as count
      FROM users GROUP BY 1
    `).all(),
    db.prepare(`
      SELECT CASE
        WHEN completed = 0 THEN 'Never responded'
        WHEN completed BETWEEN 1 AND 2 THEN '1–2 surveys'
        WHEN completed BETWEEN 3 AND 5 THEN '3–5 surveys'
        ELSE '6+ surveys'
      END as label, COUNT(*) as count
      FROM (
        SELECT u.id, COUNT(sr.id) as completed
        FROM users u
        LEFT JOIN survey_responses sr ON sr.user_id = u.id AND sr.completed_at IS NOT NULL
        GROUP BY u.id
      ) depths
      GROUP BY 1
    `).all(),
    db.prepare(`
      SELECT
        SUM(CASE WHEN date_of_birth IS NULL THEN 1 ELSE 0 END) as no_date_of_birth,
        SUM(CASE WHEN gender IS NULL OR gender = '' THEN 1 ELSE 0 END) as no_gender,
        SUM(CASE WHEN location_state IS NULL OR location_state = '' THEN 1 ELSE 0 END) as no_location,
        SUM(CASE WHEN api_products IS NULL OR api_products = '[]' THEN 1 ELSE 0 END) as no_products
      FROM users
    `).get(),
    db.prepare('SELECT COUNT(*) as c FROM users').get()
  ]);

  res.json({
    total: Number(totalRow?.c || 0),
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
