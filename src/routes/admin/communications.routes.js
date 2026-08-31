const express = require('express');

const { requirePermission } = require('../../middleware/auth');
const templates = require('../../services/emailTemplates');
const { renderTemplate } = require('../../services/email/templates');
const circles = require('../../services/circles');
const config = require('../../config');

// ─── Communications ─────────────────────────────────────────
// What this workspace's automated mail says. Gated on circles.write, the same
// permission that lets somebody set the circle's brand — this is the same kind
// of decision about how a workspace presents itself, and giving it its own
// permission would mean a migration and two roles to remember to update.

const router = express.Router();

// Enough of each variable to make a preview read like a real email rather than
// like a form. Deliberately not real data: a preview should never depend on
// there being a survey in the database, and should never show one member's
// details to whoever is editing.
const SAMPLE = {
  recipient_name: 'Chidi Nwosu',
  product_name: 'Dev Circle',
  organisation: 'Credit Direct',
  portal_url: config.appUrl,
  survey_title: 'How is the sandbox treating you?',
  survey_description: 'Six questions on your first week against the API.',
  survey_url: `${config.appUrl}/member/survey.html?id=preview`,
  time_estimate: '3',
  question_count: '6',
  session_title: 'Office hours: webhooks',
  session_time: 'Tuesday 14:00',
  session_location: 'Google Meet',
  session_url: `${config.appUrl}/member/sessions.html`,
  gift_name: 'Dev Circle hoodie',
  feedback_title: 'Webhook retries are unclear',
  feedback_status: 'resolved',
  role_name: 'Admin',
  invited_by: 'Adaeze Okonkwo',
  login_url: `${config.appUrl}/`,
  code: '482915',
  expires_in_minutes: '10',
  title: 'A note from the team'
};

// The data each renderer wants, in its own camelCase, so a preview exercises
// the real template rather than a stand-in for it.
const PREVIEW_DATA = {
  survey_invite: { surveyTitle: SAMPLE.survey_title, surveyDescription: SAMPLE.survey_description, surveyUrl: SAMPLE.survey_url, timeEstimateMin: 3, questionCount: 6 },
  survey_reminder: { surveyTitle: SAMPLE.survey_title, surveyUrl: SAMPLE.survey_url },
  session_invite: { sessionTitle: SAMPLE.session_title, when: SAMPLE.session_time, location: SAMPLE.session_location, sessionUrl: SAMPLE.session_url },
  session_reminder: { sessionTitle: SAMPLE.session_title, when: SAMPLE.session_time, location: SAMPLE.session_location, sessionUrl: SAMPLE.session_url },
  gift_claimed: { giftName: SAMPLE.gift_name },
  feedback_update: { feedbackTitle: SAMPLE.feedback_title, status: SAMPLE.feedback_status },
  staff_invite: { roleName: SAMPLE.role_name, invitedByName: SAMPLE.invited_by, loginUrl: SAMPLE.login_url },
  blast: { title: SAMPLE.title, body: 'The body of the announcement is written when it is sent.' },
  login_code: { code: SAMPLE.code, expiresInMinutes: 10 },
  generic: { title: SAMPLE.title, body: 'Whatever the notice says.' }
};

function previewFor(workflow) {
  return {
    appUrl: config.appUrl,
    recipientName: SAMPLE.recipient_name,
    ...(PREVIEW_DATA[workflow] || PREVIEW_DATA.generic)
  };
}

// GET /api/admin/email-templates
router.get('/email-templates', requirePermission('circles.write'), async (req, res) => {
  const circle = await circles.byId(req.circleId);
  res.json({
    circle: circle ? { id: circle.id, name: circle.name } : null,
    // The brand this circle's mail carries, so the screen can say whether an
    // email will look like the workspace or like the platform.
    brand: await templates.brandFor(req.circleId, { appUrl: config.appUrl }),
    workflows: await templates.forCircle(req.circleId),
    limits: templates.LIMITS
  });
});

// PUT /api/admin/email-templates/:workflow
router.put('/email-templates/:workflow', requirePermission('circles.write'), async (req, res) => {
  const { workflow } = req.params;
  if (!templates.isWorkflow(workflow)) {
    return res.status(404).json({ error: 'No such email workflow' });
  }

  const { subject, intro, outro, body_html } = req.body || {};
  try {
    const saved = await templates.save(
      req.circleId, workflow, { subject, intro, outro, body_html }, req.admin.id
    );
    res.json({
      message: saved ? 'Saved — this workspace now sends its own wording' : 'Back to the wording this platform ships',
      workflow,
      override: saved
    });
  } catch (err) {
    if (err instanceof templates.TemplateError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// DELETE /api/admin/email-templates/:workflow
router.delete('/email-templates/:workflow', requirePermission('circles.write'), async (req, res) => {
  const { workflow } = req.params;
  if (!templates.isWorkflow(workflow)) {
    return res.status(404).json({ error: 'No such email workflow' });
  }
  await templates.reset(req.circleId, workflow);
  res.json({ message: 'Back to the wording this platform ships', workflow });
});

// POST /api/admin/email-templates/:workflow/preview
// Renders what would actually go out. Takes the draft in the body rather than
// what is saved, so somebody can see a change before committing to it.
router.post('/email-templates/:workflow/preview', requirePermission('circles.write'), async (req, res) => {
  const { workflow } = req.params;
  if (!templates.isWorkflow(workflow)) {
    return res.status(404).json({ error: 'No such email workflow' });
  }

  const draft = req.body || {};
  const has = draft.subject || draft.intro || draft.outro || draft.body_html;
  const stored = has ? null : await templates.get(req.circleId, workflow);
  const source = has ? draft : stored;

  const overrides = source ? {
    subject: templates.fill(source.subject, SAMPLE),
    intro: templates.fill(source.intro, SAMPLE),
    outro: templates.fill(source.outro, SAMPLE),
    body_html: templates.fill(
      source.body_html ? templates.sanitizeBody(source.body_html) : null, SAMPLE)
  } : null;

  const rendered = renderTemplate(workflow, previewFor(workflow), {
    overrides,
    brand: await templates.brandFor(req.circleId, { appUrl: config.appUrl })
  });

  res.json({
    workflow,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    // What the platform would send if this override did not exist, so the two
    // can be put side by side.
    is_customised: Boolean(overrides)
  });
});

module.exports = router;
