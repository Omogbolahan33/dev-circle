const express = require('express');
const db = require('../../db');
const { requirePermission } = require('../../middleware/auth');
const questions = require('../../services/questions');

const router = express.Router();

// ─── Questions ──────────────────────────────────────────────
// The evidence base. Answers read together under the question that drew them
// out, rather than as one stream ordered by arrival — because arrival order is
// the one axis that carries no meaning when the point is to compare what
// different developers said to the same prompt.

// GET /api/admin/questions
router.get('/questions', requirePermission('feedback.read'), (req, res) => {
  const catalogue = questions.catalogue({ search: req.query.search || null, circleId: req.circleId });

  res.json({
    questions: catalogue,
    // Distinct developers, not answers: one developer saying a thing five
    // times and five saying it once are different facts, and a total would
    // render them identically
    totals: {
      questions: catalogue.length,
      developers: db.prepare(`
        SELECT COUNT(DISTINCT user_id) as c FROM feedback
        WHERE source IN ('survey', 'external_survey') AND circle_id = ?
      `).get(req.circleId).c,
      answers: catalogue.reduce((sum, q) => sum + q.answer_count, 0)
    }
  });
});

// GET /api/admin/questions/:id
router.get('/questions/:id', requirePermission('feedback.read'), (req, res) => {
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!question) return res.status(404).json({ error: 'Question not found' });

  const answers = questions.answers(question.id);

  res.json({
    question,
    // Where it has been asked, so a question carried by more than one survey
    // reads as one body of evidence with several occasions behind it
    asked_in: questions.askedIn(question.id),
    developer_count: new Set(answers.map(a => a.user_id)).size,
    answers
  });
});

// GET /api/admin/questions/reusable
// Offered while writing a survey. Never applied on the author's behalf.
router.get('/questions-reusable', requirePermission('surveys.write'), (req, res) => {
  res.json({ questions: questions.reusable({ type: req.query.type || 'text' }) });
});

// POST /api/admin/questions/suggest
// "You have asked something like this before" — a prompt to join the evidence
// up, shown while typing. Two initiatives can ask the same words about
// different things, so this only ever suggests.
router.post('/questions/suggest', requirePermission('surveys.write'), (req, res) => {
  const { text, type = 'text' } = req.body;
  if (!text) return res.json({ matches: [] });

  res.json({ matches: questions.suggest(text, type) });
});

module.exports = router;
