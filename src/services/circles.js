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

async function all({ includeArchived = false } = {}) {
  return await db.prepare(`
    SELECT c.*,
      COALESCE(mc.n, 0) as member_count,
      COALESCE(cc.n, 0) as cohort_count,
      COALESCE(sc.n, 0) as survey_count
    FROM circles c
    LEFT JOIN (SELECT circle_id, COUNT(*) as n FROM circle_members GROUP BY circle_id) mc
      ON mc.circle_id = c.id
    LEFT JOIN (SELECT circle_id, COUNT(*) as n FROM cohorts GROUP BY circle_id) cc
      ON cc.circle_id = c.id
    LEFT JOIN (SELECT circle_id, COUNT(*) as n FROM surveys GROUP BY circle_id) sc
      ON sc.circle_id = c.id
    ${includeArchived ? '' : "WHERE c.status = 'active'"}
    ORDER BY c.created_at
  `).all();
}

async function byId(id) {
  return await db.prepare('SELECT * FROM circles WHERE id = ?').get(id);
}

async function bySlug(slug) {
  return await db.prepare('SELECT * FROM circles WHERE slug = ?').get(slug);
}

// The circle a request falls back to when none was named. Not a "root" — just
// the first one, which in a single-workspace install is the only one.
async function fallback() {
  return await db.prepare("SELECT * FROM circles WHERE status = 'active' ORDER BY created_at LIMIT 1").get();
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

async function uniqueSlug(name) {
  const base = slugify(name) || 'circle';
  let candidate = base;
  let n = 2;
  while (await db.prepare('SELECT 1 FROM circles WHERE slug = ?').get(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

async function create({ name, description, color, createdBy }) {
  if (!name || !String(name).trim()) throw new CircleError('name is required');

  const id = uuid();
  await db.prepare(`
    INSERT INTO circles (id, name, slug, description, color, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, String(name).trim(), await uniqueSlug(name), description || null, color || '#107EBC', createdBy || null);

  return byId(id);
}

// ─── Membership ─────────────────────────────────────────────

async function members(circleId, { limit = 100, offset = 0 } = {}) {
  return await db.prepare(`
    SELECT u.id, u.name, u.email, u.company, u.work_sector, u.api_status,
           u.engagement_streak, m.role, m.added_at,
           COUNT(*) OVER() as _total
    FROM circle_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.circle_id = ?
    ORDER BY m.added_at DESC
    LIMIT ? OFFSET ?
  `).all(circleId, limit, offset);
}

// A workspace's membership is its own. There is no parent to draw from — that
// rule existed only because circles were modelled as a tree.
async function addMembers(circleId, userIds, role = 'member') {
  const circle = await byId(circleId);
  if (!circle) throw new CircleError('Circle not found');

  const insert = db.prepare(`
    INSERT INTO circle_members (circle_id, user_id, role) VALUES (?, ?, ?)
    ON CONFLICT(circle_id, user_id) DO UPDATE SET role = excluded.role
  `);
  const exists = db.prepare('SELECT 1 FROM users WHERE id = ?');

  const added = [];
  const rejected = [];

  for (const userId of userIds) {
    if (!await exists.get(userId)) {
      rejected.push({ user_id: userId, reason: 'No such member' });
      continue;
    }
    await insert.run(circleId, userId, role);
    added.push(userId);
  }

  return { added: added.length, rejected };
}

async function removeMember(circleId, userId) {
  return Number((await db.prepare('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?')
    .run(circleId, userId))?.changes || 0);
}

// Whichever circle a member arrives through, they join it. Registration and
// SSO both land in the circle the request was made against.
async function join(userId, circleId) {
  const circle = circleId ? await byId(circleId) : await fallback();
  if (!circle) return null;

  await db.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id) VALUES (?, ?)')
    .run(circle.id, userId);
  return circle.id;
}

async function forUser(userId) {
  return await db.prepare(`
    SELECT c.id, c.name, c.slug, c.description, c.color, c.theme, m.role, m.added_at
    FROM circle_members m
    JOIN circles c ON c.id = m.circle_id
    WHERE m.user_id = ? AND c.status = 'active'
    ORDER BY c.created_at
  `).all(userId);
}

async function circleIdsForUser(userId) {
  return ((await db.prepare('SELECT circle_id FROM circle_members WHERE user_id = ?')
    .all(userId)) || []).map(r => r.circle_id);
}

async function isMember(circleId, userId) {
  return Boolean(await db.prepare('SELECT 1 FROM circle_members WHERE circle_id = ? AND user_id = ?')
    .get(circleId, userId));
}

// ─── Staff access ───────────────────────────────────────────

// Which circles a staff member may work in, and with what role in each.
// A global admin is not listed against circles — they reach all of them.
async function forAdmin(admin) {
  // Access control does not count members. A GROUP BY of circle_members on
  // every request is the plan that gets worse as the base grows; the switcher
  // loads counts on GET /admin/circles instead.
  if (admin.is_global) {
    const rows = await db.prepare(`
      SELECT c.id, c.name, c.slug, c.description, c.color, c.status, c.survey_theme, c.theme, c.created_at
      FROM circles c
      WHERE c.status = 'active'
      ORDER BY c.created_at
    `).all();
    return (rows || []).map(c => ({ ...c, role_id: admin.role_id, global: true }));
  }

  return await db.prepare(`
    SELECT c.id, c.name, c.slug, c.description, c.color, c.status, c.survey_theme, c.theme, c.created_at,
           ca.role_id, 0 as global, r.permissions as role_permissions
    FROM circle_admins ca
    JOIN circles c ON c.id = ca.circle_id
    LEFT JOIN roles r ON r.id = ca.role_id
    WHERE ca.admin_id = ? AND c.status = 'active'
    ORDER BY c.created_at
  `).all(admin.id);
}

// The role this staff member holds *in this circle*. Permissions are unchanged;
// what is new is that they apply somewhere rather than everywhere.
async function roleFor(admin, circleId) {
  if (admin.is_global) return admin.role_id;

  const grant = await db.prepare('SELECT role_id FROM circle_admins WHERE admin_id = ? AND circle_id = ?')
    .get(admin.id, circleId);
  return grant ? grant.role_id : null;
}

async function canAdminister(admin, circleId) {
  if (admin.is_global) return true;
  return Boolean(await roleFor(admin, circleId));
}

async function grantAdmin(circleId, adminId, roleId) {
  if (!await byId(circleId)) throw new CircleError('Circle not found');
  await db.prepare(`
    INSERT INTO circle_admins (circle_id, admin_id, role_id) VALUES (?, ?, ?)
    ON CONFLICT(circle_id, admin_id) DO UPDATE SET role_id = excluded.role_id
  `).run(circleId, adminId, roleId);
}

async function revokeAdmin(circleId, adminId) {
  return Number((await db.prepare('DELETE FROM circle_admins WHERE circle_id = ? AND admin_id = ?')
    .run(circleId, adminId))?.changes || 0);
}

async function archive(circleId) {
  const circle = await byId(circleId);
  if (!circle) throw new CircleError('Circle not found');

  const remaining = Number((await db.prepare("SELECT COUNT(*) as c FROM circles WHERE status = 'active'").get())?.c || 0);
  if (remaining <= 1) {
    throw new CircleError('This is the only active circle — archiving it would leave nowhere to work');
  }

  await db.prepare("UPDATE circles SET status = 'archived' WHERE id = ?").run(circleId);
  return circle;
}

// ─── Branding ───────────────────────────────────────────────
// A circle's theme is the look of the whole workspace for everyone in it —
// admins, members and participants. It is stored exactly like a survey theme
// and validated through the same shared definition, so the legibility rules
// (refuse an unreadable contrast, no stylesheet ever enters the database)
// hold here too. null clears it back to product defaults.

const themes = require('./surveyForm').themes;

// The brand everyone in a circle experiences. Falls back to the circle's
// survey default (itself normalised below), then to product defaults.
function brandOf(circle) {
  if (!circle) return null;
  const parse = raw => {
    if (!raw) return null;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };
  const explicit = parse(circle.theme);
  if (explicit && Object.keys(explicit).length) {
    const { theme } = themes.normalize(explicit);
    return { ...theme, _source: 'circle' };
  }
  const surveyDefault = parse(circle.survey_theme);
  if (surveyDefault && Object.keys(surveyDefault).length) {
    const { theme } = themes.normalize(surveyDefault);
    return { ...theme, _source: 'survey_default' };
  }
  return null;
}

// Validate and persist a posted brand. Passing null (or {}) clears it.
// Returns the normalised theme plus any legibility warnings; `issues` being
// non-empty means nothing was saved.
async function setBrand(circleId, input) {
  const circle = await byId(circleId);
  if (!circle) throw new CircleError('Circle not found');

  if (input === null || input === undefined || (typeof input === 'object' && !Object.keys(input).length)) {
    await db.prepare('UPDATE circles SET theme = NULL WHERE id = ?').run(circleId);
    return { theme: null, issues: [], warnings: [] };
  }

  const { theme, issues, warnings } = themes.normalize(typeof input === 'string' ? input : input);
  if (issues.length) {
    const err = new CircleError(issues.map(i => i.message).join('; '));
    err.issues = issues;
    err.warnings = warnings;
    throw err;
  }

  await db.prepare('UPDATE circles SET theme = ? WHERE id = ?').run(JSON.stringify(theme), circleId);
  return { theme, issues, warnings };
}

module.exports = {
  all, byId, bySlug, fallback, create, slugify,
  members, addMembers, removeMember, join, forUser, circleIdsForUser, isMember,
  forAdmin, roleFor, canAdminister, grantAdmin, revokeAdmin,
  archive, brandOf, setBrand, CircleError
};
