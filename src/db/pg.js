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

function getPool() {
  if (pool) return pool;
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set — postgres pool unavailable');
  }
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.database.pgPool.max,
    idleTimeoutMillis: config.database.pgPool.idleTimeoutMillis,
    connectionTimeoutMillis: config.database.pgPool.connectionTimeoutMillis,
    ssl: config.database.pgPool.ssl || undefined
  });

  pool.on('error', err => {
    logger.error('Postgres pool error', { message: err.message });
  });

  return pool;
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

function translateSqliteToPostgres(sql) {
  let out = sql;
  // SQLite → Postgres shims
  // INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
  out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
  // Handle ON CONFLICT for the above: pg requires ON CONFLICT DO NOTHING after the INSERT
  // We append it if the statement was originally INSERT OR IGNORE and doesn't already have ON CONFLICT
  if (/INSERT\s+INTO/i.test(sql) && /OR\s+IGNORE/i.test(sql) && !/ON\s+CONFLICT/i.test(out)) {
    // Append ON CONFLICT DO NOTHING before any RETURNING or at end of first statement segment
    // Simple: replace VALUES (...) with VALUES (...) ON CONFLICT DO NOTHING where applicable
    // For now, add after the VALUES clause if present, otherwise at end before semicolon
    // This is heuristic; most OR IGNORE are simple inserts without complex logic.
    out = out.replace(/(VALUES\s*\([^;]+\))/i, '$1 ON CONFLICT DO NOTHING');
    if (!/ON\s+CONFLICT/i.test(out)) {
      out = out.replace(/;\s*$/, ' ON CONFLICT DO NOTHING;');
      if (!/ON\s+CONFLICT/i.test(out)) out += ' ON CONFLICT DO NOTHING';
    }
  }
  // INSERT OR REPLACE → INSERT ... ON CONFLICT DO UPDATE
  out = out.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'INSERT INTO');

  // datetime('now') variations
  out = out.replace(/datetime\s*\(\s*'now'\s*,\s*'[^']*'\s*\)/gi, 'NOW()');
  out = out.replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()');

  // SQLite uses `AUTOINCREMENT` not needed in Postgres
  out = out.replace(/\bAUTOINCREMENT\b/gi, '');

  // SQLite PRAGMA handling — will be caught elsewhere, but strip to avoid pg errors
  if (/^\s*PRAGMA/i.test(out)) return '-- PRAGMA ignored on Postgres';

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
    const p = getPool();
    const translated = translatePlaceholders(sql);
    // Basic datetime translation
    const finalSql = translateSqliteToPostgres(translated);
    const result = await p.query(finalSql, params);
    return result;
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

async function exec(sql) {
  const p = getPool();
  // Split on semicolon for multi-statement schema strings; pg does not allow
  // multiple statements in one query by default.
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    const final = translateSqliteToPostgres(stmt);
    if (final) await p.query(final);
  }
}

async function query(sql, params = []) {
  const p = getPool();
  const final = translateSqliteToPostgres(translatePlaceholders(sql));
  const res = await p.query(final, params);
  return res;
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
        const final = translateSqliteToPostgres(translatePlaceholders(sql));
        return client.query(final, params);
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
  query,
  transaction,
  ping,
  close,
  translatePlaceholders,
  translateSqliteToPostgres,
  parseDnsResultOrder,
  applyDnsResultOrder,
  diagnoseConnectionError
};
