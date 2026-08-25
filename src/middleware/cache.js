const { createTtlCache } = require('../utils/ttlCache');
const context = require('../db/context');

// Session JOIN is one RTT to remote Postgres (~130ms). Repeating it on
// /me, /permissions and every list is what the console is timing.
// The page bodies are the second RTT. Both live here, dropped on write.

const principals = createTtlCache({ ttlMs: 60_000, max: 2_000 });
const pages = createTtlCache({ ttlMs: 45_000, max: 500 });

const SKIP = /export|template|\.csv$|\.xlsx$|sandbox/i;
const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i;
const AUTH_TABLE = /\b(sessions|admin_users|users|roles|circle_admins|circles)\b/i;

function isMutatingSql(sql) {
  return WRITE.test(String(sql || ''));
}

function noteWrite(sql) {
  const text = String(sql || '');
  pages.clear();
  if (!AUTH_TABLE.test(text)) return;
  // A new session or member row is not a change to who is already signed in.
  // Logout, deactivation, role edits and circle grants still wipe principals.
  if (/^\s*INSERT\b/i.test(text) && /\bsessions\b/i.test(text)) return;
  if (/^\s*INSERT\b/i.test(text) && /\busers\b/i.test(text) && !/\badmin_users\b/i.test(text)) return;
  principals.clear();
}

function clearAll() {
  pages.clear();
  principals.clear();
}

function ns() {
  return context.inSandbox() ? 's' : 'l';
}

function authKey(hash) {
  return `${ns()}:${hash}`;
}

function queryKey(query) {
  if (!query) return '';
  const keys = Object.keys(query);
  if (!keys.length) return '';
  return '?' + keys.sort().map(k => `${k}=${query[k]}`).join('&');
}

function pageKey(req) {
  const circle = req.circleId || req.headers['x-circle-id'] || req.query.circle_id || '';
  const subject = req.path === '/me' ? (req.admin?.id || req.user?.id || '') : '';
  return `${ns()}|${req.baseUrl || ''}${req.path}${queryKey(req.query)}|${circle}|${subject}`;
}

function peekPage(req) {
  if (req.method !== 'GET' || SKIP.test(req.path)) return undefined;
  return pages.get(pageKey(req));
}

function rememberGet(req, res, next) {
  if (req.method !== 'GET' || SKIP.test(req.path)) return next();

  const key = pageKey(req);
  const hit = pages.get(key);
  if (hit !== undefined) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(hit);
  }

  const send = res.json.bind(res);
  res.json = function cachedJson(body) {
    const code = res.statusCode || 200;
    if (code === 200 && body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      pages.set(key, body);
    }
    return send(body);
  };
  next();
}

module.exports = {
  principals,
  pages,
  isMutatingSql,
  noteWrite,
  clearAll,
  authKey,
  pageKey,
  peekPage,
  rememberGet
};
