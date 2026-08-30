const { Pool } = require('pg');
const dns = require('dns');
const config = require('../config');
const { logger } = require('../utils/logger');

// ─── Postgres connection ────────────────────────────────────
// Used when DATABASE_URL is set (e.g. Supabase Postgres). The pool is
// lazy — only created when actually needed — so `require('./pg')` never
// throws in SQLite mode and tests keep running without a real DB.

// Node ≥17 returns dns.lookup results "verbatim" (resolver order, which
// commonly lists AAAA/IPv6 records first) and net.Socket.connect dials only
// the first address. On hosts with no IPv6 route — Render web services, many
// corporate networks — that kills every pool connection with
// `connect ENETUNREACH <ipv6-address>:5432`. The pg driver offers no escape
// hatch here: it calls stream.connect(port, host) on a plain socket and
// ignores any `family` pool option, so the fix has to happen in DNS order.
// Preferring A records keeps IPv6-only hostnames working (empty IPv4 list
// falls through to the AAAA records).
const DNS_RESULT_ORDERS = new Set(['ipv4first', 'ipv6first', 'verbatim']);

function parseDnsResultOrder(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value || value === 'default' || value === 'auto') return 'ipv4first';
  if (value === 'none' || value === 'off') return null; // keep Node's default
  if (DNS_RESULT_ORDERS.has(value)) return value;
  logger.warn('Ignoring unknown PG_DNS_RESULT_ORDER — using ipv4first', { value: raw });
  return 'ipv4first';
}

function applyDnsResultOrder(raw) {
  const order = parseDnsResultOrder(raw);
  if (!order || typeof dns.setDefaultResultOrder !== 'function') return null;
  try {
    dns.setDefaultResultOrder(order);
  } catch (err) {
    logger.warn('Could not set DNS result order', { order, message: err.message });
    return null;
  }
  return order;
}

const dnsResultOrder = applyDnsResultOrder(config.database.pgPool.dnsResultOrder);

// Turn a low-level connection failure into something actionable for the
// deploy logs. Boot already survives these (the pool retries on demand);
// the hint is what tells the operator *what to change*.
function diagnoseConnectionError(err) {
  const message = String(err?.message || '');
  const code = String(err?.code || '');
  // Full IPv6 literal, e.g. 2a05:d018:…:8274 (not the "::" wildcard form)
  const ipv6 = message.match(/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f:]*[0-9a-f]\b/i)?.[0];

  if (ipv6 && /ENETUNREACH|EAFNOSUPPORT|EADDRNOTAVAIL/.test(code + ' ' + message)) {
    return {
      reason: `Host resolved to the IPv6 address ${ipv6} but this machine has no IPv6 route`,
      fix: dnsResultOrder === 'ipv4first'
        ? 'The hostname appears to have no IPv4 (A) record. Point DATABASE_URL at an ' +
          'IPv4-reachable endpoint — for Supabase use the pooler string ' +
          '(aws-0-<region>.pooler.supabase.com:6543) instead of db.<ref>.supabase.co.'
        : `An IPv4 address was never tried. Set PG_DNS_RESULT_ORDER=ipv4first ` +
          `(currently: ${dnsResultOrder ?? 'node default'}).`
    };
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code + ' ' + message)) {
    return {
      reason: 'DNS could not resolve the database hostname',
      fix: 'Check the host in DATABASE_URL for typos; on a fresh deploy DNS may just need a minute.'
    };
  }
  if (/ETIMEDOUT|ECONNREFUSED/.test(code + ' ' + message)) {
    return {
      reason: 'The database address refused or timed out on the connection',
      fix: 'Check the port and any firewall/IP allowlist. Supabase free-tier projects pause when ' +
        'idle (restore from the dashboard) and Render free Postgres expires after 30 days — ' +
        'both look exactly like this.'
    };
  }
  if (code === '28P01' || /password authentication failed/i.test(message)) {
    return { reason: 'Postgres rejected the credentials', fix: 'Re-copy the password from DATABASE_URL in the provider dashboard.' };
  }
  return null;
}

let pool = null;

// ─── Waiting for a connection instead of failing ────────────
// Every error listed here happens while *acquiring* a connection: the pool is
// full, the server has too many clients, or the wait timed out. The statement
// never reached Postgres, so trying again cannot apply anything twice — which
// is what makes this safe for writes as well as reads. An error raised after a
// statement was sent is deliberately not in this list.
//
// The shape of the problem it solves: a burst fills the pooler, every request
// in flight fails at once — sign-in included — and a few hundred milliseconds
// later there is plenty of room again. Failing the whole burst to a 500 when
// the wait would have been a third of a second is a bad trade.
const TRANSIENT = [
  'EMAXCONNSESSION',              // Supavisor, session mode: pool is full
  'max clients reached',          // the same, spelled out in the message
  '53300',                        // Postgres too_many_connections
  'too many clients already',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect'
];

