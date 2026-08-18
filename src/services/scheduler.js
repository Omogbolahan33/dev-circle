const db = require('../db');
const { uuid, parseJSON } = require('../utils/helpers');
const { logger } = require('../utils/logger');
const notifications = require('./notifications');
const engagement = require('./engagement');

// ─── Scheduled engagement sessions ──────────────────────────
// Closes two blueprint requirements that had no implementation: members
// "receive communications for upcoming scheduled info/Test", and admins
// "send engagement communications and reminders". A session is a dated
// engagement with automated lead-up reminders, and members' selected
// availability finally means something.

class SessionError extends Error {}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WAT_OFFSET_MS = 60 * 60 * 1000;

function parseWhen(value) {
  if (!value) return null;
  const iso = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Weekday and minute-of-day of a session in West Africa Time, which is how
// members expressed their availability.
function localParts(when) {
  const local = new Date(when.getTime() + WAT_OFFSET_MS);
  return {
    day: DAY_NAMES[local.getUTCDay()],
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes()
  };
}

function toMinutes(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Does this session fall inside the window the member said they were free?
function availability(user, when) {
  const { day, minutes } = localParts(when);
  const days = parseJSON(user.preferred_days, []) || [];

  if (days.length && !days.includes(day)) {
    return { available: false, reason: `Not available on ${day}` };
  }

  const start = toMinutes(user.preferred_time_start, 0);
  const end = toMinutes(user.preferred_time_end, 24 * 60);
  const inWindow = start <= end
    ? minutes >= start && minutes <= end
    : minutes >= start || minutes <= end;

  if (!inWindow) {
    return {
      available: false,
      reason: `Outside their ${user.preferred_time_start}–${user.preferred_time_end} window`
    };
  }

  return { available: true, reason: null };
}

// ─── Audience ───────────────────────────────────────────────

function audienceFor(session) {
  const targets = parseJSON(session.target_ids, []) || [];

  if (session.target_type === 'circle') {
    const ids = targets.length ? targets : [session.circle_id].filter(Boolean);
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`
      SELECT DISTINCT u.* FROM users u
      JOIN circle_members m ON m.user_id = u.id
      WHERE m.circle_id IN (${placeholders}) AND u.status = 'active'
    `).all(...ids);
  }

  if (session.target_type === 'cohort') {
    if (!targets.length) return [];
    const placeholders = targets.map(() => '?').join(',');
    return db.prepare(`
      SELECT DISTINCT u.* FROM users u
      JOIN user_cohorts uc ON uc.user_id = u.id
      WHERE uc.cohort_id IN (${placeholders}) AND u.status = 'active'
    `).all(...targets);
  }

  if (session.target_type === 'specific') {
    if (!targets.length) return [];
    const placeholders = targets.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM users WHERE id IN (${placeholders}) AND status = 'active'`)
      .all(...targets);
  }

  // 'all' still means "everyone in this session's circle", not the whole base
  if (session.circle_id) {
    return db.prepare(`
      SELECT DISTINCT u.* FROM users u
      JOIN circle_members m ON m.user_id = u.id
      WHERE m.circle_id = ? AND u.status = 'active'
    `).all(session.circle_id);
  }

  return db.prepare("SELECT * FROM users WHERE status = 'active'").all();
}

// Who this session reaches, and who it clashes with — so a session can be
// moved before it is announced rather than after nobody turns up.
function preview(session) {
  const when = parseWhen(session.scheduled_for);
  if (!when) throw new SessionError('scheduled_for is not a valid date');

  const audience = audienceFor(session);
  const channels = parseJSON(session.channels, ['in_portal']) || ['in_portal'];

  const available = [];
  const unavailable = [];
  const unreachable = [];

  for (const user of audience) {
    const slot = availability(user, when);
    const { allowed, skipped } = notifications.resolveChannels(user, channels, 'survey_invites');

    const entry = {
      id: user.id, name: user.name, email: user.email,
      channels: allowed, reason: slot.reason
    };

    if (!allowed.length) unreachable.push({ ...entry, reasons: skipped.map(s => s.reason) });
    else if (slot.available) available.push(entry);
    else unavailable.push(entry);
  }

  const { day } = localParts(when);

  return {
    scheduled_for: session.scheduled_for,
    weekday: day,
    total: audience.length,
    available,
    unavailable,
    unreachable
  };
}

// ─── Dispatch ───────────────────────────────────────────────

function describe(session, offsetMinutes) {
  const when = parseWhen(session.scheduled_for);
  const local = new Date(when.getTime() + WAT_OFFSET_MS);
  const stamp = local.toISOString().slice(0, 16).replace('T', ' ');

  if (offsetMinutes === null) {
    return {
      title: `Scheduled: ${session.title}`,
      body: `${session.description ? session.description + ' ' : ''}Happening ${stamp} WAT` +
            `${session.location ? ` · ${session.location}` : ''}.`
    };
  }

  const lead = offsetMinutes >= 1440
    ? `${Math.round(offsetMinutes / 1440)} day(s)`
    : offsetMinutes >= 60
      ? `${Math.round(offsetMinutes / 60)} hour(s)`
      : `${offsetMinutes} minutes`;

  return {
    title: `Reminder: ${session.title} in ${lead}`,
    body: `Starts ${stamp} WAT${session.location ? ` · ${session.location}` : ''}.`
  };
}

// Send one wave for a session. offsetMinutes === null is the announcement.
async function dispatch(sessionId, offsetMinutes = null) {
  const session = db.prepare('SELECT * FROM scheduled_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new SessionError('Session not found');
  if (session.status === 'cancelled') throw new SessionError('Session is cancelled');

  const marker = offsetMinutes === null ? -1 : offsetMinutes;

  // The unique index is what actually prevents a double send; this check just
  // avoids doing the work twice.
  const already = db.prepare('SELECT 1 FROM session_dispatches WHERE session_id = ? AND offset_minutes = ?')
    .get(sessionId, marker);
  if (already) return { skipped: true, reason: 'Already dispatched' };

  const audience = audienceFor(session);
  const channels = parseJSON(session.channels, ['in_portal']) || ['in_portal'];
  const { title, body } = describe(session, offsetMinutes);

  // Where the notification takes them: the survey it is about if there is
  // one, otherwise the session itself. Pointing back at the inbox they read
  // it in would be a round trip to nowhere.
  const actionUrl = session.survey_id
    ? `/member/survey.html?id=${session.survey_id}`
    : `/member/sessions.html?id=${session.id}`;
  const sourceType = offsetMinutes === null ? 'session_invite' : 'session_reminder';
  const category = offsetMinutes === null ? 'survey_invites' : 'survey_reminders';

  let delivered = 0;
  for (const user of audience) {
    const result = await notifications.notify(user, {
      category, title, body, actionUrl,
      sourceType, sourceId: session.id, channels
    });
    if (result.delivered > 0) {
      delivered++;
      engagement.log(user.id, offsetMinutes === null ? 'message_sent' : 'survey_reminded', {
        referenceId: session.id,
        metadata: { session_title: session.title, offset_minutes: offsetMinutes },
        source: 'system'
      });
    }
  }

  try {
    db.prepare(`
      INSERT INTO session_dispatches (id, session_id, offset_minutes, recipient_count)
      VALUES (?, ?, ?, ?)
    `).run(uuid(), sessionId, marker, audience.length);
  } catch {
    // Another tick won the race; the notifications above are idempotent enough
    // that this is not worth failing the request over.
  }

  if (offsetMinutes === null && session.status === 'scheduled') {
    db.prepare("UPDATE scheduled_sessions SET status = 'announced' WHERE id = ?").run(sessionId);
  }

  return { skipped: false, recipients: audience.length, delivered, offset_minutes: offsetMinutes };
}

// ─── Tick ───────────────────────────────────────────────────
// Runs on an interval: fires due reminders, nudges stale surveys, and closes
// out sessions that have passed.

async function runDueReminders() {
  const sessions = db.prepare(`
    SELECT * FROM scheduled_sessions
    WHERE status IN ('scheduled','announced')
      AND scheduled_for > datetime('now', '-1 day')
  `).all();

  const fired = [];
  const now = Date.now();

  for (const session of sessions) {
    const when = parseWhen(session.scheduled_for);
    if (!when) continue;

    const offsets = (parseJSON(session.reminder_offsets, []) || [])
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0)
      .sort((a, b) => b - a);

    for (const offset of offsets) {
      const dueAt = when.getTime() - offset * 60 * 1000;
      // Fire once the moment has passed, but never for a window that closed
      // more than an hour ago — a late reminder is worse than none.
      if (now < dueAt || now - dueAt > 60 * 60 * 1000) continue;

      try {
        const result = await dispatch(session.id, offset);
        if (!result.skipped) fired.push({ session: session.title, offset_minutes: offset, ...result });
      } catch (err) {
        console.error(`Session reminder failed (${session.id} @ ${offset}m):`, err.message);
      }
    }
  }

  return fired;
}

// Surveys carrying reminder_after_days nudge members who were invited that
// long ago and still have not responded.
async function runSurveyReminders() {
  const surveys = db.prepare(`
    SELECT * FROM surveys
    WHERE status = 'active' AND reminder_after_days IS NOT NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).all();

  const results = [];

  for (const survey of surveys) {
    const pending = db.prepare(`
      SELECT u.* FROM survey_responses sr
      JOIN users u ON u.id = sr.user_id
      WHERE sr.survey_id = ?
        AND sr.completed_at IS NULL
        AND u.status = 'active'
        AND sr.created_at <= datetime('now', ?)
        -- Only nudge once per survey
        AND NOT EXISTS (
          SELECT 1 FROM message_deliveries d
          WHERE d.user_id = u.id AND d.source_id = sr.survey_id
            AND d.source_type = 'survey_reminder'
        )
    `).all(survey.id, `-${survey.reminder_after_days} days`);

    const mode = survey.engagement_mode;
    const channels = mode === 'in_portal' || mode === '1-on-1' ? ['in_portal'] : ['in_portal', mode];

    for (const user of pending) {
      engagement.log(user.id, 'survey_reminded', { referenceId: survey.id, source: 'system' });
      await notifications.notify(user, {
        category: 'survey_reminders',
        title: `Still open: ${survey.title}`,
        body: `About ${survey.time_estimate_min} minutes, whenever suits you.`,
        actionUrl: `/member/survey.html?id=${survey.id}`,
        sourceType: 'survey_reminder',
        sourceId: survey.id,
        channels
      });
    }

    if (pending.length) results.push({ survey: survey.title, reminded: pending.length });
  }

  return results;
}

function closePastSessions() {
  return db.prepare(`
    UPDATE scheduled_sessions
    SET status = 'completed'
    WHERE status IN ('scheduled','announced')
      AND datetime(scheduled_for, '+' || COALESCE(duration_min, 30) || ' minutes') < datetime('now')
  `).run().changes;
}

// Brand assets nothing points at any more — a logo that was replaced, or one
// uploaded into a survey that was never saved. Swept here rather than on a
// timer of its own, because this is already the thing that runs periodically
// and a second scheduler would be a second thing to reason about.
//
// Hourly rather than every tick: the work is a directory listing and a couple
// of queries, which is cheap but not free, and nothing goes wrong if an
// orphaned file survives another hour.
let lastSweep = 0;
function sweepUploads({ now = Date.now() } = {}) {
  if (now - lastSweep < 60 * 60 * 1000) return null;
  lastSweep = now;
  const { removed, bytes } = require('./uploads').sweep(db, { now });
  if (removed) {
    logger.info('Swept unreferenced brand assets', { removed, bytes });
  }
  return removed;
}

async function tick() {
  const reminders = await runDueReminders();
  const surveyNudges = await runSurveyReminders();
  const closed = closePastSessions();
  const sweptAssets = sweepUploads();
  return {
    reminders, survey_reminders: surveyNudges, sessions_closed: closed,
    ...(sweptAssets === null ? {} : { assets_swept: sweptAssets })
  };
}

let timer = null;
function start(intervalMs = 5 * 60 * 1000) {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch(err => console.error('Scheduler tick failed:', err.message));
  }, intervalMs);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  availability, audienceFor, preview, dispatch, tick,
  runDueReminders, runSurveyReminders, closePastSessions, sweepUploads,
  start, stop, localParts, parseWhen, SessionError
};
