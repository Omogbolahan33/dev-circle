const express = require('express');
const db = require('../../db');
const { uuid, parseJSON } = require('../../utils/helpers');
const {
  requirePermission, generateApiKey, hashApiKey
} = require('../../middleware/auth');

const router = express.Router();

// ─── Integrations ───────────────────────────────────────────

// GET /api/admin/integration-events
router.get('/integration-events', requirePermission('integrations.read'), (req, res) => {
  const { source, processed, limit = 50 } = req.query;
  const where = ['1=1'];
  const params = [];

  if (source) { where.push('source = ?'); params.push(source); }
  if (processed !== undefined && processed !== '') {
    where.push('processed = ?'); params.push(parseInt(processed, 10));
  }

  const events = db.prepare(`
    SELECT * FROM integration_events
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params, Math.min(200, parseInt(limit, 10) || 50));

  res.json({ events });
});

// GET /api/admin/api-keys
router.get('/api-keys', requirePermission('integrations.write'), (req, res) => {
  const keys = db.prepare(`
    SELECT id, name, prefix, permissions, last_used_at, expires_at, revoked_at, created_at
    FROM api_keys ORDER BY created_at DESC
  `).all();
  res.json({ keys: keys.map(k => ({ ...k, permissions: parseJSON(k.permissions, []) })) });
});

// POST /api/admin/api-keys — issue a key for an integration
router.post('/api-keys', requirePermission('integrations.write'), (req, res) => {
  const { name, scopes, expires_at } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const VALID_SCOPES = ['landing_page', 'customer_io', 'feex', 'events', '*'];
  const granted = Array.isArray(scopes) && scopes.length ? scopes : ['events'];
  const invalid = granted.filter(s => !VALID_SCOPES.includes(s));
  if (invalid.length) {
    return res.status(400).json({ error: `Unknown scope(s): ${invalid.join(', ')}`, valid: VALID_SCOPES });
  }

  const { key, prefix } = generateApiKey();

  db.prepare(`
    INSERT INTO api_keys (id, key_hash, name, prefix, permissions, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuid(), hashApiKey(key), name, prefix, JSON.stringify(granted), expires_at || null, req.admin.id);

  // The plaintext key is shown exactly once — only its hash is stored
  res.status(201).json({
    key,
    prefix,
    scopes: granted,
    warning: 'Copy this key now. It cannot be retrieved again.'
  });
});

// DELETE /api/admin/api-keys/:id
router.delete('/api-keys/:id', requirePermission('integrations.write'), (req, res) => {
  const result = db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
    .run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Key not found or already revoked' });
  res.json({ message: 'Key revoked' });
});

module.exports = router;