function isTransient(err) {
  const text = `${err?.code || ''} ${err?.message || ''}`;
  return TRANSIENT.some(marker => text.includes(marker));
}

const ATTEMPTS = Math.max(1, parseInt(process.env.PG_ACQUIRE_ATTEMPTS, 10) || 3);

async function withRetry(run, label) {
  let lastError;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isTransient(err) || attempt === ATTEMPTS) throw err;
      lastError = err;

      // Backing off with jitter, because every request that failed together
      // would otherwise come back together and refill the pool in the same
      // instant.
      const wait = Math.round((2 ** (attempt - 1)) * 120 * (0.5 + Math.random()));
      logger.warn('Waiting for a Postgres connection', {
        attempt, of: ATTEMPTS, wait_ms: wait, statement: label, message: err.message
      });
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }

  throw lastError;
}

function getPool() {
  if (pool) return pool;
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set — postgres pool unavailable');
  }
  const settings = config.database.pgPool;

  pool = new Pool({
    connectionString: config.databaseUrl,
    max: settings.max,
    idleTimeoutMillis: settings.idleTimeoutMillis,
    connectionTimeoutMillis: settings.connectionTimeoutMillis,
    allowExitOnIdle: settings.allowExitOnIdle || false,
    keepAlive: settings.keepAlive !== false,
    ssl: settings.ssl || undefined
  });

  pool.on('error', err => {
    logger.error('Postgres pool error', { message: err.message });
  });

  // Hold a live connection so the next request is not an SSL handshake. Worth
  // it on a long-lived server, and a leak on serverless: it pins one connection
  // per container that ever booted, for as long as the platform keeps that
  // container warm — which is a slot in a shared pool that nothing is using.
  if (settings.keepAlive !== false) {
    const warm = setInterval(() => {
      pool.query('SELECT 1').catch(() => {});
    }, 20_000);
    if (typeof warm.unref === 'function') warm.unref();
  }

  warnAboutSessionMode();

  return pool;
}

// ─── Session mode ───────────────────────────────────────────
// Supabase's pooler answers on two ports and they behave very differently.
// 6543 is transaction mode: a server connection is borrowed for the length of a
// statement and handed straight back, so hundreds of clients share a small
// pool. 5432 is session mode: one server connection is held for the whole
// client session, so the pool size *is* the number of clients you may have at
// once — fifteen, by default.
//
// A serverless deployment on 5432 runs out at fifteen concurrent containers and
// then fails everything, including signing in, until they drain. The fix is one
// character in the connection string, so it is worth saying out loud on boot
// rather than leaving to be discovered under load.
//
// Said rather than done: rewriting somebody's connection string is not
// something to do behind their back, and the direct port is the right one for
// migrations.
let warnedAboutSessionMode = false;

function warnAboutSessionMode() {
  if (warnedAboutSessionMode) return;
  warnedAboutSessionMode = true;

  const url = config.databaseUrl || '';
  const pooled = /pooler\.supabase\.com|supabase\.co/i.test(url);
  const sessionPort = /:5432(\/|\?|$)/.test(url);

  if (!pooled || !sessionPort) return;

  logger.warn(
    'Postgres is connected on port 5432 (session mode). Each client holds a server ' +
    'connection for its whole session, so the pool size is a hard ceiling on ' +
    'concurrent clients — under load every request fails with EMAXCONNSESSION, ' +
    'sign-in included. Use the transaction-mode pooler for the app: change :5432 ' +
    'to :6543 in DATABASE_URL. Keep the 5432 string for migrations.',
    { serverless: Boolean(config.database.pgPool.isServerless), pool_max: config.database.pgPool.max }
  );
}

// Translate SQLite-flavoured SQL to Postgres where possible.
// Covers the small surface this codebase actually uses:
//   ?  -> $1, $2, …
//   datetime('now') -> NOW()
//   INSERT OR IGNORE -> ON CONFLICT DO NOTHING
//   INSERT OR REPLACE -> ON CONFLICT DO UPDATE
// This is a thin shim, not a full dialect transpiler. Complex migrations
// ship with separate Postgres DDL (schema.postgres.js).
function translatePlaceholders(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

// The same statement is prepared on every request. Translating it once is
// what stops the dialect shim from running on the hot path.
const translatedCache = new Map();
const TRANSLATE_CACHE_MAX = 400;

function translateSql(sql) {
  const hit = translatedCache.get(sql);
  if (hit) return hit;
  const translated = translateSqliteToPostgres(translatePlaceholders(sql));
  if (translatedCache.size >= TRANSLATE_CACHE_MAX) translatedCache.clear();
  translatedCache.set(sql, translated);
  return translated;
}

// Replace name(...) even when the argument list nests parentheses
// (julianday(COALESCE(a, b)) is the case the naive [^)]+ regex drops).
function replaceFnCall(sql, name, replacer) {
  const re = new RegExp(`\\b${name}\\s*\\(`, 'gi');
  let out = '';
  let last = 0;
  let match;
  while ((match = re.exec(sql))) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) break;
    out += sql.slice(last, match.index) + replacer(sql.slice(open + 1, close).trim());
    last = close + 1;
    re.lastIndex = last;
  }
  return out + sql.slice(last);
}

