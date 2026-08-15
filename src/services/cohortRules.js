const db = require('../db');
const { parseJSON } = require('../utils/helpers');

// ─── Cohort rule engine ─────────────────────────────────────
// Turns a stored filter_rules definition into SQL and resolves it to a member
// list. Rules used to be evaluated in the browser for preview only and then
// dropped on save, so rule-based cohorts were created empty.
//
// A definition is either a bare array of rules (implicit AND) or
// { match: 'all' | 'any', rules: [...] }.
//
// A rule is { field, op, value }.

// Each field maps to a SQL expression over `u` plus the value type it expects.
const FIELDS = {
  api_status:        { sql: 'u.api_status', type: 'text', label: 'API status' },
  status:            { sql: 'u.status', type: 'text', label: 'Account status' },
  work_sector:       { sql: 'u.work_sector', type: 'text', label: 'Work sector' },
  company:           { sql: 'u.company', type: 'text', label: 'Company' },
  location_state:    { sql: 'u.location_state', type: 'text', label: 'State' },
  gender:            { sql: 'u.gender', type: 'text', label: 'Gender' },
  kyb_completed:     { sql: 'u.kyb_completed', type: 'bool', label: 'KYB completed' },
  engagement_streak: { sql: 'u.engagement_streak', type: 'number', label: 'Engagement streak' },

  // JSON array columns — matched with json_each rather than LIKE so
  // "Mon" cannot accidentally match "Monday" or a value inside another field.
  preferred_days:     { json: 'u.preferred_days', type: 'array', label: 'Available day' },
  preferred_channels: { json: 'u.preferred_channels', type: 'array', label: 'Preferred channel' },
  api_products:       { json: 'u.api_products', type: 'array', label: 'API product' },

  // Derived values
  age: {
    sql: "CAST((julianday('now') - julianday(u.date_of_birth)) / 365.25 AS INTEGER)",
    type: 'number', label: 'Age'
  },
  surveys_completed: {
    sql: '(SELECT COUNT(*) FROM survey_responses sr WHERE sr.user_id = u.id AND sr.completed_at IS NOT NULL)',
    type: 'number', label: 'Surveys completed'
  },
  feedback_submitted: {
    sql: "(SELECT COUNT(*) FROM feedback f WHERE f.user_id = u.id)",
    type: 'number', label: 'Feedback submitted'
  },
  gifts_claimed: {
    sql: '(SELECT COUNT(*) FROM user_gifts ug WHERE ug.user_id = u.id)',
    type: 'number', label: 'Gifts claimed'
  },
  days_since_active: {
    sql: "CAST(julianday('now') - julianday(COALESCE(u.last_active_at, u.created_at)) AS INTEGER)",
    type: 'number', label: 'Days since last active'
  },
  days_since_joined: {
    sql: "CAST(julianday('now') - julianday(u.created_at) AS INTEGER)",
    type: 'number', label: 'Days since joined'
  },
  cohort_id: {
    type: 'membership', label: 'Member of cohort',
    subquery: 'SELECT user_id FROM user_cohorts WHERE cohort_id = ?'
  },
  circle_id: {
    type: 'membership', label: 'Member of circle',
    subquery: 'SELECT user_id FROM circle_members WHERE circle_id = ?'
  },
  // Who may be contacted on a given channel — the separator that decides
  // whether a segment is reachable at all
  consent_channel: {
    type: 'membership', label: 'Consented to channel',
    subquery: "SELECT user_id FROM consent WHERE channel = ? AND status = 'granted'"
  },
  has_phone: {
    sql: "CASE WHEN COALESCE(u.phone, '') = '' THEN 0 ELSE 1 END",
    type: 'bool', label: 'Has a phone number'
  },
  has_responded: {
    sql: `(SELECT COUNT(*) FROM survey_responses sr
           WHERE sr.user_id = u.id AND sr.completed_at IS NOT NULL) > 0`,
    type: 'bool', label: 'Has ever responded to a survey'
  }
};

const OPERATORS = {
  eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<='
};

class RuleError extends Error {}

