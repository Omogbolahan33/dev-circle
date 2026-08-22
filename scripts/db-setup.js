#!/usr/bin/env node
// One-command setup for either SQLite or Postgres/Supabase.
// - Without DATABASE_URL: creates ./data/devcircle.db + runs migrations + seeds
// - With DATABASE_URL:    connects to Postgres, creates schema, marks migrations

const fs = require('fs');
const path = require('path');
const config = require('../src/config');

async function main() {
  console.log(`\nDev Circle — DB setup (${config.isPostgres ? 'Postgres' : 'SQLite'})`);
  console.log(`Env: ${config.env}\n`);

  if (config.isPostgres) {
    const pg = require('../src/db/pg');
    const { SCHEMA_POSTGRES } = require('../src/db/schema.postgres');
    console.log(`DATABASE_URL: ${(config.databaseUrl || '').replace(/:[^:@]*@/, ':***@')}`);
    if (config.supabase.configured) {
      console.log(`Supabase URL: ${config.supabase.url}`);
      console.log(`Storage bucket: ${config.supabase.storageBucket} (backend: ${config.uploads.backend})`);
    }
    console.log('');

    try {
      await pg.exec(SCHEMA_POSTGRES);
      console.log('✓ Postgres schema applied');

      await pg.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ DEFAULT NOW());`);
      const migrations = require('../src/db/migrations');
      const defined = migrations.define({ _isPostgres: true, prepare: () => ({ all: () => [], get: () => null }), exec: () => {}, pragma: () => null });
      for (const m of defined) {
        await pg.query('INSERT INTO schema_migrations (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [m.id, m.name]);
      }
      console.log(`✓ ${defined.length} migrations marked applied`);

      const ping = await pg.ping().catch(() => false);
      console.log(ping ? '✓ Postgres reachable' : '✗ Postgres ping failed');

      if (config.supabase.configured) {
        console.log('\nSupabase Storage:');
        console.log(`  Bucket "${config.supabase.storageBucket}" should exist in Dashboard → Storage`);
        console.log(`  If uploads 404, create the bucket or set UPLOAD_BACKEND=local`);
      }

      console.log('\nNext:');
      console.log('  npm run seed:postgres   # seed demo data');
      console.log('  npm start               # start server');
      console.log('');

      await pg.getPool().end();
    } catch (err) {
      console.error('✗ Setup failed:', err.message);
      console.error(err.stack);
      process.exit(1);
    }
  } else {
    console.log(`SQLite path: ${config.dbPath}`);
    const db = require('../src/db');
    const migrations = require('../src/db/migrations');
    const { applied, pending } = migrations.status(db);
    console.log(`✓ SQLite ready — ${applied.length} migrations applied, ${pending.length} pending`);
    console.log('\nNext:');
    console.log('  npm run seed            # seed demo data');
    console.log('  npm run dev             # start server');
    console.log('  npm test                # run tests');
    console.log('');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
