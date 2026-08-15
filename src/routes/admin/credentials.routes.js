const express = require('express');
const db = require('../../db');
const config = require('../../config');
const { uuid, parseJSON } = require('../../utils/helpers');
const {
  requirePermission, generateApiKey, hashApiKey
} = require('../../middleware/auth');

const router = express.Router();

// ─── Credentials ────────────────────────────────────────────
// Everything that authenticates a machine against Dev Circle, in one place:
// the keys we issue to integrations, and the credentials we hold for the
// providers we call out to.
//
// The two are managed differently on purpose. Keys we issue are stored as
// hashes, so the whole lifecycle — issue, edit, rotate, revoke — can live in
// the console safely. Provider secrets are the opposite: they must be usable
// in cleartext to sign a request, so they stay in the environment and this
// surface only ever reports whether they are set.

// ─── Scopes ─────────────────────────────────────────────────
// The catalogue the key editor builds from. Each scope names the endpoints it
// unlocks, so nobody has to guess which one an integration needs.

const SCOPES = [
  {
    key: 'landing_page',
    label: 'Landing page',
    description: 'Register developers from the public sign-up form',
    endpoints: ['POST /integrations/landing-page/ingest']
  },
  {
    key: 'customer_io',
    label: 'Customer.io',
    description: 'Receive lifecycle events and trigger surveys from them',
    endpoints: ['POST /integrations/customerio/webhook', 'GET /integrations/events/pending']
  },
  {
    key: 'feex',
    label: 'Feex',
    description: 'Mirror support tickets as engagement signals',
    endpoints: ['POST /integrations/feex/webhook', 'GET /integrations/events/pending']
  },
  {
    key: 'events',
    label: 'Developer Hub events',
    description: 'Report developer actions from the analytics bridge',
    endpoints: ['POST /integrations/events', 'GET /integrations/events/pending']
  },
  {
    key: '*',
    label: 'Everything',
    description: 'Every integration endpoint, including ones added later',
    endpoints: ['All of the above']
  }
];

const SCOPE_KEYS = new Set(SCOPES.map(s => s.key));

// ─── Providers ──────────────────────────────────────────────
// What we hold credentials *for*. Values never leave the server — only whether
// they are present, and what stops working while they are not.

function providers() {
  const { configured } = config;

  return [
    {
      id: 'customer_io',
      name: 'Customer.io',
      purpose: 'Delivers email, WhatsApp and SMS from a single transactional trigger',
      configured: configured.customer_io,
      env: ['CUSTOMERIO_SITE_ID', 'CUSTOMERIO_API_KEY'],
      degraded: 'Outbound messages are recorded as "simulated" instead of being sent. Nothing is lost — the delivery log stays honest — but nobody receives anything.'
    },
    {
      id: 'whatsapp',
      name: 'WhatsApp',
      purpose: 'Direct WhatsApp delivery, where Customer.io is not the route',
      configured: configured.whatsapp,
      env: ['WHATSAPP_API_TOKEN'],
      degraded: 'WhatsApp falls back to the Customer.io fan-out.'
    },
    {
      id: 'sms',
      name: 'SMS',
      purpose: 'Direct SMS delivery, and one-time sign-in codes to a phone',
      configured: configured.sms,
      env: ['SMS_API_KEY'],
      degraded: 'SMS falls back to the Customer.io fan-out.'
    },
    {
      id: 'dev_hub_sso',
      name: 'Developer Hub SSO',
      purpose: 'Verifies the signed handoff token that carries a developer over from the Hub',
      configured: configured.dev_hub_sso,
      env: ['DEV_HUB_SSO_SECRET'],
      degraded: 'A per-machine secret is derived instead, so handoff tokens do not survive a redeploy and will not verify across instances. Production refuses to start without it.'
    }
  ];
}

// ─── Key shaping ────────────────────────────────────────────

function keyStatus(row) {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at.replace(' ', 'T')) <= new Date()) return 'expired';
  return 'live';
}

function shape(row) {
  return {
    ...row,
    permissions: parseJSON(row.permissions, []),
    status: keyStatus(row)
  };
}

