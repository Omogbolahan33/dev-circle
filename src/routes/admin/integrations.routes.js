const express = require('express');
const db = require('../../db');
const { parseJSON } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');

const router = express.Router();

// ─── Integrations ───────────────────────────────────────────
// What the connected systems have sent us. The keys they authenticate with
// moved to credentials.routes.js: watching the events an integration produces
// and holding the credential that produces them are different jobs, and now
// different permissions.

// GET /api/admin/integration-events
router.get('/integration-events', requirePermission('integrations.read'), async (req, res) => {
  const { source, processed, limit = 50 } = req.query;
  const where = ['1=1'];
  const params = [];

  if (source) { where.push('source = ?'); params.push(source); }
  if (processed !== undefined && processed !== '') {
    where.push('processed = ?'); params.push(parseInt(processed, 10));
  }

  const events = await db.prepare(`
    SELECT * FROM integration_events
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params, Math.min(200, parseInt(limit, 10) || 50));

  res.json({ events });
});

module.exports = router;
