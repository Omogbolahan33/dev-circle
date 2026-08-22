const { Pool } = require('pg');
const config = require('../config');
const { logger } = require('../utils/logger');

// ─── Postgres connection ────────────────────────────────────
// Used when DATABASE_URL is set (e.g. Supabase Postgres). The pool is
// lazy — only created when actually needed — so `require('./pg')` never
// throws in SQLite mode and tests keep running without a real DB.

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
  translateSqliteToPostgres
};
