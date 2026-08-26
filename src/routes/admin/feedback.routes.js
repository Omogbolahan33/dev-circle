const express = require('express');
const db = require('../../db');
const { requirePermission } = require('../../middleware/auth');
const engagement = require('../../services/engagement');
const { toCSV } = require('../../utils/helpers');
const { buildXLSX } = require('../../utils/xlsx');
const views = require('../../services/feedbackViews');

// Every read is bounded by the circle being worked in
const scoped = req => ({ ...req.query, circle_id: req.circleId });

const router = express.Router();

// ─── Feedback (Admin view) ──────────────────────────────────

// GET /api/admin/feedback
router.get('/feedback', requirePermission('feedback.read'), async (req, res) => {
  const { status, source, type, prompted, limit = 50 } = req.query;
  const where = ['(f.circle_id = ? OR f.circle_id IS NULL)'];
  const params = [req.circleId];

  if (status) { where.push('f.status = ?'); params.push(status); }
  if (source) { where.push('f.source = ?'); params.push(source); }
  if (type) { where.push('f.type = ?'); params.push(type); }

  // Two kinds of evidence with different natural shapes. Answers to questions
  // we asked are comparable to each other and read best grouped by question.
  // What a developer raised unprompted has no question behind it, so arrival
  // order is genuinely the right way to read it.
  if (prompted === 'false') where.push('f.canonical_question_id IS NULL');
  if (prompted === 'true') where.push('f.canonical_question_id IS NOT NULL');

  const [feedback, bySource] = await Promise.all([
    db.prepare(`
      SELECT f.id, f.user_id, f.type, f.content, f.category, f.status, f.source,
             f.survey_id, f.canonical_question_id, f.prompt, f.created_at,
             f.external_ticket_id, f.circle_id,
             u.name as user_name, u.email as user_email, u.company as user_company,
             s.title as survey_title
      FROM feedback f
      LEFT JOIN users u ON u.id = f.user_id
      LEFT JOIN surveys s ON s.id = f.survey_id
      WHERE ${where.join(' AND ')}
      ORDER BY f.created_at DESC
      LIMIT ?
    `).all(...params, Math.min(200, parseInt(limit, 10) || 50)),
    // What the sources add up to, so the filter chips can carry counts and an
    // empty result is distinguishable from a source that has never had anything
    db.prepare(`
      SELECT source, COUNT(*) as count FROM feedback
      WHERE circle_id = ? OR circle_id IS NULL
      GROUP BY source
    `).all(req.circleId)
  ]);

  res.json({ feedback: feedback || [], sources: bySource || [] });
});

// ─── Views ──────────────────────────────────────────────────

// GET /api/admin/feedback/axes — the ways this can be cut up
router.get('/feedback/axes', requirePermission('feedback.read'), async (req, res) => {
  res.json({ axes: views.axes() });
});

// GET /api/admin/feedback/grouped?group_by=question|developer|survey|source|…
// Groups first, verbatims on drill-in. Filters and grouping compose, so
// "what did the Lending cohort say about onboarding, by developer" is one call.
router.get('/feedback/grouped', requirePermission('feedback.read'), async (req, res) => {
  const { takePreload } = require('../../middleware/preload');
  const axis = req.query.group_by || 'question';
  const query = scoped(req);
  const preloaded = await takePreload(req, () => null);
  const [groups, totals] = preloaded
    ? [preloaded.groups, preloaded.totals]
    : await Promise.all([
      views.group(axis, query),
      views.summarise(query)
    ]);

  if (!groups) {
    return res.status(400).json({
      error: `Unknown grouping "${axis}"`,
      available: views.axes().map(a => a.key)
    });
  }

  res.json({
    group_by: axis,
    axis: views.axes().find(a => a.key === axis),
    groups,
    totals
  });
});

// GET /api/admin/feedback/items — the verbatims themselves, however filtered
router.get('/feedback/items', requirePermission('feedback.read'), async (req, res) => {
  const query = scoped(req);
  const [items, totals] = await Promise.all([
    views.items(query, { limit: Math.min(500, parseInt(query.limit, 10) || 200) }),
    views.summarise(query)
  ]);
  res.json({ items, totals });
});

// ─── Export ─────────────────────────────────────────────────
// Verbatims are what a discovery round is for, so they have to leave the
// system as readily as member records do — and carry enough with them to stay
// meaningful once they are in a spreadsheet.

const FEEDBACK_COLUMNS = [
  'said_at', 'developer', 'email', 'company', 'work_sector', 'api_status',
  'source', 'came_from', 'question', 'answer', 'category', 'status', 'ticket'
];

