const express = require('express');
const db = require('../../db');
const { uuid, parseJSON } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const engagement = require('../../services/engagement');
const notifications = require('../../services/notifications');

const router = express.Router();

// ─── Gifts ──────────────────────────────────────────────────

// GET /api/admin/gifts
router.get('/gifts', requirePermission('gifts.read'), (req, res) => {
  const gifts = db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM user_gifts ug WHERE ug.gift_id = g.id) as claimed_count,
      (SELECT COUNT(*) FROM user_gifts ug WHERE ug.gift_id = g.id AND ug.delivered_at IS NOT NULL) as delivered_count
    FROM gifts g ORDER BY g.created_at DESC
  `).all();

  res.json({ gifts: gifts.map(g => ({ ...g, target_cohort_ids: parseJSON(g.target_cohort_ids, []) })) });
});

// POST /api/admin/gifts
router.post('/gifts', requirePermission('gifts.write'), (req, res) => {
  const {
    name, description, value, currency, target_cohort_ids,
    stock, min_surveys_completed, min_streak
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = uuid();
  db.prepare(`
    INSERT INTO gifts (id, name, description, value, currency, target_cohort_ids,
                       stock, min_surveys_completed, min_streak, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id, name, description || null, value || 0, currency || 'NGN',
    JSON.stringify(target_cohort_ids || []),
    stock ?? null, min_surveys_completed || 0, min_streak || 0
  );

  const gift = db.prepare('SELECT * FROM gifts WHERE id = ?').get(id);
  res.status(201).json({ gift: { ...gift, target_cohort_ids: parseJSON(gift.target_cohort_ids, []) } });
});

// PUT /api/admin/gifts/:id
router.put('/gifts/:id', requirePermission('gifts.write'), (req, res) => {
  const gift = db.prepare('SELECT * FROM gifts WHERE id = ?').get(req.params.id);
  if (!gift) return res.status(404).json({ error: 'Gift not found' });

  const fields = {
    name: req.body.name,
    description: req.body.description,
    value: req.body.value,
    stock: req.body.stock,
    min_surveys_completed: req.body.min_surveys_completed,
    min_streak: req.body.min_streak,
    active: req.body.active === undefined ? undefined : (req.body.active ? 1 : 0)
  };

  const updates = [];
  const params = [];
  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined) { updates.push(`${key} = ?`); params.push(val); }
  }
  if (req.body.target_cohort_ids !== undefined) {
    updates.push('target_cohort_ids = ?');
    params.push(JSON.stringify(req.body.target_cohort_ids));
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  params.push(gift.id);
  db.prepare(`UPDATE gifts SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM gifts WHERE id = ?').get(gift.id);
  res.json({ gift: { ...updated, target_cohort_ids: parseJSON(updated.target_cohort_ids, []) } });
});

// POST /api/admin/gifts/:id/deliver — mark a claim as fulfilled
router.post('/gifts/:id/deliver', requirePermission('gifts.write'), async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const claim = db.prepare('SELECT * FROM user_gifts WHERE gift_id = ? AND user_id = ?')
    .get(req.params.id, user_id);
  if (!claim) return res.status(404).json({ error: 'No claim found for this member' });
  if (claim.delivered_at) return res.status(409).json({ error: 'Already delivered' });

  db.prepare("UPDATE user_gifts SET delivered_at = datetime('now') WHERE id = ?").run(claim.id);

  const gift = db.prepare('SELECT * FROM gifts WHERE id = ?').get(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);

  engagement.log(user_id, 'gift_delivered', { referenceId: gift.id, metadata: { gift_name: gift.name }, source: 'manual' });

  await notifications.notify(user, {
    category: 'gift_notifications',
    title: `${gift.name} is on its way`,
    body: 'Your reward has been sent.',
    actionUrl: '/member/gifts.html',
    sourceType: 'system',
    sourceId: gift.id,
    channels: ['in_portal', 'email']
  });

  res.json({ message: 'Marked as delivered' });
});

module.exports = router;
