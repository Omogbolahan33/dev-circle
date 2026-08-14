const db = require('../db');
const { parseJSON } = require('../utils/helpers');

// ─── Audience resolution ────────────────────────────────────
// Who a piece of work reaches. Surveys, blasts and member listings all need
// the same targeting rules, so they live here rather than being reimplemented
// per route — a divergence between them would mean a survey and its reminder
// reaching different people.

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

// Filters shared by the member list and the export, so what an admin sees on
// screen is exactly what they get in the file.
function memberFilters(query) {
  const where = ['1=1'];
  const params = [];

  const {
    search, status, api_status, cohort_id, work_sector, location_state,
    gender, api_product, kyb_completed, min_streak, circle_id
  } = query;

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
  if (min_streak) {
    where.push('COALESCE(u.engagement_streak, 0) >= ?');
    params.push(parseInt(min_streak, 10) || 0);
  }
  if (api_product) {
    where.push('EXISTS (SELECT 1 FROM json_each(u.api_products) WHERE json_each.value = ?)');
    params.push(api_product);
  }
  if (cohort_id) {
    where.push('u.id IN (SELECT user_id FROM user_cohorts WHERE cohort_id = ?)');
    params.push(cohort_id);
  }
  if (circle_id) {
    where.push('u.id IN (SELECT user_id FROM circle_members WHERE circle_id = ?)');
    params.push(circle_id);
  }

  return { where: where.join(' AND '), params };
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

// Resolve a blast's recipients to member rows
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

module.exports = { circleScope, memberFilters, resolveAudience, blastRecipients };
