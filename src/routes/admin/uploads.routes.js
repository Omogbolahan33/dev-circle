const express = require('express');
const { requirePermission } = require('../../middleware/auth');
const uploads = require('../../services/uploads');

const router = express.Router();

// ─── Brand assets ───────────────────────────────────────────
// Uploading the images and fonts a survey is themed with. Gated on the same
// permission as writing a survey: an asset is only ever reachable from a
// theme, so being able to upload one and being able to use it are the same
// ability.

// POST /api/admin/uploads
router.post('/uploads', requirePermission('surveys.write'), (req, res) => {
  const { file, kind = 'image' } = req.body;

  if (!['image', 'font'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be image or font' });
  }

  try {
    const stored = uploads.store(file, { kind, by: req.admin.id });
    res.status(201).json({ asset: stored });
  } catch (err) {
    if (err instanceof uploads.UploadError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
});

module.exports = router;
