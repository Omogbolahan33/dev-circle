const db = require('../db');
const config = require('../config');
const { uuid, parseJSON } = require('../utils/helpers');
const engagement = require('./engagement');

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

function grantedChannels(userId) {
  const rows = db.prepare("SELECT channel FROM consent WHERE user_id = ? AND status = 'granted'").all(userId);
  return new Set(rows.map(r => r.channel));
}

// Decide which channels a message may actually use for this member, and why
// each requested channel was dropped.
function resolveChannels(user, requested, category) {
  const wanted = (requested && requested.length ? requested : ['in_portal'])
    .flatMap(c => (c === 'all' ? CHANNELS : [c]))
    .filter(c => CHANNELS.includes(c));

  const consented = grantedChannels(user.id);
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

  const { delivery } = config;

  if (channel === 'email' || channel === 'whatsapp' || channel === 'sms') {
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

const insertNotification = db.prepare(`
  INSERT INTO notifications (id, user_id, category, title, body, action_url, source_type, source_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDelivery = db.prepare(`
  INSERT INTO message_deliveries (id, source_type, source_id, user_id, channel, status, reason, provider_ref, sent_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Send one message to one member across every channel they allow.
async function notify(user, {
  category = 'platform_updates',
  title,
  body = null,
  actionUrl = null,
  sourceType = 'system',
  sourceId = null,
  channels = ['in_portal']
}) {
  if (!title) throw new Error('notify() requires a title');

  const { allowed, skipped } = resolveChannels(user, channels, category);
  const results = [];

  let notificationId = null;
  if (allowed.includes('in_portal')) {
    notificationId = uuid();
    insertNotification.run(notificationId, user.id, category, title, body, actionUrl, sourceType, sourceId);
  }

  const message = { category, title, body, action_url: actionUrl, notification_id: notificationId };

  for (const channel of allowed) {
    let outcome;
    try {
      outcome = await dispatchToProvider(channel, user, message);
    } catch (err) {
      outcome = { status: 'failed', ref: null, error: err.message };
    }

    insertDelivery.run(
      uuid(), sourceType, sourceId, user.id, channel,
      outcome.status, outcome.error || null, outcome.ref || null,
      ['sent', 'simulated'].includes(outcome.status) ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null
    );
    results.push({ channel, status: outcome.status, reason: outcome.error || null });
  }

  for (const { channel, reason, deferred } of skipped) {
    insertDelivery.run(
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
  sourceId = null
}) {
  if (!title) throw new Error('sendDirect() requires a title');
  if (!CHANNELS.includes(channel)) throw new Error(`Unsupported channel ${channel}`);

  let outcome;
  try {
    outcome = await dispatchToProvider(channel, user, { category, title, body, to, action_url: null });
  } catch (err) {
    outcome = { status: 'failed', ref: null, error: err.message };
  }

  insertDelivery.run(
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
async function sendMail({ to, title, body }) {
  if (!to || !title) throw new Error('sendMail() requires "to" and a title');

  const { delivery } = config;
  if (!delivery.enabled) {
    return { status: 'simulated', reason: 'No Customer.io credentials configured' };
  }

  try {
    const res = await fetch('https://api.customer.io/v1/send/triggers', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${delivery.customerIoApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        transactional_message_id: 'staff_invite',
        identifiers: { email: to },
        to,
        message_data: { title, body }
      })
    });

    if (!res.ok) return { status: 'failed', reason: `Provider responded ${res.status}` };
    return { status: 'sent', reason: null };
  } catch (err) {
    return { status: 'failed', reason: err.message };
  }
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
  const pending = db.prepare(`
    SELECT d.*, u.id as uid FROM message_deliveries d
    JOIN users u ON u.id = d.user_id
    WHERE d.status = 'queued' AND d.reason = 'quiet_hours'
      AND d.created_at > datetime('now', '-3 days')
    LIMIT 200
  `).all();

  let released = 0;

  for (const row of pending) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user || user.status !== 'active') continue;
    if (inQuietHours(user)) continue;

    // Reuse the original notification's content where we have it
    const source = row.source_id
      ? db.prepare('SELECT * FROM notifications WHERE source_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1')
          .get(row.source_id, row.user_id)
      : null;

    const outcome = await dispatchToProvider(row.channel, user, {
      category: source?.category || 'platform_updates',
      title: source?.title || 'You have an update from Dev Circle',
      body: source?.body || null,
      action_url: source?.action_url || null,
      notification_id: source?.id || null
    });

    db.prepare(`
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
    drainDeferred().catch(err => console.error('Deferred delivery drain failed:', err.message));
  }, intervalMs);
  drainTimer.unref();
}

// ─── Inbox reads ────────────────────────────────────────────

function inbox(userId, { unreadOnly = false, limit = 50 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM notifications
    WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit);

  const unread = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId).c;

  return { notifications: rows, unread_count: unread };
}

function markRead(userId, notificationId) {
  const result = db.prepare(`
    UPDATE notifications SET read_at = datetime('now')
    WHERE id = ? AND user_id = ? AND read_at IS NULL
  `).run(notificationId, userId);

  if (result.changes > 0) {
    engagement.log(userId, 'message_read', { referenceId: notificationId, source: 'dev_circle' });
  }
  return result.changes > 0;
}

function markAllRead(userId) {
  return db.prepare(`
    UPDATE notifications SET read_at = datetime('now')
    WHERE user_id = ? AND read_at IS NULL
  `).run(userId).changes;
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
