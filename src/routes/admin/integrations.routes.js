const express = require('express');
const db = require('../../db');
const { parseJSON, paginate, pageMeta } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');

const router = express.Router();

// ─── Integrations ───────────────────────────────────────────
// What the connected systems have sent us. The keys they authenticate with
// moved to credentials.routes.js: watching the events an integration produces
// and holding the credential that produces them are different jobs, and now
// different permissions.

// One page of the event log, and the one definition of it. This query is run
// twice per request — once eagerly by the preload in index.js while the
// session JOIN is still in flight, and once by the route if that preload was
// skipped — so the two reading it differently is a bug waiting to happen, and
// was one: the preload and the route each clamped `limit` on their own.
//
// The log is the fastest-growing table in the product and nothing prunes it,
// so of everything here this is the list that most needed a second page.
async function eventPage(req) {
  const { source, processed } = req.query;
  const { offset, limit, page } = paginate(req.query.page, req.query.limit || 50, { max: 200 });

  const where = ['1=1'];
  const params = [];
  if (source) { where.push('source = ?'); params.push(source); }
  if (processed !== undefined && processed !== '') {
    where.push('processed = ?'); params.push(parseInt(processed, 10));
  }
  const filter = where.join(' AND ');

  const [events, totalRow] = await Promise.all([
    db.prepare(`
      SELECT id, source, event_type, payload, processed, created_at, error
      FROM integration_events
      WHERE ${filter}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset),
    db.prepare(`SELECT COUNT(*) as c FROM integration_events WHERE ${filter}`).get(...params)
  ]);

  return {
    events: events || [],
    pagination: pageMeta({ page, limit, total: Number(totalRow?.c || 0) })
  };
}

// GET /api/admin/integration-events
router.get('/integration-events', requirePermission('integrations.read'), async (req, res) => {
  const { takePreload } = require('../../middleware/preload');
  res.json(await takePreload(req, () => eventPage(req)));
});

module.exports = router;
module.exports.eventPage = eventPage;