function normalizeDefinition(definition) {
  const parsed = typeof definition === 'string' ? parseJSON(definition, null) : definition;
  if (!parsed) return { match: 'all', rules: [] };
  if (Array.isArray(parsed)) return { match: 'all', rules: parsed };
  return {
    match: parsed.match === 'any' ? 'any' : 'all',
    rules: Array.isArray(parsed.rules) ? parsed.rules : []
  };
}

function coerceBool(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  const s = String(value).toLowerCase();
  if (['yes', 'true', '1', 'completed'].includes(s)) return 1;
  if (['no', 'false', '0', 'pending'].includes(s)) return 0;
  throw new RuleError(`Expected a yes/no value, got "${value}"`);
}

function buildClause(rule) {
  const field = FIELDS[rule.field];
  if (!field) throw new RuleError(`Unknown field "${rule.field}"`);

  const op = rule.op || 'eq';

  // Membership fields ask whether the member appears in some join table.
  // "is not" has to become NOT IN rather than a negated equality, or it would
  // only exclude the row that matched instead of the member.
  if (field.type === 'membership') {
    const negate = op === 'neq';
    return {
      sql: `u.id ${negate ? 'NOT IN' : 'IN'} (${field.subquery})`,
      params: [String(rule.value)]
    };
  }

  if (field.type === 'array') {
    if (!['eq', 'neq'].includes(op)) {
      throw new RuleError(`"${field.label}" supports "is" and "is not" only`);
    }
    const exists = `EXISTS (SELECT 1 FROM json_each(${field.json}) WHERE json_each.value = ?)`;
    return { sql: op === 'eq' ? exists : `NOT ${exists}`, params: [String(rule.value)] };
  }

  if (field.type === 'bool') {
    if (!['eq', 'neq'].includes(op)) {
      throw new RuleError(`"${field.label}" supports "is" and "is not" only`);
    }
    const wanted = coerceBool(rule.value);
    return { sql: `COALESCE(${field.sql}, 0) ${op === 'eq' ? '=' : '!='} ?`, params: [wanted] };
  }

  if (field.type === 'number') {
    const sqlOp = OPERATORS[op];
    if (!sqlOp) throw new RuleError(`Unsupported operator "${op}" for ${field.label}`);
    const num = Number(rule.value);
    if (!Number.isFinite(num)) throw new RuleError(`"${field.label}" expects a number, got "${rule.value}"`);
    // COALESCE keeps rows with no value from silently disappearing on <= checks
    return { sql: `COALESCE(${field.sql}, 0) ${sqlOp} ?`, params: [num] };
  }

  // text
  if (op === 'contains') {
    return { sql: `${field.sql} LIKE ?`, params: [`%${rule.value}%`] };
  }
  const sqlOp = OPERATORS[op];
  if (!sqlOp) throw new RuleError(`Unsupported operator "${op}" for ${field.label}`);
  if (op === 'neq') {
    // NULL != 'x' is NULL in SQL, which would drop rows that have no value set
    return { sql: `COALESCE(${field.sql}, '') != ?`, params: [String(rule.value)] };
  }
  return { sql: `${field.sql} ${sqlOp} ?`, params: [String(rule.value)] };
}

function buildQuery(definition, { activeOnly = true, circleId = null } = {}) {
  const { match, rules } = normalizeDefinition(definition);

  const ruleClauses = [];
  const ruleParams = [];

  for (const rule of rules) {
    if (rule.value === undefined || rule.value === null || rule.value === '') continue;
    const built = buildClause(rule);
    ruleClauses.push(built.sql);
    ruleParams.push(...built.params);
  }

  // Conditions and their parameters are assembled together and in order —
  // collecting rule params first and appending the circle param afterwards
  // bound them to the wrong placeholders.
  const conditions = [];
  const params = [];

  if (activeOnly) conditions.push("u.status = 'active'");

  // A cohort belonging to a sub-circle can only ever contain that circle's
  // members, however broad its rules are.
  if (circleId) {
    conditions.push('u.id IN (SELECT user_id FROM circle_members WHERE circle_id = ?)');
    params.push(circleId);
  }

  if (ruleClauses.length) {
    conditions.push('(' + ruleClauses.join(match === 'any' ? ' OR ' : ' AND ') + ')');
    params.push(...ruleParams);
  }

  return {
    where: conditions.length ? conditions.join(' AND ') : '1=1',
    params,
    ruleCount: ruleClauses.length
  };
}

