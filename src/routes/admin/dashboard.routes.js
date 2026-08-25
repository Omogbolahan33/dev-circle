const express = require('express');
const db = require('../../db');
const { requirePermission } = require('../../middleware/auth');

const router = express.Router();

// ─── Dashboard ──────────────────────────────────────────────

// GET /api/admin/dashboard
router.get('/dashboard', requirePermission('members.read'), async (req, res) => {
  const [
    statsRow, recentActivity, cohortBreakdown, statusBreakdown
  ] = await Promise.all([
    db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users) as total_members,
        (SELECT COUNT(*) FROM cohorts) as active_cohorts,
        (SELECT COUNT(*) FROM survey_responses) as surveys_sent,
        (SELECT COUNT(*) FROM survey_responses WHERE completed_at IS NOT NULL) as surveys_completed,
        (SELECT COUNT(*) FROM users WHERE created_at > datetime('now', '-7 days')) as new_this_week
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
      SELECT api_status, COUNT(*) as count FROM users GROUP BY api_status
    `).all()
  ]);

  const totalMembers = Number(statsRow?.total_members || 0);
  const totalSurveysSent = Number(statsRow?.surveys_sent || 0);
  const completedSurveys = Number(statsRow?.surveys_completed || 0);
  const engagementRate = totalSurveysSent > 0 ? Math.round((completedSurveys / totalSurveysSent) * 100) : 0;

  res.json({
    stats: {
      total_members: totalMembers,
      active_cohorts: Number(statsRow?.active_cohorts || 0),
      engagement_rate: engagementRate,
      surveys_sent: totalSurveysSent,
      surveys_completed: completedSurveys,
      new_this_week: Number(statsRow?.new_this_week || 0)
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
  // Ten GROUP BYs used to open ten connections on a pool of ten. One scan of
  // the member columns plus one survey tally is enough through a few thousand
  // rows and stays a single network wait.
  const [users, completedRows] = await Promise.all([
    db.prepare(`
      SELECT id, work_sector, location_state, gender, date_of_birth,
             api_products, api_status, kyb_completed
      FROM users
    `).all(),
    db.prepare(`
      SELECT user_id, COUNT(*) as c FROM survey_responses
      WHERE completed_at IS NOT NULL
      GROUP BY user_id
    `).all()
  ]);

  const rows = users || [];
  const completedByUser = new Map((completedRows || []).map(r => [r.user_id, Number(r.c || 0)]));

  const tally = (pick, { limit } = {}) => {
    const map = new Map();
    for (const row of rows) {
      const label = pick(row);
      map.set(label, (map.get(label) || 0) + 1);
    }
    const out = [...map.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
    return limit ? out.slice(0, limit) : out;
  };

  const blank = value => value == null || value === '' ? 'Unspecified' : value;

  const ageBand = dob => {
    if (!dob) return 'Unspecified';
    const years = (Date.now() - new Date(String(dob)).getTime()) / (365.25 * 86400000);
    if (!Number.isFinite(years) || years < 0) return 'Unspecified';
    if (years < 25) return 'Under 25';
    if (years < 35) return '25–34';
    if (years < 45) return '35–44';
    return '45+';
  };

  const productCounts = new Map();
  let noProducts = 0;
  for (const row of rows) {
    let products = row.api_products;
    if (typeof products === 'string') {
      try { products = JSON.parse(products); } catch { products = []; }
    }
    if (!Array.isArray(products) || products.length === 0) {
      noProducts++;
      continue;
    }
    for (const product of products) {
      if (product == null || product === '') continue;
      const label = String(product);
      productCounts.set(label, (productCounts.get(label) || 0) + 1);
    }
  }

  const depthTally = new Map();
  for (const row of rows) {
    const n = completedByUser.get(row.id) || 0;
    const label = n === 0 ? 'Never responded'
      : n <= 2 ? '1–2 surveys'
        : n <= 5 ? '3–5 surveys'
          : '6+ surveys';
    depthTally.set(label, (depthTally.get(label) || 0) + 1);
  }

  const kybCompleted = value => value === 1 || value === true || value === '1';

  res.json({
    total: rows.length,
    work_sector: tally(r => blank(r.work_sector)),
    location_state: tally(r => blank(r.location_state), { limit: 15 }),
    gender: tally(r => blank(r.gender)),
    age_band: tally(r => ageBand(r.date_of_birth)),
    api_products: [...productCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
    api_status: tally(r => r.api_status),
    kyb: tally(r => kybCompleted(r.kyb_completed) ? 'Completed' : 'Pending'),
    engagement_depth: [...depthTally.entries()].map(([label, count]) => ({ label, count })),
    data_coverage: {
      no_date_of_birth: rows.filter(r => r.date_of_birth == null || r.date_of_birth === '').length,
      no_gender: rows.filter(r => r.gender == null || r.gender === '').length,
      no_location: rows.filter(r => r.location_state == null || r.location_state === '').length,
      no_products: noProducts
    }
  });
});

module.exports = router;