const KEY_COLUMNS = `
  id, name, prefix, permissions, last_used_at, expires_at, revoked_at, created_at, created_by
`;

function findKey(id) {
  return db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ?`).get(id);
}

// Accepts a list of scopes and says what is wrong with it, or nothing.
function validateScopes(scopes) {
  if (!Array.isArray(scopes)) return 'scopes must be an array';
  if (!scopes.length) return 'Grant at least one scope';

  const unknown = scopes.filter(s => !SCOPE_KEYS.has(s));
  if (unknown.length) return `Unknown scope(s): ${unknown.join(', ')}`;

  // '*' beside anything else reads as a narrower key than it is
  if (scopes.includes('*') && scopes.length > 1) {
    return 'A key scoped to "*" already covers every endpoint — remove the others';
  }
  return null;
}

// Dates arrive from a date picker as YYYY-MM-DD and from a script as a full
// timestamp. Both are stored the way SQLite compares them.
function normaliseExpiry(value) {
  if (value === null || value === undefined || value === '') return { value: null };

  const text = String(value).trim();
  const date = new Date(text.includes(' ') || text.includes('T') ? text.replace(' ', 'T') : `${text}T23:59:59Z`);
  if (Number.isNaN(date.getTime())) return { error: 'expires_at must be a date or date-time' };
  if (date.getTime() <= Date.now()) return { error: 'expires_at must be in the future' };

  return { value: date.toISOString().replace('T', ' ').slice(0, 19) };
}

// ─── The whole picture ──────────────────────────────────────

// GET /api/admin/credentials
router.get('/credentials', requirePermission('credentials.read'), (req, res) => {
  const keys = db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys`).all().map(shape);

  res.json({
    providers: providers(),
    scopes: SCOPES,
    keys: {
      total: keys.length,
      live: keys.filter(k => k.status === 'live').length,
      expired: keys.filter(k => k.status === 'expired').length,
      revoked: keys.filter(k => k.status === 'revoked').length,
      // A key nobody has ever used is either a mistake or a leak waiting to be
      // noticed, so it is worth counting separately from an idle one.
      never_used: keys.filter(k => k.status === 'live' && !k.last_used_at).length,
      last_used_at: keys.map(k => k.last_used_at).filter(Boolean).sort().pop() || null
    },
    sandbox: {
      enabled: config.sandbox.enabled,
      header: 'X-Devcircle-Sandbox'
    }
  });
});

// ─── Keys ───────────────────────────────────────────────────

// GET /api/admin/api-keys
// 'integrations.write' is accepted alongside the newer permission: it is what
// gated key management before credentials.* existed, and a role that could do
// this yesterday should not have stopped overnight.
router.get('/api-keys', requirePermission('credentials.read', 'integrations.write'), (req, res) => {
  const { status } = req.query;

  const keys = db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys ORDER BY created_at DESC`)
    .all().map(shape)
    .filter(key => !status || key.status === status);

  res.json({ keys, scopes: SCOPES });
});

// GET /api/admin/api-keys/:id
router.get('/api-keys/:id', requirePermission('credentials.read'), (req, res) => {
  const key = findKey(req.params.id);
  if (!key) return res.status(404).json({ error: 'Key not found' });

  const issuedBy = key.created_by
    ? db.prepare('SELECT name, email FROM admin_users WHERE id = ?').get(key.created_by)
    : null;

  res.json({
    key: shape(key),
    issued_by: issuedBy,
    scopes: SCOPES
  });
});

// POST /api/admin/api-keys
router.post('/api-keys', requirePermission('credentials.write', 'integrations.write'), (req, res) => {
  const { name, scopes, expires_at } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

  const granted = Array.isArray(scopes) && scopes.length ? scopes : ['events'];
  const invalid = validateScopes(granted);
  if (invalid) return res.status(400).json({ error: invalid, valid: [...SCOPE_KEYS] });

  const expiry = normaliseExpiry(expires_at);
  if (expiry.error) return res.status(400).json({ error: expiry.error });

  const { key, prefix } = generateApiKey();
  const id = uuid();

  db.prepare(`
    INSERT INTO api_keys (id, key_hash, name, prefix, permissions, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, hashApiKey(key), String(name).trim(), prefix, JSON.stringify(granted), expiry.value, req.admin.id);

  // The plaintext key is shown exactly once — only its hash is stored
  res.status(201).json({
    key,
    prefix,
    scopes: granted,
    record: shape(findKey(id)),
    warning: 'Copy this key now. It cannot be retrieved again.'
  });
});

