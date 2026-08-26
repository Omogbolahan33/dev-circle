const express = require('express');
const db = require('../../db');
const { uuid, parseJSON } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const onboarding = require('../../services/onboarding');
const surveyForm = require('../../services/surveyForm');
const circles = require('../../services/circles');

const router = express.Router();

// ─── Onboarding forms, from the admin side ──────────────────
// Authoring the form, publishing it, and deciding on what comes back.
//
// A form belongs to the circle it onboards into, and every query here is
// scoped to the circle being worked in — including the queue, because an
// application is addressed to one workspace and a lead for another has no
// business reading the personal details in it.

// ─── The forms ──────────────────────────────────────────────

router.get('/onboarding', requirePermission('onboarding.read'), async (req, res) => {
  const forms = await db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM onboarding_submissions s
        WHERE s.form_id = f.id AND s.status = 'pending') as pending_count,
      (SELECT COUNT(*) FROM onboarding_submissions s
        WHERE s.form_id = f.id AND s.status = 'approved') as approved_count,
      (SELECT COUNT(*) FROM onboarding_submissions s
        WHERE s.form_id = f.id AND s.status NOT IN ('started')) as submission_count
    FROM onboarding_forms f
    WHERE f.circle_id = ?
    ORDER BY f.created_at DESC
  `).all(req.circleId);

  res.json({ forms: forms.map(onboarding.hydrate) });
});

// GET /api/admin/onboarding/schema
// What an onboarding form may contain. The question types, the branching
// operators and the theme come from the survey schema unchanged — it is the
// same builder over the same definition — and what is added is the list of
// profile fields a question may be tagged with.
router.get('/onboarding/schema', requirePermission('onboarding.read'), async (req, res) => {
  res.json({
    types: surveyForm.TYPES,
    operators: surveyForm.OPERATORS,
    operators_by_type: Object.fromEntries(
      [...surveyForm.CONDITIONABLE].map(type => [type, surveyForm.operatorsFor(type)])
    ),
    text_formats: Object.entries(surveyForm.TEXT_FORMATS).map(([value, f]) => ({ value, label: f.label })),
    rating_styles: surveyForm.RATING_STYLES,

    // Which questions can be understood as facts about the person, and what
    // may carry each. The builder draws its "this answer is…" menu from this
    // rather than holding its own copy, so a field added to the service
    // appears in the builder without a second edit.
    fields: Object.entries(onboarding.FIELDS).map(([value, field]) => ({
      value,
      label: field.label,
      hint: field.hint || null,
      types: field.types,
      essential: !!field.essential,
      // A channel field only accepts options that name a channel, so the
      // builder can offer them rather than leaving an author to guess
      channels: field.channels ? require('../../services/notifications').CHANNELS : null,
      days: value === 'preferred_days' ? onboarding.DAYS : null
    })),

    theme: {
      defaults: surveyForm.themes.DEFAULTS,
      fonts: Object.entries(surveyForm.themes.FONTS).map(([value, f]) => ({
        value, label: f.label, category: f.category, stack: f.stack, note: f.note,
        device: !!f.device, needs_upload: !!f.needsUpload
      })),
      scales: surveyForm.themes.SCALES,
      backgrounds: surveyForm.themes.BACKGROUNDS,
      corners: surveyForm.themes.CORNERS,
      layouts: surveyForm.themes.LAYOUTS,
      progress: surveyForm.themes.PROGRESS,
      modes: surveyForm.themes.MODES,
      fits: surveyForm.themes.FITS,
      contrast: { floor: surveyForm.themes.FLOOR, comfortable: surveyForm.themes.AA },
      circle: parseJSON(req.circle?.survey_theme, null)
    }
  });
});

async function formInCircle(req) {
  return await db.prepare('SELECT * FROM onboarding_forms WHERE id = ? AND circle_id = ?')
    .get(req.params.id, req.circleId);
}

router.get('/onboarding/:id', requirePermission('onboarding.read'), async (req, res) => {
  const form = await formInCircle(req);
  if (!form) return res.status(404).json({ error: 'Form not found' });

  const counts = await db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')  as pending,
      COUNT(*) FILTER (WHERE status = 'approved') as approved,
      COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
      COUNT(*) FILTER (WHERE status = 'started')  as unfinished
    FROM onboarding_submissions WHERE form_id = ?
  `).get(form.id);

  res.json({
    form: onboarding.hydrate(form),
    counts,
    // Questions are fixed once applications exist, for the same reason a
    // survey's are: rewriting one leaves answers attached to wording nobody
    // was shown — and here those answers are somebody's personal details,
    // filed under a question that no longer asks what it asked.
    questions_locked: (counts.pending + counts.approved + counts.rejected) > 0,
    circle_theme: parseJSON(req.circle?.survey_theme, null),
    embed_snippet: form.public_token ? snippet(req, form) : null
  });
});

