const express = require('express');
const db = require('../../db');
const { uuid, parseJSON, paginate, sanitizeUser, toCSV, parseCSV } = require('../../utils/helpers');
const identity = require('../../utils/identity');
const { parseXLSX, buildXLSX } = require('../../utils/xlsx');
const importTemplates = require('../../services/importTemplates');
const { requirePermission, destroyAllSessionsFor } = require('../../middleware/auth');
const { memberFilters } = require('../../services/audience');
const engagement = require('../../services/engagement');
const cohortRules = require('../../services/cohortRules');
const circles = require('../../services/circles');
const verbatims = require('../../services/verbatims');

const router = express.Router();

// ─── Members ────────────────────────────────────────────────


// GET /api/admin/members
router.get('/members', requirePermission('members.read'), async (req, res) => {
  const { offset, limit: l, page: p } = paginate(req.query.page, req.query.limit);
  // Scoped to the circle being worked in. A member of another workspace is not
  // "filtered out" here — they are not part of this one.
  const { from, where, params } = memberFilters({ ...req.query, circle_id: req.circleId });

  // Page + filter total in one plan (COUNT(*) OVER is the matching set, not
  // the page). Survey tallies are index lookups on the page only — not a scan
  // of every response. Cohorts join the same page of ids.
  const [members, cohortRows] = await Promise.all([
    db.prepare(`
      SELECT u.id, u.email, u.name, u.phone, u.company, u.work_sector,
             u.status, u.api_status, u.kyb_completed, u.engagement_streak,
             u.preferred_channels, u.preferred_days, u.api_products,
             u.gender, u.location_state, u.date_of_birth,
             u.last_active_at, u.created_at,
             COUNT(*) OVER() as _total,
             (SELECT COUNT(*) FROM survey_responses sr WHERE sr.user_id = u.id) as surveys_invited,
             (SELECT COUNT(*) FROM survey_responses sr
               WHERE sr.user_id = u.id AND sr.completed_at IS NOT NULL) as surveys_completed
      FROM ${from}
      WHERE ${where}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, l, offset),
    db.prepare(`
      SELECT uc.user_id, c.id, c.name, c.color
      FROM user_cohorts uc
      JOIN cohorts c ON c.id = uc.cohort_id
      WHERE uc.user_id IN (
        SELECT u.id FROM ${from} WHERE ${where}
        ORDER BY u.created_at DESC LIMIT ? OFFSET ?
      )
    `).all(...params, l, offset)
  ]);

  const total = (members && members.length)
    ? Number(members[0]._total || 0)
    : (offset ? Number((await db.prepare(`SELECT COUNT(*) as c FROM ${from} WHERE ${where}`).get(...params))?.c || 0) : 0);

  const cohortsByUser = new Map();
  for (const row of cohortRows || []) {
    const list = cohortsByUser.get(row.user_id) || [];
    list.push({ id: row.id, name: row.name, color: row.color });
    cohortsByUser.set(row.user_id, list);
  }

  const result = (members || []).map(m => {
    const { _total, ...rest } = m;
    return {
      ...rest,
      preferred_channels: parseJSON(m.preferred_channels, []),
      preferred_days: parseJSON(m.preferred_days, []),
      api_products: parseJSON(m.api_products, []),
      surveys_completed: Number(m.surveys_completed || 0),
      surveys_invited: Number(m.surveys_invited || 0),
      cohorts: cohortsByUser.get(m.id) || []
    };
  });

  res.json({
    members: result,
    pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) }
  });
});

// GET /api/admin/members/:id
router.get('/members/:id', requirePermission('members.read'), async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Member not found' });

  // Reachable only from a circle they are actually in
  if (!await circles.isMember(req.circleId, user.id)) {
    return res.status(404).json({ error: 'Member not found in this circle' });
  }

  const [cohorts, consent, engagementRows, feedback, survey_responses, gifts, deliveries] =
    await Promise.all([
      db.prepare(`
        SELECT c.* FROM cohorts c JOIN user_cohorts uc ON uc.cohort_id = c.id
        WHERE uc.user_id = ? AND c.circle_id = ?
      `).all(user.id, req.circleId),
      db.prepare('SELECT * FROM consent WHERE user_id = ?').all(user.id),
      db.prepare(
        'SELECT * FROM engagement_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
      ).all(user.id),
      verbatims.forUser(user.id, { limit: 50 }),
      db.prepare(`
        SELECT sr.*, s.title as survey_title
        FROM survey_responses sr JOIN surveys s ON s.id = sr.survey_id
        WHERE sr.user_id = ? ORDER BY sr.created_at DESC
      `).all(user.id),
      db.prepare(`
        SELECT g.name, g.value, g.currency, ug.claimed_at, ug.delivered_at
        FROM user_gifts ug JOIN gifts g ON g.id = ug.gift_id
        WHERE ug.user_id = ? ORDER BY ug.claimed_at DESC
      `).all(user.id),
      db.prepare(`
        SELECT source_type, channel, status, reason, created_at
        FROM message_deliveries WHERE user_id = ? ORDER BY created_at DESC LIMIT 25
      `).all(user.id)
    ]);

  res.json({
    user: sanitizeUser(user),
    cohorts,
    consent,
    engagement: engagementRows,
    // Everything this member has told us, whatever the source and whichever
    // question drew it out — the single list this change exists to make possible
    feedback,
    survey_responses,
    gifts,
    deliveries
  });
});

// GET /api/admin/members/:id/timeline
// Everything about one developer in a single stream: what they did, what they
// said, and what we sent them — from every source, in the order it happened.
// Reading three tabs and stitching the order together in your head was the
// thing that made a developer hard to see whole.
router.get('/members/:id/timeline', requirePermission('members.read'), async (req, res) => {
  const user = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Member not found' });

  const limit = Math.min(300, parseInt(req.query.limit, 10) || 150);

  const [eventRows, saidRows, sentRows] = await Promise.all([
    db.prepare(`
      SELECT eh.id, eh.type, eh.created_at, eh.metadata, eh.source, eh.reference_id,
             s.title as survey_title, g.name as gift_name
      FROM engagement_history eh
      LEFT JOIN surveys s ON s.id = eh.reference_id
      LEFT JOIN gifts g ON g.id = eh.reference_id
      WHERE eh.user_id = ?
      ORDER BY eh.created_at DESC
      LIMIT ?
    `).all(user.id, limit),
    db.prepare(`
      SELECT f.id, f.content, f.prompt, f.source, f.source_system, f.category,
             f.created_at, f.external_ticket_id, f.canonical_question_id,
             s.title as survey_title
      FROM feedback f
      LEFT JOIN surveys s ON s.id = f.survey_id
      WHERE f.user_id = ?
      ORDER BY f.created_at DESC
      LIMIT ?
    `).all(user.id, limit),
    db.prepare(`
      SELECT id, source_type, channel, status, reason, created_at
      FROM message_deliveries
      WHERE user_id = ? AND status IN ('sent', 'simulated')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(user.id, limit)
  ]);

  // What they did — the events the system recorded about them
  const events = (eventRows || []).map(e => ({
    kind: 'did',
    at: e.created_at,
    id: e.id,
    type: e.type,
    source: e.source,
    label: e.type.replace(/_/g, ' '),
    detail: e.survey_title || e.gift_name || null,
    metadata: parseJSON(e.metadata, {})
  }));

  // What they said — every verbatim, whichever door it came through
  const said = (saidRows || []).map(f => ({
    kind: 'said',
    at: f.created_at,
    id: f.id,
    source: f.source,
    source_system: f.source_system,
    prompt: f.prompt,
    content: f.content,
    question_id: f.canonical_question_id,
    detail: f.survey_title || (f.source_system || '').replace(/_/g, ' ') || null,
    ticket: f.external_ticket_id
  }));

  // What we sent them, and whether it actually went. A member who has been
  // messaged eight times and answered nothing reads very differently from one
  // nobody has contacted.
  const sent = (sentRows || []).map(d => ({
    kind: 'sent',
    at: d.created_at,
    id: d.id,
    label: d.source_type.replace(/_/g, ' '),
    channel: d.channel,
    source: 'system'
  }));

  const timeline = [...events, ...said, ...sent]
    .filter(entry => entry.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);

  res.json({
    timeline,
    counts: {
      did: events.length,
      said: said.length,
      sent: sent.length,
      // How many distinct questions this developer has answered — the measure
      // of how much they have actually given us
      questions_answered: new Set(said.filter(s => s.question_id).map(s => s.question_id)).size
    }
  });
});

// PUT /api/admin/members/:id
router.put('/members/:id', requirePermission('members.write'), async (req, res) => {
  const { status, api_status, kyb_completed, work_sector, api_products, location_state, gender } = req.body;
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Member not found' });

  const updates = [];
  const params = [];

  if (status) {
    if (!['active', 'inactive', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    updates.push('status = ?'); params.push(status);
  }
  if (api_status) { updates.push('api_status = ?'); params.push(api_status); }
  if (kyb_completed !== undefined) { updates.push('kyb_completed = ?'); params.push(kyb_completed ? 1 : 0); }
  if (work_sector !== undefined) { updates.push('work_sector = ?'); params.push(work_sector); }
  if (location_state !== undefined) { updates.push('location_state = ?'); params.push(location_state); }
  if (gender !== undefined) { updates.push('gender = ?'); params.push(gender); }
  if (api_products !== undefined) {
    if (!Array.isArray(api_products)) return res.status(400).json({ error: 'api_products must be an array' });
    updates.push('api_products = ?'); params.push(JSON.stringify(api_products));
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  params.push(user.id);

  await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // Deactivating a member must also end their live sessions, otherwise the
  // account stays usable until the token happens to expire.
  if (status && status !== 'active') {
    await destroyAllSessionsFor(user.id);
  }

  // Membership of rule-based cohorts may have changed with these fields
  await cohortRules.syncAll();

  const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: sanitizeUser(updated) });
});

// POST /api/admin/members/:id/sign-out
// Members have no password to reset — they sign in with a one-time code — so
// what an operator actually needs after a report of a lost or shared device is
// to end that member's live sessions. The next code they request is their way
// back in.
router.post('/members/:id/sign-out', requirePermission('members.write'), async (req, res) => {
  const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Member not found' });

  await destroyAllSessionsFor(user.id);
  res.json({ message: 'Signed out of every device. They can sign back in with a new code.' });
});

// ─── Bulk Import ────────────────────────────────────────────

// GET /api/admin/import/template?format=csv|xlsx
// The blank workbook to fill in. Generated from the same column spec the
// importer reads rows through, so it is always current — nobody has to
// remember to update a file checked in beside the code.
router.get('/import/template', requirePermission('members.import'), async (req, res) => {
  const format = (req.query.format || 'xlsx').toLowerCase();
  const key = req.query.type || 'members';

  try {
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename="${importTemplates.filename(key, 'csv')}"`);
      // A BOM so Excel opens it as UTF-8 rather than mangling accented names
      return res.send('﻿' + importTemplates.toCsvTemplate(key));
    }

    if (format === 'xlsx') {
      res.setHeader('Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',
        `attachment; filename="${importTemplates.filename(key, 'xlsx')}"`);
      return res.send(importTemplates.toWorkbook(key));
    }

    res.status(400).json({ error: 'format must be csv or xlsx' });
  } catch (err) {
    if (err instanceof importTemplates.TemplateError) {
      return res.status(404).json({ error: err.message });
    }
    throw err;
  }
});

// GET /api/admin/import/columns — the spec behind the template, for the UI to
// describe the upload without hardcoding a second copy of the column list
router.get('/import/columns', requirePermission('members.import'), async (req, res) => {
  const key = req.query.type || 'members';

  try {
    const template = importTemplates.get(key);
    res.json({
      key,
      label: template.label,
      guidance: template.guidance,
      columns: template.columns.map(c => ({
        key: c.key,
        label: c.label || c.key,
        required: Boolean(c.required),
        notes: c.notes || null,
        aliases: c.aliases || [],
        suggested: c.suggested || null
      }))
    });
  } catch (err) {
    if (err instanceof importTemplates.TemplateError) {
      return res.status(404).json({ error: err.message });
    }
    throw err;
  }
});

// POST /api/admin/import
// Accepts either a JSON array or raw CSV pasted from an Excel export.
router.post('/import', requirePermission('members.import'), async (req, res) => {
  const { users: importUsers, csv, xlsx_base64, cohort_id, circle_id, dry_run = false } = req.body;

  let rows;
  try {
    if (xlsx_base64) {
      // An .xlsx straight from Excel — no "save as CSV" step required
      rows = parseXLSX(xlsx_base64);
    } else if (csv) {
      rows = parseCSV(csv);
    } else if (Array.isArray(importUsers)) {
      rows = importUsers;
    } else {
      return res.status(400).json({ error: 'Provide a users array, a csv string, or xlsx_base64' });
    }
  } catch (err) {
    return res.status(400).json({ error: `Could not read the workbook: ${err.message}` });
  }

  if (!rows.length) {
    return res.status(400).json({ error: 'No data rows found. Include a header row with at least email and name.' });
  }

  const results = { created: 0, skipped: 0, errors: [], preview: [] };

  // Thrown to roll the transaction back after a dry run has counted everything
  class DryRun extends Error {}

  const existsStmt = db.prepare('SELECT id FROM users WHERE email = ?');
  const insertStmt = db.prepare(`
    INSERT INTO users (id, email, name, phone, phone_normalized, company, work_sector, password_hash,
                       date_of_birth, gender, location_state, api_products)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const allCohort = await db.prepare("SELECT id FROM cohorts WHERE name = 'All Members'").get();
  const cohortStmt = db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)');
  const circleStmt = db.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id) VALUES (?, ?)');

  // Everyone joins the root circle; a sub-circle can be named to seed it too
  const workingCircle = req.circle;
  const targetCircle = circle_id ? await db.prepare('SELECT * FROM circles WHERE id = ?').get(circle_id) : null;
  if (circle_id && !targetCircle) {
    return res.status(400).json({ error: 'Unknown circle_id' });
  }

  // Rows are read through the same column spec the downloadable template is
  // generated from, so the two cannot describe different things.
  const normalise = row => importTemplates.normaliseRow('members', row);

  const run = db.transaction(() => {
    for (const raw of rows) {
      const row = normalise(raw);

      if (!row.email || !row.name) {
        results.errors.push({ row: raw, error: 'email and name are required' });
        continue;
      }
      if (!identity.EMAIL_RE.test(row.email)) {
        results.errors.push({ row: raw, error: `"${row.email}" is not a valid email` });
        continue;
      }
      // A Credit Direct address means staff, and staff accounts are created
      // under Roles with a password — importing one would make a profile that
      // can never be signed in to.
      if (identity.isStaffEmail(row.email)) {
        results.errors.push({ row: raw, error: `"${row.email}" is a Credit Direct address — add staff under Roles` });
        continue;
      }
      if (existsStmt.get(row.email)) {
        results.skipped++;
        continue;
      }

      if (dry_run) {
        results.created++;
        if (results.preview.length < 10) results.preview.push(row);
        continue;
      }

      const id = uuid();

      try {
        insertStmt.run(
          id, row.email, row.name, row.phone, identity.normalizePhone(row.phone),
          row.company, row.work_sector, identity.NO_PASSWORD,
          row.date_of_birth, row.gender, row.location_state, JSON.stringify(row.api_products)
        );
        if (allCohort) cohortStmt.run(id, allCohort.id);
        if (cohort_id) cohortStmt.run(id, cohort_id);
        // Imported members join the circle being worked in
        if (workingCircle) circleStmt.run(workingCircle.id, id);
        if (targetCircle && targetCircle.id !== workingCircle?.id) circleStmt.run(targetCircle.id, id);
        engagement.log(id, 'account_created', { metadata: { via: 'bulk_import' }, source: 'manual' });
        results.created++;
      } catch (e) {
        results.errors.push({ row: raw, error: e.message });
      }
    }

    // A dry run must leave nothing behind
    if (dry_run) throw new DryRun();
  });

  try {
    run();
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }

  if (!dry_run) await cohortRules.syncAll();

  res.json({
    message: dry_run
      ? `Dry run: ${results.created} would be created, ${results.skipped} already exist`
      : `Import complete: ${results.created} created, ${results.skipped} skipped`,
    dry_run,
    ...results
  });
});

// ─── Export ─────────────────────────────────────────────────

// Columns an export can carry. The order here is the order in the file.
const EXPORT_COLUMNS = [
  'id', 'email', 'name', 'phone', 'company', 'work_sector', 'gender', 'location_state',
  'date_of_birth', 'age', 'api_products', 'status', 'api_status', 'kyb_completed',
  'engagement_streak', 'surveys_completed', 'gifts_claimed', 'feedback_submitted',
  'cohorts', 'circles', 'consented_channels', 'preferred_days', 'preferred_channels',
  'last_active_at', 'created_at'
];

async function selectMembers(query) {
  const { from, where, params } = memberFilters(query);

  const rows = await db.prepare(`
    SELECT u.id, u.email, u.name, u.phone, u.company, u.work_sector,
           u.gender, u.location_state, u.date_of_birth, u.api_products,
           u.status, u.api_status, u.kyb_completed, u.engagement_streak,
           u.preferred_channels, u.preferred_days, u.last_active_at, u.created_at,
           CAST((julianday('now') - julianday(u.date_of_birth)) / 365.25 AS INTEGER) as age,
           (SELECT COUNT(*) FROM survey_responses sr
             WHERE sr.user_id = u.id AND sr.completed_at IS NOT NULL) as surveys_completed,
           (SELECT COUNT(*) FROM user_gifts ug WHERE ug.user_id = u.id) as gifts_claimed,
           (SELECT COUNT(*) FROM feedback f WHERE f.user_id = u.id) as feedback_submitted,
           (SELECT GROUP_CONCAT(c.name, '; ') FROM cohorts c
             JOIN user_cohorts uc ON uc.cohort_id = c.id WHERE uc.user_id = u.id) as cohorts,
           (SELECT GROUP_CONCAT(ci.name, '; ') FROM circles ci
             JOIN circle_members cm ON cm.circle_id = ci.id WHERE cm.user_id = u.id) as circles,
           (SELECT GROUP_CONCAT(ch.channel, '; ') FROM consent ch
             WHERE ch.user_id = u.id AND ch.status = 'granted') as consented_channels
    FROM ${from} WHERE ${where}
    ORDER BY u.created_at DESC
  `).all(...params);

  return rows.map(u => ({
    ...u,
    api_products: parseJSON(u.api_products, []),
    preferred_channels: parseJSON(u.preferred_channels, []),
    preferred_days: parseJSON(u.preferred_days, []),
    cohorts: u.cohorts ? u.cohorts.split('; ') : [],
    circles: u.circles ? u.circles.split('; ') : [],
    consented_channels: u.consented_channels ? u.consented_channels.split('; ') : []
  }));
}

// Narrow the file to the columns asked for, keeping the canonical order so two
// exports of the same selection are diffable
function chosenColumns(requested) {
  if (!requested) return EXPORT_COLUMNS;
  const wanted = new Set(String(requested).split(',').map(s => s.trim()).filter(Boolean));
  const picked = EXPORT_COLUMNS.filter(c => wanted.has(c));
  return picked.length ? picked : EXPORT_COLUMNS;
}

// GET /api/admin/export/fields
// What an export can be filtered and sliced by. Each criterion carries the
// values to choose between, resolved from the domain or from the member base,
// so the filter builder never has to hold its own copy of a value list.
router.get('/export/fields', requirePermission('export.read'), async (req, res) => {
  res.json({
    criteria: await cohortRules.catalogue(),
    columns: EXPORT_COLUMNS
  });
});

// GET /api/admin/export/count — how many the criteria match, before committing
// to a download. Cheap enough to run on every edit of the filter builder.
router.get('/export/count', requirePermission('export.read'), async (req, res) => {
  try {
    const { from, where, params } = memberFilters({ ...req.query, circle_id: req.circleId });
    const total = Number((await db.prepare(`SELECT COUNT(*) as c FROM ${from} WHERE ${where}`).get(...params))?.c || 0);
    res.json({ total });
  } catch (err) {
    if (err instanceof cohortRules.RuleError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// GET /api/admin/export
// Filter with any criterion a cohort can be built from — cohort, circle, age,
// sector, consent, engagement, activity — alone or combined.
router.get('/export', requirePermission('export.read'), async (req, res) => {
  const format = (req.query.format || 'json').toLowerCase();

  let result;
  try {
    result = await selectMembers({ ...req.query, circle_id: req.circleId });
  } catch (err) {
    if (err instanceof cohortRules.RuleError) return res.status(400).json({ error: err.message });
    throw err;
  }

  const columns = chosenColumns(req.query.columns);
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `devcircle-members-${stamp}`;

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    // The BOM makes Excel read it as UTF-8; the formula guard inside toCSV
    // stays on, because these values came from members.
    return res.send('\ufeff' + toCSV(columns, result));
  }

  if (format === 'xlsx') {
    const rows = [columns, ...result.map(u => columns.map(c => {
      const value = u[c];
      return Array.isArray(value) ? value.join('; ') : value;
    }))];

    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    return res.send(buildXLSX([{ name: 'Members', rows }]));
  }

  if (format !== 'json') {
    return res.status(400).json({ error: 'format must be json, csv, or xlsx' });
  }

  res.json({ users: result, total: result.length, columns });
});

module.exports = router;