// Resolve a rule definition to matching member rows
function evaluate(definition, { limit = null, activeOnly = true, circleId = null } = {}) {
  const { where, params, ruleCount } = buildQuery(definition, { activeOnly, circleId });

  const total = db.prepare(`SELECT COUNT(*) as c FROM users u WHERE ${where}`).get(...params).c;

  const members = db.prepare(`
    SELECT u.id, u.name, u.email, u.company, u.work_sector, u.api_status, u.engagement_streak
    FROM users u WHERE ${where}
    ORDER BY u.created_at DESC
    ${limit ? 'LIMIT ?' : ''}
  `).all(...params, ...(limit ? [limit] : []));

  return { total, members, rule_count: ruleCount };
}

// Reconcile a cohort's membership with its rules. Returns what changed so the
// caller can report it rather than guessing.
function sync(cohortId) {
  const cohort = db.prepare('SELECT * FROM cohorts WHERE id = ?').get(cohortId);
  if (!cohort) throw new RuleError('Cohort not found');
  if (!cohort.filter_rules) return { added: 0, removed: 0, total: 0, rule_based: false };

  // Root-circle cohorts draw from everyone; a sub-circle's cohorts draw only
  // from that circle.
  const root = db.prepare('SELECT id FROM circles WHERE is_root = 1').get();
  const scopeCircleId = cohort.circle_id && root && cohort.circle_id !== root.id
    ? cohort.circle_id
    : null;

  const { where, params } = buildQuery(cohort.filter_rules, { circleId: scopeCircleId });
  const matching = db.prepare(`SELECT u.id FROM users u WHERE ${where}`).all(...params).map(r => r.id);
  const matchingSet = new Set(matching);

  const current = db.prepare('SELECT user_id FROM user_cohorts WHERE cohort_id = ?')
    .all(cohortId).map(r => r.user_id);
  const currentSet = new Set(current);

  const toAdd = matching.filter(id => !currentSet.has(id));
  const toRemove = current.filter(id => !matchingSet.has(id));

  const addStmt = db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)');
  const removeStmt = db.prepare('DELETE FROM user_cohorts WHERE user_id = ? AND cohort_id = ?');

  db.transaction(() => {
    for (const id of toAdd) addStmt.run(id, cohortId);
    // Only prune members the rules no longer match when the cohort is set to
    // auto-sync; otherwise manual additions would be silently undone.
    if (cohort.auto_sync) {
      for (const id of toRemove) removeStmt.run(id, cohortId);
    }
    db.prepare("UPDATE cohorts SET last_synced_at = datetime('now') WHERE id = ?").run(cohortId);
  })();

  return {
    added: toAdd.length,
    removed: cohort.auto_sync ? toRemove.length : 0,
    total: matching.length,
    rule_based: true
  };
}

// Re-run every auto-sync cohort. Called after events that change the inputs
// (KYB completion, production go-live, survey completion).
function syncAll() {
  const cohorts = db.prepare('SELECT id FROM cohorts WHERE auto_sync = 1 AND filter_rules IS NOT NULL').all();
  const results = [];
  for (const c of cohorts) {
    try {
      results.push({ cohort_id: c.id, ...sync(c.id) });
    } catch (err) {
      results.push({ cohort_id: c.id, error: err.message });
    }
  }
  return results;
}

// Field catalogue for the cohort builder UI
function catalogue() {
  return Object.entries(FIELDS).map(([key, f]) => ({
    field: key,
    label: f.label,
    type: f.type,
    operators: f.type === 'number'
      ? ['gte', 'lte', 'eq', 'gt', 'lt']
      : f.type === 'text'
        ? ['eq', 'neq', 'contains']
        : ['eq', 'neq'],
    // Membership values are ids the UI has to look up, so it needs to know
    // which list to offer
    lookup: f.type === 'membership' ? key.replace(/_id$/, '') : null
  }));
}

module.exports = { evaluate, sync, syncAll, buildQuery, catalogue, normalizeDefinition, FIELDS, RuleError };