// PUT /api/admin/api-keys/:id — rename, re-scope, or change when it expires
router.put('/api-keys/:id', requirePermission('credentials.write'), (req, res) => {
  const key = findKey(req.params.id);
  if (!key) return res.status(404).json({ error: 'Key not found' });
  if (key.revoked_at) {
    return res.status(409).json({ error: 'This key is revoked. Issue a new one instead.' });
  }

  const { name, scopes, expires_at } = req.body;
  const updates = [];
  const params = [];

  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'name cannot be empty' });
    updates.push('name = ?'); params.push(String(name).trim());
  }

  if (scopes !== undefined) {
    const invalid = validateScopes(scopes);
    if (invalid) return res.status(400).json({ error: invalid, valid: [...SCOPE_KEYS] });
    updates.push('permissions = ?'); params.push(JSON.stringify(scopes));
  }

  if (expires_at !== undefined) {
    const expiry = normaliseExpiry(expires_at);
    if (expiry.error) return res.status(400).json({ error: expiry.error });
    updates.push('expires_at = ?'); params.push(expiry.value);
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  params.push(key.id);
  db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  res.json({ key: shape(findKey(key.id)) });
});

// POST /api/admin/api-keys/:id/rotate
// Replacing a key normally means an outage: the new one is not deployed yet
// when the old one stops working. A grace period lets both work at once, so
// the integration can be moved over and the old key lapses on its own.
const MAX_GRACE_HOURS = 720;

router.post('/api-keys/:id/rotate', requirePermission('credentials.write'), (req, res) => {
  const previous = findKey(req.params.id);
  if (!previous) return res.status(404).json({ error: 'Key not found' });
  if (previous.revoked_at) {
    return res.status(409).json({ error: 'This key is already revoked. Issue a new one instead.' });
  }

  const grace = Number(req.body.grace_hours ?? 0);
  if (!Number.isFinite(grace) || grace < 0 || grace > MAX_GRACE_HOURS) {
    return res.status(400).json({ error: `grace_hours must be between 0 and ${MAX_GRACE_HOURS}` });
  }

  const scopes = parseJSON(previous.permissions, ['events']);
  const { key, prefix } = generateApiKey();
  const id = uuid();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO api_keys (id, key_hash, name, prefix, permissions, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, hashApiKey(key), previous.name, prefix, JSON.stringify(scopes), previous.expires_at, req.admin.id);

    if (grace > 0) {
      // Left live, but with a deadline it cannot outlive
      db.prepare("UPDATE api_keys SET expires_at = datetime('now', ?) WHERE id = ?")
        .run(`+${grace} hours`, previous.id);
    } else {
      db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?").run(previous.id);
    }
  })();

  const old = shape(findKey(previous.id));

  res.status(201).json({
    key,
    prefix,
    scopes,
    record: shape(findKey(id)),
    replaced: { id: old.id, prefix: old.prefix, status: old.status, expires_at: old.expires_at },
    warning: grace > 0
      ? `Copy this key now — it cannot be retrieved again. The previous key keeps working for ${grace} hour(s), then stops.`
      : 'Copy this key now. It cannot be retrieved again. The previous key stopped working immediately.'
  });
});

// DELETE /api/admin/api-keys/:id
router.delete('/api-keys/:id', requirePermission('credentials.write', 'integrations.write'), (req, res) => {
  const result = db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
    .run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Key not found or already revoked' });

  // The row survives revocation so the event log still explains what the key was
  res.json({ message: 'Key revoked', key: shape(findKey(req.params.id)) });
});

module.exports = router;
module.exports.SCOPES = SCOPES;
