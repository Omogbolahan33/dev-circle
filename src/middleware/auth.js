const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

// ─── Sessions ───────────────────────────────────────────────
// Tokens are random 32-byte values handed to the client; only their SHA-256
// hash is stored, so a database leak does not hand over live sessions.
// Persisting them means a restart no longer signs everybody out.

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// A session is normally 'full'. 'password_change' is issued when staff sign in
// with a temporary password: it authenticates them and nothing more, so the
// forced change cannot be walked around by typing a dashboard URL.
const PASSWORD_CHANGE_SCOPE = 'password_change';

// The only paths a password-change session may reach
const PASSWORD_CHANGE_ALLOWED = new Set([
  '/api/auth/password',
  '/api/auth/me',
  '/api/auth/logout'
]);

async function createSession(subjectId, isAdmin = false, meta = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionTtlMs)
    .toISOString().replace('T', ' ').slice(0, 19);

  await db.prepare(`
    INSERT INTO sessions (token_hash, subject_id, is_admin, issued_via, user_agent, expires_at, scope)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    hashToken(token),
    subjectId,
    isAdmin ? 1 : 0,
    meta.issuedVia || 'password',
    meta.userAgent ? String(meta.userAgent).slice(0, 255) : null,
    expiresAt,
    meta.scope || 'full'
  );

  return token;
}

async function getSession(token) {
  const row = await db.prepare(`
    SELECT * FROM sessions
    WHERE token_hash = ? AND expires_at > datetime('now')
  `).get(hashToken(token));

  if (!row) return null;
  return {
    userId: row.subject_id,
    isAdmin: row.is_admin === 1 || row.is_admin === true,
    issuedVia: row.issued_via,
    scope: row.scope || 'full'
  };
}

async function destroySession(token) {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

async function destroyAllSessionsFor(subjectId) {
  await db.prepare('DELETE FROM sessions WHERE subject_id = ?').run(subjectId);
}

// Sweep expired rows hourly so the table does not grow without bound
const sweeper = setInterval(async () => {
  await db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}, 60 * 60 * 1000);
sweeper.unref();

// ─── Permission catalogue ───────────────────────────────────
// Every admin capability in the product. Roles are built from this list, and
// requirePermission checks against it, so a role is now a real access boundary.

const PERMISSIONS = [
  { key: 'members.read', label: 'View members', group: 'Members' },
  { key: 'members.write', label: 'Edit members and end their sessions', group: 'Members' },
  { key: 'members.import', label: 'Bulk import members', group: 'Members' },
  { key: 'cohorts.read', label: 'View cohorts', group: 'Cohorts' },
  { key: 'cohorts.write', label: 'Create and edit cohorts', group: 'Cohorts' },
  { key: 'circles.read', label: 'View circles', group: 'Circles' },
  { key: 'circles.write', label: 'Create circles and manage their members', group: 'Circles' },
  { key: 'sessions.read', label: 'View scheduled sessions', group: 'Sessions' },
  { key: 'sessions.write', label: 'Schedule sessions and send reminders', group: 'Sessions' },
  { key: 'surveys.read', label: 'View surveys and responses', group: 'Surveys' },
  { key: 'surveys.write', label: 'Create and edit surveys', group: 'Surveys' },
  { key: 'surveys.invite', label: 'Send survey invitations', group: 'Surveys' },
  { key: 'blasts.send', label: 'Send message blasts', group: 'Messaging' },
  { key: 'feedback.read', label: 'View feedback and complaints', group: 'Feedback' },
  { key: 'feedback.write', label: 'Update feedback status', group: 'Feedback' },
  { key: 'gifts.read', label: 'View gifts', group: 'Rewards' },
  { key: 'gifts.write', label: 'Create and award gifts', group: 'Rewards' },
  { key: 'export.read', label: 'Export member and response data', group: 'Data' },
  { key: 'integrations.read', label: 'View integration events', group: 'System' },
  { key: 'integrations.write', label: 'Manage API keys and integrations', group: 'System' },
  { key: 'roles.read', label: 'View roles', group: 'System' },
  { key: 'roles.write', label: 'Create roles and manage admin users', group: 'System' },
  // Credentials are the keys to the integration surface: one of them can create
  // members, forge engagement, and mark accounts production-ready. Holding them
  // is a separate thing from watching the events they produce.
  { key: 'credentials.read', label: 'View API keys and integration credentials', group: 'Credentials' },
  { key: 'credentials.write', label: 'Issue, edit, rotate and revoke API keys', group: 'Credentials' },
  // The sandbox executes real requests, including destructive ones, against a
  // throwaway copy of the platform.
  { key: 'sandbox.use', label: 'Use the API sandbox', group: 'Credentials' },
  // The reference documents every endpoint, the payloads they take, and which
  // permission each one is gated on. That is a map of the whole admin surface,
  // so it is a capability in its own right rather than something every role
  // gets for free.
  { key: 'docs.read', label: 'View the API reference', group: 'System' }
];

const PERMISSION_KEYS = new Set(PERMISSIONS.map(p => p.key));

async function permissionsFor(admin) {
  if (!admin || !admin.role_id) return [];
  const role = await db.prepare('SELECT permissions FROM roles WHERE id = ?').get(admin.role_id);
  if (!role) return [];
  try { return JSON.parse(role.permissions || '[]'); } catch { return []; }
}

function hasPermission(perms, permission) {
  return perms.includes('*') || perms.includes(permission);
}

// ─── Middleware ─────────────────────────────────────────────

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const session = await getSession(authHeader.slice(7));
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Checked before the account is even loaded: a temporary password gets you
    // to the "choose a password" screen and nowhere else.
    if (session.scope === PASSWORD_CHANGE_SCOPE) {
      const path = req.originalUrl.split('?')[0].replace(/\/+$/, '') || '/';
      if (!PASSWORD_CHANGE_ALLOWED.has(path)) {
        return res.status(403).json({
          error: 'Set your own password before going any further.',
          must_change_password: true
        });
      }
    }

    if (session.isAdmin) {
      const admin = await db.prepare('SELECT * FROM admin_users WHERE id = ?').get(session.userId);
      if (!admin || admin.status !== 'active') {
        return res.status(401).json({ error: 'Admin account inactive' });
      }
      req.admin = admin;
      req.isAdmin = true;
      // A provisional value: a role is held within a circle, so circleContext
      // replaces this with the permissions that apply where they are working
      req.permissions = await permissionsFor(admin);
    } else {
      const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(session.userId);
      if (!user || user.status !== 'active') {
        return res.status(401).json({ error: 'User account inactive' });
      }
      req.user = user;
      req.isAdmin = false;
      req.permissions = [];
    }

    req.session = session;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Gate a route on a specific capability. Accepts one permission or a list,
// where any single match is enough.
function requirePermission(...required) {
  const wanted = required.flat();
  for (const p of wanted) {
    if (!PERMISSION_KEYS.has(p)) {
      throw new Error(`Unknown permission '${p}' — add it to the PERMISSIONS catalogue.`);
    }
  }

  return async (req, res, next) => {
    if (!req.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const perms = req.permissions || [];
    if (!wanted.some(p => hasPermission(perms, p))) {
      return res.status(403).json({
        error: `You do not have permission to do this`,
        required: wanted
      });
    }
    next();
  };
}

// ─── Integration API keys ───────────────────────────────────
// Machine-to-machine callers (landing page, Customer.io, Feex, Developer Hub)
// authenticate with an API key rather than reaching open endpoints.

function generateApiKey() {
  const raw = crypto.randomBytes(24).toString('hex');
  const prefix = raw.slice(0, 8);
  return { key: `dc_${prefix}_${raw}`, prefix };
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function requireApiKey(...scopes) {
  const wanted = scopes.flat();

  return async (req, res, next) => {
    const header = req.headers['x-api-key'] ||
      (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);

    if (!header) {
      return res.status(401).json({ error: 'API key required' });
    }

    const record = await db.prepare(`
      SELECT * FROM api_keys
      WHERE key_hash = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).get(hashApiKey(header));

    if (!record) {
      return res.status(401).json({ error: 'Invalid or revoked API key' });
    }

    let granted = [];
    try { granted = JSON.parse(record.permissions || '[]'); } catch { granted = []; }

    if (wanted.length && !wanted.some(s => granted.includes('*') || granted.includes(s))) {
      return res.status(403).json({ error: 'API key lacks the required scope', required: wanted });
    }

    await db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(record.id);
    req.apiKey = record;
    next();
  };
}

