const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { uuid } = require('../utils/helpers');
const circles = require('../services/circles');
const {
  createSession, destroySession, requireAuth,
  signSSOToken, verifySSOToken, permissionsFor
} = require('../middleware/auth');

const router = express.Router();

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

// ─── User Auth ──────────────────────────────────────────────

// POST /api/auth/register
router.post('/register', (req, res) => {
  const { email, name, password, phone, company, work_sector } = req.body;

  if (!email || !name || !password) {
    return res.status(400).json({ error: 'email, name, and password are required' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const id = uuid();
  const password_hash = bcrypt.hashSync(password, 10);

  db.prepare(`
    INSERT INTO users (id, email, name, password_hash, phone, company, work_sector)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, email, name, password_hash, phone || null, company || null, work_sector || null);

  // Auto-assign to "All Members" cohort
  const allCohort = db.prepare("SELECT id FROM cohorts WHERE name = 'All Members'").get();
  if (allCohort) {
    db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)').run(id, allCohort.id);
  }

  circles.joinRoot(id);

  // Log engagement event
  db.prepare(`
    INSERT INTO engagement_history (id, user_id, type, source, metadata)
    VALUES (?, ?, 'account_created', 'dev_circle', '{}')
  `).run(uuid(), id);

  const token = createSession(id, false);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const { password_hash: _, ...safe } = user;

  res.status(201).json({ token, user: safe });
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const key = throttleKey(req, email);
  if (isThrottled(key)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    recordFailure(key);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    recordFailure(key);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Status is checked only after the password verifies, so the endpoint does
  // not reveal which addresses are registered.
  if (user.status !== 'active') {
    return res.status(403).json({ error: 'Account is ' + user.status });
  }

  clearFailures(key);

  // Update last active
  db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").run(user.id);

  const token = createSession(user.id, false, { userAgent: req.headers['user-agent'] });
  const { password_hash: _, ...safe } = user;

  res.json({ token, user: safe });
});

// POST /api/auth/logout
router.post('/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization.slice(7);
  destroySession(token);
  res.json({ message: 'Logged out' });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  if (req.isAdmin) {
    const { password_hash: _, ...safe } = req.admin;
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.admin.role_id);
    return res.json({ user: safe, role, permissions: req.permissions, isAdmin: true });
  }
  const { password_hash: _, ...safe } = req.user;
  res.json({ user: safe, isAdmin: false });
});

// ─── Admin Auth ─────────────────────────────────────────────

// POST /api/auth/admin/login
router.post('/admin/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const key = throttleKey(req, 'admin:' + email);
  if (isThrottled(key)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const admin = db.prepare('SELECT * FROM admin_users WHERE email = ?').get(email);
  if (!admin || admin.status !== 'active' || !bcrypt.compareSync(password, admin.password_hash)) {
    recordFailure(key);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  clearFailures(key);

  const token = createSession(admin.id, true, { userAgent: req.headers['user-agent'] });
  const { password_hash: _, ...safe } = admin;

  // The client needs the permission list to hide actions the role cannot perform
  res.json({ token, admin: safe, permissions: permissionsFor(admin) });
});

// ─── SSO (Developer Hub → Dev Circle) ───────────────────────

// POST /api/auth/sso/exchange
// Trades an HMAC-signed Developer Hub handoff token for a Dev Circle session.
// The subject comes from the *verified* token payload — never from the request
// body — so knowing a dev_hub_user_id is not enough to obtain a session.
router.post('/sso/exchange', (req, res) => {
  const { hub_token } = req.body;

  if (!hub_token) {
    return res.status(400).json({ error: 'hub_token is required' });
  }

  const result = verifySSOToken(hub_token);
  if (!result.valid) {
    return res.status(401).json({ error: `SSO rejected: ${result.error}` });
  }

  const { sub: devHubUserId, email, name, company, work_sector } = result.payload;

  let user = db.prepare('SELECT * FROM users WHERE dev_hub_user_id = ?').get(devHubUserId);

  // Fall back to matching on the verified email, then link the accounts
  if (!user && email) {
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) {
      db.prepare('UPDATE users SET dev_hub_user_id = ? WHERE id = ?').run(devHubUserId, user.id);
    }
  }

  // An authenticated Hub developer with no Dev Circle profile gets one created,
  // rather than hitting a dead end on their first visit.
  if (!user && config.devHub.autoProvision && email) {
    const id = uuid();
    const placeholderPassword = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);

    db.prepare(`
      INSERT INTO users (id, email, name, password_hash, company, work_sector, dev_hub_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, email, name || email.split('@')[0], placeholderPassword, company || null, work_sector || null, devHubUserId);

    const allCohort = db.prepare("SELECT id FROM cohorts WHERE name = 'All Members'").get();
    if (allCohort) {
      db.prepare('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)').run(id, allCohort.id);
    }

    circles.joinRoot(id);

    db.prepare(`
      INSERT INTO engagement_history (id, user_id, type, source, metadata)
      VALUES (?, ?, 'account_created', 'system', ?)
    `).run(uuid(), id, JSON.stringify({ via: 'dev_hub_sso' }));

    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  if (!user) {
    return res.status(404).json({ error: 'No Dev Circle account linked to this Developer Hub user' });
  }

  if (user.status !== 'active') {
    return res.status(403).json({ error: 'Account is ' + user.status });
  }

  db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").run(user.id);
  const token = createSession(user.id, false, { issuedVia: 'dev_hub_sso', userAgent: req.headers['user-agent'] });
  const { password_hash: _, ...safe } = user;

  res.json({ token, user: safe });
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