// The export reads through the same view service the screen does, so a file
// can never contain a different set of rows than the screen that asked for it.
async function selectFeedback(query) {
  return (await views.items(query, { limit: 10000 })).map(row => ({
    said_at: row.created_at,
    developer: row.developer,
    email: row.email,
    company: row.company,
    work_sector: row.work_sector,
    api_status: row.api_status,
    source: row.source,
    came_from: row.came_from,
    question: row.question,
    answer: row.content,
    category: row.category,
    status: row.status,
    ticket: row.external_ticket_id
  }));
}

// GET /api/admin/feedback/export?format=csv|xlsx|json
router.get('/feedback/export', requirePermission('export.read'), async (req, res) => {
  const format = (req.query.format || 'csv').toLowerCase();
  const rows = await selectFeedback(scoped(req));

  const stamp = new Date().toISOString().slice(0, 10);
  const name = `devcircle-feedback-${stamp}`;

  if (format === 'json') {
    return res.json({ feedback: rows, total: rows.length, columns: FEEDBACK_COLUMNS });
  }

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    // The formula guard stays on: every one of these values was typed by a
    // developer, which is exactly the case it exists for
    return res.send('\ufeff' + toCSV(FEEDBACK_COLUMNS, rows));
  }

  if (format === 'xlsx') {
    const header = FEEDBACK_COLUMNS;
    const asRows = list => [header, ...list.map(r => header.map(c => r[c]))];

    // Grouping carries into the workbook as sheets, because the reason to
    // group on screen — reading one question's answers side by side — is the
    // same reason to want them on their own tab.
    const axis = req.query.group_by;
    if (axis && views.axes().some(a => a.key === axis)) {
      const groups = await views.group(axis, scoped(req)) || [];
      const filterKey = views.axes().find(a => a.key === axis).filter;

      const sheets = [];
      for (const g of groups.slice(0, 40)) {
        sheets.push({
          name: String(g.label || 'Unlabelled').slice(0, 31),
          rows: asRows(await selectFeedback({ ...scoped(req), [filterKey]: g.key }))
        });
      }

      // A contents tab first, so a 20-sheet workbook is navigable
      sheets.unshift({
        name: 'Overview',
        rows: [
          [views.axes().find(a => a.key === axis).label, 'Developers', 'Answers', 'Last heard'],
          ...groups.map(g => [g.label, g.developer_count, g.answer_count, g.last_at])
        ]
      });

      res.setHeader('Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${name}-by-${axis}.xlsx"`);
      return res.send(buildXLSX(sheets));
    }

    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    return res.send(buildXLSX([{ name: 'Feedback', rows: asRows(rows) }]));
  }

  res.status(400).json({ error: 'format must be csv, xlsx, or json' });
});

// GET /api/admin/feedback/export/count — size it before downloading
router.get('/feedback/export/count', requirePermission('export.read'), async (req, res) => {
  // The screen already has summarise(); pulling every verbatim just to count
  // it is the plan that gets worse as the evidence base grows.
  const totals = await views.summarise(scoped(req));
  res.json({
    total: Number(totals?.answers || 0),
    developers: Number(totals?.developers || 0),
    questions: Number(totals?.questions || 0)
  });
});

// PUT /api/admin/feedback/:id
// This marks how far the engagement team has got through *reading* feedback.
// It is triage state, not ticket resolution — Dev Circle collects information,
// it does not resolve issues.
router.put('/feedback/:id', requirePermission('feedback.write'), async (req, res) => {
  const { status, note } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  if (!['open', 'reviewed', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const fb = await db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  if (!fb) return res.status(404).json({ error: 'Feedback not found' });

  // A Feex complaint's state belongs to Feex. Dev Circle mirrors it through
  // the webhook and must not let an admin edit it here, or the two systems
  // would disagree about a ticket Feex owns.
  // A survey answer is a record of what a member said at a point in time.
  // There is no workflow to advance on it, and marking it "resolved" would
  // imply Dev Circle acts on feedback, which it does not.
  if (fb.source === 'survey') {
    return res.status(409).json({
      error: 'This is a survey answer — a record of what the member said, not an item to work through.',
      survey_id: fb.survey_id,
      prompt: fb.prompt
    });
  }

  if (fb.source === 'feex') {
    return res.status(409).json({
      error: 'This complaint is owned by Feex. Update it there — Dev Circle mirrors its status for engagement tracking only.',
      ticket_id: fb.external_ticket_id,
      feex_status: fb.feex_status,
      feex_url: fb.feex_url
    });
  }

  await db.prepare(`
    UPDATE feedback
    SET status = ?, resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') ELSE NULL END
    WHERE id = ?
  `).run(status, status, fb.id);

  if (note) {
    engagement.log(fb.user_id, 'feedback_submitted', {
      referenceId: fb.id,
      metadata: { triage_note: note, status },
      source: 'manual'
    });
  }

  res.json({ feedback: await db.prepare('SELECT * FROM feedback WHERE id = ?').get(fb.id) });
});

module.exports = router;
