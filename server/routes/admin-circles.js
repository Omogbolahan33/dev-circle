const express = require('express');
const db = require('../db');
const { parseJSON, paginate } = require('../utils/helpers');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const circles = require('../services/circles');
const cohortRules = require('../services/cohortRules');

const router = express.Router();
router.use(requireAuth, requireAdmin);

function handleCircleError(err, res) {
  if (err instanceof circles.CircleError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  return false;
}

// GET /api/admin/circles
router.get('/', requirePermission('circles.read'), (req, res) => {
  res.json({ circles: circles.withCounts(), root: circles.root() });
});

// GET /api/admin/circles/:id
router.get('/:id', requirePermission('circles.read'), (req, res) => {
  const circle = db.prepare('SELECT * FROM circles WHERE id = ?').get(req.params.id);
  if (!circle) return res.status(404).json({ error: 'Circle not found' });

  const { offset, limit } = paginate(req.query.page, req.query.limit);

  res.json({
    circle,
    parent: circle.parent_id
      ? db.prepare('SELECT id, name, slug FROM circles WHERE id = ?').get(circle.parent_id)
      : null,
    children: db.prepare('SELECT id, name, slug, color, status FROM circles WHERE parent_id = ?').all(circle.id),
    member_count: db.prepare('SELECT COUNT(*) as c FROM circle_members WHERE circle_id = ?').get(circle.id).c,
    members: circles.members(circle.id, { limit, offset }),
    cohorts: db.prepare(`
      SELECT c.id, c.name, c.color,
        (SELECT COUNT(*) FROM user_cohorts uc WHERE uc.cohort_id = c.id) as member_count
      FROM cohorts c WHERE c.circle_id = ?
    `).all(circle.id),
    surveys: db.prepare('SELECT id, title, status, engagement_mode FROM surveys WHERE circle_id = ?').all(circle.id)
  });
});

// POST /api/admin/circles
router.post('/', requirePermission('circles.write'), (req, res) => {
  const { name, description, color, parent_id, seed_from_cohort_id } = req.body;

  try {
    const circle = circles.create({
      name, description, color,
      parentId: parent_id,
      createdBy: req.admin.id
    });

    // A new circle usually starts from an existing segment — seeding it from
    // a cohort saves adding members one at a time.
    let seeded = null;
    if (seed_from_cohort_id) {
      const userIds = db.prepare('SELECT user_id FROM user_cohorts WHERE cohort_id = ?')
        .all(seed_from_cohort_id).map(r => r.user_id);
      seeded = circles.addMembers(circle.id, userIds);
    }

    res.status(201).json({ circle, seeded });
  } catch (err) {
    if (!handleCircleError(err, res)) throw err;
  }
});

// PUT /api/admin/circles/:id
router.put('/:id', requirePermission('circles.write'), (req, res) => {
  const circle = db.prepare('SELECT * FROM circles WHERE id = ?').get(req.params.id);
  if (!circle) return res.status(404).json({ error: 'Circle not found' });

  const { name, description, color } = req.body;
  const updates = [];
  const params = [];

  if (name) { updates.push('name = ?'); params.push(name); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (color) { updates.push('color = ?'); params.push(color); }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  params.push(circle.id);
  db.prepare(`UPDATE circles SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  res.json({ circle: db.prepare('SELECT * FROM circles WHERE id = ?').get(circle.id) });
});

// DELETE /api/admin/circles/:id — archive rather than delete, so the
// engagement history attached to the circle's work survives
router.delete('/:id', requirePermission('circles.write'), (req, res) => {
  try {
    circles.archive(req.params.id);
    res.json({ message: 'Circle archived' });
  } catch (err) {
    if (!handleCircleError(err, res)) throw err;
  }
});

// GET /api/admin/circles/:id/candidates — parent members not yet in this circle
router.get('/:id/candidates', requirePermission('circles.read'), (req, res) => {
  const circle = db.prepare('SELECT * FROM circles WHERE id = ?').get(req.params.id);
  if (!circle) return res.status(404).json({ error: 'Circle not found' });

  const { search } = req.query;
  const parentId = circle.parent_id;

  const params = [circle.id];
  let scope = '';
  if (parentId) {
    scope = 'AND u.id IN (SELECT user_id FROM circle_members WHERE circle_id = ?)';
    params.push(parentId);
  }

  let searchClause = '';
  if (search) {
    searchClause = 'AND (u.name LIKE ? OR u.email LIKE ? OR u.company LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  const candidates = db.prepare(`
    SELECT u.id, u.name, u.email, u.company, u.work_sector
    FROM users u
    WHERE u.status = 'active'
      AND u.id NOT IN (SELECT user_id FROM circle_members WHERE circle_id = ?)
      ${scope} ${searchClause}
    ORDER BY u.name LIMIT 100
  `).all(...params);

  res.json({ candidates });
});

// POST /api/admin/circles/:id/members
router.post('/:id/members', requirePermission('circles.write'), (req, res) => {
  const { user_ids, cohort_id, filter_rules, role } = req.body;

  let ids = Array.isArray(user_ids) ? user_ids : [];

  // Members can also be pulled in by cohort or by an ad-hoc rule set, using
  // the same engine that powers cohorts.
  if (cohort_id) {
    ids = ids.concat(
      db.prepare('SELECT user_id FROM user_cohorts WHERE cohort_id = ?').all(cohort_id).map(r => r.user_id)
    );
  }
  if (filter_rules) {
    try {
      ids = ids.concat(cohortRules.evaluate(filter_rules).members.map(m => m.id));
    } catch (err) {
      if (err instanceof cohortRules.RuleError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }

  if (!ids.length) {
    return res.status(400).json({ error: 'Provide user_ids, a cohort_id, or filter_rules' });
  }

  try {
    const result = circles.addMembers(req.params.id, [...new Set(ids)], role === 'lead' ? 'lead' : 'member');
    res.json({ ...result, member_count: db.prepare('SELECT COUNT(*) as c FROM circle_members WHERE circle_id = ?').get(req.params.id).c });
  } catch (err) {
    if (!handleCircleError(err, res)) throw err;
  }
});

// DELETE /api/admin/circles/:id/members/:userId
router.delete('/:id/members/:userId', requirePermission('circles.write'), (req, res) => {
  try {
    // Removing from a circle also removes from everything beneath it
    const removed = circles.removeFromTree(req.params.id, req.params.userId);
    if (!removed) return res.status(404).json({ error: 'Member is not in this circle' });
    res.json({ message: 'Member removed', removed_from: removed });
  } catch (err) {
    if (!handleCircleError(err, res)) throw err;
  }
});

module.exports = router;
