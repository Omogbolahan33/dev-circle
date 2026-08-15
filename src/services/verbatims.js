const db = require('../db');
const { uuid, parseJSON } = require('../utils/helpers');

// ─── Survey verbatims ───────────────────────────────────────
// A sentence a developer writes in a survey is feedback. It used to live only
// inside survey_responses.answers, keyed by question id, which meant the
// largest source of what developers tell us was also the only one nobody could
// search. Filing it alongside the rest — same table, stamped with its source
// and a pointer back to the question — is what makes "everything this
// developer has told us" a single query.
//
// Nothing is interpreted here. The text is stored as written.

// Only free text is a verbatim. A rating or a picked option is a measurement:
// it belongs in the survey's own results, and filing it here would bury the
// sentences under the numbers.
const VERBATIM_TYPES = new Set(['text']);

const insert = db.prepare(`
  INSERT OR IGNORE INTO feedback (
    id, user_id, type, content, category, status, source,
    survey_id, question_id, prompt, created_at
  ) VALUES (?, ?, 'survey_response', ?, ?, 'open', 'survey', ?, ?, ?, COALESCE(?, datetime('now')))
`);

// Pull the free-text answers out of one completed response.
// Returns [{ question_id, prompt, content }].
function extract(survey, answers) {
  const questions = typeof survey.questions === 'string'
    ? parseJSON(survey.questions, [])
    : survey.questions;

  if (!Array.isArray(questions)) return [];

  const found = [];

  for (const question of questions) {
    if (!VERBATIM_TYPES.has(question.type)) continue;

    const answer = answers ? answers[question.id] : undefined;
    if (typeof answer !== 'string' || !answer.trim()) continue;

    found.push({
      question_id: question.id,
      prompt: question.text || null,
      content: answer.trim()
    });
  }

  return found;
}

// File a response's verbatims. Idempotent: the unique index on
// (user_id, survey_id, question_id) means a replayed submission updates
// nothing and duplicates nothing.
function record(userId, survey, answers, { at = null } = {}) {
  const verbatims = extract(survey, answers);
  if (!verbatims.length) return { filed: 0, verbatims: [] };

  const write = db.transaction(rows => {
    let filed = 0;
    for (const row of rows) {
      // The survey title is the closest thing to a category the member gave
      // us, and it is what makes a list of verbatims readable at a glance.
      const result = insert.run(
        uuid(), userId, row.content, survey.title || null,
        survey.id, row.question_id, row.prompt, at
      );
      filed += result.changes;
    }
    return filed;
  });

  return { filed: write(verbatims), verbatims };
}

// Everything a member has told us, from every source, newest first. This is
// the query the whole change exists to make possible.
function forUser(userId, { limit = 100 } = {}) {
  return db.prepare(`
    SELECT f.*, s.title as survey_title
    FROM feedback f
    LEFT JOIN surveys s ON s.id = f.survey_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

module.exports = { record, extract, forUser, VERBATIM_TYPES };
