const db = require('../db');
const { uuid } = require('../utils/helpers');

// ─── Circles ────────────────────────────────────────────────
// A circle is a workspace. Dev Circle is one instance of it, not a container
// the others live inside — creating another circle creates a peer, with its
// own members, cohorts, surveys, sessions, questions and feedback. Nothing
// crosses between them.
//
// This is not the same thing as a cohort. A cohort slices the members *within*
// one circle; a circle is the space those members are in. The two were
// conflated when circles were built as a tree with Dev Circle at the root.
//
// A developer has one account across Credit Direct and may belong to several
// circles. Staff are granted a role within a circle; a small global tier sits
// above all of them and can create circles and move between.

class CircleError extends Error {}

function all({ includeArchived = false } = {}) {
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM circle_members m WHERE m.circle_id = c.id) as member_count,
      (SELECT COUNT(*) FROM cohorts x WHERE x.circle_id = c.id) as cohort_count,
      (SELECT COUNT(*) FROM surveys s WHERE s.circle_id = c.id) as survey_count
    FROM circles c
    ${includeArchived ? '' : "WHERE c.status = 'active'"}
    ORDER BY c.created_at
  `).all();
}

function byId(id) {
  return db.prepare('SELECT * FROM circles WHERE id = ?').get(id);
}

function bySlug(slug) {
  return db.prepare('SELECT * FROM circles WHERE slug = ?').get(slug);
}

// The circle a request falls back to when none was named. Not a "root" — just
// the first one, which in a single-workspace install is the only one.
function fallback() {
  return db.prepare("SELECT * FROM circles WHERE status = 'active' ORDER BY created_at LIMIT 1").get();
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
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

function create({ name, description, color, createdBy }) {
  if (!name || !String(name).trim()) throw new CircleError('name is required');

  const id = uuid();
  db.prepare(`
    INSERT INTO circles (id, name, slug, description, color, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, String(name).trim(), uniqueSlug(name), description || null, color || '#107EBC', createdBy || null);

  return byId(id);
}

// ─── Membership ─────────────────────────────────────────────

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

// A workspace's membership is its own. There is no parent to draw from — that
// rule existed only because circles were modelled as a tree.
function addMembers(circleId, userIds, role = 'member') {
  const circle = byId(circleId);
  if (!circle) throw new CircleError('Circle not found');

  const insert = db.prepare(`
    INSERT INTO circle_members (circle_id, user_id, role) VALUES (?, ?, ?)
    ON CONFLICT(circle_id, user_id) DO UPDATE SET role = excluded.role
  `);
  const exists = db.prepare('SELECT 1 FROM users WHERE id = ?');

  const added = [];
  const rejected = [];

  db.transaction(() => {
    for (const userId of userIds) {
      if (!exists.get(userId)) {
        rejected.push({ user_id: userId, reason: 'No such member' });
        continue;
      }
      insert.run(circleId, userId, role);
      added.push(userId);
    }
  })();

  return { added: added.length, rejected };
}

function removeMember(circleId, userId) {
  return db.prepare('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?')
    .run(circleId, userId).changes;
}

// Whichever circle a member arrives through, they join it. Registration and
// SSO both land in the circle the request was made against.
function join(userId, circleId) {
  const circle = circleId ? byId(circleId) : fallback();
  if (!circle) return null;

  db.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id) VALUES (?, ?)')
    .run(circle.id, userId);
  return circle.id;
}

function forUser(userId) {
  return db.prepare(`
    SELECT c.id, c.name, c.slug, c.description, c.color, m.role, m.added_at
    FROM circle_members m
    JOIN circles c ON c.id = m.circle_id
    WHERE m.user_id = ? AND c.status = 'active'
    ORDER BY c.created_at
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

// ─── Staff access ───────────────────────────────────────────

// Which circles a staff member may work in, and with what role in each.
// A global admin is not listed against circles — they reach all of them.
function forAdmin(admin) {
  if (admin.is_global) {
    return all().map(c => ({ ...c, role_id: admin.role_id, global: true }));
  }

  return db.prepare(`
    SELECT c.*, ca.role_id, 0 as global
    FROM circle_admins ca
    JOIN circles c ON c.id = ca.circle_id
    WHERE ca.admin_id = ? AND c.status = 'active'
    ORDER BY c.created_at
  `).all(admin.id);
}

// The role this staff member holds *in this circle*. Permissions are unchanged;
// what is new is that they apply somewhere rather than everywhere.
function roleFor(admin, circleId) {
  if (admin.is_global) return admin.role_id;

  const grant = db.prepare('SELECT role_id FROM circle_admins WHERE admin_id = ? AND circle_id = ?')
    .get(admin.id, circleId);
  return grant ? grant.role_id : null;
}

function canAdminister(admin, circleId) {
  return Boolean(admin.is_global) || Boolean(roleFor(admin, circleId));
}

function grantAdmin(circleId, adminId, roleId) {
  if (!byId(circleId)) throw new CircleError('Circle not found');
  db.prepare(`
    INSERT INTO circle_admins (circle_id, admin_id, role_id) VALUES (?, ?, ?)
    ON CONFLICT(circle_id, admin_id) DO UPDATE SET role_id = excluded.role_id
  `).run(circleId, adminId, roleId);
}

function revokeAdmin(circleId, adminId) {
  return db.prepare('DELETE FROM circle_admins WHERE circle_id = ? AND admin_id = ?')
    .run(circleId, adminId).changes;
}

function archive(circleId) {
  const circle = byId(circleId);
  if (!circle) throw new CircleError('Circle not found');

  const remaining = db.prepare("SELECT COUNT(*) as c FROM circles WHERE status = 'active'").get().c;
  if (remaining <= 1) {
    throw new CircleError('This is the only active circle — archiving it would leave nowhere to work');
  }

  db.prepare("UPDATE circles SET status = 'archived' WHERE id = ?").run(circleId);
  return circle;
}

module.exports = {
  all, byId, bySlug, fallback, create, slugify,
  members, addMembers, removeMember, join, forUser, circleIdsForUser, isMember,
  forAdmin, roleFor, canAdminister, grantAdmin, revokeAdmin,
  archive, CircleError
};
