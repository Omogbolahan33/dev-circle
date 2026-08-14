const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../../db');
const { uuid, parseJSON, paginate, sanitizeUser, toCSV, parseCSV } = require('../../utils/helpers');
const { parseXLSX } = require('../../utils/xlsx');
const { requirePermission, destroyAllSessionsFor } = require('../../middleware/auth');
const { memberFilters } = require('../../services/audience');
const engagement = require('../../services/engagement');
const cohortRules = require('../../services/cohortRules');
const circles = require('../../services/circles');

const router = express.Router();

// ─── Members ────────────────────────────────────────────────


// GET /api/admin/members
router.get('/members', requirePermission('members.read'), (req, res) => {
  const { offset, limit: l, page: p } = paginate(req.query.page, req.query.limit);
  const { where, params } = memberFilters(req.query);

  const total = db.prepare(`SELECT COUNT(*) as c FROM users u WHERE ${where}`).get(...params).c;

  // Counts come from correlated subqueries rather than a query per member,
  // which was N+1 across the whole page.
  const members = db.prepare(`
    SELECT u.id, u.email, u.name, u.phone, u.company, u.work_sector,
           u.status, u.api_status, u.kyb_completed, u.engagement_streak,
           u.preferred_channels, u.preferred_days, u.api_products,
           u.gender, u.location_state, u.date_of_birth,
           u.last_active_at, u.created_at,
           (SELECT COUNT(*) FROM survey_responses sr
             WHERE sr.user_id = u.id AND sr.completed_at IS NOT NULL) as surveys_completed,
           (SELECT COUNT(*) FROM survey_responses sr WHERE sr.user_id = u.id) as surveys_invited
    FROM users u
    WHERE ${where}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, l, offset);

  const cohortStmt = db.prepare(`
    SELECT c.id, c.name, c.color FROM cohorts c
    JOIN user_cohorts uc ON uc.cohort_id = c.id
    WHERE uc.user_id = ?
  `);

  const result = members.map(m => ({
    ...m,
    preferred_channels: parseJSON(m.preferred_channels, []),
    preferred_days: parseJSON(m.preferred_days, []),
    api_products: parseJSON(m.api_products, []),
    cohorts: cohortStmt.all(m.id)
  }));

  res.json({
    members: result,
    pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) }
  });
});

// GET /api/admin/members/:id
router.get('/members/:id', requirePermission('members.read'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Member not found' });

  const cohorts = db.prepare(`
    SELECT c.* FROM cohorts c JOIN user_cohorts uc ON uc.cohort_id = c.id WHERE uc.user_id = ?
  `).all(user.id);

  res.json({
    user: sanitizeUser(user),
    cohorts,
    consent: db.prepare('SELECT * FROM consent WHERE user_id = ?').all(user.id),
    engagement: db.prepare(
      'SELECT * FROM engagement_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(user.id),
    feedback: db.prepare(
      'SELECT * FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
    ).all(user.id),
    survey_responses: db.prepare(`
      SELECT sr.*, s.title as survey_title
      FROM survey_responses sr JOIN surveys s ON s.id = sr.survey_id
      WHERE sr.user_id = ? ORDER BY sr.created_at DESC
    `).all(user.id),
    gifts: db.prepare(`
      SELECT g.name, g.value, g.currency, ug.claimed_at, ug.delivered_at
      FROM user_gifts ug JOIN gifts g ON g.id = ug.gift_id
      WHERE ug.user_id = ? ORDER BY ug.claimed_at DESC
    `).all(user.id),
    deliveries: db.prepare(`
      SELECT source_type, channel, status, reason, created_at
      FROM message_deliveries WHERE user_id = ? ORDER BY created_at DESC LIMIT 25
    `).all(user.id)
  });
});

// PUT /api/admin/members/:id
router.put('/members/:id', requirePermission('members.write'), (req, res) => {
  const { status, api_status, kyb_completed, work_sector, api_products, location_state, gender } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
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

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // Deactivating a member must also end their live sessions, otherwise the
  // account stays usable until the token happens to expire.
  if (status && status !== 'active') {
    destroyAllSessionsFor(user.id);
  }

  // Membership of rule-based cohorts may have changed with these fields
  cohortRules.syncAll();

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: sanitizeUser(updated) });
});

// POST /api/admin/members/:id/reset-password
router.post('/members/:id/reset-password', requirePermission('members.write'), (req, res) => {
  const { new_password } = req.body;
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'new_password of at least 8 characters is required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Member not found' });

  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bcrypt.hashSync(new_password, 10), user.id);

  // A password reset invalidates existing sessions
  destroyAllSessionsFor(user.id);

  res.json({ message: 'Password reset successful. Existing sessions were signed out.' });
});

// ─── Bulk Import ────────────────────────────────────────────

// POST /api/admin/import
// Accepts either a JSON array or raw CSV pasted from an Excel export.
router.post('/import', requirePermission('members.import'), (req, res) => {
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
    INSERT INTO users (id, email, name, phone, company, work_sector, password_hash,
                       date_of_birth, gender, location_state, api_products)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const allCohort = db.prepare("SELECT id FROM cohorts WHERE name = 'All Members'").get();
  const cohortStmt = db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)');
  const circleStmt = db.prepare('INSERT OR IGNORE INTO circle_members (circle_id, user_id) VALUES (?, ?)');

  // Everyone joins the root circle; a sub-circle can be named to seed it too
  const rootCircle = circles.root();
  const targetCircle = circle_id ? db.prepare('SELECT * FROM circles WHERE id = ?').get(circle_id) : null;
  if (circle_id && !targetCircle) {
    return res.status(400).json({ error: 'Unknown circle_id' });
  }

  const normalise = row => ({
    email: (row.email || '').trim().toLowerCase(),
    name: (row.name || row.full_name || '').trim(),
    phone: row.phone || row.phone_number || null,
    company: row.company || row.organisation || row.organization || null,
    work_sector: row.work_sector || row.sector || null,
    date_of_birth: row.date_of_birth || row.dob || null,
    gender: row.gender || null,
    location_state: row.location_state || row.state || null,
    api_products: row.api_products
      ? String(row.api_products).split(/[;|]/).map(s => s.trim()).filter(Boolean)
      : [],
    password: row.password || null
  });

  const run = db.transaction(() => {
    for (const raw of rows) {
      const row = normalise(raw);

      if (!row.email || !row.name) {
        results.errors.push({ row: raw, error: 'email and name are required' });
        continue;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
        results.errors.push({ row: raw, error: `"${row.email}" is not a valid email` });
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
      // Imported members have no password of their own; the admin issues a
      // reset, or the member arrives via Developer Hub SSO.
      const hash = bcrypt.hashSync(row.password || crypto.randomBytes(24).toString('hex'), 10);

      try {
        insertStmt.run(
          id, row.email, row.name, row.phone, row.company, row.work_sector, hash,
          row.date_of_birth, row.gender, row.location_state, JSON.stringify(row.api_products)
        );
        if (allCohort) cohortStmt.run(id, allCohort.id);
        if (cohort_id) cohortStmt.run(id, cohort_id);
        if (rootCircle) circleStmt.run(rootCircle.id, id);
        if (targetCircle && targetCircle.id !== rootCircle?.id) circleStmt.run(targetCircle.id, id);
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

  if (!dry_run) cohortRules.syncAll();

  res.json({
    message: dry_run
      ? `Dry run: ${results.created} would be created, ${results.skipped} already exist`
      : `Import complete: ${results.created} created, ${results.skipped} skipped`,
    dry_run,
    ...results
  });
});

// ─── Export ─────────────────────────────────────────────────

// GET /api/admin/export
router.get('/export', requirePermission('export.read'), (req, res) => {
  const { format = 'json' } = req.query;
  const { where, params } = memberFilters(req.query);

  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.phone, u.company, u.work_sector,
           u.gender, u.location_state, u.date_of_birth, u.api_products,
           u.status, u.api_status, u.kyb_completed, u.engagement_streak,
           u.preferred_channels, u.preferred_days, u.last_active_at, u.created_at,
           (SELECT COUNT(*) FROM survey_responses sr
             WHERE sr.user_id = u.id AND sr.completed_at IS NOT NULL) as surveys_completed,
           (SELECT COUNT(*) FROM user_gifts ug WHERE ug.user_id = u.id) as gifts_claimed,
           (SELECT GROUP_CONCAT(c.name, '; ') FROM cohorts c
             JOIN user_cohorts uc ON uc.cohort_id = c.id WHERE uc.user_id = u.id) as cohorts,
           (SELECT GROUP_CONCAT(ch.channel, '; ') FROM consent ch
             WHERE ch.user_id = u.id AND ch.status = 'granted') as consented_channels
    FROM users u WHERE ${where}
    ORDER BY u.created_at DESC
  `).all(...params);

  const result = users.map(u => ({
    ...u,
    api_products: parseJSON(u.api_products, []),
    preferred_channels: parseJSON(u.preferred_channels, []),
    preferred_days: parseJSON(u.preferred_days, []),
    cohorts: u.cohorts ? u.cohorts.split('; ') : [],
    consented_channels: u.consented_channels ? u.consented_channels.split('; ') : []
  }));

  if (format === 'csv') {
    const headers = [
      'id', 'email', 'name', 'phone', 'company', 'work_sector', 'gender', 'location_state',
      'date_of_birth', 'api_products', 'status', 'api_status', 'kyb_completed',
      'engagement_streak', 'surveys_completed', 'gifts_claimed', 'cohorts',
      'consented_channels', 'preferred_days', 'last_active_at', 'created_at'
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="devcircle-export.csv"');
    return res.send(toCSV(headers, result));
  }

  res.json({ users: result, total: result.length });
});

module.exports = router;
