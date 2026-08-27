const db = require('../db');
const dbContext = require('../db/context');
const config = require('../config');
const { uuid, parseJSON } = require('../utils/helpers');
const engagement = require('./engagement');
const emailService = require('./email');

// ─── Notification & delivery service ────────────────────────
// The blueprint's core promise is that members "receive communications
// (in-portal, e-mail, whatsapp, SMS) for upcoming scheduled info/test" and
// that consent can be withdrawn at any time. Everything outbound goes through
// here so consent, channel preference, category preference, and quiet hours
// are enforced in exactly one place, and so every attempt leaves an auditable
// row in message_deliveries.

const CHANNELS = ['in_portal', 'email', 'whatsapp', 'sms', 'calls'];

const CATEGORIES = {
  survey_invites:     { label: 'Survey invitations', default: true },
  survey_reminders:   { label: 'Survey reminders', default: true },
  gift_notifications: { label: 'Gift claims', default: true },
  feedback_updates:   { label: 'Feedback updates', default: true },
  platform_updates:   { label: 'Platform updates', default: true },
  engagement_streaks: { label: 'Streak alerts', default: true }
};

// Categories a member cannot switch off — consent and account changes are
// transactional, not marketing.
const MANDATORY_CATEGORIES = new Set(['feedback_updates']);

function categoryEnabled(user, category) {
  if (MANDATORY_CATEGORIES.has(category)) return true;
  const prefs = parseJSON(user.notification_prefs, {}) || {};
  if (prefs[category] === undefined) {
    return CATEGORIES[category] ? CATEGORIES[category].default : true;
  }
  return prefs[category] !== false;
}

// ─── Quiet hours ────────────────────────────────────────────
// Stored as "HH:MM" in West Africa Time (UTC+1), which is where the member
// base is. Windows that wrap past midnight are handled.

const WAT_OFFSET_MINUTES = 60;

function minutesNowWAT() {
  const utc = new Date();
  const total = utc.getUTCHours() * 60 + utc.getUTCMinutes() + WAT_OFFSET_MINUTES;
  return ((total % 1440) + 1440) % 1440;
}

function parseHHMM(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return fallback;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return fallback;
  return h * 60 + m;
}

function inQuietHours(user, at = minutesNowWAT()) {
  const start = parseHHMM(user.quiet_hours_start, 22 * 60);
  const end = parseHHMM(user.quiet_hours_end, 8 * 60);
  if (start === end) return false;                 // no quiet window
  if (start < end) return at >= start && at < end; // same-day window
  return at >= start || at < end;                  // wraps past midnight
}

// ─── Channel resolution ─────────────────────────────────────

async function grantedChannels(userId) {
  const rows = await db.prepare("SELECT channel FROM consent WHERE user_id = ? AND status = 'granted'").all(userId);
  return new Set(rows.map(r => r.channel));
}

// Decide which channels a message may actually use for this member, and why
// each requested channel was dropped.
async function resolveChannels(user, requested, category) {
  const wanted = (requested && requested.length ? requested : ['in_portal'])
    .flatMap(c => (c === 'all' ? CHANNELS : [c]))
    .filter(c => CHANNELS.includes(c));

  const consented = await grantedChannels(user.id);
  const preferred = parseJSON(user.preferred_channels, []) || [];
  const quiet = inQuietHours(user);

  const allowed = [];
  const skipped = [];

  for (const channel of new Set(wanted)) {
    if (!categoryEnabled(user, category)) {
      skipped.push({ channel, reason: `Member turned off ${category.replace(/_/g, ' ')}` });
      continue;
    }

    // The in-portal inbox is a pull channel — the member sees it when they log
    // in — so it needs no consent and is never held back by quiet hours.
    if (channel === 'in_portal') {
      allowed.push(channel);
      continue;
    }

    if (!consented.has(channel)) {
      skipped.push({ channel, reason: 'No consent on file for this channel' });
      continue;
    }

    // An explicit preference list narrows delivery; an empty list means
    // "whatever I consented to".
    if (preferred.length && !preferred.includes(channel)) {
      skipped.push({ channel, reason: 'Not among the member\'s preferred channels' });
      continue;
    }

    if (quiet) {
      skipped.push({ channel, reason: 'quiet_hours', deferred: true });
      continue;
    }

    allowed.push(channel);
  }

  return { allowed, skipped };
}

// ─── Provider adapters ──────────────────────────────────────
// Credentials are not wired up in this environment. Rather than pretending a
// message was sent, an unconfigured channel records status 'simulated' so the
// audit trail stays honest.