// The two lines somebody pastes into their own page. Assembled here rather
// than in the builder so there is one definition of what an embed looks like,
// and so the address in it is the address this deployment actually answers on.
function snippet(req, form) {
  const base = `${req.protocol}://${req.get('host')}`;
  return `<div data-devcircle-onboarding="${form.public_token}"></div>\n` +
         `<script src="${base}/embed/onboarding.js" async></script>`;
}

// What has to be true before a form can be published, checked in one place so
// it holds whether the form is being created active or edited into active.
function refuseIfNotReady(res, definition, status) {
  if (definition.issues.length) {
    res.status(400).json({
      error: surveyForm.issueSummary(definition.issues),
      issues: definition.issues
    });
    return true;
  }

  if (status === 'active') {
    const blocking = onboarding.canGoOut(definition.questions);
    if (blocking.length) {
      res.status(400).json({ error: surveyForm.issueSummary(blocking), issues: blocking });
      return true;
    }
  }

  return false;
}

// Cohorts an approved applicant joins. Only cohorts of this circle: a form
// that could add somebody to another workspace's cohort would move people
// between circles without anybody choosing to.
async function cohortsInCircle(ids, circleId) {
  const wanted = Array.isArray(ids) ? ids : [];
  if (!wanted.length) return [];
  const known = (await db.prepare('SELECT id FROM cohorts WHERE circle_id = ?').all(circleId)).map(c => c.id);
  return wanted.filter(id => known.includes(id));
}

