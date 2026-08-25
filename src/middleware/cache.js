const { createTtlCache } = require('../utils/ttlCache');
const context = require('../db/context');

// Session JOIN is one RTT to remote Postgres (~130ms). Repeating it on
// /me, /permissions and every list is what the console is timing.
// The page bodies are the second RTT. Both live here; a write drops only
// the pages that read the table it touched.

const principals = createTtlCache({ ttlMs: 5 * 60_000, max: 2_000 });
const pages = createTtlCache({ ttlMs: 5 * 60_000, max: 500 });

const SKIP = /export|template|\.csv$|\.xlsx$|sandbox/i;
const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i;
const AUTH_TABLE = /\b(sessions|admin_users|users|roles|circle_admins|circles)\b/i;

// Side-effect writes that must not empty the console. last_used_at is
// stamped on every integration call; login codes and the migrations
// ledger never appear on a list GET.
const NOISE = /\blast_used_at\b|\blogin_codes\b|\bschema_migrations\b|\bsandbox_meta\b/i;

const OVERVIEW = ['/dashboard', '/demography'];
const MEMBERS = ['/members', ...OVERVIEW, '/cohorts'];
const SURVEYS = ['/surveys', ...OVERVIEW, '/feedback/grouped'];
const FEEDBACK = ['/feedback/grouped', '/dashboard'];

const TABLE_PAGES = {
  users: MEMBERS,
  circle_members: MEMBERS,
  user_cohorts: ['/members', '/cohorts', '/dashboard'],
  cohorts: ['/cohorts', '/dashboard', '/members'],
  surveys: SURVEYS,
  survey_responses: SURVEYS,
  questions: SURVEYS,
  feedback: FEEDBACK,
  gifts: ['/gifts', '/dashboard'],
  user_gifts: ['/gifts', '/dashboard'],
  message_blasts: ['/blasts'],
  message_deliveries: ['/blasts'],
  engagement_history: ['/dashboard'],
  scheduled_sessions: ['/sessions'],
  session_dispatches: ['/sessions'],
  roles: ['/roles', '/admins', '/permissions'],
  admin_users: ['/admins', '/roles'],
  circle_admins: ['/admins'],
  circles: ['/dashboard', '/members', '/cohorts', '/surveys'],
  api_keys: ['/api-keys', '/credentials'],
  integration_events: ['/integration-events']
};

function isMutatingSql(sql) {
  return WRITE.test(String(sql || ''));
}

function tablesTouched(sql) {
  const text = String(sql || '');
  const found = new Set();
  const patterns = [
    /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)/ig,
    /\bUPDATE\s+(\w+)/ig,
    /\bDELETE\s+FROM\s+(\w+)/ig,
    /\bREPLACE\s+INTO\s+(\w+)/ig
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text))) found.add(match[1].toLowerCase());
  }
  return [...found];
}

function dropPages(paths) {
  for (const path of paths) {
    pages.invalidate(`l|/api/admin${path}`);
    pages.invalidate(`s|/api/admin${path}`);
  }
}

function dropMe() {
  pages.invalidate('l|/api/auth/me');
  pages.invalidate('s|/api/auth/me');
}

let rewarmTimer = null;
function scheduleRewarm() {
  if (process.env.NODE_ENV === 'test') return;
  if (rewarmTimer) return;
  rewarmTimer = setTimeout(() => {
    rewarmTimer = null;
    require('../services/warmCache').warm().catch(() => {});
  }, 75);
  if (typeof rewarmTimer.unref === 'function') rewarmTimer.unref();
}

function noteWrite(sql) {
  const text = String(sql || '');
  if (NOISE.test(text)) return;

  const tables = tablesTouched(text);
  const paths = new Set();
  let unknown = tables.length === 0;
  for (const table of tables) {
    const mapped = TABLE_PAGES[table];
    if (!mapped) { unknown = true; break; }
    for (const path of mapped) paths.add(path);
  }
  if (unknown) pages.clear();
  else dropPages([...paths]);

  if (!AUTH_TABLE.test(text)) {
    scheduleRewarm();
    return;
  }
  // A new session or member row is not a change to who is already signed in.
  // Logout, deactivation, role edits and circle grants still wipe principals.
  if (/^\s*INSERT\b/i.test(text) && /\bsessions\b/i.test(text)) {
    scheduleRewarm();
    return;
  }
  if (/^\s*INSERT\b/i.test(text) && /\busers\b/i.test(text) && !/\badmin_users\b/i.test(text)) {
    scheduleRewarm();
    return;
  }
  principals.clear();
  dropMe();
  scheduleRewarm();
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

function putPage(path, { circleId = '', query, body } = {}) {
  pages.set(`l|/api/admin${path}${queryKey(query)}|${circleId}|`, body);
  return body;
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
  tablesTouched,
  noteWrite,
  clearAll,
  authKey,
  pageKey,
  putPage,
  peekPage,
  rememberGet
};
