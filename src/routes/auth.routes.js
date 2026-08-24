const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { uuid } = require('../utils/helpers');
const { logger } = require('../utils/logger');
const identity = require('../utils/identity');
const circles = require('../services/circles');
const loginCodes = require('../services/loginCodes');
const {
  createSession, destroySession, requireAuth,
  signSSOToken, verifySSOToken, permissionsFor
} = require('../middleware/auth');

const router = express.Router();

// ─── One way in ─────────────────────────────────────────────
// There is a single sign-in form and a single field: the visitor types the
// email or phone number they are known by, and the backend works out who they
// are. Credit Direct staff — recognised by their work email domain — are asked
// for a password. Everyone else is a participant: they receive a one-time code
// on the email or number already on their record, or arrive through Developer
// Hub SSO. Participants hold no password at all, so there is none to leak,
// reset, or reuse from another site.

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

function safeUser(row) {
  const { password_hash: _, ...rest } = row;
  return rest;
}

const BAD_IDENTIFIER = 'Enter the email address or phone number you registered with.';

// ─── Step one: who is this? ─────────────────────────────────

// POST /api/auth/identify
// Decides what to ask for next. The answer comes from the identifier alone —
// no database lookup — so this cannot be used to discover who holds an account.
router.post('/identify', (req, res) => {
  const who = identity.classify(req.body.identifier || req.body.email);
  if (!who) {
    return res.status(400).json({ error: BAD_IDENTIFIER });
  }

  res.json({
    identifier: who.value,
    type: who.type,
    audience: who.audience,
    method: who.method,                       // 'password' for staff, 'code' for participants
    channel: who.channel,                     // where a code would go
    masked: identity.mask(who),
    // Staff sign in with their Credit Direct password; the Developer Hub
    // handoff is for the people building on the APIs.
    sso: who.audience === 'participant'
  });
});

// ─── Participants: one-time code ────────────────────────────

// POST /api/auth/code/request
// Answers the same way whether or not the account exists, so the endpoint
// never becomes a membership oracle. Only a real member is actually sent
// anything.
router.post('/code/request', async (req, res) => {
  const who = identity.classify(req.body.identifier || req.body.email);
  if (!who) {
    return res.status(400).json({ error: BAD_IDENTIFIER });
  }

  if (who.audience === 'staff') {
    return res.status(400).json({
      error: 'Credit Direct staff sign in with a password.',
      method: 'password'
    });
  }

  if (await loginCodes.throttled(who.value)) {
    return res.status(429).json({
      error: 'Too many codes requested. Wait a few minutes before trying again.'
    });
  }

  const answer = {
    sent: true,
    channel: who.channel,
    masked: identity.mask(who),
    expires_in_sec: loginCodes.TTL_SEC,
    code_length: loginCodes.CODE_LENGTH
  };

  const user = await loginCodes.findParticipant(who);

  if (user && user.status === 'active') {
    const { code } = await loginCodes.issue(user, who);

    try {
      await loginCodes.deliver(user, who, code);
    } catch (err) {
      logger.error('Sign-in code delivery failed', { error: err.message });
    }

    // When nothing is actually delivered the code would otherwise be a dead
    // end. Hand it back so the advertised demo developers can still sign in.
    if (!config.delivery.enabled) answer.dev_code = code;
  }

  res.json(answer);
});

// POST /api/auth/code/verify
router.post('/code/verify', async (req, res) => {
  const who = identity.classify(req.body.identifier || req.body.email);
  if (!who || who.audience !== 'participant') {
    return res.status(400).json({ error: BAD_IDENTIFIER });
  }

  const key = throttleKey(req, 'code:' + who.value);
  if (isThrottled(key)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const result = await loginCodes.verify(who, req.body.code);
  if (!result.ok) {
    recordFailure(key);
    return res.status(401).json({ error: result.error });
  }

  // Checked only after the code verifies, so a suspended account is not
  // revealed to somebody guessing addresses.
  if (result.user.status !== 'active') {
    return res.status(403).json({ error: 'Account is ' + result.user.status });
  }

  clearFailures(key);
  await db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").run(result.user.id);

  const token = await createSession(result.user.id, false, {
    issuedVia: `login_code_${who.channel}`,
    userAgent: req.headers['user-agent']
  });

  res.json({ token, user: safeUser(result.user), isAdmin: false });
});

// ─── Staff: password ────────────────────────────────────────

// POST /api/auth/login          (and /api/auth/admin/login, kept for callers
// written against the old split) — the password half of the single form.
async function staffLogin(req, res) {
  const { password } = req.body;
  const who = identity.classify(req.body.identifier || req.body.email);

  if (!who || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  if (who.audience !== 'staff') {
    // Not a refusal to serve them — they simply have no password to give.
    return res.status(400).json({
      error: 'Sign in with a one-time code sent to your email or phone. Passwords are for Credit Direct staff.',
      method: 'code'
    });
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

  const token = await createSession(admin.id, true, { userAgent: req.headers['user-agent'] });
  const safe = safeUser(admin);

  // The client needs the permission list to hide actions the role cannot perform
  res.json({ token, admin: safe, user: safe, isAdmin: true, permissions: await permissionsFor(admin) });
}

router.post('/login', staffLogin);
router.post('/admin/login', staffLogin);

// ─── Registration ───────────────────────────────────────────

// POST /api/auth/register
// Creates a participant profile. No password is set — the account is claimed
// by signing in with a one-time code, which is also what proves the address
// belongs to whoever registered it.
router.post('/register', async (req, res) => {
  const { name, phone, company, work_sector } = req.body;
  const email = identity.normalizeEmail(req.body.email);

  if (!email || !name) {
    return res.status(400).json({ error: 'A valid email and a name are required' });
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
    phone || null, identity.normalizePhone(phone), company || null, work_sector || null
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

  // No session yet: the code sent to this address is what proves it is theirs.
  res.status(201).json({
    user: safeUser(user),
    next: { method: 'code', endpoint: '/api/auth/code/request', identifier: email }
  });
});

// ─── Session ────────────────────────────────────────────────

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  const token = req.headers.authorization.slice(7);
  await destroySession(token);
  res.json({ message: 'Logged out' });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  if (req.isAdmin) {
    const role = await db.prepare('SELECT * FROM roles WHERE id = ?').get(req.admin.role_id);
    return res.json({ user: safeUser(req.admin), role, permissions: req.permissions, isAdmin: true });
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
    return res.status(404).json({ error: 'No Dev Circle account linked to this Developer Hub user' });
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
router.post('/sso/mint', (req, res) => {
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
router.post('/sso/link', requireAuth, (req, res) => {
  const { dev_hub_user_id } = req.body;

  if (!dev_hub_user_id) {
    return res.status(400).json({ error: 'dev_hub_user_id is required' });
  }

  db.prepare('UPDATE users SET dev_hub_user_id = ? WHERE id = ?').run(dev_hub_user_id, req.user.id);

  res.json({ message: 'Account linked to Developer Hub' });
});

module.exports = router;
