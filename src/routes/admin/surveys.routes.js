const express = require('express');
const db = require('../../db');
const { uuid, parseJSON, toCSV } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const { resolveAudience } = require('../../services/audience');
const engagement = require('../../services/engagement');
const notifications = require('../../services/notifications');
const circles = require('../../services/circles');

const router = express.Router();

// ─── Surveys ────────────────────────────────────────────────

// GET /api/admin/surveys
router.get('/surveys', requirePermission('surveys.read'), (req, res) => {
  // A survey belongs to the circle that ran it
  const surveys = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM survey_responses sr WHERE sr.survey_id = s.id) as response_count,
      (SELECT COUNT(*) FROM survey_responses sr
        WHERE sr.survey_id = s.id AND sr.completed_at IS NOT NULL) as completed_count
    FROM surveys s WHERE s.circle_id = ? ORDER BY s.created_at DESC
  `).all(req.circleId);

  res.json({
    surveys: surveys.map(s => ({
      ...s,
      questions: parseJSON(s.questions, []),
      target_ids: parseJSON(s.target_ids, [])
    }))
  });
});



// GET /api/admin/surveys/:id/audience
// "See eligible cohorts of users according to their cohorts for surveys" —
// who this survey would reach, and who is already excluded.
router.get('/surveys/:id/audience', requirePermission('surveys.read'), (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const audience = resolveAudience(survey);

  const alreadyInvited = new Set(
    db.prepare('SELECT user_id FROM survey_responses WHERE survey_id = ?').all(survey.id).map(r => r.user_id)
  );
  const completed = new Set(
    db.prepare('SELECT user_id FROM survey_responses WHERE survey_id = ? AND completed_at IS NOT NULL')
      .all(survey.id).map(r => r.user_id)
  );

  const mode = survey.engagement_mode;
  const reachable = [];
  const unreachable = [];
  let completedInAudience = 0;

  for (const user of audience) {
    if (completed.has(user.id)) { completedInAudience++; continue; }
    const { allowed, skipped } = notifications.resolveChannels(
      user,
      mode === 'in_portal' || mode === '1-on-1' ? ['in_portal'] : ['in_portal', mode],
      'survey_invites'
    );
    const entry = {
      id: user.id, name: user.name, email: user.email, company: user.company,
      already_invited: alreadyInvited.has(user.id),
      channels: allowed
    };
    if (allowed.length) reachable.push(entry);
    else unreachable.push({ ...entry, reasons: skipped.map(s => s.reason) });
  }

  res.json({
    survey: { id: survey.id, title: survey.title, engagement_mode: mode, target_type: survey.target_type },
    eligible_count: audience.length,
    reachable,
    unreachable,
    // Completions within this audience — a member who responded before the
    // targeting changed should not inflate the count
    already_completed: completedInAudience,
    completed_overall: completed.size
  });
});

// POST /api/admin/surveys
router.post('/surveys', requirePermission('surveys.write'), (req, res) => {
  const {
    title, description, questions, target_type, target_ids,
    engagement_mode, time_estimate_min, expires_at, trigger_event, reminder_after_days, circle_id
  } = req.body;

  if (!title || !questions) return res.status(400).json({ error: 'title and questions required' });
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'questions must be an array' });

  const circle = circle_id ? circles.byId(circle_id) : req.circle;
  if (!circle) return res.status(400).json({ error: 'Unknown circle_id' });

  // Every question needs a stable id — responses are keyed by it, and an
  // export lines answers up against it.
  const withIds = questions.map((q, i) => ({ ...q, id: q.id || `q${i + 1}_${uuid().slice(0, 8)}` }));

  const id = uuid();
  db.prepare(`
    INSERT INTO surveys (id, title, description, questions, target_type, target_ids,
                         engagement_mode, time_estimate_min, expires_at, trigger_event,
                         reminder_after_days, circle_id, created_by, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
  `).run(
    id, title, description || null, JSON.stringify(withIds),
    target_type || 'all', JSON.stringify(target_ids || []),
    engagement_mode || 'in_portal', time_estimate_min || 5,
    expires_at || null, trigger_event || null, reminder_after_days || null,
    circle.id, req.admin.id
  );

  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(id);
  res.status(201).json({ survey: { ...survey, questions: withIds } });
});

// PUT /api/admin/surveys/:id
router.put('/surveys/:id', requirePermission('surveys.write'), (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const {
    title, description, questions, status, target_type, target_ids,
    engagement_mode, time_estimate_min, expires_at, trigger_event, reminder_after_days
  } = req.body;

  const updates = [];
  const params = [];

  if (title) { updates.push('title = ?'); params.push(title); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (questions) {
    if (!Array.isArray(questions)) return res.status(400).json({ error: 'questions must be an array' });
    // Editing questions after responses exist would orphan collected answers
    const responded = db.prepare(
      'SELECT COUNT(*) as c FROM survey_responses WHERE survey_id = ? AND completed_at IS NOT NULL'
    ).get(survey.id).c;
    if (responded > 0) {
      return res.status(409).json({
        error: `Cannot change questions — ${responded} member(s) have already responded. Close this survey and create a new version.`
      });
    }
    const withIds = questions.map((q, i) => ({ ...q, id: q.id || `q${i + 1}_${uuid().slice(0, 8)}` }));
    updates.push('questions = ?'); params.push(JSON.stringify(withIds));
  }
  if (status) {
    if (!['draft', 'active', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    updates.push('status = ?'); params.push(status);
  }
  if (target_type) { updates.push('target_type = ?'); params.push(target_type); }
  if (target_ids) { updates.push('target_ids = ?'); params.push(JSON.stringify(target_ids)); }
  if (engagement_mode) { updates.push('engagement_mode = ?'); params.push(engagement_mode); }
  if (time_estimate_min) { updates.push('time_estimate_min = ?'); params.push(time_estimate_min); }
  if (expires_at !== undefined) { updates.push('expires_at = ?'); params.push(expires_at); }
  if (trigger_event !== undefined) { updates.push('trigger_event = ?'); params.push(trigger_event || null); }
  if (reminder_after_days !== undefined) {
    updates.push('reminder_after_days = ?'); params.push(reminder_after_days || null);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  params.push(survey.id);
  db.prepare(`UPDATE surveys SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM surveys WHERE id = ?').get(survey.id);
  res.json({ survey: { ...updated, questions: parseJSON(updated.questions, []) } });
});

