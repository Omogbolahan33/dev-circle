const express = require('express');
const db = require('../../db');
const { uuid, parseJSON } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const cohortRules = require('../../services/cohortRules');
const circles = require('../../services/circles');

const router = express.Router();

// ─── Cohorts ────────────────────────────────────────────────

// GET /api/admin/cohorts
router.get('/cohorts', requirePermission('cohorts.read'), async (req, res) => {
  // Cohorts belong to the circle they were made in. Member counts are a
  // subquery so Postgres does not demand every selected column in GROUP BY.
  const cohorts = await db.prepare(`
    SELECT c.*, ci.name as circle_name,
      (SELECT COUNT(*) FROM user_cohorts uc WHERE uc.cohort_id = c.id) as member_count
    FROM cohorts c
    LEFT JOIN circles ci ON ci.id = c.circle_id
    WHERE c.circle_id = ?
    ORDER BY member_count DESC
  `).all(req.circleId);

  res.json({
    cohorts: (cohorts || []).map(c => ({ ...c, filter_rules: parseJSON(c.filter_rules, null) }))
  });
});

// GET /api/admin/cohorts/rule-fields — catalogue for the cohort builder
router.get('/cohorts/rule-fields', requirePermission('cohorts.read'), async (req, res) => {
  res.json({ fields: await cohortRules.catalogue() });
});

// POST /api/admin/cohorts/preview — how many members a rule set matches
router.post('/cohorts/preview', requirePermission('cohorts.read'), async (req, res) => {
  try {
    const result = await cohortRules.evaluate(req.body.filter_rules, { limit: 10 });
    res.json(result);
  } catch (err) {
    if (err instanceof cohortRules.RuleError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// POST /api/admin/cohorts
router.post('/cohorts', requirePermission('cohorts.write'), async (req, res) => {
  const { name, description, color, type = 'custom', filter_rules, auto_sync = true, circle_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  // Made in the circle being worked in
  const circle = req.circle;

  // Validate the rules before storing them, so a cohort can never be saved
  // with a definition the engine cannot evaluate.
  if (filter_rules) {
    try {
      await cohortRules.evaluate(filter_rules, { limit: 1 });
    } catch (err) {
      if (err instanceof cohortRules.RuleError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }

  const id = uuid();
  await db.prepare(`
    INSERT INTO cohorts (id, name, description, type, color, filter_rules, auto_sync, circle_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, description || null, type, color || '#107EBC',
    filter_rules ? JSON.stringify(filter_rules) : null,
    filter_rules && auto_sync ? 1 : 0,
    circle.id,
    req.admin.id
  );

  // Populate immediately. Rule-based cohorts used to be created empty because
  // matching happened only in the browser preview and was then discarded.
  const sync = filter_rules ? await cohortRules.sync(id) : { added: 0, removed: 0, total: 0 };

  const cohort = await db.prepare('SELECT * FROM cohorts WHERE id = ?').get(id);
  res.status(201).json({
    cohort: { ...cohort, filter_rules: parseJSON(cohort.filter_rules, null) },
    sync
  });
});

// PUT /api/admin/cohorts/:id
router.put('/cohorts/:id', requirePermission('cohorts.write'), async (req, res) => {
  const { name, description, color, filter_rules, auto_sync } = req.body;
  const cohort = await db.prepare('SELECT * FROM cohorts WHERE id = ?').get(req.params.id);
  if (!cohort) return res.status(404).json({ error: 'Cohort not found' });

  const updates = [];
  const params = [];

  if (name) { updates.push('name = ?'); params.push(name); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (color) { updates.push('color = ?'); params.push(color); }
  if (auto_sync !== undefined) { updates.push('auto_sync = ?'); params.push(auto_sync ? 1 : 0); }
  if (filter_rules !== undefined) {
    if (filter_rules) {
      try {
        await cohortRules.evaluate(filter_rules, { limit: 1 });
      } catch (err) {
        if (err instanceof cohortRules.RuleError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }
    updates.push('filter_rules = ?');
    params.push(filter_rules ? JSON.stringify(filter_rules) : null);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  params.push(cohort.id);
  await db.prepare(`UPDATE cohorts SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const sync = filter_rules !== undefined && filter_rules
    ? await cohortRules.sync(cohort.id)
    : null;

  const updated = await db.prepare('SELECT * FROM cohorts WHERE id = ?').get(cohort.id);
  res.json({ cohort: { ...updated, filter_rules: parseJSON(updated.filter_rules, null) }, sync });
});

// POST /api/admin/cohorts/:id/sync — re-run the rules on demand
router.post('/cohorts/:id/sync', requirePermission('cohorts.write'), async (req, res) => {
  try {
    res.json(await cohortRules.sync(req.params.id));
  } catch (err) {
    if (err instanceof cohortRules.RuleError) return res.status(404).json({ error: err.message });
    throw err;
  }
});

// DELETE /api/admin/cohorts/:id
router.delete('/cohorts/:id', requirePermission('cohorts.write'), async (req, res) => {
  const cohort = await db.prepare('SELECT * FROM cohorts WHERE id = ?').get(req.params.id);
  if (!cohort) return res.status(404).json({ error: 'Cohort not found' });
  if (cohort.type === 'system') return res.status(400).json({ error: 'Cannot delete system cohorts' });

  await db.prepare('DELETE FROM user_cohorts WHERE cohort_id = ?').run(cohort.id);
  await db.prepare('DELETE FROM cohorts WHERE id = ?').run(cohort.id);

  res.json({ message: 'Cohort deleted' });
});

// POST /api/admin/cohorts/:id/members
router.post('/cohorts/:id/members', requirePermission('cohorts.write'), async (req, res) => {
  const { user_ids } = req.body;
  if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids array required' });

  const cohort = await db.prepare('SELECT * FROM cohorts WHERE id = ?').get(req.params.id);
  if (!cohort) return res.status(404).json({ error: 'Cohort not found' });

  const stmt = db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)');
  const exists = db.prepare('SELECT 1 FROM users WHERE id = ?');

  let added = 0;
  const unknown = [];

  db.transaction(() => {
    for (const uid of user_ids) {
      if (!exists.get(uid)) { unknown.push(uid); continue; }
      added += stmt.run(uid, cohort.id).changes;
    }
  })();

  const count = Number((await db.prepare('SELECT COUNT(*) as c FROM user_cohorts WHERE cohort_id = ?').get(cohort.id))?.c || 0);
  res.json({ message: `${added} member(s) added`, added, unknown, member_count: count });
});

// DELETE /api/admin/cohorts/:id/members/:userId
router.delete('/cohorts/:id/members/:userId', requirePermission('cohorts.write'), async (req, res) => {
  await db.prepare('DELETE FROM user_cohorts WHERE user_id = ? AND cohort_id = ?')
    .run(req.params.userId, req.params.id);
  res.json({ message: 'Member removed from cohort' });
});

module.exports = router;
