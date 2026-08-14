const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const {
  uuid, parseJSON, paginate, sanitizeUser, toCSV, parseCSV
} = require('../utils/helpers');
const { parseXLSX } = require('../utils/xlsx');
const {
  requireAuth, requireAdmin, requirePermission,
  generateApiKey, hashApiKey, destroyAllSessionsFor,
  PERMISSIONS
} = require('../middleware/auth');
const engagement = require('../services/engagement');
const notifications = require('../services/notifications');
const cohortRules = require('../services/cohortRules');
const circles = require('../services/circles');

const router = express.Router();

// Authentication and admin status are the floor; each route below then
// declares the capability it needs. Roles were previously decorative —
// any admin could do anything regardless of their assigned permissions.
router.use(requireAuth, requireAdmin);

// ─── Dashboard ──────────────────────────────────────────────

// GET /api/admin/dashboard
router.get('/dashboard', requirePermission('members.read'), (req, res) => {
  const totalMembers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const activeCohorts = db.prepare('SELECT COUNT(*) as c FROM cohorts').get().c;
  const totalSurveysSent = db.prepare('SELECT COUNT(*) as c FROM survey_responses').get().c;
  const completedSurveys = db.prepare("SELECT COUNT(*) as c FROM survey_responses WHERE completed_at IS NOT NULL").get().c;
  const engagementRate = totalSurveysSent > 0 ? Math.round((completedSurveys / totalSurveysSent) * 100) : 0;

  const recentActivity = db.prepare(`
    SELECT eh.*, u.name as user_name, u.email as user_email
    FROM engagement_history eh
    LEFT JOIN users u ON u.id = eh.user_id
    ORDER BY eh.created_at DESC
    LIMIT 20
  `).all();

  const cohortBreakdown = db.prepare(`
    SELECT c.id, c.name, c.color, COUNT(uc.user_id) as member_count
    FROM cohorts c
    LEFT JOIN user_cohorts uc ON uc.cohort_id = c.id
    GROUP BY c.id
    ORDER BY member_count DESC
    LIMIT 10
  `).all();

  const statusBreakdown = db.prepare(`
    SELECT api_status, COUNT(*) as count FROM users GROUP BY api_status
  `).all();

  const newThisWeek = db.prepare(
    "SELECT COUNT(*) as c FROM users WHERE created_at > datetime('now', '-7 days')"
  ).get().c;

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
router.get('/demography', requirePermission('members.read'), (req, res) => {
  const bySector = db.prepare(`
    SELECT COALESCE(NULLIF(work_sector, ''), 'Unspecified') as label, COUNT(*) as count
    FROM users GROUP BY label ORDER BY count DESC
  `).all();

  const byState = db.prepare(`
    SELECT COALESCE(NULLIF(location_state, ''), 'Unspecified') as label, COUNT(*) as count
    FROM users GROUP BY label ORDER BY count DESC LIMIT 15
  `).all();

  const byGender = db.prepare(`
    SELECT COALESCE(NULLIF(gender, ''), 'Unspecified') as label, COUNT(*) as count
    FROM users GROUP BY label ORDER BY count DESC
  `).all();

  const byAge = db.prepare(`
    SELECT CASE
      WHEN date_of_birth IS NULL THEN 'Unspecified'
      WHEN (julianday('now') - julianday(date_of_birth)) / 365.25 < 25 THEN 'Under 25'
      WHEN (julianday('now') - julianday(date_of_birth)) / 365.25 < 35 THEN '25–34'
      WHEN (julianday('now') - julianday(date_of_birth)) / 365.25 < 45 THEN '35–44'
      ELSE '45+'
    END as label, COUNT(*) as count
    FROM users GROUP BY label ORDER BY count DESC
  `).all();

  // api_products is a JSON array, so each member counts once per product
  const byProduct = db.prepare(`
    SELECT json_each.value as label, COUNT(*) as count
    FROM users, json_each(users.api_products)
    GROUP BY label ORDER BY count DESC
  `).all();

  const byApiStatus = db.prepare('SELECT api_status as label, COUNT(*) as count FROM users GROUP BY label').all();

  const kyb = db.prepare(`
    SELECT CASE COALESCE(kyb_completed, 0) WHEN 1 THEN 'Completed' ELSE 'Pending' END as label,
           COUNT(*) as count
    FROM users GROUP BY label
  `).all();

  const engagementDepth = db.prepare(`
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
    ) GROUP BY label
  `).all();

  const missing = db.prepare(`
    SELECT
      SUM(CASE WHEN date_of_birth IS NULL THEN 1 ELSE 0 END) as no_date_of_birth,
      SUM(CASE WHEN gender IS NULL OR gender = '' THEN 1 ELSE 0 END) as no_gender,
      SUM(CASE WHEN location_state IS NULL OR location_state = '' THEN 1 ELSE 0 END) as no_location,
      SUM(CASE WHEN api_products IS NULL OR api_products = '[]' THEN 1 ELSE 0 END) as no_products
    FROM users
  `).get();

  res.json({
    total: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
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

// ─── Members ────────────────────────────────────────────────

// Shared filter builder for member listing and export
function memberFilters(query) {
  const where = ['1=1'];
  const params = [];

  const { search, status, api_status, cohort_id, work_sector, location_state,
          gender, api_product, kyb_completed, min_streak } = query;

  if (search) {
    where.push('(u.name LIKE ? OR u.email LIKE ? OR u.company LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (status) { where.push('u.status = ?'); params.push(status); }
  if (api_status) { where.push('u.api_status = ?'); params.push(api_status); }
  if (work_sector) { where.push('u.work_sector = ?'); params.push(work_sector); }
  if (location_state) { where.push('u.location_state = ?'); params.push(location_state); }
  if (gender) { where.push('u.gender = ?'); params.push(gender); }
  if (kyb_completed !== undefined && kyb_completed !== '') {
    where.push('COALESCE(u.kyb_completed, 0) = ?');
    params.push(['1', 'true', 'yes'].includes(String(kyb_completed)) ? 1 : 0);
  }
  if (min_streak) { where.push('COALESCE(u.engagement_streak, 0) >= ?'); params.push(parseInt(min_streak, 10) || 0); }
  if (api_product) {
    where.push('EXISTS (SELECT 1 FROM json_each(u.api_products) WHERE json_each.value = ?)');
    params.push(api_product);
  }
  if (cohort_id) {
    where.push('u.id IN (SELECT user_id FROM user_cohorts WHERE cohort_id = ?)');
    params.push(cohort_id);
  }

  return { where: where.join(' AND '), params };
}

// GET /api/admin/members
router.get('/members', requirePermission('members.read'), (req, res) => {
  const { offset, limit: l, page: p } = paginate(req.query.page, req.query.limit);
  const { where, params } = memberFilters(req.query);

  const total = db.prepare(`SELECT COUNT(*) as c FROM users u WHERE ${where}`).get(...params).c;

  // Counts come from correlated subqueries rather than a query per member,
  // which was N+1 across the whole page.
  const members = db.prepare(`
    SELECT u.id, u.email, u.name, u.phone, u.company, u.work_sector,
           u.status, u.api_status, u.kyb_completed, u.engagement_streak,
           u.preferred_channels, u.preferred_days, u.api_products,
           u.gender, u.location_state, u.date_of_birth,
           u.last_active_at, u.created_at,
           (SELECT COUNT(*) FROM survey_responses sr
             WHERE sr.user_id = u.id AND sr.completed_at IS NOT NULL) as surveys_completed,
           (SELECT COUNT(*) FROM survey_responses sr WHERE sr.user_id = u.id) as surveys_invited
    FROM users u
    WHERE ${where}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, l, offset);

  const cohortStmt = db.prepare(`
    SELECT c.id, c.name, c.color FROM cohorts c
    JOIN user_cohorts uc ON uc.cohort_id = c.id
    WHERE uc.user_id = ?
  `);

  const result = members.map(m => ({
    ...m,
    preferred_channels: parseJSON(m.preferred_channels, []),
    preferred_days: parseJSON(m.preferred_days, []),
    api_products: parseJSON(m.api_products, []),
    cohorts: cohortStmt.all(m.id)
  }));

  res.json({
    members: result,
    pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) }
  });
});

// GET /api/admin/members/:id
router.get('/members/:id', requirePermission('members.read'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Member not found' });

  const cohorts = db.prepare(`
    SELECT c.* FROM cohorts c JOIN user_cohorts uc ON uc.cohort_id = c.id WHERE uc.user_id = ?
  `).all(user.id);

  res.json({
    user: sanitizeUser(user),
    cohorts,
    consent: db.prepare('SELECT * FROM consent WHERE user_id = ?').all(user.id),
    engagement: db.prepare(
      'SELECT * FROM engagement_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(user.id),
    feedback: db.prepare(
      'SELECT * FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
    ).all(user.id),
    survey_responses: db.prepare(`
      SELECT sr.*, s.title as survey_title
      FROM survey_responses sr JOIN surveys s ON s.id = sr.survey_id
      WHERE sr.user_id = ? ORDER BY sr.created_at DESC
    `).all(user.id),
    gifts: db.prepare(`
      SELECT g.name, g.value, g.currency, ug.claimed_at, ug.delivered_at
      FROM user_gifts ug JOIN gifts g ON g.id = ug.gift_id
      WHERE ug.user_id = ? ORDER BY ug.claimed_at DESC
    `).all(user.id),
    deliveries: db.prepare(`
      SELECT source_type, channel, status, reason, created_at
      FROM message_deliveries WHERE user_id = ? ORDER BY created_at DESC LIMIT 25
    `).all(user.id)
  });
});

// PUT /api/admin/members/:id
router.put('/members/:id', requirePermission('members.write'), (req, res) => {
  const { status, api_status, kyb_completed, work_sector, api_products, location_state, gender } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Member not found' });

  const updates = [];
  const params = [];

  if (status) {
    if (!['active', 'inactive', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    updates.push('status = ?'); params.push(status);
  }
  if (api_status) { updates.push('api_status = ?'); params.push(api_status); }
  if (kyb_completed !== undefined) { updates.push('kyb_completed = ?'); params.push(kyb_completed ? 1 : 0); }
  if (work_sector !== undefined) { updates.push('work_sector = ?'); params.push(work_sector); }
  if (location_state !== undefined) { updates.push('location_state = ?'); params.push(location_state); }
  if (gender !== undefined) { updates.push('gender = ?'); params.push(gender); }
  if (api_products !== undefined) {
    if (!Array.isArray(api_products)) return res.status(400).json({ error: 'api_products must be an array' });
    updates.push('api_products = ?'); params.push(JSON.stringify(api_products));
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  params.push(user.id);

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // Deactivating a member must also end their live sessions, otherwise the
  // account stays usable until the token happens to expire.
  if (status && status !== 'active') {
    destroyAllSessionsFor(user.id);
  }

  // Membership of rule-based cohorts may have changed with these fields
  cohortRules.syncAll();

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: sanitizeUser(updated) });
});

// POST /api/admin/members/:id/reset-password
router.post('/members/:id/reset-password', requirePermission('members.write'), (req, res) => {
  const { new_password } = req.body;
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'new_password of at least 8 characters is required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Member not found' });

  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bcrypt.hashSync(new_password, 10), user.id);

  // A password reset invalidates existing sessions
  destroyAllSessionsFor(user.id);

  res.json({ message: 'Password reset successful. Existing sessions were signed out.' });
});

// ─── Cohorts ────────────────────────────────────────────────

// GET /api/admin/cohorts
router.get('/cohorts', requirePermission('cohorts.read'), (req, res) => {
  const { circle_id } = req.query;

  const cohorts = db.prepare(`
    SELECT c.*, ci.name as circle_name, COUNT(uc.user_id) as member_count
    FROM cohorts c
    LEFT JOIN user_cohorts uc ON uc.cohort_id = c.id
    LEFT JOIN circles ci ON ci.id = c.circle_id
    ${circle_id ? 'WHERE c.circle_id = ?' : ''}
    GROUP BY c.id
    ORDER BY member_count DESC
  `).all(...(circle_id ? [circle_id] : []));

  res.json({
    cohorts: cohorts.map(c => ({ ...c, filter_rules: parseJSON(c.filter_rules, null) }))
  });
});

// GET /api/admin/cohorts/rule-fields — catalogue for the cohort builder
router.get('/cohorts/rule-fields', requirePermission('cohorts.read'), (req, res) => {
  res.json({ fields: cohortRules.catalogue() });
});

// POST /api/admin/cohorts/preview — how many members a rule set matches
router.post('/cohorts/preview', requirePermission('cohorts.read'), (req, res) => {
  try {
    const result = cohortRules.evaluate(req.body.filter_rules, { limit: 10 });
    res.json(result);
  } catch (err) {
    if (err instanceof cohortRules.RuleError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// POST /api/admin/cohorts
router.post('/cohorts', requirePermission('cohorts.write'), (req, res) => {
  const { name, description, color, type = 'custom', filter_rules, auto_sync = true, circle_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  let circle;
  try {
    circle = circles.resolve(circle_id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Validate the rules before storing them, so a cohort can never be saved
  // with a definition the engine cannot evaluate.
  if (filter_rules) {
    try {
      cohortRules.evaluate(filter_rules, { limit: 1 });
    } catch (err) {
      if (err instanceof cohortRules.RuleError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO cohorts (id, name, description, type, color, filter_rules, auto_sync, circle_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, description || null, type, color || '#107EBC',
    filter_rules ? JSON.stringify(filter_rules) : null,
    filter_rules && auto_sync ? 1 : 0,
    circle.id,
    req.admin.id
  );

  // Populate immediately. Rule-based cohorts used to be created empty because
  // matching happened only in the browser preview and was then discarded.
  const sync = filter_rules ? cohortRules.sync(id) : { added: 0, removed: 0, total: 0 };

  const cohort = db.prepare('SELECT * FROM cohorts WHERE id = ?').get(id);
  res.status(201).json({
    cohort: { ...cohort, filter_rules: parseJSON(cohort.filter_rules, null) },
    sync
  });
});

// PUT /api/admin/cohorts/:id
router.put('/cohorts/:id', requirePermission('cohorts.write'), (req, res) => {
  const { name, description, color, filter_rules, auto_sync } = req.body;
  const cohort = db.prepare('SELECT * FROM cohorts WHERE id = ?').get(req.params.id);
  if (!cohort) return res.status(404).json({ error: 'Cohort not found' });

  const updates = [];
  const params = [];

  if (name) { updates.push('name = ?'); params.push(name); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (color) { updates.push('color = ?'); params.push(color); }
  if (auto_sync !== undefined) { updates.push('auto_sync = ?'); params.push(auto_sync ? 1 : 0); }
  if (filter_rules !== undefined) {
    if (filter_rules) {
      try {
        cohortRules.evaluate(filter_rules, { limit: 1 });
      } catch (err) {
        if (err instanceof cohortRules.RuleError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }
    updates.push('filter_rules = ?');
    params.push(filter_rules ? JSON.stringify(filter_rules) : null);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  params.push(cohort.id);
  db.prepare(`UPDATE cohorts SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const sync = filter_rules !== undefined && filter_rules
    ? cohortRules.sync(cohort.id)
    : null;

  const updated = db.prepare('SELECT * FROM cohorts WHERE id = ?').get(cohort.id);
  res.json({ cohort: { ...updated, filter_rules: parseJSON(updated.filter_rules, null) }, sync });
});

// POST /api/admin/cohorts/:id/sync — re-run the rules on demand
router.post('/cohorts/:id/sync', requirePermission('cohorts.write'), (req, res) => {
  try {
    res.json(cohortRules.sync(req.params.id));
  } catch (err) {
    if (err instanceof cohortRules.RuleError) return res.status(404).json({ error: err.message });
    throw err;
  }
});

// DELETE /api/admin/cohorts/:id
router.delete('/cohorts/:id', requirePermission('cohorts.write'), (req, res) => {
  const cohort = db.prepare('SELECT * FROM cohorts WHERE id = ?').get(req.params.id);
  if (!cohort) return res.status(404).json({ error: 'Cohort not found' });
  if (cohort.type === 'system') return res.status(400).json({ error: 'Cannot delete system cohorts' });

  db.transaction(() => {
    db.prepare('DELETE FROM user_cohorts WHERE cohort_id = ?').run(cohort.id);
    db.prepare('DELETE FROM cohorts WHERE id = ?').run(cohort.id);
  })();

  res.json({ message: 'Cohort deleted' });
});

// POST /api/admin/cohorts/:id/members
router.post('/cohorts/:id/members', requirePermission('cohorts.write'), (req, res) => {
  const { user_ids } = req.body;
  if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids array required' });

  const cohort = db.prepare('SELECT * FROM cohorts WHERE id = ?').get(req.params.id);
  if (!cohort) return res.status(404).json({ error: 'Cohort not found' });

  const stmt = db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)');
  const exists = db.prepare('SELECT 1 FROM users WHERE id = ?');

  let added = 0;
  const unknown = [];

  db.transaction(() => {
    for (const uid of user_ids) {
      if (!exists.get(uid)) { unknown.push(uid); continue; }
      added += stmt.run(uid, cohort.id).changes;
    }
  })();

  const count = db.prepare('SELECT COUNT(*) as c FROM user_cohorts WHERE cohort_id = ?').get(cohort.id).c;
  res.json({ message: `${added} member(s) added`, added, unknown, member_count: count });
});

// DELETE /api/admin/cohorts/:id/members/:userId
router.delete('/cohorts/:id/members/:userId', requirePermission('cohorts.write'), (req, res) => {
  db.prepare('DELETE FROM user_cohorts WHERE user_id = ? AND cohort_id = ?')
    .run(req.params.userId, req.params.id);
  res.json({ message: 'Member removed from cohort' });
});

// ─── Surveys ────────────────────────────────────────────────

// GET /api/admin/surveys
router.get('/surveys', requirePermission('surveys.read'), (req, res) => {
  const surveys = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM survey_responses sr WHERE sr.survey_id = s.id) as response_count,
      (SELECT COUNT(*) FROM survey_responses sr
        WHERE sr.survey_id = s.id AND sr.completed_at IS NOT NULL) as completed_count
    FROM surveys s ORDER BY s.created_at DESC
  `).all();

  res.json({
    surveys: surveys.map(s => ({
      ...s,
      questions: parseJSON(s.questions, []),
      target_ids: parseJSON(s.target_ids, [])
    }))
  });
});

// Membership of a sub-circle bounds every audience derived from its work.
// Root-circle work reaches everyone, so it needs no extra restriction.
function circleScope(circleId) {
  const root = db.prepare('SELECT id FROM circles WHERE is_root = 1').get();
  if (!circleId || !root || circleId === root.id) return { clause: '', params: [] };
  return {
    clause: 'AND u.id IN (SELECT user_id FROM circle_members WHERE circle_id = ?)',
    params: [circleId]
  };
}

// Resolve a survey's audience to member rows
function resolveAudience(survey) {
  const targets = parseJSON(survey.target_ids, []) || [];
  const scope = circleScope(survey.circle_id);

  if (survey.target_type === 'all') {
    return db.prepare(`SELECT * FROM users u WHERE u.status = 'active' ${scope.clause}`)
      .all(...scope.params);
  }

  if (!targets.length) return [];
  const placeholders = targets.map(() => '?').join(',');

  if (survey.target_type === 'cohort') {
    return db.prepare(`
      SELECT DISTINCT u.* FROM users u
      JOIN user_cohorts uc ON uc.user_id = u.id
      WHERE uc.cohort_id IN (${placeholders}) AND u.status = 'active' ${scope.clause}
    `).all(...targets, ...scope.params);
  }

  if (survey.target_type === 'specific') {
    return db.prepare(`
      SELECT * FROM users u WHERE u.id IN (${placeholders}) AND u.status = 'active' ${scope.clause}
    `).all(...targets, ...scope.params);
  }

  return [];
}

// GET /api/admin/surveys/:id/audience
// "See eligible cohorts of users according to their cohorts for surveys" —
// who this survey would reach, and who is already excluded.
router.get('/surveys/:id/audience', requirePermission('surveys.read'), (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const audience = resolveAudience(survey);

  const alreadyInvited = new Set(
    db.prepare('SELECT user_id FROM survey_responses WHERE survey_id = ?').all(survey.id).map(r => r.user_id)
  );
  const completed = new Set(
    db.prepare('SELECT user_id FROM survey_responses WHERE survey_id = ? AND completed_at IS NOT NULL')
      .all(survey.id).map(r => r.user_id)
  );

  const mode = survey.engagement_mode;
  const reachable = [];
  const unreachable = [];
  let completedInAudience = 0;

  for (const user of audience) {
    if (completed.has(user.id)) { completedInAudience++; continue; }
    const { allowed, skipped } = notifications.resolveChannels(
      user,
      mode === 'in_portal' || mode === '1-on-1' ? ['in_portal'] : ['in_portal', mode],
      'survey_invites'
    );
    const entry = {
      id: user.id, name: user.name, email: user.email, company: user.company,
      already_invited: alreadyInvited.has(user.id),
      channels: allowed
    };
    if (allowed.length) reachable.push(entry);
    else unreachable.push({ ...entry, reasons: skipped.map(s => s.reason) });
  }

  res.json({
    survey: { id: survey.id, title: survey.title, engagement_mode: mode, target_type: survey.target_type },
    eligible_count: audience.length,
    reachable,
    unreachable,
    // Completions within this audience — a member who responded before the
    // targeting changed should not inflate the count
    already_completed: completedInAudience,
    completed_overall: completed.size
  });
});

// POST /api/admin/surveys
router.post('/surveys', requirePermission('surveys.write'), (req, res) => {
  const {
    title, description, questions, target_type, target_ids,
    engagement_mode, time_estimate_min, expires_at, trigger_event, reminder_after_days, circle_id
  } = req.body;

  if (!title || !questions) return res.status(400).json({ error: 'title and questions required' });
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'questions must be an array' });

  let circle;
  try {
    circle = circles.resolve(circle_id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Every question needs a stable id — responses are keyed by it, and an
  // export lines answers up against it.
  const withIds = questions.map((q, i) => ({ ...q, id: q.id || `q${i + 1}_${uuid().slice(0, 8)}` }));

  const id = uuid();
  db.prepare(`
    INSERT INTO surveys (id, title, description, questions, target_type, target_ids,
                         engagement_mode, time_estimate_min, expires_at, trigger_event,
                         reminder_after_days, circle_id, created_by, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
  `).run(
    id, title, description || null, JSON.stringify(withIds),
    target_type || 'all', JSON.stringify(target_ids || []),
    engagement_mode || 'in_portal', time_estimate_min || 5,
    expires_at || null, trigger_event || null, reminder_after_days || null,
    circle.id, req.admin.id
  );

  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(id);
  res.status(201).json({ survey: { ...survey, questions: withIds } });
});

// PUT /api/admin/surveys/:id
router.put('/surveys/:id', requirePermission('surveys.write'), (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const {
    title, description, questions, status, target_type, target_ids,
    engagement_mode, time_estimate_min, expires_at, trigger_event, reminder_after_days
  } = req.body;

  const updates = [];
  const params = [];

  if (title) { updates.push('title = ?'); params.push(title); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (questions) {
    if (!Array.isArray(questions)) return res.status(400).json({ error: 'questions must be an array' });
    // Editing questions after responses exist would orphan collected answers
    const responded = db.prepare(
      'SELECT COUNT(*) as c FROM survey_responses WHERE survey_id = ? AND completed_at IS NOT NULL'
    ).get(survey.id).c;
    if (responded > 0) {
      return res.status(409).json({
        error: `Cannot change questions — ${responded} member(s) have already responded. Close this survey and create a new version.`
      });
    }
    const withIds = questions.map((q, i) => ({ ...q, id: q.id || `q${i + 1}_${uuid().slice(0, 8)}` }));
    updates.push('questions = ?'); params.push(JSON.stringify(withIds));
  }
  if (status) {
    if (!['draft', 'active', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    updates.push('status = ?'); params.push(status);
  }
  if (target_type) { updates.push('target_type = ?'); params.push(target_type); }
  if (target_ids) { updates.push('target_ids = ?'); params.push(JSON.stringify(target_ids)); }
  if (engagement_mode) { updates.push('engagement_mode = ?'); params.push(engagement_mode); }
  if (time_estimate_min) { updates.push('time_estimate_min = ?'); params.push(time_estimate_min); }
  if (expires_at !== undefined) { updates.push('expires_at = ?'); params.push(expires_at); }
  if (trigger_event !== undefined) { updates.push('trigger_event = ?'); params.push(trigger_event || null); }
  if (reminder_after_days !== undefined) {
    updates.push('reminder_after_days = ?'); params.push(reminder_after_days || null);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  params.push(survey.id);
  db.prepare(`UPDATE surveys SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM surveys WHERE id = ?').get(survey.id);
  res.json({ survey: { ...updated, questions: parseJSON(updated.questions, []) } });
});

// POST /api/admin/surveys/:id/invite
// Sends the invitation over the survey's engagement mode. Previously the mode
// was stored and no invitation was ever sent.
router.post('/surveys/:id/invite', requirePermission('surveys.invite'), async (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });
  if (survey.status !== 'active') {
    return res.status(409).json({ error: 'Activate the survey before inviting members' });
  }

  const { resend = false } = req.body;
  const audience = resolveAudience(survey);

  const invited = new Set(
    db.prepare('SELECT user_id FROM survey_responses WHERE survey_id = ?').all(survey.id).map(r => r.user_id)
  );
  const completed = new Set(
    db.prepare('SELECT user_id FROM survey_responses WHERE survey_id = ? AND completed_at IS NOT NULL')
      .all(survey.id).map(r => r.user_id)
  );

  const mode = survey.engagement_mode;
  const channels = mode === 'in_portal' || mode === '1-on-1' ? ['in_portal'] : ['in_portal', mode];

  const recipients = audience.filter(u => !completed.has(u.id) && (resend || !invited.has(u.id)));

  const insertResponse = db.prepare(`
    INSERT INTO survey_responses (id, survey_id, user_id, triggered_by) VALUES (?, ?, ?, 'manual')
  `);

  const summary = { invited: 0, delivered: 0, skipped: 0, queued: 0, failed: 0 };

  for (const user of recipients) {
    if (!invited.has(user.id)) {
      insertResponse.run(uuid(), survey.id, user.id);
      invited.add(user.id);
    }

    engagement.log(user.id, 'survey_invited', {
      referenceId: survey.id,
      metadata: { engagement_mode: mode, survey_title: survey.title },
      source: 'manual'
    });

    const result = await notifications.notify(user, {
      category: 'survey_invites',
      title: survey.title,
      body: survey.description ||
        `We'd like your input. This takes about ${survey.time_estimate_min} minutes.`,
      actionUrl: `survey.html?id=${survey.id}`,
      sourceType: 'survey_invite',
      sourceId: survey.id,
      channels
    });

    summary.invited++;
    for (const d of result.deliveries) {
      if (d.status === 'sent' || d.status === 'simulated') summary.delivered++;
      else if (d.status === 'queued') summary.queued++;
      else if (d.status === 'failed') summary.failed++;
      else summary.skipped++;
    }
  }

  res.json({
    message: `Invited ${summary.invited} member(s) via ${mode}`,
    eligible: audience.length,
    ...summary,
    // A 1-on-1 invite is a task for a rep; the portal notification is the cue
    requires_manual_followup: mode === '1-on-1' ? summary.invited : 0
  });
});

// POST /api/admin/surveys/:id/remind — nudge members who haven't responded
router.post('/surveys/:id/remind', requirePermission('surveys.invite'), async (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const pending = db.prepare(`
    SELECT u.* FROM survey_responses sr
    JOIN users u ON u.id = sr.user_id
    WHERE sr.survey_id = ? AND sr.completed_at IS NULL AND u.status = 'active'
  `).all(survey.id);

  const mode = survey.engagement_mode;
  const channels = mode === 'in_portal' || mode === '1-on-1' ? ['in_portal'] : ['in_portal', mode];

  let reminded = 0;
  for (const user of pending) {
    engagement.log(user.id, 'survey_reminded', { referenceId: survey.id, source: 'manual' });
    await notifications.notify(user, {
      category: 'survey_reminders',
      title: `Reminder: ${survey.title}`,
      body: `Still open — about ${survey.time_estimate_min} minutes of your time.`,
      actionUrl: `survey.html?id=${survey.id}`,
      sourceType: 'survey_reminder',
      sourceId: survey.id,
      channels
    });
    reminded++;
  }

  res.json({ message: `Reminded ${reminded} member(s)`, reminded });
});

// GET /api/admin/surveys/:id/responses
router.get('/surveys/:id/responses', requirePermission('surveys.read'), (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const responses = db.prepare(`
    SELECT sr.*, u.name as user_name, u.email as user_email
    FROM survey_responses sr
    JOIN users u ON u.id = sr.user_id
    WHERE sr.survey_id = ?
    ORDER BY sr.created_at DESC
  `).all(survey.id);

  res.json({
    survey: { ...survey, questions: parseJSON(survey.questions, []) },
    responses: responses.map(r => ({ ...r, answers: parseJSON(r.answers, {}) }))
  });
});

// GET /api/admin/surveys/:id/export
router.get('/surveys/:id/export', requirePermission('export.read'), (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const questions = parseJSON(survey.questions, []);
  const responses = db.prepare(`
    SELECT sr.*, u.name as user_name, u.email as user_email, u.company as user_company
    FROM survey_responses sr
    JOIN users u ON u.id = sr.user_id
    WHERE sr.survey_id = ? AND sr.completed_at IS NOT NULL
    ORDER BY sr.completed_at DESC
  `).all(survey.id);

  const headers = [
    'respondent_name', 'respondent_email', 'company', 'submitted_at', 'triggered_by',
    ...questions.map((q, i) => `q${i + 1}. ${q.text || q.type}`)
  ];

  const rows = responses.map(r => {
    const answers = parseJSON(r.answers, {});
    return [
      r.user_name, r.user_email, r.user_company, r.completed_at, r.triggered_by,
      ...questions.map(q => {
        const val = answers[q.id];
        return Array.isArray(val) ? val.join('; ') : val;
      })
    ];
  });

  const csv = toCSV(headers, rows, (row, header) => row[headers.indexOf(header)]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="survey-${survey.id}-responses.csv"`);
  res.send(csv);
});

// ─── Message Blasts ─────────────────────────────────────────

// GET /api/admin/blasts
router.get('/blasts', requirePermission('blasts.send', 'members.read'), (req, res) => {
  const blasts = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM message_deliveries d
        WHERE d.source_type = 'blast' AND d.source_id = b.id
          AND d.status IN ('sent','simulated')) as delivered_count,
      (SELECT COUNT(*) FROM message_deliveries d
        WHERE d.source_type = 'blast' AND d.source_id = b.id AND d.status = 'skipped') as skipped_count
    FROM message_blasts b ORDER BY b.created_at DESC
  `).all();

  res.json({ blasts: blasts.map(b => ({ ...b, target_ids: parseJSON(b.target_ids, []) })) });
});

// GET /api/admin/blasts/:id/deliveries — the audit trail for one blast
router.get('/blasts/:id/deliveries', requirePermission('blasts.send'), (req, res) => {
  const deliveries = db.prepare(`
    SELECT d.*, u.name as user_name, u.email as user_email
    FROM message_deliveries d
    JOIN users u ON u.id = d.user_id
    WHERE d.source_type = 'blast' AND d.source_id = ?
    ORDER BY d.created_at DESC
  `).all(req.params.id);

  res.json({ deliveries, count: deliveries.length });
});

// POST /api/admin/blasts
router.post('/blasts', requirePermission('blasts.send'), (req, res) => {
  const { subject, content, channel, target_type, target_ids, scheduled_for, circle_id } = req.body;

  if (!content || !channel || !target_type) {
    return res.status(400).json({ error: 'content, channel, and target_type required' });
  }

  let circle;
  try {
    circle = circles.resolve(circle_id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!['email', 'whatsapp', 'sms', 'in_portal', 'all'].includes(channel)) {
    return res.status(400).json({ error: 'Invalid channel' });
  }
  if (!['all', 'cohort', 'specific'].includes(target_type)) {
    return res.status(400).json({ error: 'Invalid target_type' });
  }
  if (target_type !== 'all' && (!Array.isArray(target_ids) || target_ids.length === 0)) {
    return res.status(400).json({ error: `target_ids required when targeting ${target_type}` });
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO message_blasts (id, subject, content, channel, target_type, target_ids,
                                status, sent_by, scheduled_for, circle_id)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
  `).run(id, subject || null, content, channel, target_type,
         JSON.stringify(target_ids || []), req.admin.id, scheduled_for || null, circle.id);

  const blast = db.prepare('SELECT * FROM message_blasts WHERE id = ?').get(id);
  res.status(201).json({ blast: { ...blast, target_ids: parseJSON(blast.target_ids, []) } });
});

function blastRecipients(blast) {
  const targetIds = parseJSON(blast.target_ids, []) || [];
  const scope = circleScope(blast.circle_id);

  if (blast.target_type === 'all') {
    return db.prepare(`SELECT * FROM users u WHERE u.status = 'active' ${scope.clause}`)
      .all(...scope.params);
  }

  if (!targetIds.length) return [];
  const placeholders = targetIds.map(() => '?').join(',');

  if (blast.target_type === 'cohort') {
    return db.prepare(`
      SELECT DISTINCT u.* FROM users u
      JOIN user_cohorts uc ON uc.user_id = u.id
      WHERE uc.cohort_id IN (${placeholders}) AND u.status = 'active' ${scope.clause}
    `).all(...targetIds, ...scope.params);
  }

  return db.prepare(`
    SELECT * FROM users u WHERE u.id IN (${placeholders}) AND u.status = 'active' ${scope.clause}
  `).all(...targetIds, ...scope.params);
}

// POST /api/admin/blasts/:id/preview — who this reaches, before committing
router.post('/blasts/:id/preview', requirePermission('blasts.send'), (req, res) => {
  const blast = db.prepare('SELECT * FROM message_blasts WHERE id = ?').get(req.params.id);
  if (!blast) return res.status(404).json({ error: 'Blast not found' });

  const recipients = blastRecipients(blast);
  const channels = blast.channel === 'all' ? notifications.CHANNELS : ['in_portal', blast.channel];

  let reachable = 0;
  const blocked = [];

  for (const user of recipients) {
    const { allowed, skipped } = notifications.resolveChannels(user, channels, 'platform_updates');
    if (allowed.length) reachable++;
    else blocked.push({ name: user.name, email: user.email, reasons: skipped.map(s => s.reason) });
  }

  res.json({ total: recipients.length, reachable, blocked_count: blocked.length, blocked: blocked.slice(0, 25) });
});

// POST /api/admin/blasts/:id/send
router.post('/blasts/:id/send', requirePermission('blasts.send'), async (req, res) => {
  const blast = db.prepare('SELECT * FROM message_blasts WHERE id = ?').get(req.params.id);
  if (!blast) return res.status(404).json({ error: 'Blast not found' });
  if (blast.status === 'sent') return res.status(409).json({ error: 'Already sent' });
  if (blast.status === 'sending') return res.status(409).json({ error: 'Send already in progress' });

  db.prepare("UPDATE message_blasts SET status = 'sending' WHERE id = ?").run(blast.id);

  try {
    const recipients = blastRecipients(blast);
    const channels = blast.channel === 'all' ? notifications.CHANNELS : ['in_portal', blast.channel];

    // Consent, channel preference, and quiet hours are all applied inside the
    // notification service, and every outcome is recorded per recipient.
    const summary = await notifications.notifyMany(recipients, {
      category: 'platform_updates',
      title: blast.subject || 'A message from Credit Direct',
      body: blast.content,
      actionUrl: 'notifications.html',
      sourceType: 'blast',
      sourceId: blast.id,
      channels
    });

    // Engagement history records a message as a message. It previously logged
    // every blast as 'survey_invited', which corrupted the history.
    for (const entry of summary.per_user) {
      if (entry.delivered > 0) {
        engagement.log(entry.user_id, 'message_sent', {
          referenceId: blast.id,
          metadata: { channel: blast.channel, subject: blast.subject },
          source: 'manual'
        });
      }
    }

    db.prepare(`
      UPDATE message_blasts
      SET status = 'sent', sent_at = datetime('now'), recipient_count = ?, skipped_count = ?
      WHERE id = ?
    `).run(recipients.length, summary.skipped, blast.id);

    res.json({
      message: `Blast processed for ${recipients.length} recipient(s)`,
      recipient_count: recipients.length,
      delivered: summary.delivered,
      skipped: summary.skipped,
      queued_for_quiet_hours: summary.queued,
      failed: summary.failed
    });
  } catch (err) {
    db.prepare("UPDATE message_blasts SET status = 'failed' WHERE id = ?").run(blast.id);
    throw err;
  }
});

// ─── Bulk Import ────────────────────────────────────────────

// POST /api/admin/import
// Accepts either a JSON array or raw CSV pasted from an Excel export.
router.post('/import', requirePermission('members.import'), (req, res) => {
  const { users: importUsers, csv, xlsx_base64, cohort_id, circle_id, dry_run = false } = req.body;

  let rows;
  try {
    if (xlsx_base64) {
      // An .xlsx straight from Excel — no "save as CSV" step required
      rows = parseXLSX(xlsx_base64);
    } else if (csv) {
      rows = parseCSV(csv);
    } else if (Array.isArray(importUsers)) {
      rows = importUsers;
    } else {
      return res.status(400).json({ error: 'Provide a users array, a csv string, or xlsx_base64' });
    }
  } catch (err) {
    return res.status(400).json({ error: `Could not read the workbook: ${err.message}` });
  }

  if (!rows.length) {
    return res.status(400).json({ error: 'No data rows found. Include a header row with at least email and name.' });
  }

  const results = { created: 0, skipped: 0, errors: [], preview: [] };

  // Thrown to roll the transaction back after a dry run has counted everything
  class DryRun extends Error {}

  const existsStmt = db.prepare('SELECT id FROM users WHERE email = ?');
  const insertStmt = db.prepare(`
    INSERT INTO users (id, email, name, phone, company, work_sector, password_hash,
                       date_of_birth, gender, location_state, api_products)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const allCohort = db.prepare("SELECT id FROM cohorts WHERE name = 'All Members'").get();
  const cohortStmt = db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)');
  const circleStmt = db.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id) VALUES (?, ?)');

  // Everyone joins the root circle; a sub-circle can be named to seed it too
  const rootCircle = circles.root();
  const targetCircle = circle_id ? db.prepare('SELECT * FROM circles WHERE id = ?').get(circle_id) : null;
  if (circle_id && !targetCircle) {
    return res.status(400).json({ error: 'Unknown circle_id' });
  }

  const normalise = row => ({
    email: (row.email || '').trim().toLowerCase(),
    name: (row.name || row.full_name || '').trim(),
    phone: row.phone || row.phone_number || null,
    company: row.company || row.organisation || row.organization || null,
    work_sector: row.work_sector || row.sector || null,
    date_of_birth: row.date_of_birth || row.dob || null,
    gender: row.gender || null,
    location_state: row.location_state || row.state || null,
    api_products: row.api_products
      ? String(row.api_products).split(/[;|]/).map(s => s.trim()).filter(Boolean)
      : [],
    password: row.password || null
  });

  const run = db.transaction(() => {
    for (const raw of rows) {
      const row = normalise(raw);

      if (!row.email || !row.name) {
        results.errors.push({ row: raw, error: 'email and name are required' });
        continue;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
        results.errors.push({ row: raw, error: `"${row.email}" is not a valid email` });
        continue;
      }
      if (existsStmt.get(row.email)) {
        results.skipped++;
        continue;
      }

      if (dry_run) {
        results.created++;
        if (results.preview.length < 10) results.preview.push(row);
        continue;
      }

      const id = uuid();
      // Imported members have no password of their own; the admin issues a
      // reset, or the member arrives via Developer Hub SSO.
      const hash = bcrypt.hashSync(row.password || crypto.randomBytes(24).toString('hex'), 10);

      try {
        insertStmt.run(
          id, row.email, row.name, row.phone, row.company, row.work_sector, hash,
          row.date_of_birth, row.gender, row.location_state, JSON.stringify(row.api_products)
        );
        if (allCohort) cohortStmt.run(id, allCohort.id);
        if (cohort_id) cohortStmt.run(id, cohort_id);
        if (rootCircle) circleStmt.run(rootCircle.id, id);
        if (targetCircle && targetCircle.id !== rootCircle?.id) circleStmt.run(targetCircle.id, id);
        engagement.log(id, 'account_created', { metadata: { via: 'bulk_import' }, source: 'manual' });
        results.created++;
      } catch (e) {
        results.errors.push({ row: raw, error: e.message });
      }
    }

    // A dry run must leave nothing behind
    if (dry_run) throw new DryRun();
  });

  try {
    run();
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }

  if (!dry_run) cohortRules.syncAll();

  res.json({
    message: dry_run
      ? `Dry run: ${results.created} would be created, ${results.skipped} already exist`
      : `Import complete: ${results.created} created, ${results.skipped} skipped`,
    dry_run,
    ...results
  });
});

// ─── Export ─────────────────────────────────────────────────

// GET /api/admin/export
router.get('/export', requirePermission('export.read'), (req, res) => {
  const { format = 'json' } = req.query;
  const { where, params } = memberFilters(req.query);

  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.phone, u.company, u.work_sector,
           u.gender, u.location_state, u.date_of_birth, u.api_products,
           u.status, u.api_status, u.kyb_completed, u.engagement_streak,
           u.preferred_channels, u.preferred_days, u.last_active_at, u.created_at,
           (SELECT COUNT(*) FROM survey_responses sr
             WHERE sr.user_id = u.id AND sr.completed_at IS NOT NULL) as surveys_completed,
           (SELECT COUNT(*) FROM user_gifts ug WHERE ug.user_id = u.id) as gifts_claimed,
           (SELECT GROUP_CONCAT(c.name, '; ') FROM cohorts c
             JOIN user_cohorts uc ON uc.cohort_id = c.id WHERE uc.user_id = u.id) as cohorts,
           (SELECT GROUP_CONCAT(ch.channel, '; ') FROM consent ch
             WHERE ch.user_id = u.id AND ch.status = 'granted') as consented_channels
    FROM users u WHERE ${where}
    ORDER BY u.created_at DESC
  `).all(...params);

  const result = users.map(u => ({
    ...u,
    api_products: parseJSON(u.api_products, []),
    preferred_channels: parseJSON(u.preferred_channels, []),
    preferred_days: parseJSON(u.preferred_days, []),
    cohorts: u.cohorts ? u.cohorts.split('; ') : [],
    consented_channels: u.consented_channels ? u.consented_channels.split('; ') : []
  }));

  if (format === 'csv') {
    const headers = [
      'id', 'email', 'name', 'phone', 'company', 'work_sector', 'gender', 'location_state',
      'date_of_birth', 'api_products', 'status', 'api_status', 'kyb_completed',
      'engagement_streak', 'surveys_completed', 'gifts_claimed', 'cohorts',
      'consented_channels', 'preferred_days', 'last_active_at', 'created_at'
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="devcircle-export.csv"');
    return res.send(toCSV(headers, result));
  }

  res.json({ users: result, total: result.length });
});

// ─── Gifts ──────────────────────────────────────────────────

// GET /api/admin/gifts
router.get('/gifts', requirePermission('gifts.read'), (req, res) => {
  const gifts = db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM user_gifts ug WHERE ug.gift_id = g.id) as claimed_count,
      (SELECT COUNT(*) FROM user_gifts ug WHERE ug.gift_id = g.id AND ug.delivered_at IS NOT NULL) as delivered_count
    FROM gifts g ORDER BY g.created_at DESC
  `).all();

  res.json({ gifts: gifts.map(g => ({ ...g, target_cohort_ids: parseJSON(g.target_cohort_ids, []) })) });
});

// POST /api/admin/gifts
router.post('/gifts', requirePermission('gifts.write'), (req, res) => {
  const {
    name, description, value, currency, target_cohort_ids,
    stock, min_surveys_completed, min_streak
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = uuid();
  db.prepare(`
    INSERT INTO gifts (id, name, description, value, currency, target_cohort_ids,
                       stock, min_surveys_completed, min_streak, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id, name, description || null, value || 0, currency || 'NGN',
    JSON.stringify(target_cohort_ids || []),
    stock ?? null, min_surveys_completed || 0, min_streak || 0
  );

  const gift = db.prepare('SELECT * FROM gifts WHERE id = ?').get(id);
  res.status(201).json({ gift: { ...gift, target_cohort_ids: parseJSON(gift.target_cohort_ids, []) } });
});

// PUT /api/admin/gifts/:id
router.put('/gifts/:id', requirePermission('gifts.write'), (req, res) => {
  const gift = db.prepare('SELECT * FROM gifts WHERE id = ?').get(req.params.id);
  if (!gift) return res.status(404).json({ error: 'Gift not found' });

  const fields = {
    name: req.body.name,
    description: req.body.description,
    value: req.body.value,
    stock: req.body.stock,
    min_surveys_completed: req.body.min_surveys_completed,
    min_streak: req.body.min_streak,
    active: req.body.active === undefined ? undefined : (req.body.active ? 1 : 0)
  };

  const updates = [];
  const params = [];
  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined) { updates.push(`${key} = ?`); params.push(val); }
  }
  if (req.body.target_cohort_ids !== undefined) {
    updates.push('target_cohort_ids = ?');
    params.push(JSON.stringify(req.body.target_cohort_ids));
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  params.push(gift.id);
  db.prepare(`UPDATE gifts SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM gifts WHERE id = ?').get(gift.id);
  res.json({ gift: { ...updated, target_cohort_ids: parseJSON(updated.target_cohort_ids, []) } });
});

// POST /api/admin/gifts/:id/deliver — mark a claim as fulfilled
router.post('/gifts/:id/deliver', requirePermission('gifts.write'), async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const claim = db.prepare('SELECT * FROM user_gifts WHERE gift_id = ? AND user_id = ?')
    .get(req.params.id, user_id);
  if (!claim) return res.status(404).json({ error: 'No claim found for this member' });
  if (claim.delivered_at) return res.status(409).json({ error: 'Already delivered' });

  db.prepare("UPDATE user_gifts SET delivered_at = datetime('now') WHERE id = ?").run(claim.id);

  const gift = db.prepare('SELECT * FROM gifts WHERE id = ?').get(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);

  engagement.log(user_id, 'gift_delivered', { referenceId: gift.id, metadata: { gift_name: gift.name }, source: 'manual' });

  await notifications.notify(user, {
    category: 'gift_notifications',
    title: `${gift.name} is on its way`,
    body: 'Your reward has been sent.',
    sourceType: 'system',
    sourceId: gift.id,
    channels: ['in_portal', 'email']
  });

  res.json({ message: 'Marked as delivered' });
});

// ─── Roles, Permissions & Admin Users ───────────────────────

// GET /api/admin/permissions — the catalogue the roles UI builds from
router.get('/permissions', requirePermission('roles.read'), (req, res) => {
  const grouped = {};
  for (const p of PERMISSIONS) {
    (grouped[p.group] = grouped[p.group] || []).push(p);
  }
  res.json({ permissions: PERMISSIONS, grouped });
});

// GET /api/admin/roles
router.get('/roles', requirePermission('roles.read'), (req, res) => {
  const roles = db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM admin_users a WHERE a.role_id = r.id) as admin_count
    FROM roles r ORDER BY r.is_system DESC, r.created_at DESC
  `).all();
  res.json({ roles: roles.map(r => ({ ...r, permissions: parseJSON(r.permissions, []) })) });
});

function validatePermissions(permissions) {
  if (!Array.isArray(permissions)) return 'permissions must be an array';
  const known = new Set(PERMISSIONS.map(p => p.key));
  const unknown = permissions.filter(p => p !== '*' && !known.has(p));
  if (unknown.length) return `Unknown permission(s): ${unknown.join(', ')}`;
  return null;
}

// POST /api/admin/roles
router.post('/roles', requirePermission('roles.write'), (req, res) => {
  const { name, description, permissions } = req.body;
  if (!name || !permissions) return res.status(400).json({ error: 'name and permissions required' });

  const invalid = validatePermissions(permissions);
  if (invalid) return res.status(400).json({ error: invalid });

  if (db.prepare('SELECT id FROM roles WHERE name = ?').get(name)) {
    return res.status(409).json({ error: 'A role with that name already exists' });
  }

  const id = uuid();
  db.prepare('INSERT INTO roles (id, name, description, permissions) VALUES (?, ?, ?, ?)')
    .run(id, name, description || null, JSON.stringify(permissions));

  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  res.status(201).json({ role: { ...role, permissions: parseJSON(role.permissions, []) } });
});

// PUT /api/admin/roles/:id
router.put('/roles/:id', requirePermission('roles.write'), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system) return res.status(400).json({ error: 'System roles cannot be edited' });

  const { name, description, permissions } = req.body;
  const updates = [];
  const params = [];

  if (name) { updates.push('name = ?'); params.push(name); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (permissions) {
    const invalid = validatePermissions(permissions);
    if (invalid) return res.status(400).json({ error: invalid });
    updates.push('permissions = ?'); params.push(JSON.stringify(permissions));
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  params.push(role.id);
  db.prepare(`UPDATE roles SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM roles WHERE id = ?').get(role.id);
  res.json({ role: { ...updated, permissions: parseJSON(updated.permissions, []) } });
});

// DELETE /api/admin/roles/:id
router.delete('/roles/:id', requirePermission('roles.write'), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system) return res.status(400).json({ error: 'System roles cannot be deleted' });

  const inUse = db.prepare('SELECT COUNT(*) as c FROM admin_users WHERE role_id = ?').get(role.id).c;
  if (inUse > 0) {
    return res.status(409).json({ error: `${inUse} admin user(s) still have this role. Reassign them first.` });
  }

  db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  res.json({ message: 'Role deleted' });
});

// GET /api/admin/admins
router.get('/admins', requirePermission('roles.read'), (req, res) => {
  const admins = db.prepare(`
    SELECT a.id, a.email, a.name, a.status, a.created_at, a.role_id, r.name as role_name
    FROM admin_users a LEFT JOIN roles r ON r.id = a.role_id
    ORDER BY a.created_at DESC
  `).all();
  res.json({ admins });
});

// POST /api/admin/admins — create an internal user and assign a role
router.post('/admins', requirePermission('roles.write'), (req, res) => {
  const { email, name, password, role_id } = req.body;
  if (!email || !name || !password || !role_id) {
    return res.status(400).json({ error: 'email, name, password, and role_id are required' });
  }
  if (String(password).length < 10) {
    return res.status(400).json({ error: 'Admin passwords must be at least 10 characters' });
  }
  if (!db.prepare('SELECT id FROM roles WHERE id = ?').get(role_id)) {
    return res.status(400).json({ error: 'Unknown role_id' });
  }
  if (db.prepare('SELECT id FROM admin_users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An admin with that email already exists' });
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO admin_users (id, email, name, password_hash, role_id) VALUES (?, ?, ?, ?, ?)
  `).run(id, email, name, bcrypt.hashSync(password, 10), role_id);

  const admin = db.prepare('SELECT id, email, name, status, role_id, created_at FROM admin_users WHERE id = ?').get(id);
  res.status(201).json({ admin });
});

// PUT /api/admin/admins/:id — change role or status
router.put('/admins/:id', requirePermission('roles.write'), (req, res) => {
  const target = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Admin not found' });

  const { role_id, status } = req.body;

  // Guard against an admin removing their own access and locking the team out
  if (target.id === req.admin.id && status && status !== 'active') {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }

  const updates = [];
  const params = [];

  if (role_id) {
    if (!db.prepare('SELECT id FROM roles WHERE id = ?').get(role_id)) {
      return res.status(400).json({ error: 'Unknown role_id' });
    }
    updates.push('role_id = ?'); params.push(role_id);
  }
  if (status) {
    if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    updates.push('status = ?'); params.push(status);
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  params.push(target.id);
  db.prepare(`UPDATE admin_users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // A role or status change must take effect immediately, not at token expiry
  destroyAllSessionsFor(target.id);

  const updated = db.prepare('SELECT id, email, name, status, role_id FROM admin_users WHERE id = ?').get(target.id);
  res.json({ admin: updated, message: 'Updated. The admin will need to sign in again.' });
});

// ─── Feedback (Admin view) ──────────────────────────────────

// GET /api/admin/feedback
router.get('/feedback', requirePermission('feedback.read'), (req, res) => {
  const { status, source, type, limit = 50 } = req.query;
  const where = ['1=1'];
  const params = [];

  if (status) { where.push('f.status = ?'); params.push(status); }
  if (source) { where.push('f.source = ?'); params.push(source); }
  if (type) { where.push('f.type = ?'); params.push(type); }

  const feedback = db.prepare(`
    SELECT f.*, u.name as user_name, u.email as user_email, u.company as user_company
    FROM feedback f
    JOIN users u ON u.id = f.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(...params, Math.min(200, parseInt(limit, 10) || 50));

  res.json({ feedback });
});

// PUT /api/admin/feedback/:id
// PUT /api/admin/feedback/:id
// This marks how far the engagement team has got through *reading* feedback.
// It is triage state, not ticket resolution — Dev Circle collects information,
// it does not resolve issues.
router.put('/feedback/:id', requirePermission('feedback.write'), (req, res) => {
  const { status, note } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  if (!['open', 'reviewed', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const fb = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  if (!fb) return res.status(404).json({ error: 'Feedback not found' });

  // A Feex complaint's state belongs to Feex. Dev Circle mirrors it through
  // the webhook and must not let an admin edit it here, or the two systems
  // would disagree about a ticket Feex owns.
  if (fb.source === 'feex') {
    return res.status(409).json({
      error: 'This complaint is owned by Feex. Update it there — Dev Circle mirrors its status for engagement tracking only.',
      ticket_id: fb.external_ticket_id,
      feex_status: fb.feex_status,
      feex_url: fb.feex_url
    });
  }

  db.prepare(`
    UPDATE feedback
    SET status = ?, resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') ELSE NULL END
    WHERE id = ?
  `).run(status, status, fb.id);

  if (note) {
    engagement.log(fb.user_id, 'feedback_submitted', {
      referenceId: fb.id,
      metadata: { triage_note: note, status },
      source: 'manual'
    });
  }

  res.json({ feedback: db.prepare('SELECT * FROM feedback WHERE id = ?').get(fb.id) });
});

// ─── Integrations ───────────────────────────────────────────

// GET /api/admin/integration-events
router.get('/integration-events', requirePermission('integrations.read'), (req, res) => {
  const { source, processed, limit = 50 } = req.query;
  const where = ['1=1'];
  const params = [];

  if (source) { where.push('source = ?'); params.push(source); }
  if (processed !== undefined && processed !== '') {
    where.push('processed = ?'); params.push(parseInt(processed, 10));
  }

  const events = db.prepare(`
    SELECT * FROM integration_events
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params, Math.min(200, parseInt(limit, 10) || 50));

  res.json({ events });
});

// GET /api/admin/api-keys
router.get('/api-keys', requirePermission('integrations.write'), (req, res) => {
  const keys = db.prepare(`
    SELECT id, name, prefix, permissions, last_used_at, expires_at, revoked_at, created_at
    FROM api_keys ORDER BY created_at DESC
  `).all();
  res.json({ keys: keys.map(k => ({ ...k, permissions: parseJSON(k.permissions, []) })) });
});

// POST /api/admin/api-keys — issue a key for an integration
router.post('/api-keys', requirePermission('integrations.write'), (req, res) => {
  const { name, scopes, expires_at } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const VALID_SCOPES = ['landing_page', 'customer_io', 'feex', 'events', '*'];
  const granted = Array.isArray(scopes) && scopes.length ? scopes : ['events'];
  const invalid = granted.filter(s => !VALID_SCOPES.includes(s));
  if (invalid.length) {
    return res.status(400).json({ error: `Unknown scope(s): ${invalid.join(', ')}`, valid: VALID_SCOPES });
  }

  const { key, prefix } = generateApiKey();

  db.prepare(`
    INSERT INTO api_keys (id, key_hash, name, prefix, permissions, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuid(), hashApiKey(key), name, prefix, JSON.stringify(granted), expires_at || null, req.admin.id);

  // The plaintext key is shown exactly once — only its hash is stored
  res.status(201).json({
    key,
    prefix,
    scopes: granted,
    warning: 'Copy this key now. It cannot be retrieved again.'
  });
});

// DELETE /api/admin/api-keys/:id
router.delete('/api-keys/:id', requirePermission('integrations.write'), (req, res) => {
  const result = db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
    .run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Key not found or already revoked' });
  res.json({ message: 'Key revoked' });
});

module.exports = router;
