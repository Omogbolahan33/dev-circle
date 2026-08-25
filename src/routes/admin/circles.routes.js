const express = require('express');
const db = require('../../db');
const { paginate } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const { requireGlobalAdmin } = require('../../middleware/circleContext');
const circles = require('../../services/circles');
const cohortRules = require('../../services/cohortRules');
const surveyForm = require('../../services/surveyForm');

const router = express.Router();

// ─── Circles ────────────────────────────────────────────────
// A circle is a workspace. These endpoints are about which workspace you are
// in and who may work there — not about segmenting the members inside one,
// which is what cohorts do.

function handleCircleError(err, res) {
  if (err instanceof circles.CircleError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  return false;
}

// GET /api/admin/circles
// The workspaces this staff member can reach, and which one they are in.
// Every admin needs this to render the switcher, so it takes no permission
// beyond being staff.
router.get('/', async (req, res) => {
  const ids = req.availableCircles.map(c => c.id);
  const counts = new Map();
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.prepare(`
      SELECT circle_id, COUNT(*) as n FROM circle_members
      WHERE circle_id IN (${placeholders})
      GROUP BY circle_id
    `).all(...ids);
    for (const row of rows || []) counts.set(row.circle_id, Number(row.n || 0));
  }

  res.json({
    circles: req.availableCircles.map(c => ({
      id: c.id, name: c.name, slug: c.slug, description: c.description,
      color: c.color, member_count: counts.has(c.id) ? counts.get(c.id) : 0
    })),
    current: { id: req.circle.id, name: req.circle.name, slug: req.circle.slug },
    can_create: Boolean(req.admin.is_global)
  });
});

// GET /api/admin/circles/all — every workspace, for the tier that spans them
router.get('/all', requireGlobalAdmin, async (req, res) => {
  res.json({ circles: await circles.all({ includeArchived: req.query.include_archived === 'true' }) });
});

// GET /api/admin/circles/:id
router.get('/:id', requirePermission('circles.read'), async (req, res) => {
  const circle = await circles.byId(req.params.id);
  if (!circle) return res.status(404).json({ error: 'Circle not found' });

  if (!await circles.canAdminister(req.admin, circle.id)) {
    return res.status(403).json({ error: 'You do not have access to that circle.' });
  }

  const { offset, limit } = paginate(req.query.page, req.query.limit);

  const [countRow, members, cohorts, surveys, staff] = await Promise.all([
    db.prepare('SELECT COUNT(*) as c FROM circle_members WHERE circle_id = ?').get(circle.id),
    circles.members(circle.id, { limit, offset }),
    db.prepare(`
      SELECT c.id, c.name, c.color,
        (SELECT COUNT(*) FROM user_cohorts uc WHERE uc.cohort_id = c.id) as member_count
      FROM cohorts c WHERE c.circle_id = ?
    `).all(circle.id),
    db.prepare('SELECT id, title, status FROM surveys WHERE circle_id = ?').all(circle.id),
    db.prepare(`
      SELECT a.id, a.name, a.email, r.name as role_name
      FROM circle_admins ca
      JOIN admin_users a ON a.id = ca.admin_id
      LEFT JOIN roles r ON r.id = ca.role_id
      WHERE ca.circle_id = ?
    `).all(circle.id)
  ]);

  res.json({
    circle,
    member_count: Number(countRow?.c || 0),
    members,
    cohorts,
    surveys,
    staff
  });
});

// POST /api/admin/circles — start another workspace
router.post('/', requireGlobalAdmin, async (req, res) => {
  const { name, description, color, seed_from_cohort_id } = req.body;

  try {
    const circle = await circles.create({ name, description, color, createdBy: req.admin.id });

    // A new workspace usually starts from people who are already known, so a
    // cohort can be used to populate it. Those members join the new circle;
    // they do not leave the one they were in.
    let seeded = null;
    if (seed_from_cohort_id) {
      const userIds = ((await db.prepare('SELECT user_id FROM user_cohorts WHERE cohort_id = ?')
        .all(seed_from_cohort_id)) || []).map(r => r.user_id);
      seeded = await circles.addMembers(circle.id, userIds);
    }

    // Whoever created it can work in it
    await circles.grantAdmin(circle.id, req.admin.id, req.admin.role_id);

    res.status(201).json({ circle, seeded });
  } catch (err) {
    if (!handleCircleError(err, res)) throw err;
  }
});

