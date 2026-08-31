const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { uuid } = require('../utils/helpers');
const { logger } = require('../utils/logger');
const identity = require('../utils/identity');
const circles = require('../services/circles');
const {
  createSession, destroySession, requireAuth,
  signSSOToken, verifySSOToken, permissionsFor, flagOn,
  hashToken, PASSWORD_CHANGE_SCOPE
} = require('../middleware/auth');
const { rememberGet } = require('../middleware/cache');

const router = express.Router();

// ─── One way in ─────────────────────────────────────────────
// There is a single sign-in form: the visitor types the address they are known
// by, and the backend works out who they are and what to ask for next.
//
// Credit Direct staff — recognised by their work email domain — are asked for a
// password. Everyone else is a participant, and a participant gives the last
// six digits of the phone number on their record, or arrives through Developer
// Hub SSO. Participants still hold no password at all, so there is none to
// leak, reset, or reuse from another site.
//
// This replaced a one-time code sent by email or SMS. The code was stronger and
// it cost a delivery that had to arrive, be found, and be typed before it
// expired — on a platform whose whole purpose is short, voluntary engagements,
// that step was the one people abandoned at. The trade is deliberate and it is
// written down in identity.js, next to what the new secret is actually worth.
// services/loginCodes.js is left standing: the same machinery is what email
// verification will be built on, and nothing else about it has changed.

const { NO_PASSWORD } = identity;

// ─── Login throttling ───────────────────────────────────────
// Slows credential stuffing without adding a dependency. Keyed by
// email+IP so one attacker cannot lock out a legitimate user globally.
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

function throttleKey(req, email) {
  return `${(email || '').toLowerCase()}|${req.ip}`;
}

