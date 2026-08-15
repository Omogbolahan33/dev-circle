const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Each run gets a throwaway database, so the suite never touches the
// developer's working data and tests cannot leak state into one another.
const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devcircle-test-')), 'test.db');

process.env.DEVCIRCLE_DB_PATH = TMP_DB;
process.env.DEVCIRCLE_QUIET = '1';
process.env.NODE_ENV = 'test';
process.env.DEV_HUB_SSO_SECRET = 'test-sso-secret';

const app = require('../../src/app');
const db = require('../../src/db');
const auth = require('../../src/middleware/auth');

let server;
let baseUrl;

async function start() {
  if (server) return baseUrl;
  await new Promise(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  return baseUrl;
}

function stop() {
  if (server) server.close();
  try { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); } catch {}
}

// Thin fetch wrapper: returns status and parsed body together so assertions
// can check both without two awaits everywhere.
async function call(method, endpoint, { token, apiKey, body, raw, sandbox, headers: extra } = {}) {
  const headers = { ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  // Routes the request to the throwaway database, exactly as the API reference
  // does when its sandbox toggle is on
  if (sandbox) headers['X-Devcircle-Sandbox'] = '1';

  const res = await fetch(baseUrl + endpoint, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (raw) return { status: res.status, text: await res.text(), headers: res.headers };

  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { _raw: text }; }
  return { status: res.status, body: parsed, headers: res.headers };
}

const get = (endpoint, opts) => call('GET', endpoint, opts);
const post = (endpoint, body, opts = {}) => call('POST', endpoint, { ...opts, body: body ?? {} });
const put = (endpoint, body, opts = {}) => call('PUT', endpoint, { ...opts, body: body ?? {} });
const del = (endpoint, opts) => call('DELETE', endpoint, opts);

// ─── Fixtures ───────────────────────────────────────────────

function uuid() { return crypto.randomUUID(); }

function reset() {
  // Rate-limit windows are process-wide, so a test that made many requests
  // would otherwise spend the next test's budget
  require('../../src/middleware/rateLimit').store.resetAll();

  const tables = [
    'login_codes',
    'session_dispatches', 'scheduled_sessions', 'message_deliveries', 'notifications',
    'user_gifts', 'gifts', 'consent', 'feedback', 'survey_responses', 'surveys',
    'engagement_history', 'circle_members', 'circles', 'user_cohorts', 'cohorts',
    'sessions', 'users', 'admin_users', 'roles', 'api_keys', 'message_blasts',
    'integration_events'
  ];
  db.transaction(() => {
    for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
  })();
}

function makeRootCircle() {
  const id = uuid();
  db.prepare(`
    INSERT INTO circles (id, name, slug, description, color, is_root)
    VALUES (?, 'Dev Circle', 'dev-circle', 'root', '#107EBC', 1)
  `).run(id);
  return id;
}

function makeRole(name, permissions) {
  const id = uuid();
  db.prepare('INSERT INTO roles (id, name, description, permissions) VALUES (?, ?, ?, ?)')
    .run(id, name, name, JSON.stringify(permissions));
  return id;
}

function makeAdmin({ email, password = 'admin-password', roleId }) {
  const bcrypt = require('bcryptjs');
  const id = uuid();
  db.prepare('INSERT INTO admin_users (id, email, name, password_hash, role_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, email, email.split('@')[0], bcrypt.hashSync(password, 4), roleId);
  return { id, email, password };
}

function makeUser(overrides = {}) {
  const identity = require('../../src/utils/identity');
  const id = uuid();
  const user = {
    email: `dev-${id.slice(0, 8)}@example.ng`,
    name: 'Test Developer',
    phone: null,
    company: 'Testco',
    work_sector: 'Fintech',
    api_status: 'sandbox',
    kyb_completed: 0,
    engagement_streak: 0,
    preferred_channels: [],
    preferred_days: [],
    preferred_time_start: '09:00',
    preferred_time_end: '17:00',
    api_products: [],
    location_state: 'Lagos',
    gender: 'female',
    date_of_birth: '1994-01-01',
    ...overrides
  };

  db.prepare(`
    INSERT INTO users (id, email, name, phone, phone_normalized, password_hash,
                       company, work_sector, api_status,
                       kyb_completed, engagement_streak, preferred_channels, preferred_days,
                       preferred_time_start, preferred_time_end, api_products,
                       location_state, gender, date_of_birth, status,
                       quiet_hours_start, quiet_hours_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    id, user.email, user.name,
    user.phone, identity.normalizePhone(user.phone),
    // Members have no password at all — a one-time code is the way in
    identity.NO_PASSWORD,
    user.company,
    user.work_sector, user.api_status, user.kyb_completed, user.engagement_streak,
    JSON.stringify(user.preferred_channels), JSON.stringify(user.preferred_days),
    user.preferred_time_start, user.preferred_time_end,
    JSON.stringify(user.api_products), user.location_state, user.gender, user.date_of_birth,
    // Fixtures default to no quiet window (start === end), so delivery
    // assertions do not depend on what time of day the suite runs. Tests that
    // care about quiet hours set the window explicitly.
    user.quiet_hours_start ?? '00:00',
    user.quiet_hours_end ?? '00:00'
  );

  return { id, ...user };
}

function grantConsent(userId, channel) {
  db.prepare(`
    INSERT INTO consent (id, user_id, channel, status, granted_at)
    VALUES (?, ?, ?, 'granted', datetime('now'))
  `).run(uuid(), userId, channel);
}

function withdrawConsent(userId, channel) {
  db.prepare(`
    INSERT INTO consent (id, user_id, channel, status, withdrawn_at)
    VALUES (?, ?, ?, 'withdrawn', datetime('now'))
  `).run(uuid(), userId, channel);
}

function makeApiKey(scopes = ['*']) {
  const { key, prefix } = auth.generateApiKey();
  db.prepare('INSERT INTO api_keys (id, key_hash, name, prefix, permissions) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), auth.hashApiKey(key), 'test key', prefix, JSON.stringify(scopes));
  return key;
}

async function loginAdmin(email, password) {
  const res = await post('/api/auth/login', { identifier: email, password });
  return res.body.token;
}

// Members hold no password: they ask for a one-time code and send it back.
// Outside production the code comes back in the request response, which is
// what makes the real flow exercisable here rather than reaching into the
// database for it.
async function loginUser(identifier) {
  const requested = await post('/api/auth/code/request', { identifier });
  const verified = await post('/api/auth/code/verify', {
    identifier,
    code: requested.body.dev_code
  });
  return verified.body.token;
}

module.exports = {
  start, stop, db, app,
  baseUrl: () => baseUrl,
  get, post, put, del, call,
  reset, uuid,
  makeRootCircle, makeRole, makeAdmin, makeUser, makeApiKey,
  grantConsent, withdrawConsent,
  loginAdmin, loginUser
};
