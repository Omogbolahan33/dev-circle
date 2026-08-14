const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../db');
const { uuid, parseJSON } = require('../../utils/helpers');
const { requirePermission, destroyAllSessionsFor, PERMISSIONS } = require('../../middleware/auth');

const router = express.Router();

// ─── Roles, Permissions & Admin Users ───────────────────────

// GET /api/admin/permissions — the catalogue the roles UI builds from
router.get('/permissions', requirePermission('roles.read'), (req, res) => {
  const grouped = {};
  for (const p of PERMISSIONS) {
    (grouped[p.group] = grouped[p.group] || []).push(p);
  }
  res.json({ permissions: PERMISSIONS, grouped });
});

// GET /api/admin/roles
router.get('/roles', requirePermission('roles.read'), (req, res) => {
  const roles = db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM admin_users a WHERE a.role_id = r.id) as admin_count
    FROM roles r ORDER BY r.is_system DESC, r.created_at DESC
  `).all();
  res.json({ roles: roles.map(r => ({ ...r, permissions: parseJSON(r.permissions, []) })) });
});

function validatePermissions(permissions) {
  if (!Array.isArray(permissions)) return 'permissions must be an array';
  const known = new Set(PERMISSIONS.map(p => p.key));
  const unknown = permissions.filter(p => p !== '*' && !known.has(p));
  if (unknown.length) return `Unknown permission(s): ${unknown.join(', ')}`;
  return null;
}

// POST /api/admin/roles
router.post('/roles', requirePermission('roles.write'), (req, res) => {
  const { name, description, permissions } = req.body;
  if (!name || !permissions) return res.status(400).json({ error: 'name and permissions required' });

  const invalid = validatePermissions(permissions);
  if (invalid) return res.status(400).json({ error: invalid });

  if (db.prepare('SELECT id FROM roles WHERE name = ?').get(name)) {
    return res.status(409).json({ error: 'A role with that name already exists' });
  }

  const id = uuid();
  db.prepare('INSERT INTO roles (id, name, description, permissions) VALUES (?, ?, ?, ?)')
    .run(id, name, description || null, JSON.stringify(permissions));

  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  res.status(201).json({ role: { ...role, permissions: parseJSON(role.permissions, []) } });
});

// PUT /api/admin/roles/:id
router.put('/roles/:id', requirePermission('roles.write'), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system) return res.status(400).json({ error: 'System roles cannot be edited' });

  const { name, description, permissions } = req.body;
  const updates = [];
  const params = [];

  if (name) { updates.push('name = ?'); params.push(name); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (permissions) {
    const invalid = validatePermissions(permissions);
    if (invalid) return res.status(400).json({ error: invalid });
    updates.push('permissions = ?'); params.push(JSON.stringify(permissions));
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  params.push(role.id);
  db.prepare(`UPDATE roles SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM roles WHERE id = ?').get(role.id);
  res.json({ role: { ...updated, permissions: parseJSON(updated.permissions, []) } });
});

// DELETE /api/admin/roles/:id
router.delete('/roles/:id', requirePermission('roles.write'), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system) return res.status(400).json({ error: 'System roles cannot be deleted' });

  const inUse = db.prepare('SELECT COUNT(*) as c FROM admin_users WHERE role_id = ?').get(role.id).c;
  if (inUse > 0) {
    return res.status(409).json({ error: `${inUse} admin user(s) still have this role. Reassign them first.` });
  }

  db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  res.json({ message: 'Role deleted' });
});

// GET /api/admin/admins
router.get('/admins', requirePermission('roles.read'), (req, res) => {
  const admins = db.prepare(`
    SELECT a.id, a.email, a.name, a.status, a.created_at, a.role_id, r.name as role_name
    FROM admin_users a LEFT JOIN roles r ON r.id = a.role_id
    ORDER BY a.created_at DESC
  `).all();
  res.json({ admins });
});

// POST /api/admin/admins — create an internal user and assign a role
router.post('/admins', requirePermission('roles.write'), (req, res) => {
  const { email, name, password, role_id } = req.body;
  if (!email || !name || !password || !role_id) {
    return res.status(400).json({ error: 'email, name, password, and role_id are required' });
  }
  if (String(password).length < 10) {
    return res.status(400).json({ error: 'Admin passwords must be at least 10 characters' });
  }
  if (!db.prepare('SELECT id FROM roles WHERE id = ?').get(role_id)) {
    return res.status(400).json({ error: 'Unknown role_id' });
  }
  if (db.prepare('SELECT id FROM admin_users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An admin with that email already exists' });
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO admin_users (id, email, name, password_hash, role_id) VALUES (?, ?, ?, ?, ?)
  `).run(id, email, name, bcrypt.hashSync(password, 10), role_id);

  const admin = db.prepare('SELECT id, email, name, status, role_id, created_at FROM admin_users WHERE id = ?').get(id);
  res.status(201).json({ admin });
});

// PUT /api/admin/admins/:id — change role or status
router.put('/admins/:id', requirePermission('roles.write'), (req, res) => {
  const target = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Admin not found' });

  const { role_id, status } = req.body;

  // Guard against an admin removing their own access and locking the team out
  if (target.id === req.admin.id && status && status !== 'active') {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }

  const updates = [];
  const params = [];

  if (role_id) {
    if (!db.prepare('SELECT id FROM roles WHERE id = ?').get(role_id)) {
      return res.status(400).json({ error: 'Unknown role_id' });
    }
    updates.push('role_id = ?'); params.push(role_id);
  }
  if (status) {
    if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    updates.push('status = ?'); params.push(status);
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  params.push(target.id);
  db.prepare(`UPDATE admin_users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // A role or status change must take effect immediately, not at token expiry
  destroyAllSessionsFor(target.id);

  const updated = db.prepare('SELECT id, email, name, status, role_id FROM admin_users WHERE id = ?').get(target.id);
  res.json({ admin: updated, message: 'Updated. The admin will need to sign in again.' });
});

module.exports = router;
