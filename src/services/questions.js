const db = require('../db');
const { uuid } = require('../utils/helpers');

// ─── Questions ──────────────────────────────────────────────
// A question is a thing in its own right rather than an entry inside one
// survey's JSON, so answers to it can be read together whichever survey
// carried it.
//
// This is not a fixed library to pick from. Every discovery initiative asks
// whatever it needs, new questions are the ordinary case, and a question asked
// exactly once is a normal question. The identity only makes *continuing* a
// question possible — and continuing is always the author's decision. Matching
// text is offered as a suggestion and never acts on its own, because two
// initiatives can ask "Any other feedback?" about entirely different things:
// two piles can be joined later, one wrongly merged pile cannot be separated.
//
// Surveys still own their own arrangement — order, options, scale. What they
// borrow is the identity of the question being asked.

// How many distinct people said a thing. COUNT(DISTINCT user_id) skips NULLs
// entirely, so once answers can arrive over a public link that count silently
// stops including everyone without an account — the evidence is in the table
// and simply absent from every total. Falling back to the response makes each
// anonymous submission count once, which is what a respondent is.
const RESPONDENTS = "COUNT(DISTINCT COALESCE(f.user_id, 'anon:' || COALESCE(f.response_id, f.id)))";

// Case, spacing and trailing punctuation do not make two questions different.
// This is used to *offer* a reuse, never to perform one.
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?.!,;:\s]+$/, '')
    .trim();
}

