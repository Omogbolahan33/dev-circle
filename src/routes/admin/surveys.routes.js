const express = require('express');
const db = require('../../db');
const { uuid, now, parseJSON, toCSV, parseCSV } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const { resolveAudience } = require('../../services/audience');
const engagement = require('../../services/engagement');
const notifications = require('../../services/notifications');
const circles = require('../../services/circles');
const surveyForm = require('../../services/surveyForm');
const responseImport = require('../../services/responseImport');
const verbatims = require('../../services/verbatims');
const { parseXLSX } = require('../../utils/xlsx');
const identity = require('../../utils/identity');

const router = express.Router();

// ─── Surveys ────────────────────────────────────────────────

// GET /api/admin/surveys
router.get('/surveys', requirePermission('surveys.read'), async (req, res) => {
  // A survey belongs to the circle that ran it
  const surveys = await db.prepare(`
    SELECT s.*,
      COALESCE(sr.response_count, 0) as response_count,
      COALESCE(sr.completed_count, 0) as completed_count
    FROM surveys s
    LEFT JOIN (
      SELECT survey_id,
             COUNT(*) as response_count,
             SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) as completed_count
      FROM survey_responses
      WHERE survey_id IN (SELECT id FROM surveys WHERE circle_id = ?)
      GROUP BY survey_id
    ) sr ON sr.survey_id = s.id
    WHERE s.circle_id = ?
    ORDER BY s.created_at DESC
  `).all(req.circleId, req.circleId);

  res.json({ surveys: (surveys || []).map(surveyForm.hydrate) });
});

// GET /api/admin/surveys/schema
// What a survey may contain: the question types, what each one accepts, and
// the conditions branching can be written from. The builder draws itself from
// this rather than carrying its own copy — the same reason the criteria
// builder asks the server which fields exist.
router.get('/surveys/schema', requirePermission('surveys.read'), async (req, res) => {
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
      // Sent with the stacks themselves, so the builder can set each option in
      // its own type — a font list you cannot see is a list of words
      fonts: Object.entries(surveyForm.themes.FONTS).map(([value, f]) => ({
        value, label: f.label, category: f.category, stack: f.stack, note: f.note,
        // Not served from here: it renders for readers who already have it
        device: !!f.device,
        needs_upload: !!f.needsUpload
      })),
      scales: surveyForm.themes.SCALES,
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
      circle: parseJSON(
        req.circle?.survey_theme != null
          ? req.circle.survey_theme
          : (await db.prepare('SELECT survey_theme FROM circles WHERE id = ?').get(req.circleId))?.survey_theme,
        null
      )
    }
  });
});

// GET /api/admin/surveys/:id — one survey, for editing or reviewing
router.get('/surveys/:id', requirePermission('surveys.read'), async (req, res) => {
  const survey = await db.prepare(`
    SELECT s.*,
           c.survey_theme as circle_theme,
           (SELECT COUNT(*) FROM survey_responses sr
             WHERE sr.survey_id = s.id AND sr.completed_at IS NOT NULL) as completed_count
    FROM surveys s
    LEFT JOIN circles c ON c.id = s.circle_id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const { circle_theme, completed_count, ...row } = survey;
  const completed = Number(completed_count || 0);

  res.json({
    survey: surveyForm.hydrate(row),
    circle_theme: parseJSON(circle_theme, null),
    completed_count: completed,
    questions_locked: completed > 0
  });
});



// GET /api/admin/surveys/:id/audience
// "See eligible cohorts of users according to their cohorts for surveys" —
// who this survey would reach, and who is already excluded.
router.get('/surveys/:id/audience', requirePermission('surveys.read'), async (req, res) => {
  const survey = await db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const audience = await resolveAudience(survey);

  const alreadyInvited = new Set(
    ((await db.prepare('SELECT user_id FROM survey_responses WHERE survey_id = ?').all(survey.id) || []) || []).map(r => r.user_id)
  );
  const completed = new Set(
    ((await db.prepare('SELECT user_id FROM survey_responses WHERE survey_id = ? AND completed_at IS NOT NULL')
      .all(survey.id)) || []).map(r => r.user_id)
  );

  const mode = survey.engagement_mode;
  const reachable = [];
  const unreachable = [];
  let completedInAudience = 0;

  for (const user of audience) {
    if (completed.has(user.id)) { completedInAudience++; continue; }
    const { allowed, skipped } = await notifications.resolveChannels(
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
router.post('/surveys', requirePermission('surveys.write'), async (req, res) => {
  const {
    title, description, questions, target_type, target_ids,
    engagement_mode, time_estimate_min, expires_at, trigger_event, reminder_after_days,
    circle_id, status
  } = req.body;

  if (!title || !questions) return res.status(400).json({ error: 'title and questions required' });
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'questions must be an array' });

  const circle = circle_id ? await circles.byId(circle_id) : req.circle;
  if (!circle) return res.status(400).json({ error: 'Unknown circle_id' });

  // Publishing was the one thing this endpoint ignored: the status arrived,
  // was dropped, and every survey was written as a draft — so "Publish" put
  // nothing in front of anyone.
  const opening = status === 'active' ? 'active' : 'draft';

  // A survey that cannot be answered is not saved. Every reason comes back at
  // once, each against the question it belongs to, because fixing five
  // problems one refusal at a time is how a builder gets abandoned. A draft
  // may still be empty — it is being written.
  const definition = await surveyForm.normalizeDefinition(req.body, {
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
  await db.prepare(`
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
    survey: surveyForm.hydrate(await db.prepare('SELECT * FROM surveys WHERE id = ?').get(id)),
    // Saved, but worth a second look — a brand combination that is legible
    // rather than comfortable
    ...(definition.warnings?.length ? { warnings: definition.warnings } : {})
  });
});

