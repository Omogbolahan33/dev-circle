const express = require('express');
const { requirePermission } = require('../../middleware/auth');
const { spec } = require('../../docs/openapi');

const router = express.Router();

// ─── API reference ──────────────────────────────────────────
// The specification behind /admin/api-docs.html. It documents every endpoint
// including the ones a given role cannot call, and names the permission each
// is gated on — a map of the whole admin surface — so reading it is itself a
// permission rather than something any signed-in colleague can do.

// GET /api/admin/docs/openapi.json
router.get('/openapi.json', requirePermission('docs.read'), (req, res) => {
  // Served as a download-friendly document: a developer given this file has
  // the entire API, examples included, with nothing else to fetch.
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="devcircle-openapi.json"');
  res.send(JSON.stringify(spec(), null, 2));
});

module.exports = router;
