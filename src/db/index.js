const path = require('path');
const fs = require('fs');

const config = require('../config');
const context = require('./context');

let live;
let isPostgres = false;

// ─── Doing several writes as one ────────────────────────────
// `db.transaction(fn)()` is better-sqlite3's, it takes a *synchronous* body,
// and it is what migrations, the seeder and the test fixtures use. It stays
// exactly as it was, because those all run against SQLite and a synchronous
// body is genuinely atomic there.
//
// `db.atomic(fn)` is the one request handlers want. Its body is async and
// awaits every statement, which is the only shape that can be correct on both
// adapters now that Postgres statements return promises:
//
//   await db.atomic(async () => {
//     await db.prepare('INSERT ...').run(...);
//     await db.prepare('UPDATE ...').run(...);
//   });
//
// On Postgres the block takes one pooled client, opens the transaction on it,
// and binds it for the duration so every db.prepare inside lands on the same
// connection — see db/context.js for why that binding is the whole fix. On
// SQLite it is BEGIN IMMEDIATE and COMMIT on the one connection there is.
//
// One honest limitation, on SQLite only: an async body yields between
// statements, and another request writing in that window would be swept into
// this transaction and rolled back with it. The blocks are serialised against
// each other so two of them cannot interleave, but a plain write elsewhere
// still could. It is left standing rather than solved because of where SQLite
// is actually used — one developer locally, and a test suite that runs its
// requests one at a time. Postgres, which is what deployments run, has a
// connection per transaction and none of this applies.
function makeAtomic({ isPostgres, sqlite, pg }) {
  // Serialises atomic blocks against one another. A promise chain rather than
  // a lock: each block waits on the one before it and hands the next its own
  // completion, so they queue in the order they were asked for.
  let queue = Promise.resolve();

  return function atomic(fn) {
    // Already inside one. What a caller means by a transaction inside a
    // transaction is one transaction, so the body simply runs in the open one:
    // it commits with it and rolls back with it. Opening a second would be an
    // error in SQLite and a warning in Postgres — and queueing behind the block
    // we are *inside* would wait for something that is waiting for us.
    if (context.txClient()) return Promise.resolve().then(fn);

    const run = async () => {
      if (isPostgres) {
        const client = await pg.getPool().connect();
        try {
          await client.query('BEGIN');
          const result = await context.runInTransaction(client, fn);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch { /* the client is going back to the pool either way */ }
          throw err;
        } finally {
          client.release();
        }
      }

      // IMMEDIATE takes the write lock up front. Without it SQLite starts the
      // transaction as a reader and upgrades on the first write, which is the
      // shape that produces SQLITE_BUSY on an upgrade it cannot get.
      //
      // The handle is bound into the context here too. Nothing on this side
      // needs it to route a statement — there is one connection — but it is
      // what makes the nesting check above true on both adapters.
      const database = context.active() || sqlite;
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = await context.runInTransaction(database, fn);
        database.exec('COMMIT');
        return result;
      } catch (err) {
        try { database.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
    };

    // The caller waits on their own block; the queue waits on it too, and
    // swallows the failure so one refused block does not poison the next.
    const started = queue.then(run, run);
    queue = started.catch(() => {});
    return started;
  };
}


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
      // ── 1. Every table and index the schema declares ──
      // Idempotent throughout, so this is what creates an empty database and a
      // no-op on one that is current.
      await pg.exec(SCHEMA_POSTGRES);

      // ── 2. Bring an older database forward ──
      // CREATE TABLE IF NOT EXISTS does nothing for a table that already
      // exists, so a column added to the schema after that database was built
      // never lands, and a constraint relaxed later stays as it was. These are
      // the ALTERs that close that gap, derived from the schema itself — see
      // db/reconcile.js.
      //
      // Best effort, one statement at a time: a repair that cannot apply is
      // worth a line in the log and is not worth refusing to start over. What
      // is worth refusing to start over is checked below.
      const reconcile = require('./reconcile');
      const repairs = reconcile.alterStatements(SCHEMA_POSTGRES);
      let repaired = 0;

      for (const statement of repairs) {
        try {
          await pg.query(statement);
          repaired++;
        } catch (err) {
          logger.warn('Schema repair skipped', { statement, message: err.message });
        }
      }

      // ── 3. Check it actually worked ──
      // This exists because it did not, for two releases, in silence. Twenty
      // three of the schema's statements were being discarded by the splitter
      // in pg.exec, and the first anybody knew of it was a 500 from a table
      // that had never been created. A missing table is not something to
      // discover at request time.
      const expected = reconcile.tablesIn(SCHEMA_POSTGRES).map(t => t.name);
      const present = await pg.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = ANY($1)`,
        [expected]
      );
      const found = new Set(present.rows.map(r => r.table_name));
      const missing = expected.filter(name => !found.has(name));

      if (missing.length) {
        throw new Error(
          `The schema did not apply: ${missing.length} table(s) missing after boot — ` +
          `${missing.join(', ')}. Nothing that reads them can work, so this is fatal ` +
          'rather than a warning.'
        );
      }

      // ── 4. The ledger ──
      // The JS migrations are SQLite's — they rebuild tables and speak PRAGMA —
      // so on Postgres the schema above is what carries their effect, and they
      // are recorded as applied rather than run.
      await pg.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      const migrations = require('./migrations');
      const defined = migrations.define({ _isPostgres: true, prepare: async () => ({ all: async () => [], get: async () => null }), exec: () => {}, pragma: async () => null });
      for (const m of defined) {
        await pg.query(
          'INSERT INTO schema_migrations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
          [m.id, m.name]
        );
      }
      logger.info('Postgres schema applied', {
        tables: expected.length,
        repairs_applied: repaired,
        migrations_recorded: defined.length
      });
      const bootstrap = require('./bootstrap');
      const seeded = await bootstrap.ensureDemoAccounts(live);
      if (!seeded.skipped) {
        logger.info('Demo accounts ready', {
          admin: 'admin@creditdirect.ng',
          created: seeded.created
        });
      }
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
  module.exports.atomic = makeAtomic({ isPostgres: true, pg });

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

  const bootstrap = require('./bootstrap');
  const demoReady = bootstrap.ensureDemoAccounts(sqliteLive).then(seeded => {
    if (!seeded.skipped) {
      logger.info('Demo accounts ready', {
        admin: 'admin@creditdirect.ng',
        created: seeded.created
      });
    }
    return seeded;
  }).catch(err => {
    logger.error('Demo account bootstrap failed', { message: err.message, stack: err.stack });
    throw err;
  });

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
      if (property === 'prepare') {
        return sql => {
          const stmt = database.prepare(sql);
          const cache = require('../middleware/cache');
          if (!cache.isMutatingSql(sql)) return stmt;
          const run = stmt.run.bind(stmt);
          stmt.run = (...args) => {
            const result = run(...args);
            if (result && Number(result.changes) > 0) cache.noteWrite(sql);
            return result;
          };
          return stmt;
        };
      }
      const value = database[property];
      return typeof value === 'function' ? value.bind(database) : value;
    }
  });
  module.exports.isPostgres = false;
  module.exports.isSQLite = true;
  module.exports.atomic = makeAtomic({ isPostgres: false, sqlite: sqliteLive });
  module.exports.ready = demoReady;
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