// POST /api/admin/surveys/:id/invite
// Sends the invitation over the survey's engagement mode. Previously the mode
// was stored and no invitation was ever sent.
router.post('/surveys/:id/invite', requirePermission('surveys.invite'), async (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });
  if (survey.status !== 'active') {
    return res.status(409).json({ error: 'Activate the survey before inviting members' });
  }

  const { resend = false } = req.body;
  const audience = resolveAudience(survey);

  const invited = new Set(
    db.prepare('SELECT user_id FROM survey_responses WHERE survey_id = ?').all(survey.id).map(r => r.user_id)
  );
  const completed = new Set(
    db.prepare('SELECT user_id FROM survey_responses WHERE survey_id = ? AND completed_at IS NOT NULL')
      .all(survey.id).map(r => r.user_id)
  );

  const mode = survey.engagement_mode;
  const channels = mode === 'in_portal' || mode === '1-on-1' ? ['in_portal'] : ['in_portal', mode];

  const recipients = audience.filter(u => !completed.has(u.id) && (resend || !invited.has(u.id)));

  const insertResponse = db.prepare(`
    INSERT INTO survey_responses (id, survey_id, user_id, triggered_by) VALUES (?, ?, ?, 'manual')
  `);

  const summary = { invited: 0, delivered: 0, skipped: 0, queued: 0, failed: 0 };

  for (const user of recipients) {
    if (!invited.has(user.id)) {
      insertResponse.run(uuid(), survey.id, user.id);
      invited.add(user.id);
    }

    engagement.log(user.id, 'survey_invited', {
      referenceId: survey.id,
      metadata: { engagement_mode: mode, survey_title: survey.title },
      source: 'manual'
    });

    const result = await notifications.notify(user, {
      category: 'survey_invites',
      title: survey.title,
      body: survey.description ||
        `We'd like your input. This takes about ${survey.time_estimate_min} minutes.`,
      actionUrl: `/member/survey.html?id=${survey.id}`,
      sourceType: 'survey_invite',
      sourceId: survey.id,
      channels
    });

    summary.invited++;
    for (const d of result.deliveries) {
      if (d.status === 'sent' || d.status === 'simulated') summary.delivered++;
      else if (d.status === 'queued') summary.queued++;
      else if (d.status === 'failed') summary.failed++;
      else summary.skipped++;
    }
  }

  res.json({
    message: `Invited ${summary.invited} member(s) via ${mode}`,
    eligible: audience.length,
    ...summary,
    // A 1-on-1 invite is a task for a rep; the portal notification is the cue
    requires_manual_followup: mode === '1-on-1' ? summary.invited : 0
  });
});