// ─── Developer Hub SSO ──────────────────────────────────────
// The Hub mints a handoff token: base64url(payload).hexHmac. We verify the
// signature with the shared secret and reject anything stale, which closes
// the hole where any known dev_hub_user_id granted a session.

function signSSOToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.devHub.ssoSecret).update(body).digest('hex');
  return `${body}.${sig}`;
}

function verifySSOToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, error: 'Malformed token' };
  }

  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', config.devHub.ssoSecret).update(body).digest('hex');

  const given = Buffer.from(sig || '', 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return { valid: false, error: 'Signature verification failed' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, error: 'Malformed token payload' };
  }

  if (!payload.sub) {
    return { valid: false, error: 'Token missing subject' };
  }

  const issuedAt = Number(payload.iat);
  if (!Number.isFinite(issuedAt)) {
    return { valid: false, error: 'Token missing issued-at' };
  }

  const ageSec = Math.floor(Date.now() / 1000) - issuedAt;
  if (ageSec > config.devHub.tokenMaxAgeSec || ageSec < -60) {
    return { valid: false, error: 'Token expired' };
  }

  return { valid: true, payload };
}

module.exports = {
  hashToken,
  createSession,
  getSession,
  destroySession,
  destroyAllSessionsFor,
  requireAuth,
  requireAdmin,
  requirePermission,
  requireApiKey,
  generateApiKey,
  hashApiKey,
  signSSOToken,
  verifySSOToken,
  permissionsFor,
  hasPermission,
  PERMISSIONS,
  PERMISSION_KEYS,
  PASSWORD_CHANGE_SCOPE
};