router.post('/onboarding', requirePermission('onboarding.write'), async (req, res) => {
  const { name, description, redirect_url, submitted_message, duplicate_policy, status } = req.body;

  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

  const opening = status === 'active' ? 'active' : 'draft';

  const definition = await onboarding.normalizeDefinition(req.body, {
    createdBy: req.admin.id,
    allowEmpty: opening !== 'active'
  });

  const { origins, issues: originIssues } = onboarding.normalizeOrigins(req.body.allowed_origins);
  definition.issues.push(...originIssues.map(i => ({ index: -1, ...i })));

  if (refuseIfNotReady(res, definition, opening)) return;

  const policy = ['replace', 'reject', 'allow'].includes(duplicate_policy) ? duplicate_policy : 'replace';

  const id = uuid();
  await db.prepare(`
    INSERT INTO onboarding_forms (id, circle_id, name, description, questions, theme, field_map,
                                  cohort_ids, status, public_token, allowed_origins,
                                  redirect_url, submitted_message, duplicate_policy, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.circleId, String(name).trim(), description || null,
    JSON.stringify(definition.questions),
    definition.theme ? JSON.stringify(definition.theme) : null,
    JSON.stringify(definition.field_map),
    JSON.stringify(await cohortsInCircle(req.body.cohort_ids, req.circleId)),
    opening,
    // The token exists from the moment the form does, so the snippet can be
    // copied out of the builder on the first save rather than after a second
    // step nobody remembers to take.
    onboarding.publicToken(),
    JSON.stringify(origins),
    redirect_url || null, submitted_message || null, policy, req.admin.id
  );

  const form = await db.prepare('SELECT * FROM onboarding_forms WHERE id = ?').get(id);
  res.status(201).json({
    form: onboarding.hydrate(form),
    embed_snippet: snippet(req, form),
    ...(definition.warnings?.length ? { warnings: definition.warnings } : {})
  });
});

router.put('/onboarding/:id', requirePermission('onboarding.write'), async (req, res) => {
  const form = await formInCircle(req);
  if (!form) return res.status(404).json({ error: 'Form not found' });

  const decided = (await db.prepare(
    "SELECT COUNT(*) as n FROM onboarding_submissions WHERE form_id = ? AND status != 'started'"
  ).get(form.id)).n;

  const wanted = ['draft', 'active', 'closed'].includes(req.body.status) ? req.body.status : form.status;

  // Questions are frozen once applications exist. The look, the origins it may
  // be embedded on, where it sends people afterwards and whether it is open
  // can all still change — none of those alters what anybody was asked.
  let questions = onboarding.hydrate(form).questions;
  let field_map = parseJSON(form.field_map, {});
  let theme = parseJSON(form.theme, null);
  let warnings = [];

  // Checked before either branch: where a form may be embedded can change
  // whether or not its questions are frozen, so refusing a bad origin cannot
  // live inside the branch that still rewrites questions. It did, and a locked
  // form silently dropped what it could not parse.
  const { origins, issues: originIssues } = onboarding.normalizeOrigins(req.body.allowed_origins);
  if (originIssues.length) {
    return res.status(400).json({
      error: originIssues[0].message,
      issues: originIssues.map(i => ({ index: -1, ...i }))
    });
  }

  if (decided > 0) {
    // The theme is still the author's to change, so it is normalized on its
    // own rather than skipped with the questions.
    const themed = surveyForm.themes.normalize(req.body.theme);
    if (themed.issues.length) {
      return res.status(400).json({
        error: themed.issues[0].message,
        issues: themed.issues.map(i => ({ index: -1, field: `theme.${i.field}`, message: i.message }))
      });
    }
    theme = themed.theme;
    warnings = themed.warnings || [];

    if (Array.isArray(req.body.questions)) {
      const posted = JSON.stringify(req.body.questions.map(q => ({ id: q.id, text: q.text, type: q.type })));
      const held = JSON.stringify(questions.map(q => ({ id: q.id, text: q.text, type: q.type })));
      if (posted !== held) {
        return res.status(409).json({
          error: `${decided} ${decided === 1 ? 'person has' : 'people have'} already filled this in, so the questions are fixed. Close it and write a new one to ask differently.`
        });
      }
    }
  } else {
    const definition = await onboarding.normalizeDefinition(req.body, {
      createdBy: req.admin.id,
      allowEmpty: wanted !== 'active'
    });

    if (refuseIfNotReady(res, definition, wanted)) return;

    questions = definition.questions;
    field_map = definition.field_map;
    theme = definition.theme;
    warnings = definition.warnings || [];
  }

  // Publishing a frozen form still has to be publishable — a draft that was
  // saved without an email question must not become active through an edit
  // that only changed its colours.
  if (wanted === 'active') {
    const blocking = onboarding.canGoOut(questions);
    if (blocking.length) {
      return res.status(400).json({ error: surveyForm.issueSummary(blocking), issues: blocking });
    }
  }

  const policy = ['replace', 'reject', 'allow'].includes(req.body.duplicate_policy)
    ? req.body.duplicate_policy : form.duplicate_policy;

  await db.prepare(`
    UPDATE onboarding_forms
    SET name = ?, description = ?, questions = ?, theme = ?, field_map = ?, cohort_ids = ?,
        status = ?, allowed_origins = ?, redirect_url = ?, submitted_message = ?,
        duplicate_policy = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    req.body.name ? String(req.body.name).trim() : form.name,
    req.body.description ?? form.description,
    JSON.stringify(questions),
    theme ? JSON.stringify(theme) : null,
    JSON.stringify(field_map),
    JSON.stringify(await cohortsInCircle(req.body.cohort_ids, req.circleId)),
    wanted,
    JSON.stringify(origins),
    req.body.redirect_url ?? form.redirect_url,
    req.body.submitted_message ?? form.submitted_message,
    policy,
    form.id
  );

  const updated = await db.prepare('SELECT * FROM onboarding_forms WHERE id = ?').get(form.id);
  res.json({
    form: onboarding.hydrate(updated),
    embed_snippet: snippet(req, updated),
    ...(warnings.length ? { warnings } : {})
  });
});