async function dispatchToProvider(channel, user, message) {
  if (channel === 'in_portal') {
    return { status: 'sent', ref: message.notification_id };
  }

  // Nothing leaves the building from the sandbox. The in-portal inbox above is
  // fine — it writes to the sandbox database like everything else — but an
  // email, WhatsApp or SMS would reach a real person, and somebody trying the
  // API out is not expecting to have sent anything.
  if (dbContext.inSandbox()) {
    return { status: 'simulated', ref: null, error: 'Sandbox — not dispatched' };
  }

  if (channel === 'email') {
    const outcome = await emailService.sendNotificationEmail({ user, message });
    return {
      status: outcome.status,
      ref: outcome.ref || null,
      error: outcome.error || null
    };
  }
  if (channel === 'whatsapp' || channel === 'sms') {
    const { delivery } = config;
    if (!delivery.enabled) {
      return { status: 'simulated', ref: null };
    }
    // Customer.io is the engagement platform of record per the blueprint;
    // it fans out to email/WhatsApp/SMS from a single transactional trigger.
    const res = await fetch('https://api.customer.io/v1/send/triggers', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${delivery.customerIoApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        transactional_message_id: message.category,
        identifiers: { email: user.email },
        // An explicit destination wins, so a sign-in code goes to the address
        // or number the member actually typed rather than their primary one
        to: message.to || (channel === 'email' ? user.email : user.phone),
        message_data: { title: message.title, body: message.body, action_url: message.action_url }
      })
    });

    if (!res.ok) {
      return { status: 'failed', ref: null, error: `Provider responded ${res.status}` };
    }
    const body = await res.json().catch(() => ({}));
    return { status: 'sent', ref: body.delivery_id || null };
  }

  // A phone call is a task for a CDL rep, not something the system dispatches
  if (channel === 'calls') {
    return { status: 'queued', ref: null, error: 'Awaiting CDL rep callback' };
  }

  return { status: 'failed', ref: null, error: `Unsupported channel ${channel}` };
}

// ─── Public API ─────────────────────────────────────────────

