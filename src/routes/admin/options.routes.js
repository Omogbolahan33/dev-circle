const express = require('express');
const { requirePermission } = require('../../middleware/auth');
const vocabularies = require('../../services/vocabularies');
const onboarding = require('../../services/onboarding');

const router = express.Router();

// ─── The answers with a fixed set ───────────────────────────
// The states, the sectors, the genders, the product families — the lists a
// question offers when its answer is one of a known few.
//
// They ship with a default and a circle may replace it. That is the whole of
// this file: everything else about them lives in services/vocabularies.js, and
// the reason they are a table rather than a constant is written on migration
// 32 — a sector list that needs a deploy to add a row is a list that stops
// being true.
//
// Gated on the onboarding permissions rather than a key of their own. Curating
// what a form may ask is the same job as authoring the form, and adding a
// permission would mean every existing role silently losing the ability until
// somebody granted it. If these ever grow past onboarding — they already reach
// the member's own profile — that is the moment to split them out.

// GET /api/admin/options
// Every field that has a list, what this circle asks, and what ships.
router.get('/options', requirePermission('onboarding.read'), async (req, res) => {
  const catalogue = await vocabularies.catalogue(req.circleId);

  res.json({
    fields: catalogue.map(entry => ({
      ...entry,
      // The label the builder and the profile already call it by, so this
      // screen and the form builder name the same thing the same way.
      label: onboarding.FIELDS[entry.field]?.label || entry.field,
      hint: onboarding.FIELDS[entry.field]?.hint || null
    }))
  });
});

// PUT /api/admin/options/:field
// Replace the list for this circle. The whole list, not a patch: reordering
// and removing are as much of an edit as adding, and a list is short enough
// that sending all of it is simpler than describing the change to it.
router.put('/options/:field', requirePermission('onboarding.write'), async (req, res) => {
  const result = await vocabularies.setList(
    req.params.field, req.circleId, req.body.options, req.admin.id
  );
  if (result.error) return res.status(400).json({ error: result.error });

  res.json({ field: req.params.field, options: result.options, customised: true });
});

// DELETE /api/admin/options/:field
// Back to the list that ships.
router.delete('/options/:field', requirePermission('onboarding.write'), async (req, res) => {
  const result = await vocabularies.resetList(req.params.field, req.circleId);
  if (result.error) return res.status(400).json({ error: result.error });

  res.json({ field: req.params.field, options: result.options, customised: false });
});

module.exports = router;
