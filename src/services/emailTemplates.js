const crypto = require('crypto');
const db = require('../db');
const { createTtlCache } = require('../utils/ttlCache');

// ─── What outbound mail says ─────────────────────────────────
// The wording of every automated email used to live only in
// services/email/templates/*.js, which put the sentence a developer reads when
// they are invited to something out of reach of the people doing the inviting.
//
// A stored row is an override and nothing more. Each field falls back on its
// own, so changing a subject line does not mean adopting a body, and a workflow
// nobody has touched renders exactly the code it always did. That is what makes
// this safe to ship: the defaults are not copied into the database on install,
// they stay in code, and reverting is deleting a row.
//
// Overrides are per circle, because everything else authored here is — a
// survey, a cohort, a session, a form all belong to one workspace, and an
// invitation is that workspace speaking.

// The variables a workflow can put in a subject or a body, written {{like_this}}.
// Deliberately a short, named list per workflow rather than "whatever is in the
// data": an author should be offered the things that exist here, and a typo
// should leave visible evidence rather than silently emptying a sentence.
const COMMON = ['recipient_name', 'product_name', 'organisation', 'portal_url'];

const WORKFLOWS = [
  {
    key: 'survey_invite',
    label: 'Survey invitation',
    description: 'Sent when somebody is invited to a survey.',
    defaultSubject: "You're invited: {{survey_title}}",
    variables: [...COMMON, 'survey_title', 'survey_description', 'survey_url', 'time_estimate', 'question_count']
  },
  {
    key: 'survey_reminder',
    label: 'Survey reminder',
    description: 'The nudge for a survey somebody has not answered yet.',
    defaultSubject: 'Reminder: {{survey_title}}',
    variables: [...COMMON, 'survey_title', 'survey_url']
  },
  {
    key: 'session_invite',
    label: 'Session invitation',
    description: 'Sent when a session is announced.',
    defaultSubject: 'Invited: {{session_title}}',
    variables: [...COMMON, 'session_title', 'session_time', 'session_location', 'session_url']
  },
  {
    key: 'session_reminder',
    label: 'Session reminder',
    description: 'Sent ahead of a session somebody is expected at.',
    defaultSubject: 'Upcoming: {{session_title}}',
    variables: [...COMMON, 'session_title', 'session_time', 'session_location', 'session_url']
  },
  {
    key: 'gift_claimed',
    label: 'Reward claimed',
    description: 'Confirms a reward a member has claimed.',
    defaultSubject: 'Gift claimed: {{gift_name}}',
    variables: [...COMMON, 'gift_name']
  },
  {
    key: 'feedback_update',
    label: 'Feedback reply',
    description: 'Sent when feedback somebody raised changes state.',
    defaultSubject: 'Update on feedback: {{feedback_title}}',
    variables: [...COMMON, 'feedback_title', 'feedback_status']
  },
  {
    key: 'staff_invite',
    label: 'Staff invitation',
    description: 'Sent to a colleague being given access to the console.',
    defaultSubject: 'You have been invited to {{organisation}} {{product_name}}',
    variables: [...COMMON, 'role_name', 'invited_by', 'login_url']
  },
  {
    key: 'blast',
    label: 'Broadcast',
    description: 'The wrapper around an announcement. The announcement itself is written when it is sent.',
    defaultSubject: '{{title}}',
    variables: [...COMMON, 'title']
  },
  {
    key: 'login_code',
    label: 'Sign-in code',
    description: 'Carries a one-time code. The code itself is always inserted by the platform.',
    defaultSubject: '{{code}} is your {{product_name}} sign-in code',
    variables: [...COMMON, 'code', 'expires_in_minutes']
  },
  {
    key: 'generic',
    label: 'Platform notice',
    description: 'The fallback for anything without a template of its own.',
    defaultSubject: '{{title}}',
    variables: [...COMMON, 'title']
  }
];

const BY_KEY = new Map(WORKFLOWS.map(w => [w.key, w]));

function definitions() {
  return WORKFLOWS.map(w => ({ ...w, variables: [...w.variables] }));
}

function isWorkflow(key) {
  return BY_KEY.has(String(key));
}

// ─── Filling a template in ───────────────────────────────────
// {{name}} and nothing else. An unknown name is left standing rather than
// blanked, so a typo shows up in a preview as itself instead of quietly
// deleting half a sentence — the author can see what they wrote.
const VARIABLE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

function fill(text, values) {
  if (!text) return text;
  return String(text).replace(VARIABLE, (whole, name) => {
    const value = values[name.toLowerCase()];
    return value === undefined || value === null || value === '' ? whole : String(value);
  });
}

// Names an author never has to be given, because they are true of every mail.
function withCommon(values, { product, organisation, portalUrl, recipientName }) {
  return {
    product_name: product,
    organisation,
    portal_url: portalUrl,
    recipient_name: recipientName || '',
    ...values
  };
}

// ─── Storage ─────────────────────────────────────────────────

function shape(row) {
  if (!row) return null;
  return {
    workflow: row.workflow,
    subject: row.subject || null,
    intro: row.intro || null,
    outro: row.outro || null,
    body_html: row.body_html || null,
    updated_at: row.updated_at || null,
    updated_by: row.updated_by || null
  };
}

// Every override a circle holds, keyed by workflow.
async function forCircle(circleId) {
  const rows = await db.prepare(
    'SELECT * FROM email_templates WHERE circle_id = ?'
  ).all(circleId);

  const held = new Map((rows || []).map(r => [r.workflow, shape(r)]));
  return definitions().map(definition => ({
    ...definition,
    override: held.get(definition.key) || null,
    customised: held.has(definition.key)
  }));
}

