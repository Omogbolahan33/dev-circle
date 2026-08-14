const express = require('express');
const db = require('../db');
const { uuid } = require('../utils/helpers');
const { requireAuth } = require('../middleware/auth');
const engagement = require('../services/engagement');

const router = express.Router();

const CATEGORIES = ['documentation', 'api', 'sandbox', 'support', 'billing', 'feature_request', 'other'];

// POST /api/feedback
router.post('/', requireAuth, (req, res) => {
  const { content, category, rating, survey_id } = req.body;

  if (!content || !String(content).trim()) {
    return res.status(400).json({ error: 'content is required' });
  }
  if (String(content).length > 5000) {
    return res.status(400).json({ error: 'content is limited to 5000 characters' });
  }
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Unknown category', valid: CATEGORIES });
  }
  if (rating !== undefined && rating !== null) {
    const r = Number(rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) {
      return res.status(400).json({ error: 'rating must be an integer from 1 to 5' });
    }
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO feedback (id, user_id, type, content, category, rating, source, survey_id)
    VALUES (?, ?, ?, ?, ?, ?, 'dev_circle', ?)
  `).run(
    id, req.user.id,
    survey_id ? 'system_triggered' : 'self_initiated',
    String(content).trim(), category || null, rating ?? null, survey_id || null
  );

  // Submitting feedback counts toward the engagement streak
  const { streak } = engagement.record(req.user.id, 'feedback_submitted', {
    referenceId: id,
    metadata: { category, rating }
  });

  res.status(201).json({
    feedback: db.prepare('SELECT * FROM feedback WHERE id = ?').get(id),
    streak: streak ? streak.streak : null
  });
});

// GET /api/feedback — the caller's own feedback only
router.get('/', requireAuth, (req, res) => {
  const { status, limit = 50 } = req.query;
  let query = 'SELECT * FROM feedback WHERE user_id = ?';
  const params = [req.user.id];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(200, parseInt(limit, 10) || 50));

  res.json({ feedback: db.prepare(query).all(...params), categories: CATEGORIES });
});

// GET /api/feedback/:id
router.get('/:id', requireAuth, (req, res) => {
  const feedback = db.prepare('SELECT * FROM feedback WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!feedback) return res.status(404).json({ error: 'Feedback not found' });
  res.json({ feedback });
});

module.exports = router;
