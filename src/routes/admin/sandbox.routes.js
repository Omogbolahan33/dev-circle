const express = require('express');
const config = require('../../config');
const { requirePermission } = require('../../middleware/auth');
const dbContext = require('../../db/context');
const sandbox = require('../../db/sandbox');

const router = express.Router();

// ─── Sandbox control ────────────────────────────────────────
// These two are deliberately the only endpoints in the product that reach past
// the request's own database. A reset sent *from* the sandbox still rebuilds
// the sandbox, which is what somebody clicking "reset" from inside it means.

// GET /api/admin/sandbox
router.get('/', requirePermission('sandbox.use'), (req, res) => {
  res.json({
    ...sandbox.status(),
    // Whether this very request was served from it, so a client never has to
    // infer which data it is looking at
    active: dbContext.inSandbox()
  });
});

// POST /api/admin/sandbox/reset
router.post('/reset', requirePermission('sandbox.use'), (req, res) => {
  if (!config.sandbox.enabled) {
    return res.status(503).json({ error: 'The API sandbox is switched off in this environment' });
  }

  const status = sandbox.reset();

  res.json({
    message: 'Sandbox rebuilt from demo data. Anything created in it is gone.',
    ...status,
    active: dbContext.inSandbox()
  });
});

module.exports = router;
