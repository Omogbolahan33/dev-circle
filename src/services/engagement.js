const db = require('../db');
const { uuid } = require('../utils/helpers');

// ─── Engagement logging ─────────────────────────────────────
// A single writer for engagement_history so every caller records the same
// shape, and so streak maintenance cannot be forgotten at a call site.

// Prepared per call rather than once at module load: the handle resolves to
// whichever database the current request belongs to, and a statement held from
// load would write to the live one even from inside the sandbox.
async function log(userId, type, { referenceId = null, metadata = {}, source = 'dev_circle' } = {}) {
  const id = uuid();
  await db.prepare(`
    INSERT INTO engagement_history (id, user_id, type, reference_id, metadata, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, type, referenceId, JSON.stringify(metadata), source);
  return id;
}

// Activities that count toward a participation streak. Receiving a message
// does not — the streak measures what the member chose to do.
const STREAK_EVENTS = new Set([
  'survey_completed',
  'feedback_submitted',
  'gift_claimed'
]);

// A streak survives a gap of up to this long between qualifying actions.
const STREAK_WINDOW_DAYS = 30;

function daysBetween(a, b) {
  return Math.floor((a - b) / 86400000);
}

function parseSqliteDate(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d;
}

// Recompute the streak on a qualifying action. Previously the counter only
// ever went up, which made both engagement_streak and best_streak meaningless.
async function recordActivity(userId, type) {
  await db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").run(userId);

  if (!STREAK_EVENTS.has(type)) return null;

  const user = await db.prepare('SELECT engagement_streak, best_streak, last_engagement_at FROM users WHERE id = ?').get(userId);
  if (!user) return null;

  const now = new Date();
  const last = parseSqliteDate(user.last_engagement_at);
  const gap = last ? daysBetween(now, last) : null;

  let streak;
  if (gap === null || gap > STREAK_WINDOW_DAYS) {
    streak = 1;                       // first action, or the streak lapsed
  } else if (gap === 0) {
    streak = user.engagement_streak || 1;  // same day — already counted
  } else {
    streak = (user.engagement_streak || 0) + 1;
  }

  const best = Math.max(streak, user.best_streak || 0);

  await db.prepare(`
    UPDATE users SET engagement_streak = ?, best_streak = ?, last_engagement_at = datetime('now')
    WHERE id = ?
  `).run(streak, best, userId);

  return { streak, best_streak: best, continued: gap !== null && gap <= STREAK_WINDOW_DAYS };
}

// Log an event and update the streak in one call
async function record(userId, type, options = {}) {
  const id = await log(userId, type, options);
  const streak = await recordActivity(userId, type);
  return { id, streak };
}

// Roll a lapsed streak back to zero. Called on read so a member who walked
// away does not keep showing a stale number.
async function decayStale(userOrId) {
  // The session already joined the member row. Reloading it just to read two
  // columns was another RTT on every profile view.
  const user = userOrId && typeof userOrId === 'object'
    ? userOrId
    : await db.prepare('SELECT id, engagement_streak, last_engagement_at FROM users WHERE id = ?').get(userOrId);
  if (!user || !user.engagement_streak) return user;

  const last = parseSqliteDate(user.last_engagement_at);
  if (last && daysBetween(new Date(), last) <= STREAK_WINDOW_DAYS) return user;

  await db.prepare('UPDATE users SET engagement_streak = 0 WHERE id = ?').run(user.id);
  user.engagement_streak = 0;
  return user;
}

module.exports = { log, record, recordActivity, decayStale, STREAK_EVENTS, STREAK_WINDOW_DAYS };
