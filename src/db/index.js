const path = require('path');
const fs = require('fs');

const config = require('../config');
const context = require('./context');

let live;
let isPostgres = false;

// ─── Adapter selection ──────────────────────────────────────
// SQLite is the default for local dev and tests (DEVCIRCLE_DB_PATH is set by
// tests to a tmp file). When DATABASE_URL is present we use Postgres (Supabase).
// The proxy below keeps the same `require('../db')` handle for both.

if (config.isPostgres) {
  isPostgres = true;

  // Lazily require pg so sqlite runs don't need the driver installed
  const pg = require('./pg');
  const { SCHEMA_POSTGRES } = require('./schema.postgres');

  // Wrap pg pool to look like a better-sqlite3 Database where possible.
  // The proxy below still routes through context.active(), so sandboxed
  // requests work the same way.

  const { logger } = require('../utils/logger');

  // Postgres live handle — exposes the same surface as better-sqlite3 but async.
  // Migrations run eagerly on startup; for Postgres they run via `pg`.
  const pool = pg.getPool();

  // Minimal sync-like shim for startup: we need to ensure schema + migrations
  // before any request arrives. We do it async and expose a ready promise.
  let ready = null;
  let readyError = null;

  async function initPostgres() {
    try {
      await pg.exec(SCHEMA_POSTGRES);
      // For Postgres fresh DBs the comprehensive schema above already includes
      // every table as of the latest migration, so we just ensure the
      // migrations ledger exists and mark all known migrations as applied.
      // Existing Postgres DBs that were created earlier will be brought forward
      // via ALTER TABLE IF NOT EXISTS in the ledger step.
      await pg.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      const migrations = require('./migrations');
      const defined = migrations.define({ _isPostgres: true, prepare: () => ({ all: () => [], get: () => null }), exec: () => {}, pragma: () => null });
      for (const m of defined) {
        await pg.query(
          'INSERT INTO schema_migrations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
          [m.id, m.name]
        );
      }
      logger.info('Postgres schema and migrations applied');
    } catch (err) {
      readyError = err;
      logger.error('Failed to init Postgres', { message: err.message, stack: err.stack });
      throw err;
    }
  }

  function createPgDbLike(pgModule) {
    return {
      prepare(sql) {
        return pgModule.prepare(sql);
      },
      exec(sql) {
        return pgModule.exec(sql);
      },
      query(sql, params) {
        return pgModule.query(sql, params);
      },
      pragma() {
        // No-op on Postgres; migrations guard with `if (enforcing) ...`
        return null;
      },
      transaction(fn) {
        // better-sqlite3: db.transaction(() => { ... })()
        // For pg we return an async function that runs fn in a BEGIN/COMMIT block.
        return async (...args) => {
          const client = await pgModule.getPool().connect();
          try {
            await client.query('BEGIN');
            const result = await fn(...args);
            await client.query('COMMIT');
            return result;
          } catch (e) {
            try { await client.query('ROLLBACK'); } catch {}
            throw e;
          } finally {
            client.release();
          }
        };
      }
    };
  }

  live = createPgDbLike(pg);
  live._isPostgres = true;
  live._pool = pool;
  live._pg = pg;
  ready = initPostgres();

  // Expose ready promise for server.js to await
  live.ready = ready;
  live.readyError = () => readyError;

  // Provide sqlite-like helpers that pg doesn't normally have, for call sites
  // that do `db.prepare(...).get()` synchronously. In Postgres mode those
  // become async and call sites should `await`. We keep a sync warning.
  live._isAsync = true;

  context.useLive(live);

  // For Postgres, the proxy needs to handle async prepare().get() etc.
  // We expose the pg-backed live as the target; context.active() may still
  // return an sqlite sandbox db (sandbox always uses sqlite files).
  module.exports = new Proxy(live, {
    get(target, property) {
      // Ready promise passthrough
      if (property === 'ready' || property === 'then' || property === 'catch') {
        return target[property];
      }
      const database = context.active() || target;
      // If active is an sqlite sandbox db, use its sync methods directly
      if (database !== target && typeof database[property] === 'function') {
        return database[property].bind(database);
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  // Attach helper to check adapter
  module.exports.isPostgres = true;

} else {
  // ─── SQLite path (default, used by tests and local dev) ──────
  const Database = require('better-sqlite3');
  const { SCHEMA } = require('./schema');

  const DB_PATH = config.dbPath;

  // Ensure data directory exists
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const sqliteLive = new Database(DB_PATH);

  // Enable WAL mode for better concurrent reads
  sqliteLive.pragma('journal_mode = WAL');
  sqliteLive.pragma('foreign_keys = ON');

  sqliteLive.exec(SCHEMA);

  // Apply any migrations this database has not seen yet
  const { logger } = require('../utils/logger');
  require('./migrations').run(sqliteLive, { log: msg => logger.info(msg) });

  context.useLive(sqliteLive);

  live = sqliteLive;

  // ─── The handle everything else holds ───────────────────────
  // Exported as a proxy rather than the connection itself. Ordinarily it forwards
  // straight to the live database and costs a property lookup; inside a sandboxed
  // request it forwards to the throwaway one instead. Twenty-odd modules hold
  // this object and none of them need to know which is which.
  //
  // The one rule this places on the rest of the codebase: prepare statements when
  // you use them, not at module load. A statement prepared at load belongs to
  // whichever database existed then, and would write there forever.
  module.exports = new Proxy(sqliteLive, {
    get(target, property) {
      const database = context.active() || target;
      const value = database[property];
      return typeof value === 'function' ? value.bind(database) : value;
    }
  });
  module.exports.isPostgres = false;
  module.exports.isSQLite = true;
}

// Shared helpers
module.exports._isPostgres = isPostgres;
module.exports.close = async () => {
  if (isPostgres && live && live._pool) {
    await live._pool.end();
  } else if (live && typeof live.close === 'function') {
    live.close();
  }
};