// PUT /api/admin/circles/:id
router.put('/:id', requirePermission('circles.write'), async (req, res) => {
  const circle = await circles.byId(req.params.id);
  if (!circle) return res.status(404).json({ error: 'Circle not found' });
  if (!await circles.canAdminister(req.admin, circle.id)) {
    return res.status(403).json({ error: 'You do not have access to that circle.' });
  }

  const { name, description, color, survey_theme } = req.body;
  const updates = [];
  const params = [];
  const themeWarnings = [];

  if (name) { updates.push('name = ?'); params.push(name); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (color) { updates.push('color = ?'); params.push(color); }

  // The look every survey in this workspace starts from, so a circle running
  // its own programme is not re-themed one survey at a time. Null clears it.
  if (survey_theme !== undefined) {
    if (survey_theme === null) {
      updates.push('survey_theme = ?'); params.push(null);
    } else {
      const { theme, issues, warnings } = surveyForm.themes.normalize(survey_theme);
      if (issues.length) {
        return res.status(400).json({ error: issues[0].message, issues });
      }
      themeWarnings.push(...warnings);
      updates.push('survey_theme = ?'); params.push(theme ? JSON.stringify(theme) : null);
    }
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  params.push(circle.id);
  await db.prepare(`UPDATE circles SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  res.json({
    circle: await circles.byId(circle.id),
    ...(themeWarnings.length ? { warnings: themeWarnings } : {})
  });
});

// DELETE /api/admin/circles/:id — archive, keeping the history attached to it
router.delete('/:id', requireGlobalAdmin, async (req, res) => {
  try {
    await circles.archive(req.params.id);
    res.json({ message: 'Circle archived' });
  } catch (err) {
    if (!handleCircleError(err, res)) throw err;
  }
});

// ─── Members ────────────────────────────────────────────────

// GET /api/admin/circles/:id/candidates — people not yet in this workspace
router.get('/:id/candidates', requirePermission('circles.read'), async (req, res) => {
  const circle = await circles.byId(req.params.id);
  if (!circle) return res.status(404).json({ error: 'Circle not found' });

  const params = [circle.id];
  let searchClause = '';

  if (req.query.search) {
    searchClause = 'AND (u.name LIKE ? OR u.email LIKE ? OR u.company LIKE ?)';
    const s = `%${req.query.search}%`;
    params.push(s, s, s);
  }

  // Anyone with an account, since a developer may belong to several circles
  res.json({
    candidates: await db.prepare(`
      SELECT u.id, u.name, u.email, u.company, u.work_sector
      FROM users u
      WHERE u.status = 'active'
        AND u.id NOT IN (SELECT user_id FROM circle_members WHERE circle_id = ?)
        ${searchClause}
      ORDER BY u.name LIMIT 100
    `).all(...params)
  });
});

// POST /api/admin/circles/:id/members
router.post('/:id/members', requirePermission('circles.write'), async (req, res) => {
  const { user_ids, cohort_id, filter_rules, role } = req.body;

  let ids = Array.isArray(user_ids) ? user_ids : [];

  if (cohort_id) {
    ids = ids.concat(
      (await db.prepare('SELECT user_id FROM user_cohorts WHERE cohort_id = ?').all(cohort_id) || []).map(r => r.user_id)
    );
  }
  if (filter_rules) {
    try {
      ids = ids.concat(((await cohortRules.evaluate(filter_rules)).members || []).map(m => m.id));
    } catch (err) {
      if (err instanceof cohortRules.RuleError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }

  if (!ids.length) {
    return res.status(400).json({ error: 'Provide user_ids, a cohort_id, or filter_rules' });
  }

  try {
    const result = await circles.addMembers(req.params.id, [...new Set(ids)], role === 'lead' ? 'lead' : 'member');
    res.json({
      ...result,
      member_count: Number((await db.prepare('SELECT COUNT(*) as c FROM circle_members WHERE circle_id = ?')
        .get(req.params.id))?.c || 0)
    });
  } catch (err) {
    if (!handleCircleError(err, res)) throw err;
  }
});

// DELETE /api/admin/circles/:id/members/:userId
router.delete('/:id/members/:userId', requirePermission('circles.write'), async (req, res) => {
  // Leaving one workspace has no bearing on the others they belong to
  const removed = await circles.removeMember(req.params.id, req.params.userId);
  if (!removed) return res.status(404).json({ error: 'Member is not in this circle' });
  res.json({ message: 'Member removed from this circle' });
});

// ─── Staff access ───────────────────────────────────────────

// POST /api/admin/circles/:id/staff — give someone a role in this workspace
router.post('/:id/staff', requireGlobalAdmin, async (req, res) => {
  const { admin_id, role_id } = req.body;
  if (!admin_id || !role_id) {
    return res.status(400).json({ error: 'admin_id and role_id are required' });
  }
  if (!await db.prepare('SELECT 1 FROM admin_users WHERE id = ?').get(admin_id)) {
    return res.status(400).json({ error: 'Unknown admin_id' });
  }
  if (!await db.prepare('SELECT 1 FROM roles WHERE id = ?').get(role_id)) {
    return res.status(400).json({ error: 'Unknown role_id' });
  }

  try {
    await circles.grantAdmin(req.params.id, admin_id, role_id);
    res.json({ message: 'Access granted to this circle' });
  } catch (err) {
    if (!handleCircleError(err, res)) throw err;
  }
});

// DELETE /api/admin/circles/:id/staff/:adminId
router.delete('/:id/staff/:adminId', requireGlobalAdmin, async (req, res) => {
  const removed = await circles.revokeAdmin(req.params.id, req.params.adminId);
  if (!removed) return res.status(404).json({ error: 'They did not have access to this circle' });
  res.json({ message: 'Access revoked' });
});

module.exports = router;
