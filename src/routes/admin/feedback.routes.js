const express = require('express');
const db = require('../../db');
const { requirePermission } = require('../../middleware/auth');
const engagement = require('../../services/engagement');

const router = express.Router();

// ─── Feedback (Admin view) ──────────────────────────────────

// GET /api/admin/feedback
router.get('/feedback', requirePermission('feedback.read'), (req, res) => {
  const { status, source, type, limit = 50 } = req.query;
  const where = ['1=1'];
  const params = [];

  if (status) { where.push('f.status = ?'); params.push(status); }
  if (source) { where.push('f.source = ?'); params.push(source); }
  if (type) { where.push('f.type = ?'); params.push(type); }

  const feedback = db.prepare(`
    SELECT f.*, u.name as user_name, u.email as user_email, u.company as user_company
    FROM feedback f
    JOIN users u ON u.id = f.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(...params, Math.min(200, parseInt(limit, 10) || 50));

  res.json({ feedback });
});

// PUT /api/admin/feedback/:id
// PUT /api/admin/feedback/:id
// This marks how far the engagement team has got through *reading* feedback.
// It is triage state, not ticket resolution — Dev Circle collects information,
// it does not resolve issues.
router.put('/feedback/:id', requirePermission('feedback.write'), (req, res) => {
  const { status, note } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  if (!['open', 'reviewed', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const fb = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  if (!fb) return res.status(404).json({ error: 'Feedback not found' });

  // A Feex complaint's state belongs to Feex. Dev Circle mirrors it through
  // the webhook and must not let an admin edit it here, or the two systems
  // would disagree about a ticket Feex owns.
  if (fb.source === 'feex') {
    return res.status(409).json({
      error: 'This complaint is owned by Feex. Update it there — Dev Circle mirrors its status for engagement tracking only.',
      ticket_id: fb.external_ticket_id,
      feex_status: fb.feex_status,
      feex_url: fb.feex_url
    });
  }

  db.prepare(`
    UPDATE feedback
    SET status = ?, resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') ELSE NULL END
    WHERE id = ?
  `).run(status, status, fb.id);

  if (note) {
    engagement.log(fb.user_id, 'feedback_submitted', {
      referenceId: fb.id,
      metadata: { triage_note: note, status },
      source: 'manual'
    });
  }

  res.json({ feedback: db.prepare('SELECT * FROM feedback WHERE id = ?').get(fb.id) });
});

module.exports = router;
