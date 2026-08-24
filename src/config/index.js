// ─── Dev Circle — Runtime Configuration ─────────────────────
// All secrets and environment-specific values resolve here so nothing
// is hardcoded in route handlers. Load a .env file if one is present.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal .env loader (avoids adding a dependency for one file)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

// Secrets must be explicit in production. In development we derive a stable
// per-machine secret so local sessions survive restarts without setup.
function requireSecret(name, devFallbackSeed) {
  const value = process.env[name];
  if (value) return value;
  if (isProduction) {
    throw new Error(`${name} must be set in production. Refusing to start with a derived secret.`);
  }
  return crypto.createHash('sha256').update(`devcircle:${devFallbackSeed}`).digest('hex');
}

// ─── Database — SQLite (local) vs Postgres / Supabase (managed) ──
// Dev / test default to local SQLite via better-sqlite3. When DATABASE_URL is
// set (e.g. Supabase Postgres connection string) the app switches to `pg` and
// talks to Postgres instead. The switch is automatic — no code change — and the
// test suite keeps using SQLite because it injects DEVCIRCLE_DB_PATH.
//
// DATABASE_URL examples:
//   postgres://postgres:password@db.xxx.supabase.co:5432/postgres
//   postgres://postgres:password@db.xxx.supabase.co:6543/postgres?pgbouncer=true
//
// For Supabase the connection string is under Project → Database → Connection string.
// Use the pooled (6543) string for serverless / Render, the direct (5432) one for migrations.
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
const isPostgres = Boolean(databaseUrl);

// Supabase client config (optional — enables Supabase Storage for uploads,
// Supabase Auth helpers, and the Supabase dashboard link on the credentials screen).
// The database itself still connects via DATABASE_URL; these are for the JS client.
const supabase = {
  url: process.env.SUPABASE_URL || null,
  anonKey: process.env.SUPABASE_ANON_KEY || null,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || null,
  // Storage bucket for brand assets when using Supabase Storage instead of local disk
  storageBucket: process.env.SUPABASE_STORAGE_BUCKET || 'uploads',
  get configured() {
    return Boolean(this.url && this.anonKey);
  },
  get hasServiceRole() {
    return Boolean(this.url && this.serviceRoleKey);
  }
};

// Postgres pool tuning — overridable for Render / Supabase pgbouncer
const pgPool = {
  // Supabase pgbouncer already pools, so keep Node pool small there
  max: parseInt(process.env.PG_POOL_MAX, 10) || 10,
  idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS, 10) || 30000,
  connectionTimeoutMillis: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS, 10) || 10000,
  // Hosts without an IPv6 route (Render et al) fail with
  // `connect ENETUNREACH <ipv6>:5432` when DNS lists AAAA records first,
  // so prefer IPv4 answers unless PG_DNS_RESULT_ORDER overrides.
  dnsResultOrder: process.env.PG_DNS_RESULT_ORDER || 'ipv4first',
  // Supabase requires SSL; local Postgres does not
  ssl: process.env.PGSSLMODE === 'disable' || process.env.PG_SSL === 'false'
    ? false
    : isPostgres
      ? { rejectUnauthorized: false }
      : false
};

