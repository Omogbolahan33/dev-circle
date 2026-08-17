const express = require('express');
const db = require('../../db');
const { uuid, parseJSON, toCSV } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const { resolveAudience } = require('../../services/audience');
const engagement = require('../../services/engagement');
const notifications = require('../../services/notifications');
const circles = require('../../services/circles');
const surveyForm = require('../../services/surveyForm');

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

  res.json({ surveys: surveys.map(surveyForm.hydrate) });
});

// GET /api/admin/surveys/schema
// What a survey may contain: the question types, what each one accepts, and
// the conditions branching can be written from. The builder draws itself from
// this rather than carrying its own copy — the same reason the criteria
// builder asks the server which fields exist.
router.get('/surveys/schema', requirePermission('surveys.read'), (req, res) => {
  res.json({
    types: surveyForm.TYPES,
    operators: surveyForm.OPERATORS,
    operators_by_type: Object.fromEntries(
      [...surveyForm.CONDITIONABLE].map(type => [type, surveyForm.operatorsFor(type)])
    ),
    text_formats: Object.entries(surveyForm.TEXT_FORMATS).map(([value, f]) => ({ value, label: f.label })),
    rating_styles: surveyForm.RATING_STYLES,
    theme: {
      defaults: surveyForm.themes.DEFAULTS,
      fonts: Object.entries(surveyForm.themes.FONTS).map(([value, f]) => ({ value, label: f.label })),
      backgrounds: surveyForm.themes.BACKGROUNDS,
      corners: surveyForm.themes.CORNERS,
      layouts: surveyForm.themes.LAYOUTS,
      progress: surveyForm.themes.PROGRESS,
      modes: surveyForm.themes.MODES,
      fits: surveyForm.themes.FITS,
      // The contrast a themed survey is held to: refused below the floor,
      // allowed with a warning below AA
      contrast: { floor: surveyForm.themes.FLOOR, comfortable: surveyForm.themes.AA },
      // What this circle's surveys start from, so the builder opens on the
      // workspace's look rather than the product's
      circle: parseJSON(req.circle?.survey_theme, null)
    }
  });
});

// GET /api/admin/surveys/:id — one survey, for editing or reviewing
router.get('/surveys/:id', requirePermission('surveys.read'), (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  // Questions can only be rewritten while no answers depend on them, and the
  // builder needs to know that before it lets someone start editing.
  const completed = db.prepare(
    'SELECT COUNT(*) as c FROM survey_responses WHERE survey_id = ? AND completed_at IS NOT NULL'
  ).get(survey.id).c;

  res.json({
    survey: surveyForm.hydrate(survey),
    circle_theme: parseJSON(circles.byId(survey.circle_id)?.survey_theme, null),
    completed_count: completed,
    questions_locked: completed > 0
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
    engagement_mode, time_estimate_min, expires_at, trigger_event, reminder_after_days,
    circle_id, status
  } = req.body;

  if (!title || !questions) return res.status(400).json({ error: 'title and questions required' });
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'questions must be an array' });

  const circle = circle_id ? circles.byId(circle_id) : req.circle;
  if (!circle) return res.status(400).json({ error: 'Unknown circle_id' });

  // Publishing was the one thing this endpoint ignored: the status arrived,
  // was dropped, and every survey was written as a draft — so "Publish" put
  // nothing in front of anyone.
  const opening = status === 'active' ? 'active' : 'draft';

  // A survey that cannot be answered is not saved. Every reason comes back at
  // once, each against the question it belongs to, because fixing five
  // problems one refusal at a time is how a builder gets abandoned. A draft
  // may still be empty — it is being written.
  const definition = surveyForm.normalizeDefinition(req.body, {
    createdBy: req.admin.id,
    allowEmpty: opening !== 'active'
  });
  if (definition.issues.length) {
    return res.status(400).json({
      error: surveyForm.issueSummary(definition.issues),
      issues: definition.issues
    });
  }

  const audience = target_type || 'all';
  if (!['all', 'cohort', 'specific', surveyForm.ANONYMOUS].includes(audience)) {
    return res.status(400).json({ error: 'Unknown target_type' });
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO surveys (id, title, description, questions, theme, target_type, target_ids,
                         engagement_mode, time_estimate_min, expires_at, trigger_event,
                         reminder_after_days, circle_id, created_by, status, public_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, title, description || null,
    JSON.stringify(definition.questions),
    definition.theme ? JSON.stringify(definition.theme) : null,
    audience, JSON.stringify(target_ids || []),
    engagement_mode || 'in_portal', time_estimate_min || 5,
    expires_at || null, trigger_event || null, reminder_after_days || null,
    circle.id, req.admin.id, opening,
    // The link comes into existence with the survey, so it can be copied out
    // of the builder the moment it is saved rather than after a second step
    audience === surveyForm.ANONYMOUS ? surveyForm.publicToken() : null
  );

  res.status(201).json({
    survey: surveyForm.hydrate(db.prepare('SELECT * FROM surveys WHERE id = ?').get(id)),
    // Saved, but worth a second look — a brand combination that is legible
    // rather than comfortable
    ...(definition.warnings?.length ? { warnings: definition.warnings } : {})
  });
});

