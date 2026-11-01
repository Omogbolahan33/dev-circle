const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { SCHEMA_POSTGRES } = require('../../src/db/schema.postgres');
const { statementsIn } = require('../../src/db/sql');

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

test('Postgres SQL splitter ignores semicolons inside comments and dollar-quoted bodies', () => {
  assert.deepEqual(statementsIn('-- a comment; with punctuation\nCREATE TABLE example (id TEXT);\nSELECT 1;'), [
    'CREATE TABLE example (id TEXT)',
    'SELECT 1'
  ]);
  assert.deepEqual(statementsIn(`DO $rls$ DECLARE target record; BEGIN
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target.schemaname, target.tablename);
  END $rls$; SELECT 1;`), [
    `DO $rls$ DECLARE target record; BEGIN\n    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target.schemaname, target.tablename);\n  END $rls$`,
    'SELECT 1'
  ]);

  const schemaStatements = statementsIn(SCHEMA_POSTGRES);
  assert.ok(schemaStatements.some(s => /^DO \$rls\$/i.test(s) && s.includes('ENABLE ROW LEVEL SECURITY')));
  assert.ok(schemaStatements.some(s => /CREATE TABLE IF NOT EXISTS developer_circle_consent/i.test(s)));
  assert.ok(!schemaStatements.some(s => /^withdrawal\b/i.test(s)));
});

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

test('current Postgres schema preserves the initial Supabase table definitions', () => {
  const sqlPath = path.join(__dirname, '../../supabase/migrations/20260821000000_initial_schema.sql');
  const initial = fs.readFileSync(sqlPath, 'utf8');
  const normalize = sql => statementsIn(sql)
    .map(s => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const initialTables = normalize(initial).filter(s => /^CREATE TABLE IF NOT EXISTS/i.test(s));
  const currentTables = new Set(normalize(SCHEMA_POSTGRES)
    .filter(s => /^CREATE TABLE IF NOT EXISTS/i.test(s)));

  for (const table of initialTables) {
    assert.ok(currentTables.has(table), `current schema must preserve initial table definition: ${table.slice(0, 80)}`);
  }
});