// Put ON CONFLICT DO NOTHING where Postgres will take it: after the values or
// the select that feeds the insert, and before RETURNING if there is one.
// Appending blindly to the end would put it after RETURNING, which is a syntax
// error rather than a subtle one — but the subtle ones are what this file is
// for, so it is handled rather than assumed away.
function appendOnConflict(sql) {
  if (/ON\s+CONFLICT/i.test(sql)) return sql;

  const trailing = /;\s*$/.exec(sql);
  const body = trailing ? sql.slice(0, trailing.index) : sql;
  const tail = trailing ? trailing[0] : '';

  const returning = /\sRETURNING\s/i.exec(body);
  if (returning) {
    return body.slice(0, returning.index) +
      ' ON CONFLICT DO NOTHING' +
      body.slice(returning.index) + tail;
  }

  return `${body.trimEnd()} ON CONFLICT DO NOTHING${tail}`;
}

function translateSqliteToPostgres(sql) {
  let out = sql;
  // SQLite → Postgres shims
  // ── INSERT OR IGNORE → INSERT … ON CONFLICT DO NOTHING ──
  //
  // This was written as "strip the OR IGNORE, then add ON CONFLICT if the
  // original said INSERT INTO and OR IGNORE" — and the original never says
  // `INSERT INTO`, because at that point it still says `INSERT OR IGNORE INTO`.
  // The guard was false every time, so the clause was never added and the
  // branch was dead from the day it was written.
  //
  // What that cost: every INSERT OR IGNORE in the codebase became a plain
  // INSERT on Postgres, and the twenty-four of them are the joining paths —
  // adding somebody to a circle, to a cohort, to the members of a gift. The
  // second time any of those ran for the same pair it raised a duplicate key
  // error instead of doing nothing, which is precisely what OR IGNORE exists to
  // avoid. Approving an onboarding applicant who was already in the "All
  // Members" cohort is one such second time.
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(out)) {
    out = appendOnConflict(out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO'));
  }

  // INSERT OR REPLACE has no honest one-line equivalent: ON CONFLICT DO UPDATE
  // needs a conflict target and a column list, and neither can be read off the
  // statement without knowing the table's keys. Rather than guess — and quietly
  // turn a replace into a plain insert that fails on the second run, which is
  // the mistake above — it says so.
  //
  // The one use of it is sandbox_meta, and the sandbox is always SQLite (see
  // db/sandbox.js), so nothing reaches this today.
  if (/INSERT\s+OR\s+REPLACE\s+INTO/i.test(out)) {
    throw new Error(
      'INSERT OR REPLACE has no direct Postgres translation — write it as ' +
      'INSERT … ON CONFLICT (key) DO UPDATE SET … with the conflict target spelled out'
    );
  }

  // datetime('now', '-7 days') must keep the offset — replacing the whole
  // call with NOW() made "new this week" count every member.
  out = out.replace(
    /datetime\s*\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi,
    (_, mod) => `(NOW() + INTERVAL '${mod.replace(/'/g, "''")}')`
  );
  out = out.replace(
    /datetime\s*\(\s*'now'\s*,\s*(\$\d+)\s*\)/gi,
    (_, p) => `(NOW() + (${p})::interval)`
  );
  out = out.replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()');

  out = out.replace(
    /date\s*\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi,
    (_, mod) => `(CURRENT_DATE + INTERVAL '${mod.replace(/'/g, "''")}')`
  );
  out = out.replace(/date\s*\(\s*'now'\s*\)/gi, 'CURRENT_DATE');

  out = replaceFnCall(out, 'julianday', args => {
    if (/^'now'$/i.test(args)) return '(EXTRACT(EPOCH FROM NOW()) / 86400.0)';
    return `(EXTRACT(EPOCH FROM (${args})::timestamptz) / 86400.0)`;
  });

  out = replaceFnCall(out, 'json_array_length', args => {
    const expr = args.split(',')[0].trim();
    return `jsonb_array_length(COALESCE(NULLIF(TRIM((${expr})::text), ''), '[]')::jsonb)`;
  });

  // json_each(col) → a set of text values aliased json_each, so `.value`
  // in the original SQL still resolves.
  out = replaceFnCall(out, 'json_each', args => {
    const expr = args.split(',')[0].trim();
    return `LATERAL jsonb_array_elements_text(COALESCE(NULLIF(TRIM(${expr}::text), ''), '[]')::jsonb) AS json_each`;
  });

  // SQLite uses `AUTOINCREMENT` not needed in Postgres
  out = out.replace(/\bAUTOINCREMENT\b/gi, '');

  // SQLite PRAGMA handling — will be caught elsewhere, but strip to avoid pg errors
  if (/^\s*PRAGMA/i.test(out)) return '-- PRAGMA ignored on Postgres';

  // Member export concatenates related names. Postgres has no GROUP_CONCAT.
  out = out.replace(
    /GROUP_CONCAT\s*\(\s*([^,()]+)\s*,\s*('(?:[^']|'')*')\s*\)/gi,
    'string_agg($1, $2)'
  );
  out = out.replace(/GROUP_CONCAT\s*\(\s*([^()]+)\s*\)/gi, "string_agg($1, ',')");

  return out;
}