// PUT /api/admin/surveys/:id
router.put('/surveys/:id', requirePermission('surveys.write'), (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const {
    title, description, questions, theme, status, target_type, target_ids,
    engagement_mode, time_estimate_min, expires_at, trigger_event, reminder_after_days
  } = req.body;

  const updates = [];
  const params = [];
  let written = null;              // the questions this request is storing, if any
  // Honoured, but worth the author's attention — a brand combination that is
  // legible rather than comfortable. Returned alongside the saved survey
  // instead of refusing it: that is a judgement about a brand, not a broken page.
  const warnings = [];

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

    const definition = surveyForm.normalizeDefinition(req.body, {
      createdBy: req.admin.id,
      allowEmpty: (status || survey.status) !== 'active'
    });
    if (definition.issues.length) {
      return res.status(400).json({
        error: surveyForm.issueSummary(definition.issues),
        issues: definition.issues
      });
    }
    updates.push('questions = ?'); params.push(JSON.stringify(definition.questions));
    written = definition.questions;
  }

  // Look and feel can be changed at any point, including on a survey that is
  // already collecting: it changes how the remaining members see it, not what
  // any of them were asked.
  if (theme !== undefined) {
    if (theme === null) {
      updates.push('theme = ?'); params.push(null);
    } else {
      const { theme: normalized, issues, warnings: themeWarnings } = surveyForm.themes.normalize(theme);
      if (issues.length) {
        return res.status(400).json({
          error: issues[0].message,
          issues: issues.map(i => ({ index: -1, field: `theme.${i.field}`, message: i.message }))
        });
      }
      warnings.push(...themeWarnings);
      updates.push('theme = ?'); params.push(normalized ? JSON.stringify(normalized) : null);
    }
  }
  if (status) {
    if (!['draft', 'active', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    // An empty draft is work in progress; an empty active survey is an
    // invitation to answer nothing. The check belongs here as well as at
    // creation, because this is the other way a survey becomes live.
    if (status === 'active') {
      const going = written || surveyForm.hydrate(survey).questions;
      if (!surveyForm.canGoOut(going)) {
        return res.status(400).json({ error: 'Add at least one question before publishing' });
      }
    }
    updates.push('status = ?'); params.push(status);
  }
  if (target_type) {
    if (!['all', 'cohort', 'specific', surveyForm.ANONYMOUS].includes(target_type)) {
      return res.status(400).json({ error: 'Unknown target_type' });
    }
    updates.push('target_type = ?'); params.push(target_type);

    // Switching to a link audience mints the link. Switching away leaves it
    // alone: someone may already be holding it, and quietly breaking a link
    // that is out in the world is worse than a survey that stops accepting
    // answers for a reason it can state.
    if (target_type === surveyForm.ANONYMOUS && !survey.public_token) {
      updates.push('public_token = ?'); params.push(surveyForm.publicToken());
    }
  }
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

  res.json({
    survey: surveyForm.hydrate(db.prepare('SELECT * FROM surveys WHERE id = ?').get(survey.id)),
    ...(warnings.length ? { warnings } : {})
  });
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
  // There is nobody to invite: the link is how this one reaches people. Said
  // plainly rather than reporting a successful send to nought recipients.
  if (survey.target_type === surveyForm.ANONYMOUS) {
    return res.status(409).json({
      error: 'This survey is answered over its link, so there is nobody to invite. Share the link instead.',
      public_path: `/s/${survey.public_token}`
    });
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
    LEFT JOIN users u ON u.id = sr.user_id
    WHERE sr.survey_id = ?
    ORDER BY sr.created_at DESC
  `).all(survey.id);

  const hydrated = surveyForm.hydrate(survey);

  res.json({
    survey: hydrated,
    responses: responses.map(r => {
      const answers = parseJSON(r.answers, {});
      return {
        ...r,
        answers,
        // Which questions this member was actually shown. With branching, "12
        // of 40 answered" is meaningless without knowing that only 14 were
        // ever asked of them.
        asked: r.completed_at ? surveyForm.visible(hydrated.questions, answers).map(q => q.id) : null
      };
    })
  });
});

// GET /api/admin/surveys/:id/export
router.get('/surveys/:id/export', requirePermission('export.read'), (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  // Sections hold no answer, so they hold no column
  const questions = surveyForm.hydrate(survey).questions.filter(surveyForm.isAnswerable);

  const responses = db.prepare(`
    SELECT sr.*, u.name as user_name, u.email as user_email, u.company as user_company
    FROM survey_responses sr
    LEFT JOIN users u ON u.id = sr.user_id
    WHERE sr.survey_id = ? AND sr.completed_at IS NOT NULL
    ORDER BY sr.completed_at DESC
  `).all(survey.id);

  const headers = [
    'respondent_name', 'respondent_email', 'company', 'submitted_at', 'triggered_by',
    ...questions.map((q, i) => `q${i + 1}. ${q.text || q.type}`)
  ];

  const rows = responses.map(r => {
    const answers = parseJSON(r.answers, {});
    const asked = new Set(surveyForm.visible(
      surveyForm.hydrate(survey).questions, answers
    ).map(q => q.id));

    // A respondent with no account has no name to export. Said outright
    // rather than left blank, so a column of empty cells is not read as a
    // fault in the export.
    return [
      r.user_name || 'Anonymous', r.user_email || '', r.user_company || '',
      r.completed_at, r.triggered_by,
      // A question this member was never shown is left empty rather than
      // marked unanswered: they did not decline it, it was not put to them.
      // A grid or a ranking is flattened the same way it reads on screen.
      ...questions.map(q => (asked.has(q.id) ? surveyForm.answerToText(q, answers[q.id]) : ''))
    ];
  });

  const csv = toCSV(headers, rows, (row, header) => row[headers.indexOf(header)]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="survey-${survey.id}-responses.csv"`);
  res.send(csv);
});

module.exports = router;
