#!/usr/bin/env node

// Migration CLI: `npm run migrate` applies what is pending,
// `npm run migrate:status` reports where the database stands.

const db = require('../db');           // requiring db already applies pending migrations
const migrations = require('../migrations');
const config = require('../config');

const command = process.argv[2] || 'up';

if (command === 'status') {
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
    // The database has run migrations this checkout does not define, which
    // means the code is older than the data it is pointed at.
    console.log(`\n⚠ Recorded but not defined in this codebase (${unknown.length}):`);
    for (const m of unknown) console.log(`  ? ${m.id}  ${m.name}`);
    process.exitCode = 1;
  }

  console.log('');
} else if (command === 'up') {
  // db.js already ran them on require; report the resulting state
  const { pending } = migrations.status(db);
  if (pending.length) {
    console.error(`✗ ${pending.length} migration(s) still pending after run`);
    process.exitCode = 1;
  } else {
    console.log('✓ Database is up to date');
  }
} else {
  console.error(`Unknown command "${command}". Use: migrate [up|status]`);
  process.exitCode = 1;
}