// ─── Prepared statement wrapper ─────────────────────────────
// Mirrors the better-sqlite3 interface (prepare().get/.all/.run) but async.
// SQLite call sites can `await` the result and it works for both adapters
// because `await nonPromise` is a no-op.

function prepare(sql) {
  // Keep original SQL for debugging, translate only at execution
  const isMutating = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);

  async function execWith(params = []) {
    // Inside a transaction the statement has to go on the connection that
    // opened it — see db/context.js. Outside one, any pooled connection will
    // do, and waiting for one beats failing for want of one.
    const bound = require('./context').txClient();
    if (bound) return bound.query(translateSql(sql), params);

    return withRetry(() => getPool().query(translateSql(sql), params), sql.slice(0, 60));
  }

  return {
    get: async (...params) => {
      const res = await execWith(params);
      return res.rows[0] || undefined;
    },
    all: async (...params) => {
      const res = await execWith(params);
      return res.rows;
    },
    run: async (...params) => {
      const res = await execWith(params);
      if (isMutating && res.rowCount > 0) {
        require('../middleware/cache').noteWrite(sql);
      }
      // Mimic better-sqlite3 RunResult
      return {
        changes: res.rowCount,
        lastInsertRowid: res.rows[0]?.id || undefined,
        rowCount: res.rowCount
      };
    },
    // For migrations that need raw exec
    _sql: sql
  };
}

// A schema string, split into the statements it is made of. pg will not take
// several in one query, so they go one at a time.
//
// Comments are stripped rather than used to decide whether a chunk is worth
// running, and that distinction is the whole of a bug that cost two tables.
// Splitting on `;` puts the comment *above* a statement in the same chunk as
// the statement; a check for "does this chunk start with `--`" then threw the
// pair away together. Twenty-three of the ninety-five statements in the schema
// were discarded that way — users, circles, roles, surveys and both onboarding
// tables among them — and nothing said so. Existing deployments survived only
// because those tables predated the comments being written above them.
//
// Only whole comment lines are removed. A `--` inside a string literal is left
// alone, which is what stops this from quietly rewriting data.
function statementsIn(sql) {
  return sql
    .split(';')
    .map(chunk => chunk
      .split('\n')
      .filter(line => !/^\s*--/.test(line))
      .join('\n')
      .trim())
    .filter(Boolean);
}

async function exec(sql) {
  const p = getPool();
  for (const stmt of statementsIn(sql)) {
    const final = translateSqliteToPostgres(stmt);
    // The translator turns a PRAGMA into a comment; there is nothing to send.
    if (final && !/^\s*--/.test(final)) await p.query(final);
  }
}

async function query(sql, params = []) {
  return withRetry(() => getPool().query(translateSql(sql), params), sql.slice(0, 60));
}

// Transaction helper: BEGIN/COMMIT/ROLLBACK wrapper.
// Usage: await pg.transaction(async (client) => { await client.query(...) })
// For compatibility with better-sqlite3's db.transaction(fn) we also expose
// a sync-like wrapper that returns a function.
function transaction(fn) {
  // Returns a function that, when called, runs fn inside a transaction.
  // For SQLite compatibility: db.transaction(() => { ... })()
  return async (...args) => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      // Provide a client-bound query helper inside the transaction
      const txQuery = async (sql, params = []) => {
        return client.query(translateSql(sql), params);
      };
      const result = await fn(txQuery, ...args);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  };
}

// Simple health check
async function ping() {
  const p = getPool();
  const res = await p.query('SELECT 1 as ok');
  return res.rows[0]?.ok === 1;
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  getPool,
  prepare,
  exec,
  statementsIn,
  withRetry,
  isTransient,
  query,
  transaction,
  ping,
  close,
  translatePlaceholders,
  translateSqliteToPostgres,
  translateSql,
  replaceFnCall,
  parseDnsResultOrder,
  applyDnsResultOrder,
  diagnoseConnectionError
};
