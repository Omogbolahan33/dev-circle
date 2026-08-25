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

// Values a member can actually hold. Anything with a known set declares it
// here, so a criterion is chosen from a list rather than typed from memory —
// "suspended" spelled wrong silently matches nobody, which looks identical to
// a segment that is genuinely empty.
const CHANNELS = ['email', 'whatsapp', 'sms', 'calls', 'in_portal'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Values already present in the member base. Filtering by a value nobody holds
// returns nothing, so the list is drawn from the data rather than guessed.
const distinct = column => async database => ((await database.prepare(
  `SELECT DISTINCT ${column} AS value FROM users
   WHERE COALESCE(${column}, '') != '' ORDER BY value`
).all()) || []).map(r => r.value);

// Same, for the JSON array columns
const distinctInArray = column => async database => ((await database.prepare(
  `SELECT DISTINCT json_each.value AS value FROM users, json_each(users.${column})
   WHERE COALESCE(json_each.value, '') != '' ORDER BY value`
).all()) || []).map(r => r.value);

// Free text a member typed. A dropdown of everything anyone has ever written
// would be unusable, so these stay open and lean on "contains".
const OPEN_TEXT = new Set(['company']);

// Each field maps to a SQL expression over `u`, the value type it expects, and
// where the values to choose from come from.
const FIELDS = {
  api_status: {
    sql: 'u.api_status', type: 'text', label: 'API status',
    values: ['sandbox', 'production']
  },
  status: {
    sql: 'u.status', type: 'text', label: 'Account status',
    values: ['active', 'inactive', 'suspended']
  },
  work_sector: {
    sql: 'u.work_sector', type: 'text', label: 'Work sector',
    values: distinct('work_sector')
  },
  company: {
    sql: 'u.company', type: 'text', label: 'Company'
    // deliberately open: one per member, so a list would be as long as the base
  },
  location_state: {
    sql: 'u.location_state', type: 'text', label: 'State',
    values: distinct('location_state')
  },
  gender: {
    sql: 'u.gender', type: 'text', label: 'Gender',
    values: distinct('gender')
  },
  kyb_completed: { sql: 'u.kyb_completed', type: 'bool', label: 'KYB completed' },
  engagement_streak: { sql: 'u.engagement_streak', type: 'number', label: 'Engagement streak' },

  // JSON array columns — matched with json_each rather than LIKE so
  // "Mon" cannot accidentally match "Monday" or a value inside another field.
  preferred_days: {
    json: 'u.preferred_days', type: 'array', label: 'Available day',
    values: WEEKDAYS
  },
  preferred_channels: {
    json: 'u.preferred_channels', type: 'array', label: 'Preferred channel',
    values: CHANNELS
  },
  api_products: {
    json: 'u.api_products', type: 'array', label: 'API product',
    values: distinctInArray('api_products')
  },

  // Derived values
  age: {
    sql: "CAST((julianday('now') - julianday(u.date_of_birth)) / 365.25 AS INTEGER)",
    type: 'number', label: 'Age', unit: 'years'
  },
  surveys_completed: {
    sql: 'COALESCE(_sr.n, 0)',
    join: 'LEFT JOIN (SELECT user_id, COUNT(*) as n FROM survey_responses WHERE completed_at IS NOT NULL GROUP BY user_id) _sr ON _sr.user_id = u.id',
    type: 'number', label: 'Surveys completed'
  },
  feedback_submitted: {
    sql: 'COALESCE(_fb.n, 0)',
    join: 'LEFT JOIN (SELECT user_id, COUNT(*) as n FROM feedback GROUP BY user_id) _fb ON _fb.user_id = u.id',
    type: 'number', label: 'Feedback submitted'
  },
  gifts_claimed: {
    sql: 'COALESCE(_ug.n, 0)',
    join: 'LEFT JOIN (SELECT user_id, COUNT(*) as n FROM user_gifts GROUP BY user_id) _ug ON _ug.user_id = u.id',
    type: 'number', label: 'Gifts claimed'
  },
  days_since_active: {
    sql: "CAST(julianday('now') - julianday(COALESCE(u.last_active_at, u.created_at)) AS INTEGER)",
    type: 'number', label: 'Days since last active', unit: 'days'
  },
  days_since_joined: {
    sql: "CAST(julianday('now') - julianday(u.created_at) AS INTEGER)",
    type: 'number', label: 'Days since joined', unit: 'days'
  },
  cohort_id: {
    type: 'membership', label: 'Member of cohort',
    exists: 'SELECT 1 FROM user_cohorts WHERE cohort_id = ? AND user_id = u.id',
    values: async db => await db.prepare('SELECT id AS value, name AS label FROM cohorts ORDER BY name').all()
  },
  circle_id: {
    type: 'membership', label: 'Member of circle',
    exists: 'SELECT 1 FROM circle_members WHERE circle_id = ? AND user_id = u.id',
    values: async db => await db.prepare(
      "SELECT id AS value, name AS label FROM circles WHERE status = 'active' ORDER BY created_at"
    ).all()
  },
  // Who may be contacted on a given channel — the separator that decides
  // whether a segment is reachable at all
  consent_channel: {
    type: 'membership', label: 'Consented to channel',
    exists: "SELECT 1 FROM consent WHERE channel = ? AND status = 'granted' AND user_id = u.id",
    values: CHANNELS
  },
  has_phone: {
    sql: "CASE WHEN COALESCE(u.phone, '') = '' THEN 0 ELSE 1 END",
    type: 'bool', label: 'Has a phone number'
  },
  has_responded: {
    sql: `EXISTS (SELECT 1 FROM survey_responses sr
           WHERE sr.user_id = u.id AND sr.completed_at IS NOT NULL)`,
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
  // EXISTS stops at the first matching row; IN (SELECT …) materialises the
  // whole membership list per candidate.
  if (field.type === 'membership') {
    const negate = op === 'neq';
    return {
      sql: `${negate ? 'NOT ' : ''}EXISTS (${field.exists})`,
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
  const joins = [];
  const seenJoins = new Set();

  for (const rule of rules) {
    if (rule.value === undefined || rule.value === null || rule.value === '') continue;
    const field = FIELDS[rule.field];
    if (field?.join && !seenJoins.has(field.join)) {
      seenJoins.add(field.join);
      joins.push(field.join);
    }
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
    conditions.push('EXISTS (SELECT 1 FROM circle_members cmr WHERE cmr.user_id = u.id AND cmr.circle_id = ?)');
    params.push(circleId);
  }

  if (ruleClauses.length) {
    conditions.push('(' + ruleClauses.join(match === 'any' ? ' OR ' : ' AND ') + ')');
    params.push(...ruleParams);
  }

  return {
    where: conditions.length ? conditions.join(' AND ') : '1=1',
    from: `users u${joins.length ? ' ' + joins.join(' ') : ''}`,
    params,
    ruleCount: ruleClauses.length
  };
}

// Resolve a rule definition to matching member rows
async function evaluate(definition, { limit = null, activeOnly = true, circleId = null } = {}) {
  const { where, from, params, ruleCount } = buildQuery(definition, { activeOnly, circleId });

  const [totalRow, members] = await Promise.all([
    db.prepare(`SELECT COUNT(*) as c FROM ${from} WHERE ${where}`).get(...params),
    db.prepare(`
      SELECT u.id, u.name, u.email, u.company, u.work_sector, u.api_status, u.engagement_streak
      FROM ${from} WHERE ${where}
      ORDER BY u.created_at DESC
      ${limit ? 'LIMIT ?' : ''}
    `).all(...params, ...(limit ? [limit] : []))
  ]);
  const total = Number(totalRow?.c || 0);

  return { total, members, rule_count: ruleCount };
}

// Reconcile a cohort's membership with its rules. Returns what changed so the
// caller can report it rather than guessing.
async function sync(cohortId) {
  const cohort = await db.prepare('SELECT * FROM cohorts WHERE id = ?').get(cohortId);
  if (!cohort) throw new RuleError('Cohort not found');
  if (!cohort.filter_rules) return { added: 0, removed: 0, total: 0, rule_based: false };

  // A cohort slices the members of the circle it belongs to, never beyond it
  const { where, from, params } = buildQuery(cohort.filter_rules, { circleId: cohort.circle_id });
  const matching = ((await db.prepare(`SELECT u.id FROM ${from} WHERE ${where}`).all(...params) || []) || []).map(r => r.id);
  const matchingSet = new Set(matching);

  const current = ((await db.prepare('SELECT user_id FROM user_cohorts WHERE cohort_id = ?')
    .all(cohortId)) || []).map(r => r.user_id);
  const currentSet = new Set(current);

  const toAdd = matching.filter(id => !currentSet.has(id));
  const toRemove = current.filter(id => !matchingSet.has(id));

  const addStmt = db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)');
  const removeStmt = db.prepare('DELETE FROM user_cohorts WHERE user_id = ? AND cohort_id = ?');

  for (const id of toAdd) await addStmt.run(id, cohortId);
  // Only prune members the rules no longer match when the cohort is set to
  // auto-sync; otherwise manual additions would be silently undone.
  if (cohort.auto_sync) {
    for (const id of toRemove) await removeStmt.run(id, cohortId);
  }
  await db.prepare("UPDATE cohorts SET last_synced_at = datetime('now') WHERE id = ?").run(cohortId);

  return {
    added: toAdd.length,
    removed: cohort.auto_sync ? toRemove.length : 0,
    total: matching.length,
    rule_based: true
  };
}

// Re-run every auto-sync cohort. Called after events that change the inputs
// (KYB completion, production go-live, survey completion).
async function syncAll() {
  const cohorts = await db.prepare('SELECT id FROM cohorts WHERE auto_sync = 1 AND filter_rules IS NOT NULL').all();
  const results = [];
  for (const c of cohorts) {
    try {
      results.push({ cohort_id: c.id, ...(await sync(c.id)) });
    } catch (err) {
      results.push({ cohort_id: c.id, error: err.message });
    }
  }
  return results;
}

// ─── Catalogue ──────────────────────────────────────────────
// Everything a criteria builder needs to render itself: the fields, the
// operators each accepts, and — the part that matters — the values to choose
// between. Both the cohort builder and the export builder read this, so a
// value list cannot be right on one screen and wrong on the other, and adding
// a field makes it appear on both.

function operatorsFor(field) {
  if (field.type === 'number') return ['gte', 'lte', 'eq', 'gt', 'lt'];
  // Open text is the only place "contains" earns its keep; on a field with a
  // fixed set it just invites a typo that matches nothing.
  if (field.type === 'text') {
    return field.values ? ['eq', 'neq'] : ['eq', 'neq', 'contains'];
  }
  return ['eq', 'neq'];
}

// Normalise every value source to { value, label } so the UI has one shape to
// render, whether it came from a constant, a distinct query, or a join table.
async function resolveValues(field) {
  if (field.type === 'bool') {
    return [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
  }
  if (!field.values) return null;

  const raw = typeof field.values === 'function' ? await field.values(db) : field.values;
  return (raw || [])
    .filter(v => v !== null && v !== undefined && v !== '')
    .map(v => (typeof v === 'object'
      ? { value: String(v.value), label: String(v.label ?? v.value) }
      : { value: String(v), label: String(v) }));
}

async function catalogue() {
  const keys = Object.entries(FIELDS);
  const resolved = await Promise.all(keys.map(([, field]) => resolveValues(field)));
  return keys.map(([key, field], i) => {
    const values = resolved[i];
    return {
      field: key,
      label: field.label,
      type: field.type,
      unit: field.unit || null,
      operators: operatorsFor(field),
      // Present means "offer exactly these"; null means free entry
      values,
      // A field with a known set that happens to be empty is still a choice
      // field — the base simply has no values yet, and typing one would match
      // nobody. The UI says so rather than showing an empty dropdown.
      empty: Boolean(field.values) && values !== null && values.length === 0,
      open: OPEN_TEXT.has(key)
    };
  });
}

module.exports = { evaluate, sync, syncAll, buildQuery, catalogue, normalizeDefinition, FIELDS, RuleError };