function isThrottled(key) {
  const record = attempts.get(key);
  if (!record) return false;
  if (Date.now() - record.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const record = attempts.get(key);
  if (!record || Date.now() - record.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    record.count++;
  }
}

function clearFailures(key) {
  attempts.delete(key);
}

// The counter is process-wide and outlives any one request, which is the point
// of it — and which is why a test suite needs a way to put it back. Exported
// alongside the router rather than through it, so nothing reachable over HTTP
// can clear somebody else's failed attempts.
function resetThrottle() {
  attempts.clear();
}

function safeUser(row) {
  const { password_hash: _, ...rest } = row;
  return rest;
}

const BAD_IDENTIFIER = 'Enter the email address or phone number you registered with.';

// ─── Step one: who is this? ─────────────────────────────────

// POST /api/auth/identify
// Decides what to ask for next. The answer comes from the identifier alone —
// no database lookup — so this cannot be used to discover who holds an account.
router.post('/identify', async (req, res) => {
  const who = identity.classify(req.body.identifier || req.body.email);
  if (!who) {
    return res.status(400).json({ error: BAD_IDENTIFIER });
  }

  res.json({
    identifier: who.value,
    type: who.type,
    audience: who.audience,
    // 'password' for staff, 'phone_digits' for participants, and
    // 'email_required' for a participant who typed their phone number — see
    // classify() for why that one cannot be accepted as an identifier.
    method: who.method,
    channel: who.channel,
    digits: who.digits || null,
    masked: identity.mask(who),
    // Staff sign in with their Credit Direct password; the Developer Hub
    // handoff is for the people building on the APIs.
    sso: who.audience === 'participant'
  });
});

// ─── Signing in ─────────────────────────────────────────────
// One endpoint, two audiences, because it is one form on one page.
//
// Staff give a password. A participant gives the last six digits of the phone
// number they registered with — see identity.js for what that secret is worth
// and what stands in front of it.
//
// Both halves answer failure identically and only check the account's status
// after the credential has verified, so neither can be used to find out which
// addresses have accounts here.

const BAD_CREDENTIALS = 'That email address and those digits do not match an account.';

async function participantLogin(req, res, who) {
  const digits = req.body.digits ?? req.body.phone_digits ?? req.body.password;

  if (who.method === 'email_required') {
    return res.status(400).json({
      error: 'Sign in with the email address you registered with, not your phone number.',
      method: 'email_required'
    });
  }

  if (!digits) {
    return res.status(400).json({
      error: `Enter the last ${identity.PHONE_DIGITS} digits of your phone number.`,
      method: 'phone_digits',
      digits: identity.PHONE_DIGITS
    });
  }

  const key = throttleKey(req, 'participant:' + who.value);
  if (isThrottled(key)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const user = await db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(who.value);

  // One refusal for four different reasons: no such address, an address that
  // belongs to a staff account, a member with no phone number on file, and the
  // wrong digits. Telling them apart is exactly what would turn this into a
  // membership oracle — and the member with no number is the one that matters
  // most to keep quiet about, since "this address exists but cannot sign in"
  // is a fact worth nothing to them and something to an attacker.
  if (!user || !identity.checkPhoneDigits(user.phone_normalized, digits)) {
    recordFailure(key);
    return res.status(401).json({ error: BAD_CREDENTIALS });
  }

  if (user.status !== 'active') {
    return res.status(403).json({ error: 'Account is ' + user.status });
  }

  clearFailures(key);
  await db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").run(user.id);

  const token = await createSession(user.id, false, {
    issuedVia: 'phone_digits',
    userAgent: req.headers['user-agent']
  });

  res.json({ token, user: safeUser(user), isAdmin: false });
}

// ─── Staff: password ────────────────────────────────────────

async function staffLogin(req, res, who) {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const key = throttleKey(req, 'staff:' + who.value);
  if (isThrottled(key)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const admin = await db.prepare('SELECT * FROM admin_users WHERE lower(email) = ?').get(who.value);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    recordFailure(key);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Status is checked only after the password verifies, so the endpoint does
  // not reveal which addresses have accounts.
  if (admin.status !== 'active') {
    return res.status(403).json({ error: 'Account is ' + admin.status });
  }

  clearFailures(key);

  const scope = admin.must_change_password ? PASSWORD_CHANGE_SCOPE : 'full';
  const token = await createSession(admin.id, true, {
    userAgent: req.headers['user-agent'],
    scope
  });
  const safe = safeUser(admin);

  // The client needs the permission list to hide actions the role cannot perform
  res.json({
    token,
    admin: safe,
    user: safe,
    isAdmin: true,
    must_change_password: Boolean(admin.must_change_password),
    permissions: await permissionsFor(admin)
  });
}

// POST /api/auth/login          (and /api/auth/admin/login, kept for callers
// written against the old split)
async function login(req, res) {
  const who = identity.classify(req.body.identifier || req.body.email);
  if (!who) {
    return res.status(400).json({ error: BAD_IDENTIFIER });
  }

  return who.audience === 'staff'
    ? staffLogin(req, res, who)
    : participantLogin(req, res, who);
}

router.post('/login', login);
router.post('/admin/login', login);

// ─── Registration ───────────────────────────────────────────

// POST /api/auth/register
// Creates a participant profile. No password is set: the account is signed into
// with this address and the last six digits of the number registered against
// it, so both are required here — a profile with no number is one nobody can
// ever sign in to.
router.post('/register', async (req, res) => {
  const { name, company, work_sector } = req.body;
  const email = identity.normalizeEmail(req.body.email);
  const phone = identity.normalizePhone(req.body.phone);

  if (!email || !name) {
    return res.status(400).json({ error: 'A valid email and a name are required' });
  }

  if (!phone) {
    return res.status(400).json({
      error: 'A phone number is required — its last ' + identity.PHONE_DIGITS +
             ' digits are what you sign in with.'
    });
  }

  if (identity.isStaffEmail(email)) {
    return res.status(400).json({
      error: 'Credit Direct accounts are created by an administrator, not through registration.'
    });
  }

  const existing = await db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const id = uuid();

  await db.prepare(`
    INSERT INTO users (id, email, name, password_hash, phone, phone_normalized, company, work_sector)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, email, name, NO_PASSWORD,
    req.body.phone, phone, company || null, work_sector || null
  );

  // Auto-assign to "All Members" cohort
  const allCohort = await db.prepare("SELECT id FROM cohorts WHERE name = 'All Members'").get();
  if (allCohort) {
    await db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)').run(id, allCohort.id);
  }

  await circles.join(id, req.circleId);

  // Log engagement event
  await db.prepare(`
    INSERT INTO engagement_history (id, user_id, type, source, metadata)
    VALUES (?, ?, 'account_created', 'dev_circle', '{}')
  `).run(uuid(), id);

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  // No session yet. Signing in is a separate step, and the digits they already
  // know are what they sign in with.
  res.status(201).json({
    user: safeUser(user),
    next: {
      method: 'phone_digits',
      endpoint: '/api/auth/login',
      identifier: email,
      digits: identity.PHONE_DIGITS
    }
  });
});

// ─── Session ────────────────────────────────────────────────

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  const token = req.headers.authorization.slice(7);
  await destroySession(token);
  res.json({ message: 'Logged out' });
});

// POST /api/auth/password
// Allows staff who signed in with a temporary password (or want to update their password)
// to set their new password, clearing must_change_password and upgrading their session to 'full'.
router.post('/password', requireAuth, async (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Only staff accounts manage passwords' });
  }

  const { new_password, current_password } = req.body;
  if (!new_password || String(new_password).length < 10) {
    return res.status(400).json({ error: 'New password must be at least 10 characters' });
  }

  // If session is already full, optionally verify current password
  if (req.session.scope === 'full' && current_password) {
    const admin = await db.prepare('SELECT password_hash FROM admin_users WHERE id = ?').get(req.admin.id);
    if (!admin || !bcrypt.compareSync(current_password, admin.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
  }

  const token = req.headers.authorization.slice(7);
  const tokenHash = hashToken(token);

  await db.prepare('UPDATE admin_users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(new_password, 10), req.admin.id);

  // Upgrade the active session scope to full
  await db.prepare("UPDATE sessions SET scope = 'full' WHERE token_hash = ?").run(tokenHash);

  res.json({ message: 'Password updated successfully' });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  if (req.isAdmin) {
    return res.json({
      user: safeUser(req.admin),
      role: req.role || null,
      permissions: req.permissions,
      isAdmin: true,
      // Enough for the switcher without a second COUNT of circle_members.
      // member_count is omitted on purpose — the circles page still loads it.
      // brand is the workspace look the console paints itself with.
      circles: (req.availableCircles || []).map(c => ({
        id: c.id, name: c.name, slug: c.slug, description: c.description,
        color: c.color, status: c.status, brand: circles.brandOf(c)
      })),
      can_create_circles: Boolean(req.isGlobalAdmin)
    });
  }
  res.json({ user: safeUser(req.user), isAdmin: false });
});

// ─── SSO (Developer Hub → Dev Circle) ───────────────────────

// POST /api/auth/sso/exchange
// Trades an HMAC-signed Developer Hub handoff token for a Dev Circle session.
// The subject comes from the *verified* token payload — never from the request
// body — so knowing a dev_hub_user_id is not enough to obtain a session.
router.post('/sso/exchange', async (req, res) => {
  const { hub_token } = req.body;

  if (!hub_token) {
    return res.status(400).json({ error: 'hub_token is required' });
  }

  const result = verifySSOToken(hub_token);
  if (!result.valid) {
    return res.status(401).json({ error: `SSO rejected: ${result.error}` });
  }

  const { sub: devHubUserId, email: rawEmail, name, company, work_sector } = result.payload;
  const email = identity.normalizeEmail(rawEmail);

  let user = await db.prepare('SELECT * FROM users WHERE dev_hub_user_id = ?').get(devHubUserId);

  // Fall back to matching on the verified email, then link the accounts
  if (!user && email) {
    user = await db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
    if (user) {
      await db.prepare('UPDATE users SET dev_hub_user_id = ? WHERE id = ?').run(devHubUserId, user.id);
    }
  }

  // An authenticated Hub developer with no Dev Circle profile gets one created,
  // rather than hitting a dead end on their first visit. A Credit Direct
  // address is the one thing not provisioned this way: staff sign in with a
  // password, so a participant profile on that domain could never be used.
  if (!user && config.devHub.autoProvision && email && !identity.isStaffEmail(email)) {
    const id = uuid();

    await db.prepare(`
      INSERT INTO users (id, email, name, password_hash, company, work_sector, dev_hub_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, email, name || email.split('@')[0], NO_PASSWORD, company || null, work_sector || null, devHubUserId);

    const allCohort = await db.prepare("SELECT id FROM cohorts WHERE name = 'All Members'").get();
    if (allCohort) {
      await db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)').run(id, allCohort.id);
    }

    await circles.join(id, req.circleId);

    await db.prepare(`
      INSERT INTO engagement_history (id, user_id, type, source, metadata)
      VALUES (?, ?, 'account_created', 'system', ?)
    `).run(uuid(), id, JSON.stringify({ via: 'dev_hub_sso' }));

    user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  if (!user) {
    return res.status(404).json({ error: `No ${config.brand.product} account linked to this Developer Hub user` });
  }

  if (user.status !== 'active') {
    return res.status(403).json({ error: 'Account is ' + user.status });
  }

  await db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").run(user.id);
  const token = await createSession(user.id, false, { issuedVia: 'dev_hub_sso', userAgent: req.headers['user-agent'] });

  res.json({ token, user: safeUser(user), isAdmin: false });
});

// POST /api/auth/sso/mint  (development helper)
// Mints a handoff token the way the Developer Hub would, so the integration
// can be exercised locally. Disabled in production.
router.post('/sso/mint', async (req, res) => {
  if (config.isProduction) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  const { sub, email, name, company, work_sector } = req.body;
  if (!sub) return res.status(400).json({ error: 'sub (dev hub user id) is required' });

  res.json({
    hub_token: signSSOToken({
      sub, email, name, company, work_sector,
      iat: Math.floor(Date.now() / 1000)
    })
  });
});

// POST /api/auth/sso/link
// Links a Dev Circle account to a Developer Hub account
router.post('/sso/link', requireAuth, async (req, res) => {
  const { dev_hub_user_id } = req.body;

  if (!dev_hub_user_id) {
    return res.status(400).json({ error: 'dev_hub_user_id is required' });
  }

  await db.prepare('UPDATE users SET dev_hub_user_id = ? WHERE id = ?').run(dev_hub_user_id, req.user.id);

  res.json({ message: 'Account linked to Developer Hub' });
});

module.exports = router;
module.exports.resetThrottle = resetThrottle;
