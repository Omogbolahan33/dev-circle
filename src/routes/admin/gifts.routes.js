const express = require('express');
const db = require('../../db');
const { uuid, parseJSON } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const engagement = require('../../services/engagement');
const notifications = require('../../services/notifications');

const router = express.Router();

// ─── Gifts ──────────────────────────────────────────────────

async function loadGiftList(circleId) {
  const gifts = await db.prepare(`
    SELECT g.*,
      COALESCE(ug.claimed_count, 0) as claimed_count,
      COALESCE(ug.delivered_count, 0) as delivered_count
    FROM gifts g
    LEFT JOIN (
      SELECT ug.gift_id,
             COUNT(*) as claimed_count,
             SUM(CASE WHEN ug.delivered_at IS NOT NULL THEN 1 ELSE 0 END) as delivered_count
      FROM user_gifts ug
      JOIN gifts gx ON gx.id = ug.gift_id AND gx.circle_id = ?
      GROUP BY ug.gift_id
    ) ug ON ug.gift_id = g.id
    WHERE g.circle_id = ?
    ORDER BY g.created_at DESC
  `).all(circleId, circleId);

  return { gifts: (gifts || []).map(g => ({ ...g, target_cohort_ids: parseJSON(g.target_cohort_ids, []) })) };
}

// GET /api/admin/gifts
router.get('/gifts', requirePermission('gifts.read'), async (req, res) => {
  const { takePreload } = require('../../middleware/preload');
  res.json(await takePreload(req, () => loadGiftList(req.circleId)));
});

// POST /api/admin/gifts
router.post('/gifts', requirePermission('gifts.write'), async (req, res) => {
  const {
    name, description, value, currency, target_cohort_ids,
    stock, min_surveys_completed, min_streak
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = uuid();
  await db.prepare(`
    INSERT INTO gifts (id, name, description, value, currency, target_cohort_ids,
                       stock, min_surveys_completed, min_streak, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id, name, description || null, value || 0, currency || 'NGN',
    JSON.stringify(target_cohort_ids || []),
    stock ?? null, min_surveys_completed || 0, min_streak || 0
  );

  const gift = await db.prepare('SELECT * FROM gifts WHERE id = ?').get(id);
  res.status(201).json({ gift: { ...gift, target_cohort_ids: parseJSON(gift.target_cohort_ids, []) } });
});

// PUT /api/admin/gifts/:id
router.put('/gifts/:id', requirePermission('gifts.write'), async (req, res) => {
  const gift = await db.prepare('SELECT * FROM gifts WHERE id = ?').get(req.params.id);
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
  await db.prepare(`UPDATE gifts SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = await db.prepare('SELECT * FROM gifts WHERE id = ?').get(gift.id);
  res.json({ gift: { ...updated, target_cohort_ids: parseJSON(updated.target_cohort_ids, []) } });
});

// POST /api/admin/gifts/:id/deliver — mark a claim as fulfilled
router.post('/gifts/:id/deliver', requirePermission('gifts.write'), async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const claim = await db.prepare('SELECT * FROM user_gifts WHERE gift_id = ? AND user_id = ?')
    .get(req.params.id, user_id);
  if (!claim) return res.status(404).json({ error: 'No claim found for this member' });
  if (claim.delivered_at) return res.status(409).json({ error: 'Already delivered' });

  await db.prepare("UPDATE user_gifts SET delivered_at = datetime('now') WHERE id = ?").run(claim.id);

  const gift = await db.prepare('SELECT * FROM gifts WHERE id = ?').get(req.params.id);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);

  engagement.log(user_id, 'gift_delivered', { referenceId: gift.id, metadata: { gift_name: gift.name }, source: 'manual' });

  await notifications.notify(user, {
    category: 'gift_notifications',
    title: `${gift.name} is on its way`,
    body: 'Your reward has been sent.',
    actionUrl: '/member/gifts.html',
    sourceType: 'system',
    sourceId: gift.id,
    workflow: 'gift_claimed',
    templateData: {
      giftName: gift.name,
      giftValue: gift.value,
      currency: gift.currency || 'NGN'
    },
    channels: ['in_portal', 'email']
  });

  res.json({ message: 'Marked as delivered' });
});

module.exports = router;
module.exports.loadGiftList = loadGiftList;