// Prepared per call rather than once at module load: the handle resolves to
// whichever database the current request belongs to, and a statement held from
// load would write to the live one even from inside the sandbox.
const insertNotification = () => db.prepare(`
  INSERT INTO notifications (id, user_id, category, title, body, action_url, source_type, source_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDelivery = () => db.prepare(`
  INSERT INTO message_deliveries (id, source_type, source_id, user_id, channel, status, reason, provider_ref, sent_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Send one message to one member across every channel they allow.
// `workflow` + `templateData` let a caller name the business event (a session
// invite, a gift, a feedback reply…) so the email it renders uses the matching
// branded template with its full data, rather than a generic announcement.
async function notify(user, {
  category = 'platform_updates',
  title,
  body = null,
  actionUrl = null,
  sourceType = 'system',
  sourceId = null,
  channels = ['in_portal'],
  workflow = null,
  templateData = null
}) {
  if (!title) throw new Error('notify() requires a title');

  const { allowed, skipped } = await resolveChannels(user, channels, category);
  const results = [];

  let notificationId = null;
  if (allowed.includes('in_portal')) {
    notificationId = uuid();
    await insertNotification().run(notificationId, user.id, category, title, body, actionUrl, sourceType, sourceId);
  }

  const message = {
    category, title, body, action_url: actionUrl, notification_id: notificationId,
    source_type: sourceType, source_id: sourceId, workflow, templateData
  };

  for (const channel of allowed) {
    let outcome;
    try {
      outcome = await dispatchToProvider(channel, user, message);
    } catch (err) {
      outcome = { status: 'failed', ref: null, error: err.message };
    }

    await insertDelivery().run(
      uuid(), sourceType, sourceId, user.id, channel,
      outcome.status, outcome.error || null, outcome.ref || null,
      ['sent', 'simulated'].includes(outcome.status) ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null
    );
    results.push({ channel, status: outcome.status, reason: outcome.error || null });
  }

  for (const { channel, reason, deferred } of skipped) {
    await insertDelivery().run(
      uuid(), sourceType, sourceId, user.id, channel,
      deferred ? 'queued' : 'skipped', reason, null, null
    );
    results.push({ channel, status: deferred ? 'queued' : 'skipped', reason });
  }

  return { notification_id: notificationId, deliveries: results, delivered: allowed.length };
}

// Send one transactional message on one channel, bypassing consent, category
// preference, and quiet hours. This exists for messages the member has just
// asked for and cannot proceed without — a sign-in code — where the filters
// that govern outbound engagement would instead lock someone out of their own
// account. It is deliberately not reachable from blasts or campaigns. The
// attempt is recorded in message_deliveries like any other.
async function sendDirect(user, {
  channel,
  to = null,
  category = 'platform_updates',
  title,
  body = null,
  sourceType = 'system',
  sourceId = null,
  workflow = null,
  templateData = null
}) {
  if (!title) throw new Error('sendDirect() requires a title');
  if (!CHANNELS.includes(channel)) throw new Error(`Unsupported channel ${channel}`);

  let outcome;
  try {
    outcome = await dispatchToProvider(channel, user, {
      category, title, body, to, action_url: null,
      source_type: sourceType, source_id: sourceId, workflow, templateData
    });
  } catch (err) {
    outcome = { status: 'failed', ref: null, error: err.message };
  }

  await insertDelivery().run(
    uuid(), sourceType, sourceId, user.id, channel,
    outcome.status, outcome.error || null, outcome.ref || null,
    ['sent', 'simulated'].includes(outcome.status)
      ? new Date().toISOString().replace('T', ' ').slice(0, 19)
      : null
  );

  return { channel, status: outcome.status, reason: outcome.error || null };
}

// Mail an address that is not a member — a Credit Direct colleague being
// invited into the admin console. They have no users row, so there is no
// consent record to consult and no delivery row to write; the caller is told
// what actually happened instead, because an invite that only looks sent
// leaves somebody unable to get in.
async function sendMail({ to, title, body, template = 'generic', templateData = {}, actionUrl = null }) {
  if (!to || !title) throw new Error('sendMail() requires "to" and a title');

  if (dbContext.inSandbox()) {
    return { status: 'simulated', reason: 'Sandbox — not dispatched' };
  }

  const outcome = await emailService.send({
    to,
    subject: title,
    body,
    template,
    templateData: {
      ...templateData,
      title,
      body,
      actionUrl
    },
    actionUrl,
    category: 'staff_invite'
  });

  return {
    status: outcome.status,
    reason: outcome.error || null,
    ref: outcome.ref || null,
    provider: outcome.provider
  };
}

// Send the same message to many members
async function notifyMany(users, message) {
  const summary = { delivered: 0, skipped: 0, queued: 0, failed: 0, per_user: [] };

  for (const user of users) {
    const result = await notify(user, message);
    for (const d of result.deliveries) {
      if (d.status === 'sent' || d.status === 'simulated') summary.delivered++;
      else if (d.status === 'queued') summary.queued++;
      else if (d.status === 'failed') summary.failed++;
      else summary.skipped++;
    }
    summary.per_user.push({ user_id: user.id, ...result });
  }

  return summary;
}

// ─── Quiet-hours drain ──────────────────────────────────────
// Deliveries held back by quiet hours are retried once the window closes,
// so "deferred" genuinely means later rather than never.

async function drainDeferred() {
  const pending = await db.prepare(`
    SELECT d.*, u.id as uid FROM message_deliveries d
    JOIN users u ON u.id = d.user_id
    WHERE d.status = 'queued' AND d.reason = 'quiet_hours'
      AND d.created_at > datetime('now', '-3 days')
    LIMIT 200
  `).all();

  let released = 0;

  for (const row of pending) {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user || user.status !== 'active') continue;
    if (inQuietHours(user)) continue;

    // Reuse the original notification's content where we have it
    const source = row.source_id
      ? await db.prepare('SELECT * FROM notifications WHERE source_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1')
          .get(row.source_id, row.user_id)
      : null;

    const outcome = await dispatchToProvider(row.channel, user, {
      category: source?.category || 'platform_updates',
      title: source?.title || 'You have an update from Dev Circle',
      body: source?.body || null,
      action_url: source?.action_url || null,
      notification_id: source?.id || null,
      // Carry the original event so a drained email renders its real template
      // (a held session invite is still a session invite an hour later).
      source_type: source?.source_type || null,
      source_id: source?.source_id || null
    });

    await db.prepare(`
      UPDATE message_deliveries
      SET status = ?, reason = ?, provider_ref = ?, sent_at = datetime('now')
      WHERE id = ?
    `).run(outcome.status, outcome.error || null, outcome.ref || null, row.id);

    released++;
  }

  return released;
}

let drainTimer = null;
function startDrain(intervalMs = 15 * 60 * 1000) {
  if (drainTimer) return;
  drainTimer = setInterval(() => {
    drainDeferred().catch(async err => console.error('Deferred delivery drain failed:', err.message));
  }, intervalMs);
  drainTimer.unref();
}

// ─── Inbox reads ────────────────────────────────────────────

async function inbox(userId, { unreadOnly = false, limit = 50 } = {}) {
  const [rows, unreadRow] = await Promise.all([
    db.prepare(`
      SELECT n.* FROM notifications n
      WHERE n.user_id = ? ${unreadOnly ? 'AND n.read_at IS NULL' : ''}
      ORDER BY n.created_at DESC
      LIMIT ?
    `).all(userId, limit),
    db.prepare(`
      SELECT COUNT(*) as c FROM notifications
      WHERE user_id = ? AND read_at IS NULL
    `).get(userId)
  ]);

  return {
    notifications: rows || [],
    unread_count: Number(unreadRow?.c || 0)
  };
}

async function markRead(userId, notificationId) {
  const result = await db.prepare(`
    UPDATE notifications SET read_at = datetime('now')
    WHERE id = ? AND user_id = ? AND read_at IS NULL
  `).run(notificationId, userId);

  if (result.changes > 0) {
    engagement.log(userId, 'message_read', { referenceId: notificationId, source: 'dev_circle' });
  }
  return result.changes > 0;
}

async function markAllRead(userId) {
  return Number((await db.prepare(`
    UPDATE notifications SET read_at = datetime('now')
    WHERE user_id = ? AND read_at IS NULL
  `).run(userId))?.changes || 0);
}

module.exports = {
  notify,
  notifyMany,
  sendDirect,
  sendMail,
  inbox,
  markRead,
  markAllRead,
  resolveChannels,
  inQuietHours,
  drainDeferred,
  startDrain,
  categoryEnabled,
  CHANNELS,
  CATEGORIES,
  MANDATORY_CATEGORIES
};
