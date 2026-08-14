const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { uuid } = require('../utils/helpers');
const notifications = require('./notifications');

// ─── One-time sign-in codes ─────────────────────────────────
// Participants hold no password. They prove who they are by receiving a short
// code on the email or phone number already on their record — the same thing a
// password reset would prove, without the standing secret in between.
//
// Rules that make that safe:
//   · only the hash of a code is stored, as with session tokens;
//   · a code is bound to the identifier it was sent to, so one obtained by
//     email cannot be redeemed against a phone number;
//   · issuing a new code retires the previous one, so only the latest works;
//   · wrong guesses are counted and burn the code, and requests per identifier
//     are capped, so neither the code nor someone's inbox can be brute-forced.

const { length: CODE_LENGTH, ttlSec: TTL_SEC, maxAttempts: MAX_ATTEMPTS,
        maxPerWindow: MAX_PER_WINDOW, windowSec: WINDOW_SEC } = config.loginCode;

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateCode() {
  const max = 10 ** CODE_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(CODE_LENGTH, '0');
}

function sqlTime(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

// ─── Account lookup ─────────────────────────────────────────

// Find the participant behind an identifier. Returns null rather than throwing
// when there is none — callers must answer identically either way.
function findParticipant(identity) {
  if (!identity || identity.audience !== 'participant') return null;

  if (identity.type === 'email') {
    return db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(identity.value) || null;
  }

  // A number shared by two accounts cannot identify one person, so it
  // identifies nobody; that member signs in with their email instead.
  const matches = db.prepare('SELECT * FROM users WHERE phone_normalized = ?').all(identity.value);
  return matches.length === 1 ? matches[0] : null;
}

// ─── Issuing ────────────────────────────────────────────────

function recentRequests(identifier) {
  return db.prepare(`
    SELECT COUNT(*) as c FROM login_codes
    WHERE identifier = ? AND created_at > datetime('now', ?)
  `).get(identifier, `-${WINDOW_SEC} seconds`).c;
}

function throttled(identifier) {
  return recentRequests(identifier) >= MAX_PER_WINDOW;
}

// Issue a code for a member and hand back the plaintext exactly once, for the
// caller to deliver. Nothing else can read it back afterwards.
function issue(user, identity) {
  const code = generateCode();

  db.transaction(() => {
    // Only the newest code is live, so an older message cannot be replayed
    db.prepare(`
      UPDATE login_codes SET consumed_at = datetime('now')
      WHERE user_id = ? AND consumed_at IS NULL
    `).run(user.id);

    db.prepare(`
      INSERT INTO login_codes (id, user_id, identifier, channel, code_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      uuid(), user.id, identity.value, identity.channel,
      hashCode(code), sqlTime(new Date(Date.now() + TTL_SEC * 1000))
    );
  })();

  return { code, expiresInSec: TTL_SEC };
}

// Deliver the code on the channel it was requested for. A sign-in code is
// transactional and the member asked for it seconds ago, so it goes out
// directly rather than through consent, category, and quiet-hours filtering —
// those exist to govern outbound engagement, not to lock someone out of their
// own account. The attempt is still recorded like any other delivery.
async function deliver(user, identity, code) {
  const minutes = Math.round(TTL_SEC / 60);

  return notifications.sendDirect(user, {
    channel: identity.channel,
    to: identity.value,
    category: 'platform_updates',
    title: `${code} is your Dev Circle sign-in code`,
    body: `Enter ${code} to sign in. It expires in ${minutes} minutes. ` +
          'If you did not try to sign in, you can ignore this message.'
  });
}

// ─── Verifying ──────────────────────────────────────────────

function verify(identity, submitted) {
  const code = String(submitted || '').replace(/\D/g, '');
  if (code.length !== CODE_LENGTH) {
    return { ok: false, error: 'That code is not valid. Check it and try again.' };
  }

  const user = findParticipant(identity);
  if (!user) {
    return { ok: false, error: 'That code is not valid. Check it and try again.' };
  }

  const row = db.prepare(`
    SELECT * FROM login_codes
    WHERE user_id = ? AND identifier = ? AND consumed_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(user.id, identity.value);

  if (!row || row.expires_at <= sqlTime(new Date())) {
    return { ok: false, error: 'That code has expired. Ask for a new one.' };
  }

  const given = Buffer.from(hashCode(code), 'utf8');
  const want = Buffer.from(row.code_hash, 'utf8');
  const matches = given.length === want.length && crypto.timingSafeEqual(given, want);

  if (!matches) {
    const attempts = row.attempts + 1;
    // Enough wrong guesses and the code dies rather than staying open to the
    // next one — a six-digit secret has no depth to spare.
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare("UPDATE login_codes SET attempts = ?, consumed_at = datetime('now') WHERE id = ?")
        .run(attempts, row.id);
      return { ok: false, error: 'Too many wrong attempts. Ask for a new code.' };
    }
    db.prepare('UPDATE login_codes SET attempts = ? WHERE id = ?').run(attempts, row.id);
    return { ok: false, error: 'That code is not valid. Check it and try again.' };
  }

  db.prepare("UPDATE login_codes SET consumed_at = datetime('now') WHERE id = ?").run(row.id);
  return { ok: true, user };
}

// Old rows are kept briefly so the request throttle can see them, then swept
const sweeper = setInterval(() => {
  db.prepare("DELETE FROM login_codes WHERE created_at <= datetime('now', '-1 day')").run();
}, 60 * 60 * 1000);
sweeper.unref();

module.exports = {
  findParticipant,
  issue,
  deliver,
  verify,
  throttled,
  CODE_LENGTH,
  TTL_SEC
};