const config = {
  env: NODE_ENV,
  isProduction,
  port: parseInt(process.env.PORT, 10) || 3000,

  // ─── Database ────────────────────────────────────────────
  // Overridable so the test suite runs against a throwaway database instead
  // of the developer's working data. When DATABASE_URL is set postgres is used
  // and this path is ignored (kept for the sandbox fallback in local dev).
  dbPath: process.env.DEVCIRCLE_DB_PATH ||
    path.join(__dirname, '..', 'data', 'devcircle.db'),

  // The canonical connection info. `isPostgres` drives adapter selection in src/db.
  database: {
    url: databaseUrl,
    isPostgres,
    // Back-compat: some scripts still read config.databaseUrl
    get connectionString() { return databaseUrl; },
    pgPool,
    supabase
  },
  // Back-compat alias
  get databaseUrl() { return databaseUrl; },
  get isPostgres() { return isPostgres; },
  supabase,

  // ─── API sandbox ──────────────────────────────────────────
  // A throwaway database the API reference can be pointed at, so a developer
  // can send real requests — including the destructive ones — without touching
  // the member base or sending anybody a message. Off with SANDBOX_ENABLED=false.
  // With Postgres, the sandbox is a separate schema/prefix in the same DB or a
  // second connection string via DEVCIRCLE_SANDBOX_DATABASE_URL.
  sandbox: {
    enabled: process.env.SANDBOX_ENABLED !== 'false',
    dbPath: process.env.DEVCIRCLE_SANDBOX_DB_PATH ||
      (process.env.DEVCIRCLE_DB_PATH
        ? process.env.DEVCIRCLE_DB_PATH.replace(/(\.db)?$/, '-sandbox.db')
        : path.join(__dirname, '..', 'data', 'devcircle-sandbox.db')),
    databaseUrl: process.env.DEVCIRCLE_SANDBOX_DATABASE_URL || process.env.SANDBOX_DATABASE_URL || null
  },

  // ─── Uploaded brand assets ────────────────────────────────
  // Logos, background images and brand fonts uploaded by whoever themes a
  // survey. Deliberately outside public/: files that arrived from a browser
  // are served by a route that decides their content type, never by the static
  // handler that would happily serve them as whatever their extension claims.
  // With Supabase, set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and assets
  // are stored in Supabase Storage (bucket `uploads` by default) instead of
  // on disk. Local disk remains the fallback.
  uploadDir: process.env.DEVCIRCLE_UPLOAD_DIR ||
    path.join(__dirname, '..', 'data', 'uploads'),
  uploads: {
    // 'supabase' | 'local' — auto when Supabase is configured, overridable.
    get backend() {
      if (process.env.UPLOAD_BACKEND) return process.env.UPLOAD_BACKEND;
      return supabase.hasServiceRole ? 'supabase' : 'local';
    },
    bucket: supabase.storageBucket
  },

  // Big enough for a wordmark, a hero image or a weight of a brand font;
  // small enough that it cannot be used as free storage.
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES, 10) || 3 * 1024 * 1024,

  // Where this deployment answers. Used to build the links inside outbound
  // mail, which cannot be relative.
  appUrl: (process.env.APP_URL || `http://localhost:${parseInt(process.env.PORT, 10) || 3000}`)
    .replace(/\/+$/, ''),

  // Session lifetime for Dev Circle's own tokens
  sessionTtlMs: parseInt(process.env.SESSION_TTL_HOURS, 10) * 3600 * 1000 || 24 * 3600 * 1000,

  // ─── Who is staff ─────────────────────────────────────────
  // There is one sign-in form. These domains are what tells the backend the
  // person in front of it works for Credit Direct and should be asked for a
  // password; everybody else is a participant and signs in with a one-time
  // code or Developer Hub SSO.
  staffEmailDomains: (process.env.STAFF_EMAIL_DOMAINS || 'creditdirect.ng,fcmb.com')
    .split(',').map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),

  // One-time sign-in codes for participants
  loginCode: {
    length: 6,
    ttlSec: parseInt(process.env.LOGIN_CODE_TTL_SEC, 10) || 10 * 60,
    // Wrong guesses allowed against a single code before it is burned
    maxAttempts: parseInt(process.env.LOGIN_CODE_MAX_ATTEMPTS, 10) || 5,
    // Codes one identifier may request inside the window, so the endpoint
    // cannot be used to spam somebody's inbox or phone
    maxPerWindow: parseInt(process.env.LOGIN_CODE_MAX_PER_WINDOW, 10) || 4,
    windowSec: parseInt(process.env.LOGIN_CODE_WINDOW_SEC, 10) || 15 * 60
  },

  // Shared secret used to verify SSO handoff tokens minted by the Developer Hub
  devHub: {
    ssoSecret: requireSecret('DEV_HUB_SSO_SECRET', 'sso'),
    // Reject handoff tokens older than this to limit replay windows
    tokenMaxAgeSec: parseInt(process.env.DEV_HUB_TOKEN_MAX_AGE_SEC, 10) || 300,
    // Create a Dev Circle profile on first SSO arrival rather than 404-ing
    autoProvision: process.env.DEV_HUB_AUTO_PROVISION !== 'false'
  },

  // Outbound message delivery. Without credentials the dispatcher records
  // deliveries as 'simulated' instead of silently pretending they were sent.
  delivery: {
    customerIoSiteId: process.env.CUSTOMERIO_SITE_ID || null,
    customerIoApiKey: process.env.CUSTOMERIO_API_KEY || null,
    whatsappToken: process.env.WHATSAPP_API_TOKEN || null,
    smsApiKey: process.env.SMS_API_KEY || null,
    get enabled() {
      return Boolean(this.customerIoSiteId && this.customerIoApiKey);
    }
  },

  // Feex is inbound-only: it owns support tickets end to end and posts them
  // to Dev Circle for engagement visibility. There is no outbound credential
  // because Dev Circle never writes back.

  // Which secrets were actually supplied. The Credentials screen reports this
  // so an operator can see what is wired up without anything having to hand
  // back a value — only ever whether one is present.
  get configured() {
    return {
      customer_io: Boolean(this.delivery.customerIoSiteId && this.delivery.customerIoApiKey),
      whatsapp: Boolean(this.delivery.whatsappToken),
      sms: Boolean(this.delivery.smsApiKey),
      // The SSO secret always has a value — outside production one is derived
      // per machine — so what matters is whether it was set deliberately.
      dev_hub_sso: Boolean(process.env.DEV_HUB_SSO_SECRET),
      database: isPostgres ? 'postgres' : 'sqlite',
      supabase: supabase.configured,
      supabase_storage: supabase.hasServiceRole,
      uploads: this.uploads.backend
    };
  },

  // Comma-separated origin allowlist; '*' only permitted outside production
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean),

  // Bootstrap key printed on first run so integrations can authenticate
  bootstrapApiKey: process.env.BOOTSTRAP_API_KEY || null,

  // Upsert the advertised demo logins on boot so a fresh deploy is usable.
  // Tests skip this regardless. Set SEED_DEMO_ACCOUNTS=false to disable.
  seedDemoAccounts: process.env.SEED_DEMO_ACCOUNTS !== 'false'
};

if (isProduction && config.corsOrigins.includes('*')) {
  throw new Error('CORS_ORIGINS must be an explicit allowlist in production.');
}

module.exports = config;