// Copying a form. Every slot gets a fresh id and the branching rules are
// rewritten to match — surveyForm.copyQuestions is where that is explained,
// and the mapping is rebuilt against the new ids in the same pass.
router.post('/onboarding/:id/duplicate', requirePermission('onboarding.write'), async (req, res) => {
  const form = await formInCircle(req);
  if (!form) return res.status(404).json({ error: 'Form not found' });

  const questions = surveyForm.copyQuestions(onboarding.hydrate(form).questions);
  const field_map = Object.fromEntries(
    questions.filter(q => q.maps_to).map(q => [q.id, q.maps_to])
  );

  const id = uuid();
  await db.prepare(`
    INSERT INTO onboarding_forms (id, circle_id, name, description, questions, theme, field_map,
                                  cohort_ids, status, public_token, allowed_origins,
                                  redirect_url, submitted_message, duplicate_policy, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
  `).run(
    id, form.circle_id, `${form.name} (copy)`, form.description,
    JSON.stringify(questions), form.theme, JSON.stringify(field_map), form.cohort_ids,
    // A copy is a different form, so it gets a different address. Sharing one
    // would mean closing the original closed the copy.
    onboarding.publicToken(),
    form.allowed_origins, form.redirect_url, form.submitted_message,
    form.duplicate_policy, req.admin.id
  );

  res.status(201).json({
    form: onboarding.hydrate(await db.prepare('SELECT * FROM onboarding_forms WHERE id = ?').get(id))
  });
});

// A form that nobody has filled in can be deleted. One that somebody has is
// closed instead — deleting it would take the applications with it, and those
// are the record of what people were asked and what they were told.
router.delete('/onboarding/:id', requirePermission('onboarding.write'), async (req, res) => {
  const form = await formInCircle(req);
  if (!form) return res.status(404).json({ error: 'Form not found' });

  const submissions = (await db.prepare(
    "SELECT COUNT(*) as n FROM onboarding_submissions WHERE form_id = ? AND status != 'started'"
  ).get(form.id)).n;

  if (submissions > 0) {
    return res.status(409).json({
      error: `${submissions} ${submissions === 1 ? 'person has' : 'people have'} filled this in. Close it instead — deleting it would delete their applications too.`
    });
  }

  await db.prepare('DELETE FROM onboarding_forms WHERE id = ?').run(form.id);
  res.json({ message: 'Form deleted' });
});

// ─── The queue ──────────────────────────────────────────────

// Applications across every form in this circle. Unfinished ones are left out
// by default: somebody who opened a form and stopped typing has not applied,
// and a queue full of blank rows is a queue nobody works through.
router.get('/onboarding-applications', requirePermission('onboarding.read'), async (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'withdrawn', 'started'].includes(req.query.status)
    ? req.query.status : 'pending';

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const formId = req.query.form_id || null;

  const rows = await db.prepare(`
    SELECT s.id, s.form_id, s.email, s.name, s.status, s.submitted_at, s.created_at,
           s.source_origin, s.source_page, s.decided_at, s.decision_note, s.user_id,
           f.name as form_name,
           a.name as decided_by_name
    FROM onboarding_submissions s
    JOIN onboarding_forms f ON f.id = s.form_id
    LEFT JOIN admin_users a ON a.id = s.decided_by
    WHERE s.circle_id = ? AND s.status = ? ${formId ? 'AND s.form_id = ?' : ''}
    ORDER BY COALESCE(s.submitted_at, s.created_at) DESC
    LIMIT ? OFFSET ?
  `).all(...[req.circleId, status, ...(formId ? [formId] : []), limit, offset]);

  const total = (await db.prepare(`
    SELECT COUNT(*) as n FROM onboarding_submissions
    WHERE circle_id = ? AND status = ? ${formId ? 'AND form_id = ?' : ''}
  `).get(...[req.circleId, status, ...(formId ? [formId] : [])])).n;

  res.json({ applications: rows, total, pending: await pendingCount(req.circleId) });
});