async function get(circleId, workflow) {
  if (!isWorkflow(workflow)) return null;
  return shape(await db.prepare(
    'SELECT * FROM email_templates WHERE circle_id = ? AND workflow = ?'
  ).get(circleId, workflow));
}

class TemplateError extends Error {}

const LIMITS = { subject: 200, intro: 2000, outro: 2000, body_html: 100_000 };

function clean(value, field) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > LIMITS[field]) {
    throw new TemplateError(`That ${field.replace('_', ' ')} is too long (limit ${LIMITS[field]} characters)`);
  }
  return text;
}

// An uploaded body is markup somebody typed, so it is cleaned rather than
// trusted. Mail clients ignore most of what follows anyway; the point is that a
// template cannot carry script into whatever does render it, and cannot reach
// out to somebody else's server on open.
function sanitizeBody(html) {
  if (!html) return html;
  return String(html)
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

async function save(circleId, workflow, patch, adminId = null) {
  if (!isWorkflow(workflow)) throw new TemplateError(`No such email workflow: ${workflow}`);

  const fields = {
    subject: clean(patch.subject, 'subject'),
    intro: clean(patch.intro, 'intro'),
    outro: clean(patch.outro, 'outro'),
    body_html: patch.body_html === undefined
      ? undefined
      : sanitizeBody(clean(patch.body_html, 'body_html'))
  };

  const existing = await db.prepare(
    'SELECT id FROM email_templates WHERE circle_id = ? AND workflow = ?'
  ).get(circleId, workflow);

  if (existing) {
    // Only what was sent is written, so a form that edits the subject does not
    // silently drop a body somebody uploaded from another screen.
    const sets = [];
    const values = [];
    for (const [column, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (sets.length) {
      sets.push('updated_at = ?', 'updated_by = ?');
      values.push(new Date().toISOString().replace('T', ' ').slice(0, 19), adminId);
      await db.prepare(
        `UPDATE email_templates SET ${sets.join(', ')} WHERE id = ?`
      ).run(...values, existing.id);
    }
  } else {
    await db.prepare(`
      INSERT INTO email_templates (id, circle_id, workflow, subject, intro, outro, body_html, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(), circleId, workflow,
      fields.subject ?? null, fields.intro ?? null,
      fields.outro ?? null, fields.body_html ?? null,
      adminId
    );
  }

  forget(circleId);

  // An override with nothing left in it is not an override.
  const saved = await get(circleId, workflow);
  if (saved && !saved.subject && !saved.intro && !saved.outro && !saved.body_html) {
    await reset(circleId, workflow);
    return null;
  }
  return saved;
}

// Reverting is deleting the row: the default was never copied anywhere, so
// what comes back is whatever the code renders today.
async function reset(circleId, workflow) {
  await db.prepare(
    'DELETE FROM email_templates WHERE circle_id = ? AND workflow = ?'
  ).run(circleId, workflow);
  forget(circleId);
}

// ─── What a send actually uses ───────────────────────────────
// Called on the way out of the email service. Everything here is optional: no
// circle, no row, or no brand each mean "render the template as written", which
// is why an installation that never opens the Communications screen behaves
// exactly as it did before this existed.
//
// Cached briefly because it sits on the path of every outbound message and the
// answer changes only when somebody saves the form.
const cache = createTtlCache({ ttlMs: 60_000, max: 200 });

function forget(circleId) {
  cache.del(`tpl:${circleId}`);
  cache.del(`brand:${circleId}`);
}

async function overridesFor(circleId) {
  if (!circleId) return new Map();
  const key = `tpl:${circleId}`;
  const held = cache.get(key);
  if (held !== undefined) return held;

  const rows = await db.prepare(
    'SELECT * FROM email_templates WHERE circle_id = ?'
  ).all(circleId);
  const map = new Map((rows || []).map(r => [r.workflow, shape(r)]));
  cache.set(key, map);
  return map;
}

// A circle's colours, in the shape the mail layout wants. Only the two things
// that survive an email client are carried across: one accent and a logo. The
// rest of a workspace theme — surfaces, type, canvas imagery — has no meaning
// in a mail client and is deliberately dropped rather than half-applied.
async function brandFor(circleId, { appUrl = '' } = {}) {
  if (!circleId) return null;
  const key = `brand:${circleId}`;
  const held = cache.get(key);
  if (held !== undefined) return held;

  const circles = require('./circles');
  const circle = await circles.byId(circleId);
  if (!circle) { cache.set(key, null); return null; }

  const theme = circles.brandOf(circle) || {};
  const logo = theme.logo_url || null;

  const brand = {
    name: circle.name,
    accent: theme.accent || circle.color || null,
    // A mail client fetches over the network from wherever it is opened, so a
    // path that works in the browser is useless here.
    logoUrl: logo && appUrl ? `${appUrl.replace(/\/$/, '')}${logo.startsWith('/') ? '' : '/'}${logo}` : null
  };
  cache.set(key, brand);
  return brand;
}

// The override for one workflow, with its variables filled in.
async function resolveFor(circleId, workflow, values = {}) {
  const map = await overridesFor(circleId);
  const row = map.get(workflow);
  if (!row) return null;

  return {
    subject: fill(row.subject, values),
    intro: fill(row.intro, values),
    outro: fill(row.outro, values),
    body_html: fill(row.body_html, values)
  };
}

module.exports = {
  WORKFLOWS, definitions, isWorkflow,
  forCircle, get, save, reset,
  overridesFor, brandFor, resolveFor, forget,
  fill, withCommon, sanitizeBody,
  TemplateError, LIMITS
};
