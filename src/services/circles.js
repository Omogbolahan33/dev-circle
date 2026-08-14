const db = require('../db');
const { uuid } = require('../utils/helpers');

// ─── Circles ────────────────────────────────────────────────
// The blueprint asks admins to "create other Circles/group similar to the dev
// circle as sub circles". A circle is a full engagement space — its own
// members, cohorts, surveys, gifts and messaging — nested under the root
// Dev Circle. This is distinct from a cohort, which segments members inside
// one circle.

class CircleError extends Error {}

function root() {
  return db.prepare('SELECT * FROM circles WHERE is_root = 1').get();
}

function bySlug(slug) {
  return db.prepare('SELECT * FROM circles WHERE slug = ?').get(slug);
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function uniqueSlug(name) {
  const base = slugify(name) || 'circle';
  let candidate = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM circles WHERE slug = ?').get(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

// Every circle from this one down. Used so a lead of a parent circle can see
// activity in its sub-circles without being added to each one.
function descendants(circleId) {
  const rows = db.prepare(`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM circles WHERE id = ?
      UNION
      SELECT c.id FROM circles c JOIN tree t ON c.parent_id = t.id
    )
    SELECT id FROM tree
  `).all(circleId);
  return rows.map(r => r.id);
}

function create({ name, description, color, parentId, createdBy }) {
  if (!name || !String(name).trim()) throw new CircleError('name is required');

  const parent = parentId
    ? db.prepare('SELECT * FROM circles WHERE id = ?').get(parentId)
    : root();

  if (!parent) throw new CircleError('Parent circle not found');
  if (parent.status !== 'active') throw new CircleError('Cannot nest under an archived circle');

  // Two levels is the useful depth here — the root plus its sub-circles.
  // Deeper nesting makes membership and targeting hard to reason about.
  if (!parent.is_root && parent.parent_id) {
    throw new CircleError('Sub-circles cannot be nested more than one level below Dev Circle');
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO circles (id, name, slug, description, color, parent_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, String(name).trim(), uniqueSlug(name), description || null,
         color || '#107EBC', parent.id, createdBy || null);

  return db.prepare('SELECT * FROM circles WHERE id = ?').get(id);
}

function withCounts() {
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM circle_members m WHERE m.circle_id = c.id) as member_count,
      (SELECT COUNT(*) FROM cohorts x WHERE x.circle_id = c.id) as cohort_count,
      (SELECT COUNT(*) FROM surveys s WHERE s.circle_id = c.id) as survey_count,
      p.name as parent_name
    FROM circles c
    LEFT JOIN circles p ON p.id = c.parent_id
    ORDER BY c.is_root DESC, c.created_at ASC
  `).all();
}

function members(circleId, { limit = 100, offset = 0 } = {}) {
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.company, u.work_sector, u.api_status,
           u.engagement_streak, m.role, m.added_at
    FROM circle_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.circle_id = ?
    ORDER BY m.added_at DESC
    LIMIT ? OFFSET ?
  `).all(circleId, limit, offset);
}

// Add members, skipping anyone who is not a member of the parent circle —
// a sub-circle is drawn from its parent's membership, not from nowhere.
function addMembers(circleId, userIds, role = 'member') {
  const circle = db.prepare('SELECT * FROM circles WHERE id = ?').get(circleId);
  if (!circle) throw new CircleError('Circle not found');

  const insert = db.prepare(`
    INSERT INTO circle_members (circle_id, user_id, role) VALUES (?, ?, ?)
    ON CONFLICT(circle_id, user_id) DO UPDATE SET role = excluded.role
  `);
  const inParent = db.prepare('SELECT 1 FROM circle_members WHERE circle_id = ? AND user_id = ?');
  const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?');

  const added = [];
  const rejected = [];

  db.transaction(() => {
    for (const userId of userIds) {
      if (!userExists.get(userId)) {
        rejected.push({ user_id: userId, reason: 'No such member' });
        continue;
      }
      if (circle.parent_id && !inParent.get(circle.parent_id, userId)) {
        rejected.push({ user_id: userId, reason: 'Not a member of the parent circle' });
        continue;
      }
      insert.run(circleId, userId, role);
      added.push(userId);
    }
  })();

  return { added: added.length, rejected };
}

function removeMember(circleId, userId) {
  const circle = db.prepare('SELECT * FROM circles WHERE id = ?').get(circleId);
  if (!circle) throw new CircleError('Circle not found');
  if (circle.is_root) {
    throw new CircleError('Members cannot be removed from the root circle — deactivate the account instead');
  }

  return db.prepare('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?')
    .run(circleId, userId).changes;
}

// Removing someone from a parent circle must also remove them from its
// sub-circles, otherwise they keep receiving work they no longer belong to.
function removeFromTree(circleId, userId) {
  const ids = descendants(circleId);
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`DELETE FROM circle_members WHERE user_id = ? AND circle_id IN (${placeholders})`)
    .run(userId, ...ids).changes;
}

// Every new member joins the root circle, whichever door they came through
// (self-registration, landing page, bulk import, or Developer Hub SSO).
function joinRoot(userId) {
  const rootCircle = root();
  if (!rootCircle) return null;
  db.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id) VALUES (?, ?)')
    .run(rootCircle.id, userId);
  return rootCircle.id;
}

function forUser(userId) {
  return db.prepare(`
    SELECT c.id, c.name, c.slug, c.description, c.color, c.is_root, m.role, m.added_at
    FROM circle_members m
    JOIN circles c ON c.id = m.circle_id
    WHERE m.user_id = ? AND c.status = 'active'
    ORDER BY c.is_root DESC, c.name
  `).all(userId);
}

function circleIdsForUser(userId) {
  return db.prepare('SELECT circle_id FROM circle_members WHERE user_id = ?')
    .all(userId).map(r => r.circle_id);
}

function isMember(circleId, userId) {
  return Boolean(db.prepare('SELECT 1 FROM circle_members WHERE circle_id = ? AND user_id = ?')
    .get(circleId, userId));
}

function archive(circleId) {
  const circle = db.prepare('SELECT * FROM circles WHERE id = ?').get(circleId);
  if (!circle) throw new CircleError('Circle not found');
  if (circle.is_root) throw new CircleError('The root circle cannot be archived');

  const children = db.prepare("SELECT COUNT(*) as c FROM circles WHERE parent_id = ? AND status = 'active'")
    .get(circleId).c;
  if (children > 0) {
    throw new CircleError(`Archive the ${children} sub-circle(s) beneath this one first`);
  }

  db.prepare("UPDATE circles SET status = 'archived' WHERE id = ?").run(circleId);
  return circle;
}

// Resolve the circle an admin request is operating in. Defaults to the root
// so every existing endpoint keeps working without a circle_id.
function resolve(circleId) {
  if (!circleId) return root();
  const circle = db.prepare('SELECT * FROM circles WHERE id = ?').get(circleId);
  if (!circle) throw new CircleError('Circle not found');
  return circle;
}

module.exports = {
  root, bySlug, create, withCounts, members, addMembers, removeMember, joinRoot,
  removeFromTree, forUser, circleIdsForUser, isMember, archive, resolve,
  descendants, slugify, CircleError
};