async function pendingCount(circleId) {
  return (await db.prepare(
    "SELECT COUNT(*) as n FROM onboarding_submissions WHERE circle_id = ? AND status = 'pending'"
  ).get(circleId)).n;
}

// One application, in full: what they were asked, what they answered, and what
// of it the form understood as a fact about them. All three, because a
// reviewer deciding whether to let somebody into a workspace is entitled to
// see the answers in the words they were given rather than a summary of them.
router.get('/onboarding-applications/:id', requirePermission('onboarding.read'), async (req, res) => {
  const submission = await db.prepare(`
    SELECT s.*, f.name as form_name, f.questions as form_questions, a.name as decided_by_name
    FROM onboarding_submissions s
    JOIN onboarding_forms f ON f.id = s.form_id
    LEFT JOIN admin_users a ON a.id = s.decided_by
    WHERE s.id = ? AND s.circle_id = ?
  `).get(req.params.id, req.circleId);

  if (!submission) return res.status(404).json({ error: 'Application not found' });

  const answers = parseJSON(submission.answers, {});
  const questions = parseJSON(submission.form_questions, []);

  // Only what this applicant was actually shown. A branch they never went
  // down is not an unanswered question, and listing it as one is how a
  // reviewer comes to believe somebody skipped something.
  const asked = surveyForm.visible(questions, answers).map(question => ({
    id: question.id,
    text: question.text,
    type: question.type,
    maps_to: question.maps_to || null,
    answer: answers[question.id] ?? null,
    answer_text: surveyForm.answerToText(question, answers[question.id])
  }));

  const email = submission.email;
  res.json({
    application: {
      ...submission,
      answers,
      profile: parseJSON(submission.profile, {}),
      consent_channels: parseJSON(submission.consent_channels, []),
      form_questions: undefined
    },
    asked,
    // Whether approving this would create an account or join an existing one
    // to the circle. Worth knowing before deciding: the second is somebody who
    // is already a member somewhere in the platform.
    existing_member: email
      ? (await db.prepare('SELECT id, name, email, created_at FROM users WHERE lower(email) = ?').get(email)) || null
      : null
  });
});

router.post('/onboarding-applications/:id/approve', requirePermission('onboarding.approve'), async (req, res) => {
  const submission = await db.prepare(
    'SELECT id FROM onboarding_submissions WHERE id = ? AND circle_id = ?'
  ).get(req.params.id, req.circleId);
  if (!submission) return res.status(404).json({ error: 'Application not found' });

  try {
    const result = await onboarding.approve(submission.id, { adminId: req.admin.id, note: req.body?.note });
    res.json({ message: result.created ? 'Member created' : 'Existing member joined to this circle', ...result });
  } catch (err) {
    if (err instanceof onboarding.OnboardingError) return res.status(409).json({ error: err.message });
    throw err;
  }
});

router.post('/onboarding-applications/:id/reject', requirePermission('onboarding.approve'), async (req, res) => {
  const submission = await db.prepare(
    'SELECT id FROM onboarding_submissions WHERE id = ? AND circle_id = ?'
  ).get(req.params.id, req.circleId);
  if (!submission) return res.status(404).json({ error: 'Application not found' });

  try {
    await onboarding.reject(submission.id, { adminId: req.admin.id, note: req.body?.note });
    res.json({ message: 'Application rejected' });
  } catch (err) {
    if (err instanceof onboarding.OnboardingError) return res.status(409).json({ error: err.message });
    throw err;
  }
});

module.exports = router;
