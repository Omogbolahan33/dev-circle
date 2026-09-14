const express = require('express');
const db = require('../db');
const { uuid, paginate, pageMeta } = require('../utils/helpers');
const { requireAuth } = require('../middleware/auth');
const engagement = require('../services/engagement');

const router = express.Router();

const CATEGORIES = ['documentation', 'api', 'sandbox', 'support', 'billing', 'feature_request', 'other'];

// POST /api/feedback
router.post('/', requireAuth, async (req, res) => {
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
  // Filed in the circle they belong to. A member of several has this recorded
  // against the one the feedback was raised in.
  const circleId = await db.prepare(
    'SELECT circle_id FROM circle_members WHERE user_id = ? ORDER BY added_at LIMIT 1'
  ).get(req.user.id)?.circle_id || null;

  await db.prepare(`
    INSERT INTO feedback (id, user_id, type, content, category, rating, source, survey_id, circle_id)
    VALUES (?, ?, ?, ?, ?, ?, 'dev_circle', ?, ?)
  `).run(
    id, req.user.id,
    survey_id ? 'system_triggered' : 'self_initiated',
    String(content).trim(), category || null, rating ?? null, survey_id || null, circleId
  );

  // Submitting feedback counts toward the engagement streak
  const { streak } = await engagement.record(req.user.id, 'feedback_submitted', {
    referenceId: id,
    metadata: { category, rating }
  });

  res.status(201).json({
    feedback: await db.prepare('SELECT * FROM feedback WHERE id = ?').get(id),
    streak: streak ? streak.streak : null
  });
});

// GET /api/feedback — the caller's own feedback only
// Paged for the same reason as the engagement history: it only grows, and a
// bare `limit` meant everything past the cap was unreachable rather than
// merely on the next page.
router.get('/', requireAuth, async (req, res) => {
  const { status } = req.query;
  const { offset, limit, page } = paginate(req.query.page, req.query.limit || 50, { max: 200 });

  const where = ['user_id = ?'];
  const params = [req.user.id];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const filter = where.join(' AND ');

  const [feedback, totalRow] = await Promise.all([
    db.prepare(`SELECT * FROM feedback WHERE ${filter} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset),
    db.prepare(`SELECT COUNT(*) as c FROM feedback WHERE ${filter}`).get(...params)
  ]);

  res.json({
    feedback: feedback || [],
    categories: CATEGORIES,
    pagination: pageMeta({ page, limit, total: Number(totalRow?.c || 0) })
  });
});

// GET /api/feedback/:id
router.get('/:id', requireAuth, async (req, res) => {
  const feedback = await db.prepare('SELECT * FROM feedback WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!feedback) return res.status(404).json({ error: 'Feedback not found' });
  res.json({ feedback });
});

module.exports = router;
