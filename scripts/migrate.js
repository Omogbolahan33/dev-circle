#!/usr/bin/env node

// Migration CLI: `npm run migrate` applies what is pending,
// `npm run migrate:status` reports where the database stands.
// Works with both SQLite (local) and Postgres (Supabase) — detects via DATABASE_URL.

const config = require('../src/config');

async function main() {
  const command = process.argv[2] || 'up';

  if (config.isPostgres) {
    // Postgres path — async
    const pg = require('../src/db/pg');
    const migrations = require('../src/db/migrations');
    const { SCHEMA_POSTGRES } = require('../src/db/schema.postgres');

    console.log(`\nDatabase: Postgres (${(config.databaseUrl || '').replace(/:[^:@]*@/, ':***@')})\n`);

    // Ensure schema exists
    await pg.exec(SCHEMA_POSTGRES);

    // Then bring an older database forward. CREATE TABLE IF NOT EXISTS does
    // nothing for a table that already exists, so a column added to the schema
    // afterwards never lands and a constraint relaxed afterwards stays as it
    // was — see src/db/reconcile.js. The same step runs on boot; it is here so
    // a deployment can be repaired without waiting for one.
    const reconcile = require('../src/db/reconcile');
    const repairs = reconcile.alterStatements(SCHEMA_POSTGRES);
    const applied = [];
    const skipped = [];

    for (const statement of repairs) {
      try {
        await pg.query(statement);
        applied.push(statement);
      } catch (err) {
        skipped.push({ statement, message: err.message });
      }
    }

    // Only the ones that changed something are worth printing — the list is
    // five hundred statements long and almost all of it is already true.
    console.log(`Schema reconciled: ${applied.length} statement(s) ran, ${skipped.length} skipped.`);
    if (skipped.length) {
      console.log('\nSkipped:');
      for (const s of skipped.slice(0, 10)) console.log(`  · ${s.statement}\n    ${s.message}`);
      if (skipped.length > 10) console.log(`  … and ${skipped.length - 10} more`);
    }

    // And check it worked. A missing table is why this script exists.
    const expected = reconcile.tablesIn(SCHEMA_POSTGRES).map(t => t.name);
    const present = await pg.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [expected]
    );
    const found = new Set(present.rows.map(r => r.table_name));
    const missing = expected.filter(name => !found.has(name));

    if (missing.length) {
      console.error(`\n✗ ${missing.length} table(s) still missing: ${missing.join(', ')}`);
      process.exitCode = 1;
      await pg.getPool().end();
      return;
    }
    console.log(`✓ all ${expected.length} tables present\n`);

    await pg.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    if (command === 'status') {
      let rows = [];
      try {
        const res = await pg.query('SELECT id, name, applied_at FROM schema_migrations ORDER BY id');
        rows = res.rows;
      } catch (e) {
        console.error('Failed to read schema_migrations:', e.message);
        process.exitCode = 1;
        return;
      }

      // Define migrations without needing a db handle (we just need the list)
      const all = migrations.define({ _isPostgres: true, prepare: () => ({ all: () => [], get: () => null }), exec: () => {}, pragma: () => null });
      const done = new Map(rows.map(r => [r.id, r]));

      const applied = all.filter(m => done.has(m.id)).map(m => ({ ...done.get(m.id), name: m.name }));
      const pending = all.filter(m => !done.has(m.id)).map(m => ({ id: m.id, name: m.name }));
      const unknown = [...done.values()].filter(r => !all.some(m => m.id === r.id));

      console.log(`Applied (${applied.length}):`);
      for (const m of applied) {
        console.log(`  ✓ ${String(m.id).padStart(3)}  ${m.name.padEnd(28)} ${m.applied_at}`);
      }

      if (pending.length) {
        console.log(`\nPending (${pending.length}):`);
        for (const m of pending) console.log(`  · ${String(m.id).padStart(3)}  ${m.name}`);
        // Auto-apply pending by marking them (comprehensive schema already applied)
        console.log('\nMarking pending as applied (Postgres comprehensive schema is already up to date)...');
        for (const m of pending) {
          await pg.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [m.id, m.name]);
          console.log(`  + ${m.id} ${m.name}`);
        }
        console.log('\n✓ Database is up to date (Postgres)');
      } else {
        console.log('\nPending: none — the database is up to date.');
      }

      if (unknown.length) {
        console.log(`\n⚠ Recorded but not defined in this codebase (${unknown.length}):`);
        for (const m of unknown) console.log(`  ? ${m.id}  ${m.name}`);
        process.exitCode = 1;
      }
      console.log('');
      await pg.getPool().end();
    } else if (command === 'up') {
      const all = migrations.define({ _isPostgres: true, prepare: () => ({ all: () => [], get: () => null }), exec: () => {}, pragma: () => null });
      for (const m of all) {
        await pg.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [m.id, m.name]);
      }
      console.log('✓ Database is up to date (Postgres — comprehensive schema applied)');
      await pg.getPool().end();
    } else {
      console.error(`Unknown command "${command}". Use: migrate [up|status]`);
      process.exitCode = 1;
      await pg.getPool().end();
    }
    return;
  }

  // SQLite path — sync, original behavior
  const db = require('../src/db');           // requiring db already applies pending migrations
  const migrations = require('../src/db/migrations');

  const cmd = command;

  if (cmd === 'status') {
    const { applied, pending, unknown } = migrations.status(db);

    console.log(`\nDatabase: ${config.dbPath}\n`);

    console.log(`Applied (${applied.length}):`);
    for (const m of applied) {
      console.log(`  ✓ ${String(m.id).padStart(3)}  ${m.name.padEnd(28)} ${m.applied_at}`);
    }

    if (pending.length) {
      console.log(`\nPending (${pending.length}):`);
      for (const m of pending) console.log(`  · ${String(m.id).padStart(3)}  ${m.name}`);
    } else {
      console.log('\nPending: none — the database is up to date.');
    }

    if (unknown.length) {
      console.log(`\n⚠ Recorded but not defined in this codebase (${unknown.length}):`);
      for (const m of unknown) console.log(`  ? ${m.id}  ${m.name}`);
      process.exitCode = 1;
    }

    console.log('');
  } else if (cmd === 'up') {
    const { pending } = migrations.status(db);
    if (pending.length) {
      console.error(`✗ ${pending.length} migration(s) still pending after run`);
      process.exitCode = 1;
    } else {
      console.log('✓ Database is up to date (SQLite)');
    }
  } else {
    console.error(`Unknown command "${command}". Use: migrate [up|status]`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