// POST /api/admin/surveys/:id/remind — nudge members who haven't responded
router.post('/surveys/:id/remind', requirePermission('surveys.invite'), async (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const pending = db.prepare(`
    SELECT u.* FROM survey_responses sr
    JOIN users u ON u.id = sr.user_id
    WHERE sr.survey_id = ? AND sr.completed_at IS NULL AND u.status = 'active'
  `).all(survey.id);

  const mode = survey.engagement_mode;
  const channels = mode === 'in_portal' || mode === '1-on-1' ? ['in_portal'] : ['in_portal', mode];

  let reminded = 0;
  for (const user of pending) {
    engagement.log(user.id, 'survey_reminded', { referenceId: survey.id, source: 'manual' });
    await notifications.notify(user, {
      category: 'survey_reminders',
      title: `Reminder: ${survey.title}`,
      body: `Still open — about ${survey.time_estimate_min} minutes of your time.`,
      actionUrl: `/member/survey.html?id=${survey.id}`,
      sourceType: 'survey_reminder',
      sourceId: survey.id,
      channels
    });
    reminded++;
  }

  res.json({ message: `Reminded ${reminded} member(s)`, reminded });
});

// GET /api/admin/surveys/:id/responses
router.get('/surveys/:id/responses', requirePermission('surveys.read'), (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const responses = db.prepare(`
    SELECT sr.*, u.name as user_name, u.email as user_email
    FROM survey_responses sr
    JOIN users u ON u.id = sr.user_id
    WHERE sr.survey_id = ?
    ORDER BY sr.created_at DESC
  `).all(survey.id);

  res.json({
    survey: { ...survey, questions: parseJSON(survey.questions, []) },
    responses: responses.map(r => ({ ...r, answers: parseJSON(r.answers, {}) }))
  });
});

// GET /api/admin/surveys/:id/export
router.get('/surveys/:id/export', requirePermission('export.read'), (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const questions = parseJSON(survey.questions, []);
  const responses = db.prepare(`
    SELECT sr.*, u.name as user_name, u.email as user_email, u.company as user_company
    FROM survey_responses sr
    JOIN users u ON u.id = sr.user_id
    WHERE sr.survey_id = ? AND sr.completed_at IS NOT NULL
    ORDER BY sr.completed_at DESC
  `).all(survey.id);

  const headers = [
    'respondent_name', 'respondent_email', 'company', 'submitted_at', 'triggered_by',
    ...questions.map((q, i) => `q${i + 1}. ${q.text || q.type}`)
  ];

  const rows = responses.map(r => {
    const answers = parseJSON(r.answers, {});
    return [
      r.user_name, r.user_email, r.user_company, r.completed_at, r.triggered_by,
      ...questions.map(q => {
        const val = answers[q.id];
        return Array.isArray(val) ? val.join('; ') : val;
      })
    ];
  });

  const csv = toCSV(headers, rows, (row, header) => row[headers.indexOf(header)]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="survey-${survey.id}-responses.csv"`);
  res.send(csv);
});

module.exports = router;
