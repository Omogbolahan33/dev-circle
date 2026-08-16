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
function create(text, type = 'text', { createdBy = null } = {}) {
  const normalized = normalize(text);
  if (!normalized) return null;

  const id = uuid();
  db.prepare('INSERT INTO questions (id, text, normalized, type, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, String(text).trim(), normalized, type, createdBy);

  return db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
}

// Questions already asked that read like this one, so the author can join the
// evidence up if they meant the same thing. Ordered by how much each has
// already collected, since that is what makes reuse worth doing.
function suggest(text, type = 'text', { limit = 5 } = {}) {
  const normalized = normalize(text);
  if (normalized.length < 8) return [];

  return db.prepare(`
    SELECT q.id, q.text,
           (SELECT COUNT(DISTINCT f.user_id) FROM feedback f
             WHERE f.canonical_question_id = q.id) as developer_count,
           (SELECT COUNT(DISTINCT f.survey_id) FROM feedback f
             WHERE f.canonical_question_id = q.id) as survey_count
    FROM questions q
    WHERE q.type = ? AND q.normalized = ?
    ORDER BY developer_count DESC
    LIMIT ?
  `).all(type, normalized, limit);
}

// Give every question in a survey an identity. An explicit question_id means
// the author chose to carry on an existing question; anything else starts a
// new one, so authoring is never constrained by what has been asked before.
function attachToSurvey(questions, { createdBy = null } = {}) {
  return questions.map((question, index) => {
    const withSlot = {
      ...question,
      // The slot id: which position in this survey an answer came from
      id: question.id || `q${index + 1}_${uuid().slice(0, 8)}`
    };

    if (!question.text) return withSlot;

    const chosen = question.question_id
      ? db.prepare('SELECT * FROM questions WHERE id = ?').get(question.question_id)
      : null;

    const canonical = chosen || create(question.text, question.type || 'text', { createdBy });
    if (!canonical) return withSlot;

    // Reusing a question keeps its wording, so the same question does not
    // drift into two slightly different sentences across surveys
    return { ...withSlot, question_id: canonical.id, text: chosen ? canonical.text : withSlot.text };
  });
}

// A question belonging to a survey run somewhere else. Identity is scoped to
// the form it came from, so re-delivering the same Google Form accumulates
// against one question, while a different form asking the same words stays its
// own body of evidence — the same reasoning that keeps matching non-binding
// inside Dev Circle.
function forExternalSurvey(text, { source, ref, type = 'text' } = {}) {
  const normalized = normalize(text);
  if (!normalized || !source) return null;

  const existing = db.prepare(`
    SELECT * FROM questions
    WHERE normalized = ? AND type = ? AND external_source = ? AND COALESCE(external_ref, '') = ?
  `).get(normalized, type, source, ref || '');

  if (existing) return existing;

  const id = uuid();
  db.prepare(`
    INSERT INTO questions (id, text, normalized, type, external_source, external_ref)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, String(text).trim(), normalized, type, source, ref || null);

  return db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
}

// ─── Reading ────────────────────────────────────────────────

// Every question we have asked that drew written answers, with the size of the
// evidence behind it. Developers, not answers, because one developer saying a
// thing five times and five saying it once are different facts.
function catalogue({ search = null } = {}) {
  // Answers from surveys run here and elsewhere are the same evidence
  const where = ["f.source IN ('survey', 'external_survey')"];
  const params = [];

  if (search) {
    where.push('(q.text LIKE ? OR f.content LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  return db.prepare(`
    SELECT q.id, q.text, q.type, q.external_source,
           COUNT(f.id) as answer_count,
           COUNT(DISTINCT f.user_id) as developer_count,
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

// Everything said in answer to one question, whichever survey asked it
function answers(questionId, { limit = 200 } = {}) {
  return db.prepare(`
    SELECT f.id, f.content, f.created_at, f.survey_id, f.source, f.source_system,
           u.id as user_id, u.name as user_name, u.company as user_company,
           u.api_status, s.title as survey_title
    FROM feedback f
    JOIN users u ON u.id = f.user_id
    LEFT JOIN surveys s ON s.id = f.survey_id
    WHERE f.canonical_question_id = ?
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(questionId, limit);
}

// Which surveys have carried this question, and when
function askedIn(questionId) {
  return db.prepare(`
    SELECT s.id, s.title, s.status,
           COUNT(DISTINCT f.user_id) as developer_count,
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
function reusable({ type = 'text' } = {}) {
  return db.prepare(`
    SELECT q.id, q.text, q.type,
           (SELECT COUNT(DISTINCT f.user_id) FROM feedback f
             WHERE f.canonical_question_id = q.id) as developer_count,
           (SELECT COUNT(DISTINCT f.survey_id) FROM feedback f
             WHERE f.canonical_question_id = q.id) as survey_count
    FROM questions q
    WHERE q.type = ?
    ORDER BY developer_count DESC, q.text
  `).all(type);
}

module.exports = {
  normalize, create, suggest, attachToSurvey, forExternalSurvey,
  catalogue, answers, askedIn, reusable
};
