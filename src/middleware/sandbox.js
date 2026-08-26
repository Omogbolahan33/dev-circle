const config = require('../config');
const context = require('../db/context');
const sandbox = require('../db/sandbox');
const { hashToken, permissionsFor, hasPermission } = require('./auth');

// ─── Sandbox routing ────────────────────────────────────────
// A request that asks for the sandbox is served against the throwaway database
// instead of the live one. Everything downstream — routes, services, the
// notification dispatcher — is unchanged and unaware; they hold a handle that
// resolves per request.
//
// The decision has to be made before authentication runs, because
// authentication itself reads a database. So this resolves the caller against
// the live database on its own, checks they are allowed in, copies their
// session across, and only then switches.

const HEADER = 'x-devcircle-sandbox';
const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'sandbox']);

function requested(req) {
  const header = req.headers[HEADER];
  return typeof header === 'string' && TRUTHY.has(header.trim().toLowerCase());
}

function bearer(req) {
  const header = req.headers.authorization;
  return header && header.startsWith('Bearer ') ? header.slice(7) : null;
}

function isHealth(req) {
  const path = String(req.originalUrl || req.url || req.path || '').split('?')[0];
  return path === '/health' || path === '/api/health' || path.endsWith('/health');
}

function isAdminSession(session) {
  const flag = session && session.is_admin;
  return flag === 1 || flag === true || flag === '1' || flag === 't' || flag === 'true';
}

async function sandboxContext(req, res, next) {
  if (!requested(req)) return next();
  // Liveness must not depend on mirroring a session into SQLite. The API
  // docs send this header on every Try-it-out call, including GET /health.
  if (isHealth(req)) return next();

  if (!config.sandbox.enabled) {
    return res.status(503).json({ error: 'The API sandbox is switched off in this environment' });
  }

  const token = bearer(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Read against the live database explicitly. Using the shared handle would
  // work here too — we have not switched yet — but saying it outright is what
  // stops a later edit from quietly looking the caller up in the sandbox,
  // where anybody could have written themselves an account.
  const live = context.live();

  const session = await live.prepare(`
    SELECT * FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')
  `).get(hashToken(token));

  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Members have no business in the sandbox: it is a tool for exploring the
  // admin surface, and mirroring a member session would put their own portal
  // in front of invented data.
  if (!isAdminSession(session)) {
    return res.status(403).json({ error: 'The sandbox is for Credit Direct staff' });
  }

  const admin = await live.prepare('SELECT * FROM admin_users WHERE id = ?').get(session.subject_id);
  if (!admin || admin.status !== 'active') {
    return res.status(401).json({ error: 'Admin account inactive' });
  }

  if (!hasPermission(await permissionsFor(admin), 'sandbox.use')) {
    return res.status(403).json({
      error: 'You do not have permission to use the API sandbox',
      required: ['sandbox.use']
    });
  }

  const role = admin.role_id
    ? await live.prepare('SELECT * FROM roles WHERE id = ?').get(admin.role_id)
    : null;

  const database = sandbox.db();
  sandbox.mirrorAccess(database, { admin, role, session });

  // The console stamps every admin call with the live workspace. That id
  // does not exist here — the sandbox is its own single circle — so a
  // reset or a Try-it-out would 403 as "no access to that circle".
  delete req.headers['x-circle-id'];
  if (req.query && Object.prototype.hasOwnProperty.call(req.query, 'circle_id')) {
    delete req.query.circle_id;
  }

  // Said out loud on the way back, so a client can never be confused about
  // which set of data it is looking at.
  res.setHeader('X-Devcircle-Sandbox', 'active');

  return context.runWith(database, () => next());
}

module.exports = { sandboxContext, requested, HEADER };