// Start a question. Writing a new one is the ordinary case: every discovery
// initiative asks what it needs, and a question asked once is a normal
// question. Reuse is something the author chooses, not something that happens
// to them because two initiatives phrased a line the same way.
async function create(text, type = 'text', { createdBy = null } = {}) {
  const normalized = normalize(text);
  if (!normalized) return null;

  const id = uuid();
  await db.prepare('INSERT INTO questions (id, text, normalized, type, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, String(text).trim(), normalized, type, createdBy);

  return await db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
}

// Questions already asked that read like this one, so the author can join the
// evidence up if they meant the same thing. Ordered by how much each has
// already collected, since that is what makes reuse worth doing.
async function suggest(text, type = 'text', { limit = 5 } = {}) {
  const normalized = normalize(text);
  if (normalized.length < 8) return [];

  return await db.prepare(`
    SELECT q.id, q.text,
           COALESCE(f.developer_count, 0) as developer_count,
           COALESCE(f.survey_count, 0) as survey_count
    FROM questions q
    LEFT JOIN (
      SELECT canonical_question_id,
             ${RESPONDENTS} as developer_count,
             COUNT(DISTINCT survey_id) as survey_count
      FROM feedback
      WHERE canonical_question_id IN (
        SELECT id FROM questions WHERE type = ? AND normalized = ?
      )
      GROUP BY canonical_question_id
    ) f ON f.canonical_question_id = q.id
    WHERE q.type = ? AND q.normalized = ?
    ORDER BY developer_count DESC
    LIMIT ?
  `).all(type, normalized, type, normalized, limit);
}

// Give every question in a survey an identity. An explicit question_id means
// the author chose to carry on an existing question; anything else starts a
// new one, so authoring is never constrained by what has been asked before.
//
// `identifies` decides what counts as a question at all. A section heading
// carries wording but nobody answers it, and giving it an identity would file
// "Part 2: Billing" in the catalogue of things we have asked developers.
async function attachToSurvey(questions, { createdBy = null, identifies = () => true } = {}) {
  const attached = [];
  for (const [index, question] of questions.entries()) {
    const withSlot = {
      ...question,
      // The slot id: which position in this survey an answer came from
      id: question.id || `q${index + 1}_${uuid().slice(0, 8)}`
    };

    if (!question.text || !identifies(question)) {
      attached.push(withSlot);
      continue;
    }

    const chosen = question.question_id
      ? await db.prepare('SELECT * FROM questions WHERE id = ?').get(question.question_id)
      : null;

    const canonical = chosen || await create(question.text, question.type || 'text', { createdBy });
    if (!canonical) {
      attached.push(withSlot);
      continue;
    }

    // Reusing a question keeps its wording, so the same question does not
    // drift into two slightly different sentences across surveys
    attached.push({ ...withSlot, question_id: canonical.id, text: chosen ? canonical.text : withSlot.text });
  }
  return attached;
}

// A question belonging to a survey run somewhere else. Identity is scoped to
// the form it came from, so re-delivering the same Google Form accumulates
// against one question, while a different form asking the same words stays its
// own body of evidence — the same reasoning that keeps matching non-binding
// inside Dev Circle.
async function forExternalSurvey(text, { source, ref, type = 'text' } = {}) {
  const normalized = normalize(text);
  if (!normalized || !source) return null;

  const existing = await db.prepare(`
    SELECT * FROM questions
    WHERE normalized = ? AND type = ? AND external_source = ? AND COALESCE(external_ref, '') = ?
  `).get(normalized, type, source, ref || '');

  if (existing) return existing;

  const id = uuid();
  await db.prepare(`
    INSERT INTO questions (id, text, normalized, type, external_source, external_ref)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, String(text).trim(), normalized, type, source, ref || null);

  return await db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
}

// ─── Reading ────────────────────────────────────────────────

// Every question we have asked that drew written answers, with the size of the
// evidence behind it. Developers, not answers, because one developer saying a
// thing five times and five saying it once are different facts.
async function catalogue({ search = null, circleId = null } = {}) {
  // Answers from surveys run here and elsewhere are the same evidence
  const where = ["f.source IN ('survey', 'external_survey')"];
  const params = [];

  if (circleId) { where.push('(f.circle_id = ? OR f.circle_id IS NULL)'); params.push(circleId); }

  if (search) {
    where.push('(q.text LIKE ? OR f.content LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  return await db.prepare(`
    SELECT q.id, q.text, q.type, q.external_source,
           COUNT(f.id) as answer_count,
           ${RESPONDENTS} as developer_count,
           COUNT(DISTINCT COALESCE(f.survey_id, f.source_system)) as survey_count,
           MAX(f.created_at) as last_answered_at,
           MIN(f.created_at) as first_answered_at
    FROM questions q
    JOIN feedback f ON f.canonical_question_id = q.id
    WHERE ${where.join(' AND ')}
    GROUP BY q.id
    ORDER BY developer_count DESC, last_answered_at DESC
  `).all(...params);
}

// Everything said in answer to one question, whichever survey asked it.
//
// Left joined, because an answer given over a public link has no member behind
// it. An inner join here would have quietly dropped every anonymous answer
// from the one page built to read them — the evidence would be in the table
// and nowhere on screen.
async function answers(questionId, { limit = 200 } = {}) {
  return await db.prepare(`
    SELECT f.id, f.content, f.created_at, f.survey_id, f.source, f.source_system,
           u.id as user_id, u.name as user_name, u.company as user_company,
           u.api_status, s.title as survey_title
    FROM feedback f
    LEFT JOIN users u ON u.id = f.user_id
    LEFT JOIN surveys s ON s.id = f.survey_id
    WHERE f.canonical_question_id = ?
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(questionId, limit);
}

// Which surveys have carried this question, and when
async function askedIn(questionId) {
  return await db.prepare(`
    SELECT s.id, s.title, s.status,
           ${RESPONDENTS} as developer_count,
           MIN(f.created_at) as first_answered_at
    FROM feedback f
    JOIN surveys s ON s.id = f.survey_id
    WHERE f.canonical_question_id = ?
    GROUP BY s.id
    ORDER BY first_answered_at DESC
  `).all(questionId);
}

// Questions an author can reuse, with how much they have already produced.
// Only free-text ones: a rating reused across surveys means something quite
// different and is not what this is for.
async function reusable({ type = 'text' } = {}) {
  return await db.prepare(`
    SELECT q.id, q.text, q.type,
           COALESCE(f.developer_count, 0) as developer_count,
           COALESCE(f.survey_count, 0) as survey_count
    FROM questions q
    LEFT JOIN (
      SELECT canonical_question_id,
             ${RESPONDENTS} as developer_count,
             COUNT(DISTINCT survey_id) as survey_count
      FROM feedback
      GROUP BY canonical_question_id
    ) f ON f.canonical_question_id = q.id
    WHERE q.type = ?
    ORDER BY developer_count DESC, q.text
  `).all(type);
}

module.exports = {
  normalize, create, suggest, attachToSurvey, forExternalSurvey,
  catalogue, answers, askedIn, reusable
};
