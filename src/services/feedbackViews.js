const db = require('../db');

// ─── Ways of looking at feedback ────────────────────────────
// The same body of verbatims, cut along whichever axis answers the question
// being asked. "What did this developer say", "what did people answer when we
// asked this", "what came out of that round" and "what is support hearing" are
// four different questions over one set of rows.
//
// Every axis is declared once, here, so the screen, the counts and the export
// cannot disagree about what a grouping means.

// Left joined onto users, because an answer given over a survey's public link
// has no member behind it. An inner join would drop every one of them from
// each of these four views at once, without anything on screen saying so.
const FROM = `
  FROM feedback f
  LEFT JOIN users u ON u.id = f.user_id
  LEFT JOIN surveys s ON s.id = f.survey_id
  LEFT JOIN questions q ON q.id = f.canonical_question_id
`;

const GROUPINGS = {
  question: {
    label: 'Question',
    describe: 'What people answered when we asked the same thing',
    key: 'f.canonical_question_id',
    name: 'COALESCE(q.text, f.prompt)',
    // Answers to a question only exist where a question was asked
    having: 'f.canonical_question_id IS NOT NULL',
    filter: 'question_id'
  },
  developer: {
    label: 'Developer',
    describe: 'Everything one person has told us',
    key: 'f.user_id',
    name: 'u.name',
    context: 'u.company',
    filter: 'user_id'
  },
  survey: {
    label: 'Survey',
    describe: 'What came out of one round of asking',
    // A round run elsewhere has no surveys row, so it is identified by the
    // system it was collected in instead
    key: 'COALESCE(f.survey_id, f.source_system)',
    name: "COALESCE(s.title, REPLACE(COALESCE(f.source_system, f.source), '_', ' '))",
    filter: 'survey_id'
  },
  source: {
    label: 'Source',
    describe: 'Where it reached us',
    key: 'f.source',
    name: "REPLACE(f.source, '_', ' ')",
    filter: 'source'
  },
  system: {
    label: 'Collected in',
    describe: 'Which tool it was gathered with',
    key: 'COALESCE(f.source_system, f.source)',
    name: "REPLACE(COALESCE(f.source_system, f.source), '_', ' ')",
    filter: 'source_system'
  },
  company: {
    label: 'Company',
    describe: 'What one partner is telling us across their people',
    key: 'u.company',
    name: 'u.company',
    filter: 'company'
  },
  work_sector: {
    label: 'Sector',
    describe: 'Whether banks and fintechs report different things',
    key: 'u.work_sector',
    name: 'u.work_sector',
    filter: 'work_sector'
  },
  api_status: {
    label: 'Stage',
    describe: 'Whether sandbox and production hit different problems',
    key: 'u.api_status',
    name: 'u.api_status',
    filter: 'api_status'
  },
  location_state: {
    label: 'State',
    describe: 'Where the people saying it are based',
    key: 'u.location_state',
    name: 'u.location_state',
    filter: 'location_state'
  },
  month: {
    label: 'Month',
    describe: 'How what we hear changes over time',
    key: 'substr(f.created_at, 1, 7)',
    name: 'substr(f.created_at, 1, 7)',
    filter: 'month'
  },
  status: {
    label: 'Triage',
    describe: 'How far the team has read',
    key: 'f.status',
    name: 'f.status',
    filter: 'status'
  }
};

// Cohort is a facet rather than a column: a developer belongs to several at
// once, so one answer legitimately appears under more than one group.
const MEMBERSHIP_GROUPINGS = {
  cohort: {
    label: 'Cohort',
    describe: 'What a segment is telling us',
    table: 'user_cohorts', column: 'cohort_id', names: 'cohorts',
    filter: 'cohort_id'
  }
};

function axes() {
  return [
    ...Object.entries(GROUPINGS).map(([key, g]) => ({
      key, label: g.label, describe: g.describe, filter: g.filter, facet: false
    })),
    ...Object.entries(MEMBERSHIP_GROUPINGS).map(([key, g]) => ({
      key, label: g.label, describe: g.describe, filter: g.filter, facet: true
    }))
  ];
}

