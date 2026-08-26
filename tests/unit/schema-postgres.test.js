const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { SCHEMA_POSTGRES } = require('../../src/db/schema.postgres');

// The Postgres schema is applied statement-by-statement (pg.exec splits on
// ';'). A CREATE TABLE that REFERENCES another table must therefore appear
// after that table — otherwise boot fails with
//   relation "admin_users" does not exist
// which is exactly what a fresh Render / Supabase deploy hit.

function statements(sql) {
  return sql.split(';').map(s => s.trim()).filter(Boolean);
}

function createTableName(stmt) {
  const match = stmt.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i);
  return match ? match[1] : null;
}

function referencedTables(stmt) {
  return [...stmt.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)].map(m => m[1]);
}

test('postgres schema creates referenced tables before their foreign keys', () => {
  const created = new Set();

  for (const stmt of statements(SCHEMA_POSTGRES)) {
    const name = createTableName(stmt);
    if (!name) continue;

    for (const ref of referencedTables(stmt)) {
      if (ref === name) continue; // self-reference is fine
      assert.ok(
        created.has(ref),
        `${name} references ${ref} before ${ref} is created`
      );
    }
    created.add(name);
  }

  assert.ok(created.has('admin_users'), 'admin_users must be part of the schema');
  assert.ok(created.has('circle_admins'), 'circle_admins must be part of the schema');
  assert.ok(created.has('roles'), 'roles must be part of the schema');
});

test('indexes only target tables that the schema creates', () => {
  const created = new Set();
  for (const stmt of statements(SCHEMA_POSTGRES)) {
    const name = createTableName(stmt);
    if (name) created.add(name);
  }

  for (const stmt of statements(SCHEMA_POSTGRES)) {
    const match = stmt.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+(\w+)/i);
    if (!match) continue;
    assert.ok(created.has(match[1]), `index targets unknown table ${match[1]}`);
  }
});

test('supabase SQL migration stays in lockstep with SCHEMA_POSTGRES', () => {
  const sqlPath = path.join(__dirname, '../../supabase/migrations/20260821000000_initial_schema.sql');
  const fromFile = fs.readFileSync(sqlPath, 'utf8');

  const normalize = sql => statements(sql)
    .map(s => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  assert.deepEqual(
    normalize(fromFile),
    normalize(SCHEMA_POSTGRES),
    'supabase/migrations/20260821000000_initial_schema.sql must match SCHEMA_POSTGRES'
  );
});