// PUT /api/admin/surveys/:id
router.put('/surveys/:id', requirePermission('surveys.write'), async (req, res) => {
  const survey = await db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
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
    const responded = Number((await db.prepare(
      'SELECT COUNT(*) as c FROM survey_responses WHERE survey_id = ? AND completed_at IS NOT NULL'
    ).get(survey.id))?.c || 0);
    if (responded > 0) {
      return res.status(409).json({
        error: `Cannot change questions — ${responded} member(s) have already responded. Close this survey and create a new version.`
      });
    }

    const definition = await surveyForm.normalizeDefinition(req.body, {
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
  await db.prepare(`UPDATE surveys SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  res.json({
    survey: surveyForm.hydrate(await db.prepare('SELECT * FROM surveys WHERE id = ?').get(survey.id)),
    ...(warnings.length ? { warnings } : {})
  });
});

// POST /api/admin/surveys/:id/duplicate
// The same survey again, as a draft. Written because the alternative people
// actually reach for is rewriting forty questions by hand, and the copy they
// end up with is never quite the original — which quietly makes the two rounds
// incomparable, the one thing a repeated survey exists to be.
//
// What is copied is the survey; what is not is anything that belongs to the
// run of it. No responses, no completions, no status — the copy opens as a
// draft, because a duplicate that published itself to the original's audience
// would be the most expensive kind of accident this screen can produce.
router.post('/surveys/:id/duplicate', requirePermission('surveys.write'), async (req, res) => {
  const survey = await db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const hydrated = surveyForm.hydrate(survey);

  // A copy can be lifted into another workspace, which is how a round that
  // worked for one circle gets run by another
  const circle = req.body.circle_id ? await circles.byId(req.body.circle_id) : await circles.byId(survey.circle_id);
  if (!circle) return res.status(400).json({ error: 'Unknown circle_id' });

  const title = String(req.body.title || `${survey.title} (copy)`).trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'A survey needs a title' });

  // Run through the same normalisation a hand-written survey gets. The
  // original was valid when it was saved, but the schema is where a question
  // acquires its identity, and a copy has to acquire its own.
  const definition = await surveyForm.normalizeDefinition({
    questions: surveyForm.copyQuestions(hydrated.questions),
    theme: hydrated.theme
  }, { createdBy: req.admin.id, allowEmpty: true });

  if (definition.issues.length) {
    return res.status(400).json({
      error: surveyForm.issueSummary(definition.issues),
      issues: definition.issues
    });
  }

  // An expiry is a date, not a duration, so carrying a past one over would
  // hand back a copy that is closed before it is published
  const expiry = survey.expires_at &&
    new Date(String(survey.expires_at).replace(' ', 'T')) > new Date() ? survey.expires_at : null;

  const id = uuid();
  await db.prepare(`
    INSERT INTO surveys (id, title, description, questions, theme, target_type, target_ids,
                         engagement_mode, time_estimate_min, expires_at, trigger_event,
                         reminder_after_days, circle_id, created_by, status, public_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
  `).run(
    id, title, survey.description,
    JSON.stringify(definition.questions),
    definition.theme ? JSON.stringify(definition.theme) : null,
    survey.target_type, survey.target_ids,
    survey.engagement_mode, survey.time_estimate_min, expiry, survey.trigger_event,
    survey.reminder_after_days, circle.id, req.admin.id,
    // A fresh link, never the original's. Two surveys cannot share an address
    // — and someone already holding the first one's link must keep reaching
    // the survey they were given, not its successor.
    survey.target_type === surveyForm.ANONYMOUS ? surveyForm.publicToken() : null
  );

  res.status(201).json({
    survey: surveyForm.hydrate(await db.prepare('SELECT * FROM surveys WHERE id = ?').get(id)),
    copied_from: survey.id,
    questions: definition.questions.length,
    ...(definition.warnings?.length ? { warnings: definition.warnings } : {})
  });
});

// POST /api/admin/surveys/:id/invite
// Sends the invitation over the survey's engagement mode. Previously the mode
// was stored and no invitation was ever sent.
router.post('/surveys/:id/invite', requirePermission('surveys.invite'), async (req, res) => {
  const survey = await db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
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
  const audience = await resolveAudience(survey);

  const invited = new Set(
    ((await db.prepare('SELECT user_id FROM survey_responses WHERE survey_id = ?').all(survey.id) || []) || []).map(r => r.user_id)
  );
  const completed = new Set(
    ((await db.prepare('SELECT user_id FROM survey_responses WHERE survey_id = ? AND completed_at IS NOT NULL')
      .all(survey.id)) || []).map(r => r.user_id)
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
      await insertResponse.run(uuid(), survey.id, user.id);
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
  const survey = await db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const pending = await db.prepare(`
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
router.get('/surveys/:id/responses', requirePermission('surveys.read'), async (req, res) => {
  const survey = await db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const responses = await db.prepare(`
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

// ─── Responses collected elsewhere ──────────────────────────
// A survey that was run on paper at a meetup, through Google Forms, or inside
// a partner's own tool comes back as a spreadsheet. Those answers are the same
// evidence as the ones typed in here, and the only thing standing between them
// and the summary screen is a way of landing a sheet against a definition.
//
// All three endpoints are gated on surveys.write rather than a permission of
// their own: an import writes answers into one survey, and being able to
// change what a survey asks already implies being able to say what it
// collected.

// GET /api/admin/surveys/:id/responses/template?format=csv|xlsx
// The blank sheet to fill in, generated from this survey's own questions. Not
// a fixed template like the member import's — the columns *are* the questions,
// so a survey that gains a question gains a column without anybody
// remembering to update a file.
router.get('/surveys/:id/responses/template', requirePermission('surveys.read'), async (req, res) => {
  const survey = await db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const format = String(req.query.format || 'xlsx').toLowerCase();

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="${responseImport.filename(survey, 'csv')}"`);
    // A BOM so Excel opens it as UTF-8 rather than mangling the wording of a
    // question that carries an accent
    return res.send('﻿' + responseImport.toCsvTemplate(survey));
  }

  if (format === 'xlsx') {
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${responseImport.filename(survey, 'xlsx')}"`);
    return res.send(responseImport.toWorkbook(survey));
  }

  res.status(400).json({ error: 'format must be csv or xlsx' });
});

// GET /api/admin/surveys/:id/responses/columns
// The spec behind the template, so a screen can describe the upload without
// keeping a second copy of the column list that drifts from the parser's.
router.get('/surveys/:id/responses/columns', requirePermission('surveys.read'), async (req, res) => {
  const survey = await db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  res.json({
    survey: { id: survey.id, title: survey.title },
    guidance: responseImport.guidance(survey),
    columns: responseImport.columns(survey).map(column => ({
      key: column.key,
      kind: column.kind,
      label: column.kind === 'respondent' ? column.label : column.key,
      required: column.kind === 'question' && !!column.question.required,
      question_id: column.kind === 'question' ? column.question.id : null,
      type: column.kind === 'question' ? column.question.type : null,
      row: column.row || null,
      // A grid packed into one cell is read but not offered — see the note in
      // responseImport.columns
      in_template: column.template !== false,
      accepts: column.kind === 'question'
        ? responseImport.accepts(column.question)
        : column.notes,
      // Every other heading this column answers to, so the screen can say why
      // a Google Forms export lines up without being edited
      also_accepted: column.match
    }))
  });
});

// POST /api/admin/surveys/:id/responses/import
// A sheet of already-collected answers, landed as real responses.
//
// Every row goes through surveyForm.checkResponse — the same check a member's
// submission gets, from the same definition. That is deliberate and it is
// occasionally inconvenient: a form run elsewhere that let people skip a
// question this survey requires will have rows refused. The alternative is a
// survey whose stored responses do not satisfy the rules it states about
// itself, and then every count drawn from it means something slightly
// different depending on which door the answer came in by.
router.post('/surveys/:id/responses/import', requirePermission('surveys.write'), async (req, res) => {
  const survey = await db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  const { csv, xlsx_base64, rows: given, dry_run = false, create_missing = true } = req.body;

  // Which tool the sheet came out of. Free text on purpose — a new form
  // builder should never need a migration — but held to a length, because it
  // is written to every response and every verbatim the import files.
  const sourceSystem = req.body.source_system
    ? String(req.body.source_system).trim().slice(0, 40) || null
    : null;

  const hydrated = surveyForm.hydrate(survey);
  if (!surveyForm.canGoOut(hydrated.questions)) {
    return res.status(400).json({
      error: 'This survey has no questions yet, so there is nothing for a sheet to line up against'
    });
  }

  let rows;
  try {
    if (xlsx_base64) rows = parseXLSX(xlsx_base64);
    else if (csv) rows = parseCSV(csv);
    else if (Array.isArray(given)) rows = given;
    else return res.status(400).json({ error: 'Provide a rows array, a csv string, or xlsx_base64' });
  } catch (err) {
    return res.status(400).json({ error: `Could not read the workbook: ${err.message}` });
  }

  if (!rows.length) {
    return res.status(400).json({
      error: 'No data rows found. The first row must be the headings, with a row per respondent under it.'
    });
  }

  const questions = hydrated.questions;
  const headings = responseImport.index(responseImport.columns(survey));

  const results = {
    imported: 0, skipped: 0, errors: [], preview: [],
    // Reported once for the sheet rather than once per row: a heading that
    // matched nothing is a fact about the file, and repeating it two hundred
    // times would bury everything else
    unmatched_columns: [],
    // Rows that went in and still deserve a look. Kept apart from errors,
    // which are the rows that did not.
    flagged: [],
    matched_members: 0, created_members: 0, added_to_circle: 0,
    anonymous: 0, verbatims: 0, discarded: 0
  };

  const unmatchedColumns = new Set();
  // Addresses this run brought into existence, so a dry run can say which rows
  // would create somebody rather than only how many
  const created = new Set();

  // Ids already spoken for, so a sheet that repeats a reference is caught here
  // with a sentence rather than by a unique index with a constraint error
  const seenExternal = new Set(
    ((await db.prepare(`
      SELECT external_response_id FROM survey_responses
      WHERE survey_id = ? AND external_response_id IS NOT NULL
    `).all(survey.id) || []) || []).map(r => r.external_response_id)
  );

  const completedBy = new Set(
    (await db.prepare(`
      SELECT user_id FROM survey_responses
      WHERE survey_id = ? AND user_id IS NOT NULL AND completed_at IS NOT NULL
    `).all(survey.id) || []).map(r => r.user_id)
  );

  // Scoped to the workspace that owns the survey, exactly as its audience is.
  // A member of another circle could never have been asked this, so a row
  // claiming they answered it is wrong however plausible the address looks.
  // An older survey belonging to no circle is unrestricted, which is what
  // circleScope does with the same absence.
  const findMember = survey.circle_id
    ? db.prepare(`
        SELECT u.id, u.name, u.email FROM users u
        WHERE u.email = ?
          AND u.id IN (SELECT user_id FROM circle_members WHERE circle_id = ?)
      `)
    : db.prepare('SELECT id, name, email FROM users WHERE email = ?');
  const lookup = email => (survey.circle_id
    ? findMember.get(email, survey.circle_id)
    : findMember.get(email)); // awaited at call sites

  // Only consulted to tell two failures apart. "We have never heard of them"
  // and "they are in another workspace" need different things done about them,
  // and one message covering both would send an operator to the wrong screen.
  const findAnywhere = db.prepare('SELECT * FROM users WHERE email = ?');

  // ── Respondents this workspace has not met
  // A round run elsewhere brings its own people. Refusing those rows would
  // mean the answers from developers who are not yet members — often the ones
  // worth hearing from most — are exactly the answers that cannot be imported.
  // So the respondent is created, on the same terms the member import creates
  // one: no password, because members sign in with a one-time code.
  const insertMember = db.prepare(`
    INSERT INTO users (id, email, name, company, password_hash) VALUES (?, ?, ?, ?, ?)
  `);
  const joinCircle = db.prepare(
    'INSERT OR IGNORE INTO circle_members (circle_id, user_id) VALUES (?, ?)'
  );
  const joinCohort = db.prepare(
    'INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)'
  );
  const allMembers = await db.prepare("SELECT id FROM cohorts WHERE name = 'All Members'").get();

  // Bring one respondent into this workspace: either somebody new, or somebody
  // who exists elsewhere and is being recorded as part of this survey's
  // audience. Returns the member, or the reason there is not one.
  async function admit(meta) {
    if (!identity.EMAIL_RE.test(meta.email)) {
      return { ok: false, error: `"${meta.email}" is not a valid email address` };
    }
    // Staff hold a password and a role, which is a different account made on a
    // different screen. Creating one here would make a profile that can never
    // be signed in to — the member import refuses these for the same reason.
    if (identity.isStaffEmail(meta.email)) {
      return {
        ok: false,
        error: `"${meta.email}" is a Credit Direct address — staff are added under Roles, ` +
               'not created by an import'
      };
    }

    const existing = await findAnywhere.get(meta.email);

    if (existing) {
      // Known here, but not in this workspace. Importing a response is an
      // assertion that they were part of this survey's audience, so this is
      // the membership catching up with what already happened rather than a
      // new fact about them.
      if (!create_missing) {
        return {
          ok: false,
          error: `"${meta.email}" belongs to another workspace, so this survey was never ` +
                 'put to them'
        };
      }
      if (!dry_run && survey.circle_id) await joinCircle.run(survey.circle_id, existing.id);
      results.added_to_circle++;
      return { ok: true, member: existing };
    }

    if (!create_missing) {
      return {
        ok: false,
        error: `"${meta.email}" is not a member here — import them under Members first, ` +
               'or clear the email to file these answers with nobody attached'
      };
    }

    const id = uuid();
    if (!dry_run) {
      await insertMember.run(id, meta.email, meta.name || meta.email.split('@')[0],
        meta.company || null, identity.NO_PASSWORD);

      if (survey.circle_id) await joinCircle.run(survey.circle_id, id);
      if (allMembers) await joinCohort.run(id, allMembers.id);

      await engagement.log(id, 'account_created', {
        metadata: { via: 'survey_response_import', survey_id: survey.id, source_system: sourceSystem },
        source: 'manual'
      });
    }

    results.created_members++;
    created.add(meta.email);
    return { ok: true, member: { id, name: meta.name || meta.email, email: meta.email } };
  }

  // A survey addressed to whoever holds its link expects respondents with no
  // name on them; one put to a named audience does not. That is the difference
  // between a blank email being the point of the round and a blank email being
  // a column that did not line up.
  const anonymousExpected = survey.target_type === surveyForm.ANONYMOUS;

  // A member who was invited already has a response waiting on them. Filling
  // that one in is the truthful record — inserting a second would leave the
  // survey reporting one more invitation than it ever sent.
  const findPending = db.prepare(`
    SELECT id FROM survey_responses
    WHERE survey_id = ? AND user_id = ? AND completed_at IS NULL
  `);

  const insertResponse = db.prepare(`
    INSERT INTO survey_responses (id, survey_id, user_id, answers, completed_at, triggered_by,
                                  respondent_kind, source_system, external_response_id)
    VALUES (?, ?, ?, ?, ?, 'import', ?, ?, ?)
  `);
  const completeResponse = db.prepare(`
    UPDATE survey_responses
    SET answers = ?, completed_at = ?, triggered_by = 'import',
        source_system = ?, external_response_id = ?
    WHERE id = ?
  `);

  for (const [index, raw] of rows.entries()) {
      const line = index + 2;                 // the heading row is line 1 in the sheet
      const fail = error => results.errors.push({ line, error });

      const { meta, answers, unmatched } = responseImport.readRow(headings, raw);
      for (const heading of unmatched) unmatchedColumns.add(heading);

      if (!Object.keys(answers).length) {
        fail('No column in this row matched a question in the survey');
        continue;
      }

      // An email that names nobody here is refused rather than quietly
      // detached. Filing the answers with no member attached would look
      // identical to a deliberate anonymous row, and the operator would never
      // learn that the person they meant to credit was not credited.
      let member = null;

      if (meta.email) {
        member = await lookup(meta.email);

        if (!member) {
          const admitted = await admit(meta);
          if (!admitted.ok) { fail(admitted.error); continue; }
          member = admitted.member;
        }

        if (completedBy.has(member.id)) {
          results.skipped++;
          continue;
        }
      } else if (!anonymousExpected) {
        // Flagged, not refused: the answers are real either way, and a row
        // dropped here would have to come back in a later run, which without a
        // reference means importing the whole sheet again. Said out loud
        // instead, where a dry run puts it in front of the operator before
        // anything is written.
        results.flagged.push({
          line,
          reason: 'No email, on a survey that was put to named people — check the column ' +
                  'lined up before accepting this as an anonymous reply'
        });
      }

      if (meta.externalId) {
        if (seenExternal.has(meta.externalId)) {
          results.skipped++;
          continue;
        }
      }

      const checked = surveyForm.checkResponse(questions, answers);
      if (!checked.ok) {
        // Named by their wording rather than their slot id: the operator is
        // looking at a spreadsheet column, not at a question id they have
        // never seen
        const named = Object.entries(checked.errors).map(([id, message]) => {
          const question = questions.find(q => q.id === id);
          return `${question ? question.text : id} — ${message}`;
        });
        fail(named.join('; '));
        continue;
      }

      results.discarded += checked.dropped.length;

      if (member) { results.matched_members++; completedBy.add(member.id); }
      else results.anonymous++;
      if (meta.externalId) seenExternal.add(meta.externalId);

      if (dry_run) {
        results.imported++;
        if (results.preview.length < 10) {
          results.preview.push({
            line,
            member: member ? member.name : null,
            email: member ? member.email : null,
            // Whether accepting this sheet would also create the person
            new_member: created.has(meta.email),
            answered: checked.asked.filter(id => checked.answers[id] !== undefined).length,
            submitted_at: meta.submittedAt
          });
        }
        continue;
      }

      const at = meta.submittedAt || now();
      const serialized = JSON.stringify(checked.answers);

      const pending = member ? await findPending.get(survey.id, member.id) : null;
      const responseId = pending ? pending.id : uuid();

      if (pending) {
        await completeResponse.run(serialized, at, sourceSystem, meta.externalId || null, responseId);
      } else {
        await insertResponse.run(
          responseId, survey.id, member ? member.id : null, serialized, at,
          // Not 'anonymous': nobody answered this under a promise of
          // anonymity. It is a response with no account behind it, which is a
          // different thing and is worth being able to tell apart later.
          // A response with no account behind it on a link survey is anonymous
          // in the sense the word promises whoever answered. On a survey put
          // to named people it is simply one we could not attach, which is a
          // different thing and worth being able to tell apart later.
          member ? 'member' : (anonymousExpected ? 'anonymous' : 'external'),
          sourceSystem, meta.externalId || null
        );
      }

      // What was written in a sheet is what a developer told us, on the same
      // terms as anything typed in here
      const { filed } = await verbatims.record(member ? member.id : null, survey, checked.answers, {
        at, responseId, sourceSystem, externalResponseId: meta.externalId || null
      });
      results.verbatims += filed;

      if (member) {
        // log() rather than record(): a streak measures what someone has done
        // lately, and a response transcribed today from a form they filled in
        // last March is not activity today. The history gains the event; the
        // counter is left alone.
        await engagement.log(member.id, 'survey_completed', {
          referenceId: survey.id,
          metadata: { survey_title: survey.title, via: 'import', source_system: sourceSystem },
          source: 'manual'
        });
      }

      results.imported++;
  }

  results.unmatched_columns = [...unmatchedColumns];

  // Creating people is the part of this an operator most needs told, so it is
  // in the sentence rather than only in a counter further down
  const people = results.created_members
    ? `, ${results.created_members} new member${results.created_members === 1 ? '' : 's'}`
    : '';

  res.json({
    message: dry_run
      ? `Checked: ${results.imported} response(s) would be imported${people}` +
        (results.skipped ? `, ${results.skipped} already here` : '') +
        (results.errors.length ? `, ${results.errors.length} refused` : '')
      : `Imported ${results.imported} response(s)${people}` +
        (results.skipped ? `, ${results.skipped} already here` : '') +
        (results.errors.length ? `, ${results.errors.length} refused` : ''),
    dry_run,
    ...results
  });
});

// GET /api/admin/surveys/:id/export
router.get('/surveys/:id/export', requirePermission('export.read'), async (req, res) => {
  const survey = await db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });

  // Sections hold no answer, so they hold no column
  const questions = surveyForm.hydrate(survey).questions.filter(surveyForm.isAnswerable);

  const responses = await db.prepare(`
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
