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
// ─── Is this a long-lived server or a function? ─────────────
// The two want opposite pool settings and getting it wrong is invisible until
// production is under load.
//
// A long-lived process (Render, Fly, a container) is one pool for the life of
// the deployment: a handful of connections, held open, is exactly right.
//
// A serverless function is not. Every concurrent invocation is its own
// container with its own pool, so `max` is not the number of connections — it
// is the number *per container*, multiplied by however many the platform
// decided to run. Ten looks modest and becomes eighty behind a traffic spike,
// against a Supavisor pool of fifteen.
const isServerless = Boolean(
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.VERCEL ||
  process.env.FUNCTION_TARGET ||          // Google Cloud Functions
  process.env.K_SERVICE ||                // Cloud Run
  process.env.NETLIFY ||
  process.env.LAMBDA_TASK_ROOT
);

const pgPool = {
  // One per container on serverless. A function handles one request at a time,
  // so a second connection buys nothing and costs a slot in a pool everybody
  // else is queueing for.
  max: parseInt(process.env.PG_POOL_MAX, 10) || (isServerless ? 1 : 10),

  // Returned quickly on serverless. A container that has finished its request
  // is frozen, not exited — the timer that would reap an idle client does not
  // run while it is frozen, so the connection sits held until the pooler itself
  // times it out. A short window means fewer of them are held at the moment the
  // next spike arrives.
  idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS, 10) || (isServerless ? 5000 : 30000),

  connectionTimeoutMillis: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS, 10) || 10000,

  // Let the pool stop holding the event loop open, so a finished invocation can
  // actually settle rather than being frozen mid-connection.
  allowExitOnIdle: isServerless,

  // A 20-second `SELECT 1` keeps the socket warm and saves an SSL handshake on
  // a long-lived server. On serverless it is a leak with a friendly name: it
  // pins one connection per container that ever booted, for as long as the
  // platform keeps that container around.
  keepAlive: !isServerless,

  // Hosts without an IPv6 route (Render et al) fail with
  // `connect ENETUNREACH <ipv6>:5432` when DNS lists AAAA records first,
  // so prefer IPv4 answers unless PG_DNS_RESULT_ORDER overrides.
  dnsResultOrder: process.env.PG_DNS_RESULT_ORDER || 'ipv4first',
  isServerless,
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

  // One-time codes. No longer the way in — participants sign in with their
  // address and the last six digits of their number — but the delivery,
  // hashing and throttle machinery is what email verification will be built on.
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

  // ─── Outbound Email Interface ─────────────────────────────
  // Configures external email service providers (Termii, Simpu, Customer.io)
  // for survey invitations, session invitations, staff invites, codes, and broadcasts.
  email: {
    provider: process.env.EMAIL_PROVIDER || 'auto',
    fromEmail: process.env.EMAIL_FROM || process.env.EMAIL_FROM_ADDRESS || 'devcircle@creditdirect.ng',
    fromName: process.env.EMAIL_FROM_NAME || 'Credit Direct Dev Circle',
    replyTo: process.env.EMAIL_REPLY_TO || 'devrelations@creditdirect.ng',
    termii: {
      apiKey: process.env.TERMII_API_KEY || null,
      emailConfigurationId: process.env.TERMII_EMAIL_CONFIGURATION_ID || null,
      baseUrl: (process.env.TERMII_BASE_URL || 'https://api.ng.termii.com').replace(/\/+$/, ''),
      templateId: process.env.TERMII_TEMPLATE_ID || null,
      get configured() {
        return Boolean(this.apiKey && this.emailConfigurationId);
      }
    },
    // ── Whichever REST email API this deployment has a key for ──
    // Configured from the environment rather than from code, because the shape
    // of "send an email" is nearly the same everywhere and the differences are
    // mostly what each vendor calls the four fields. Covers the flat-payload
    // services — Resend, Postmark, Brevo, MailerSend and most smaller ones.
    // See providers/http.js for what it deliberately does not cover.
    http: {
      url: process.env.EMAIL_HTTP_URL || null,
      apiKey: process.env.EMAIL_HTTP_API_KEY || null,
      method: process.env.EMAIL_HTTP_METHOD || 'POST',

      // `Authorization: Bearer <key>` by default. A vendor-specific header
      // holding the bare key is the other common shape: set the header name and
      // an empty scheme.
      authHeader: process.env.EMAIL_HTTP_AUTH_HEADER || 'Authorization',
      authScheme: process.env.EMAIL_HTTP_AUTH_SCHEME === undefined
        ? 'Bearer'
        : process.env.EMAIL_HTTP_AUTH_SCHEME,

      fieldTo: process.env.EMAIL_HTTP_FIELD_TO || 'to',
      fieldFrom: process.env.EMAIL_HTTP_FIELD_FROM || 'from',
      fieldSubject: process.env.EMAIL_HTTP_FIELD_SUBJECT || 'subject',
      fieldHtml: process.env.EMAIL_HTTP_FIELD_HTML || 'html',
      fieldText: process.env.EMAIL_HTTP_FIELD_TEXT || 'text',
      fieldReplyTo: process.env.EMAIL_HTTP_FIELD_REPLY_TO || 'reply_to',

      fromWithName: process.env.EMAIL_HTTP_FROM_WITH_NAME !== 'false',
      toAsArray: process.env.EMAIL_HTTP_TO_AS_ARRAY === 'true',

      // Where the vendor puts the id of the message it accepted, as a dotted
      // path — `id`, `data.id`, `MessageID`.
      refPath: process.env.EMAIL_HTTP_REF_PATH || 'id',

      // Anything the vendor requires on every send that the flat mapping
      // cannot express — a template id, a message stream, a sending domain.
      extra: (() => {
        if (!process.env.EMAIL_HTTP_EXTRA) return {};
        try { return JSON.parse(process.env.EMAIL_HTTP_EXTRA); } catch { return {}; }
      })(),

      fromEmail: process.env.EMAIL_FROM || 'devcircle@creditdirect.ng',
      fromName: process.env.EMAIL_FROM_NAME || 'Credit Direct Dev Circle',
      replyTo: process.env.EMAIL_REPLY_TO || 'devrelations@creditdirect.ng',

      get configured() {
        return Boolean(this.url && this.apiKey);
      }
    },
    simpu: {
      apiKey: process.env.SIMPU_API_KEY || null,
      senderId: process.env.SIMPU_SENDER_ID || process.env.EMAIL_FROM || 'devcircle@creditdirect.ng',
      fromName: process.env.SIMPU_FROM_NAME || process.env.EMAIL_FROM_NAME || 'Credit Direct Dev Circle',
      baseUrl: (process.env.SIMPU_BASE_URL || 'https://api.simpu.co').replace(/\/+$/, ''),
      get configured() {
        return Boolean(this.apiKey);
      }
    },
    get enabled() {
      return Boolean(
        (this.http.url && this.http.apiKey) ||
        (this.termii.apiKey && this.termii.emailConfigurationId) ||
        this.simpu.apiKey ||
        Boolean(process.env.CUSTOMERIO_SITE_ID && process.env.CUSTOMERIO_API_KEY)
      );
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
      termii: Boolean(this.email.termii.apiKey && this.email.termii.emailConfigurationId),
      simpu: Boolean(this.email.simpu.apiKey),
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