// Filters narrow the rows; the grouping decides how what remains is cut up.
function conditions(query = {}) {
  const where = ['1=1'];
  const params = [];

  // Scoped to one workspace. A developer in two circles has what they said in
  // one stay there — the same person, two separate bodies of evidence.
  if (query.circle_id) { where.push('f.circle_id = ?'); params.push(query.circle_id); }

  const direct = {
    status: 'f.status', source: 'f.source', source_system: 'f.source_system',
    question_id: 'f.canonical_question_id', user_id: 'f.user_id',
    company: 'u.company', work_sector: 'u.work_sector',
    api_status: 'u.api_status', location_state: 'u.location_state'
  };

  for (const [param, column] of Object.entries(direct)) {
    if (query[param]) { where.push(`${column} = ?`); params.push(query[param]); }
  }

  if (query.survey_id) {
    where.push('COALESCE(f.survey_id, f.source_system) = ?');
    params.push(query.survey_id);
  }
  if (query.month) { where.push('substr(f.created_at, 1, 7) = ?'); params.push(query.month); }
  if (query.since) { where.push('f.created_at >= ?'); params.push(query.since); }
  if (query.prompted === 'false') where.push('f.canonical_question_id IS NULL');
  if (query.prompted === 'true') where.push('f.canonical_question_id IS NOT NULL');

  if (query.search) {
    where.push('(f.content LIKE ? OR f.prompt LIKE ? OR q.text LIKE ?)');
    const like = `%${query.search}%`;
    params.push(like, like, like);
  }
  if (query.cohort_id) {
    where.push('f.user_id IN (SELECT user_id FROM user_cohorts WHERE cohort_id = ?)');
    params.push(query.cohort_id);
  }
  return { where: where.join(' AND '), params };
}

// The groups themselves. Developers rather than answers is the headline number
// throughout: five people saying a thing once is not one person saying it five
// times, and a single total renders them identically.
function group(axis, query = {}) {
  const { where, params } = conditions(query);

  if (MEMBERSHIP_GROUPINGS[axis]) {
    const g = MEMBERSHIP_GROUPINGS[axis];
    return db.prepare(`
      SELECT m.${g.column} as key, n.name as label, NULL as context,
             COUNT(f.id) as answer_count,
             COUNT(DISTINCT COALESCE(f.user_id, 'anon:' || COALESCE(f.response_id, f.id))) as developer_count,
             MAX(f.created_at) as last_at
      ${FROM}
      JOIN ${g.table} m ON m.user_id = f.user_id
      JOIN ${g.names} n ON n.id = m.${g.column}
      WHERE ${where}
      GROUP BY m.${g.column}
      ORDER BY developer_count DESC, last_at DESC
    `).all(...params);
  }

  const g = GROUPINGS[axis];
  if (!g) return null;

  return db.prepare(`
    SELECT ${g.key} as key, ${g.name} as label, ${g.context || 'NULL'} as context,
           COUNT(f.id) as answer_count,
           COUNT(DISTINCT COALESCE(f.user_id, 'anon:' || COALESCE(f.response_id, f.id))) as developer_count,
           MAX(f.created_at) as last_at
    ${FROM}
    WHERE ${where} ${g.having ? `AND ${g.having}` : ''} AND ${g.key} IS NOT NULL
    GROUP BY ${g.key}
    ORDER BY developer_count DESC, last_at DESC
  `).all(...params);
}

// The verbatims themselves, in whatever the filters leave
function items(query = {}, { limit = 500 } = {}) {
  const { where, params } = conditions(query);

  return db.prepare(`
    SELECT f.id, f.content, f.created_at, f.source, f.source_system, f.status,
           f.category, f.external_ticket_id, f.canonical_question_id,
           COALESCE(q.text, f.prompt) as question,
           COALESCE(s.title, REPLACE(COALESCE(f.source_system, f.source), '_', ' ')) as came_from,
           u.id as user_id, u.name as developer, u.email, u.company,
           u.work_sector, u.api_status
    ${FROM}
    WHERE ${where}
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(...params, limit);
}

function summarise(query = {}) {
  const { where, params } = conditions(query);
  return db.prepare(`
    SELECT COUNT(f.id) as answers,
           COUNT(DISTINCT COALESCE(f.user_id, 'anon:' || COALESCE(f.response_id, f.id))) as developers,
           COUNT(DISTINCT f.canonical_question_id) as questions
    ${FROM} WHERE ${where}
  `).get(...params);
}

module.exports = {
  axes, group, items, summarise, conditions, GROUPINGS, MEMBERSHIP_GROUPINGS
};
