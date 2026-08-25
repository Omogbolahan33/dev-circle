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

function parsePermissions(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

async function permissionsFor(admin) {
  if (!admin || !admin.role_id) return [];
  if (admin.role_permissions !== undefined) return parsePermissions(admin.role_permissions);
  const role = await db.prepare('SELECT permissions FROM roles WHERE id = ?').get(admin.role_id);
  if (!role) return [];
  return parsePermissions(role.permissions);
}

function hasPermission(perms, permission) {
  return perms.includes('*') || perms.includes(permission);
}

// ─── Middleware ─────────────────────────────────────────────

function flagOn(value) {
  return value === 1 || value === true || value === '1' || value === 't' || value === 'true';
}

function circlesFromAccessRows(rows, admin) {
  const global = flagOn(admin.is_global);
  const seen = new Set();
  const circles = [];
  for (const row of rows) {
    if (!row.circle_id || seen.has(row.circle_id)) continue;
    seen.add(row.circle_id);
    circles.push({
      id: row.circle_id,
      name: row.circle_name,
      slug: row.circle_slug,
      description: row.circle_description,
      color: row.circle_color,
      status: row.circle_status,
      survey_theme: row.circle_survey_theme,
      created_at: row.circle_created_at,
      role_id: global ? admin.role_id : row.circle_role_id,
      global,
      role_permissions: global ? row.role_permissions : row.circle_role_permissions
    });
  }
  return circles;
}

async function resolvePrincipal(hash) {
  // Session, staff, role and the circles they may work in — one plan. A
  // second query in circleContext was another RTT on every admin page.
  const rows = await db.prepare(`
    SELECT
      s.subject_id, s.is_admin, s.issued_via, s.scope,
      a.id as admin_id, a.email as admin_email, a.name as admin_name,
      a.password_hash as admin_password_hash, a.role_id as admin_role_id,
      a.status as admin_status, a.is_global as admin_is_global,
      a.must_change_password as admin_must_change_password,
      a.invited_by as admin_invited_by, a.invited_at as admin_invited_at,
      a.created_at as admin_created_at,
      r.id as joined_role_id, r.name as role_name, r.description as role_description,
      r.permissions as role_permissions, r.is_system as role_is_system,
      r.created_at as role_created_at,
      u.id as user_id, u.status as user_status,
      c.id as circle_id, c.name as circle_name, c.slug as circle_slug,
      c.description as circle_description, c.color as circle_color,
      c.status as circle_status, c.survey_theme as circle_survey_theme,
      c.created_at as circle_created_at,
      ca.role_id as circle_role_id,
      cr.permissions as circle_role_permissions
    FROM sessions s
    LEFT JOIN admin_users a ON a.id = s.subject_id
    LEFT JOIN roles r ON r.id = a.role_id
    LEFT JOIN users u ON u.id = s.subject_id
    LEFT JOIN circles c ON CAST(s.is_admin AS TEXT) IN ('1', 'true', 't')
      AND c.status = 'active'
      AND (
        CAST(a.is_global AS TEXT) IN ('1', 'true', 't')
        OR EXISTS (
          SELECT 1 FROM circle_admins gx
          WHERE gx.admin_id = a.id AND gx.circle_id = c.id
        )
      )
    LEFT JOIN circle_admins ca ON ca.admin_id = a.id AND ca.circle_id = c.id
    LEFT JOIN roles cr ON cr.id = ca.role_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
    ORDER BY c.created_at
  `).all(hash);

  const row = rows && rows[0];
  if (!row) return null;

  const session = {
    userId: row.subject_id,
    isAdmin: flagOn(row.is_admin),
    issuedVia: row.issued_via,
    scope: row.scope || 'full'
  };

  if (session.isAdmin) {
    if (!row.admin_id || row.admin_status !== 'active') {
      return { error: 'inactive', message: 'Admin account inactive' };
    }
    const principal = {
      session,
      isAdmin: true,
      admin: {
        id: row.admin_id,
        email: row.admin_email,
        name: row.admin_name,
        password_hash: row.admin_password_hash,
        role_id: row.admin_role_id,
        status: row.admin_status,
        is_global: row.admin_is_global,
        must_change_password: row.admin_must_change_password,
        invited_by: row.admin_invited_by,
        invited_at: row.admin_invited_at,
        created_at: row.admin_created_at
      },
      permissions: parsePermissions(row.role_permissions),
      role: row.joined_role_id ? {
        id: row.joined_role_id,
        name: row.role_name,
        description: row.role_description,
        permissions: row.role_permissions,
        is_system: row.role_is_system,
        created_at: row.role_created_at
      } : null,
      user: null,
      circles: circlesFromAccessRows(rows, {
        role_id: row.admin_role_id,
        is_global: row.admin_is_global
      })
    };
    return principal;
  }

  if (!row.user_id || row.user_status !== 'active') {
    return { error: 'inactive', message: 'User account inactive' };
  }
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || user.status !== 'active') {
    return { error: 'inactive', message: 'User account inactive' };
  }
  const principal = {
    session,
    isAdmin: false,
    admin: null,
    permissions: [],
    user
  };
  return principal;
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const hash = hashToken(authHeader.slice(7));
    const principal = await resolvePrincipal(hash);

    if (!principal) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (principal.error === 'inactive') {
      return res.status(401).json({ error: principal.message });
    }

    const session = principal.session;

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

    req.session = session;
    req.isAdmin = principal.isAdmin;
    req.permissions = principal.permissions;
    if (principal.isAdmin) {
      req.admin = principal.admin;
      req.role = principal.role || null;
      req.availableCircles = principal.circles || [];
    } else {
      req.user = principal.user;
    }
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
  parsePermissions,
  hasPermission,
  PERMISSIONS,
  PERMISSION_KEYS,
  PASSWORD_CHANGE_SCOPE
};
