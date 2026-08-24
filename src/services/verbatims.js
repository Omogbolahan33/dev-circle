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
//
// A text question held to a format is not free text either — an email address
// is a field, and filing one as something a developer told us would put
// contact details in the middle of a page of quotes.
const VERBATIM_TYPES = new Set(['text']);

// The types that can carry an "Other" box. What someone writes there is in
// their own words by definition: it is what they said when none of the options
// were what they meant, which makes it the most pointed sentence on the page.
const OTHER_TYPES = new Set(['choice', 'dropdown', 'multi_choice']);

const fold = value => String(value ?? '').trim().toLowerCase();

// What was typed rather than picked. Returns null when the member stayed
// within the options they were offered.
function otherText(question, answer) {
  if (!question.allow_other) return null;
  const offered = new Set((question.options || []).map(fold));
  const written = (Array.isArray(answer) ? answer : [answer])
    .map(v => String(v ?? '').trim())
    .filter(v => v && !offered.has(fold(v)));
  return written.length ? written.join('; ') : null;
}

// Prepared on use rather than at load: the handle may point at a sandbox
const insert = () => db.prepare(`
  INSERT OR IGNORE INTO feedback (
    id, user_id, type, content, category, status, source, source_system,
    survey_id, question_id, canonical_question_id, prompt, circle_id, response_id,
    external_response_id, created_at
  ) VALUES (?, ?, 'survey_response', ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
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
    const answer = answers ? answers[question.id] : undefined;
    if (answer === undefined || answer === null) continue;

    let content = null;

    if (VERBATIM_TYPES.has(question.type) && !question.format) {
      if (typeof answer === 'string' && answer.trim()) content = answer.trim();
    } else if (OTHER_TYPES.has(question.type)) {
      content = otherText(question, answer);
    }

    if (!content) continue;

    found.push({
      // The slot inside this survey, and the question it is an instance of.
      // Grouping reads the second; tracing an answer home reads the first.
      question_id: question.id,
      canonical_question_id: question.question_id || null,
      prompt: question.text || null,
      content
    });
  }

  return found;
}

// File a response's verbatims. Idempotent: the unique index on
// (user_id, survey_id, question_id) means a replayed submission updates
// nothing and duplicates nothing.
//
// `userId` is null for someone answering over a public link, and `responseId`
// takes its place as the thing that makes the row unique. What a person
// without an account wrote is evidence on the same terms as anyone else's —
// the only difference is that there is no one to attribute it to.
//
// `sourceSystem` names the tool a response was collected in when it was not
// this one. It changes nothing about how the words are stored — they are the
// same evidence — only what the row says about where they came from, which is
// the difference between "a developer told us this" and "a developer told us
// this, in the Google Form we ran in March".
async function record(userId, survey, answers, {
  at = null, responseId = null, sourceSystem = null, externalResponseId = null
} = {}) {
  const verbatims = extract(survey, answers);
  if (!verbatims.length) return { filed: 0, verbatims: [] };

  // A verbatim belongs to the circle whose survey drew it out. If the survey
  // carries none, fall back to the member's own — evidence filed against no
  // workspace would be invisible everywhere, which is worse than approximate.
  const circleId = survey.circle_id || (userId ? (await db.prepare(
    'SELECT circle_id FROM circle_members WHERE user_id = ? ORDER BY added_at LIMIT 1'
  ).get(userId))?.circle_id : null) || null;

  let filed = 0;
  for (const row of verbatims) {
      // The survey title is the closest thing to a category the member gave
      // us, and it is what makes a list of verbatims readable at a glance.
      const result = await insert().run(
        uuid(), userId || null, row.content, survey.title || null,
        // 'survey' has always meant "a survey run in Dev Circle". Answers
        // collected elsewhere are the same kind of thing arriving another way,
        // so they share the type and are told apart by the system they came
        // out of.
        sourceSystem ? 'external_survey' : 'survey', sourceSystem || 'dev_circle',
        survey.id, row.question_id, row.canonical_question_id, row.prompt,
        circleId, responseId,
        // Scoped to the answer rather than the submission, because a
        // submission carries many. The same shape the integrations endpoint
        // writes, so a response that arrives over the API and again in a
        // spreadsheet is filed once rather than twice.
        externalResponseId ? `${externalResponseId}:${row.question_id}` : null,
        at
      );
      filed += Number(result?.changes || 0);
  }

  return { filed, verbatims };
}

// Everything a member has told us, from every source, newest first. This is
// the query the whole change exists to make possible.
async function forUser(userId, { limit = 100 } = {}) {
  return await db.prepare(`
    SELECT f.*, s.title as survey_title
    FROM feedback f
    LEFT JOIN surveys s ON s.id = f.survey_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

module.exports = { record, extract, forUser, VERBATIM_TYPES, OTHER_TYPES };
