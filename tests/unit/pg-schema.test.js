const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SCHEMA_POSTGRES } = require('../../src/db/schema.postgres');
const { statementsIn, translateSqliteToPostgres } = require('../../src/db/pg');
const reconcile = require('../../src/db/reconcile');

// ─── Applying the schema to Postgres ────────────────────────
// These exist because of a live 500 reading "relation onboarding_forms does not
// exist" on a deployment whose schema said it should.
//
// The cause was the splitter below. Postgres will not take several statements in
// one query, so the schema string is cut on semicolons — which puts the comment
// written *above* a statement into the same chunk as the statement. A check for
// "does this chunk start with --" then discarded the pair together. Twenty-three
// of the ninety-five statements went that way, including users, circles, roles,
// surveys and both onboarding tables. Older deployments survived only because
// those tables predated the comments being written above them.
//
// Nothing said so. That is the part worth testing against.

const tableNames = sql => [...sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map(m => m[1]);

// What the schema actually sends to Postgres, comments and PRAGMAs removed.
const executed = () => statementsIn(SCHEMA_POSTGRES)
  .map(translateSqliteToPostgres)
  .filter(s => s && !/^\s*--/.test(s));

test('every table the schema declares is a statement that actually runs', () => {
  const declared = tableNames(SCHEMA_POSTGRES);
  const running = tableNames(executed().join(';'));

  assert.ok(declared.length >= 25, 'the schema should have most of the platform in it');
  assert.deepEqual(
    declared.filter(name => !running.includes(name)),
    [],
    'a table in the schema that never reaches Postgres is a 500 nobody sees coming'
  );
});

test('nothing at all is silently dropped on the way to Postgres', () => {
  // Not just tables: an index or an ALTER lost this way is just as quiet.
  const chunks = statementsIn(SCHEMA_POSTGRES);
  const skipped = chunks.filter(c => {
    const final = translateSqliteToPostgres(c);
    return !final || /^\s*--/.test(final);
  });

  assert.deepEqual(skipped, [], 'every chunk should be something Postgres is asked to run');
});

test('a comment above a statement does not take the statement with it', () => {
  const sql = `
    -- A table, described first
    -- across two lines
    CREATE TABLE IF NOT EXISTS described (id TEXT PRIMARY KEY);

    CREATE TABLE IF NOT EXISTS bare (id TEXT PRIMARY KEY);
  `;

  const statements = statementsIn(sql);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^CREATE TABLE IF NOT EXISTS described/);
  assert.match(statements[1], /^CREATE TABLE IF NOT EXISTS bare/);
});

test('a double dash inside a string literal is left alone', () => {
  // Stripping comments must not become rewriting data.
  const sql = "INSERT INTO t (v) VALUES ('a -- b');";
  assert.deepEqual(statementsIn(sql), ["INSERT INTO t (v) VALUES ('a -- b')"]);
});

// ─── Bringing an old database forward ───────────────────────
// CREATE TABLE IF NOT EXISTS does nothing for a table that already exists, so a
// column added to the schema later never lands on a database built before it,
// and a constraint relaxed later stays as it was. db/reconcile.js derives the
// ALTERs that close that gap from the schema itself.

test('every table in the schema is parsed, with its columns', () => {
  const tables = reconcile.tablesIn(SCHEMA_POSTGRES);
  assert.deepEqual(
    tables.map(t => t.name).sort(),
    tableNames(SCHEMA_POSTGRES).sort()
  );

  const users = tables.find(t => t.name === 'users');
  const columns = users.columns.map(c => c.name);
  for (const expected of ['id', 'email', 'name', 'phone_normalized', 'api_products']) {
    assert.ok(columns.includes(expected), `users should carry ${expected}`);
  }
  // A table-level constraint is not a column
  assert.ok(!columns.some(c => /^(PRIMARY|UNIQUE|CHECK|FOREIGN)/i.test(c)));
});

test('a column added to the schema becomes an ALTER for databases that predate it', () => {
  const statements = reconcile.alterStatements(SCHEMA_POSTGRES);

  // The two migration 28 added to a table migration 27 had already created —
  // exactly the shape CREATE TABLE IF NOT EXISTS cannot deliver.
  assert.ok(statements.includes(
    "ALTER TABLE onboarding_submissions ADD COLUMN IF NOT EXISTS external_ref TEXT"
  ));
  assert.ok(statements.includes(
    "ALTER TABLE onboarding_submissions ADD COLUMN IF NOT EXISTS arrived_by TEXT DEFAULT 'form'"
  ));
});

test('a constraint the schema relaxed is dropped on databases that still hold it', () => {
  const statements = reconcile.alterStatements(SCHEMA_POSTGRES);

  // users.name became nullable when an onboarding form was allowed to decide it
  // need not ask for one.
  assert.ok(statements.includes('ALTER TABLE users ALTER COLUMN name DROP NOT NULL'));

  // …and email did not, because it is half the credential.
  assert.ok(!statements.includes('ALTER TABLE users ALTER COLUMN email DROP NOT NULL'));
});

test('a primary key is never asked to become nullable', () => {
  // Postgres refuses it, and the boot would report a repair it could not make
  // on every start.
  const statements = reconcile.alterStatements(SCHEMA_POSTGRES);
  const dropped = statements
    .map(s => /^ALTER TABLE (\w+) ALTER COLUMN (\w+) DROP NOT NULL$/.exec(s))
    .filter(Boolean);

  for (const table of reconcile.tablesIn(SCHEMA_POSTGRES)) {
    for (const column of table.columns.filter(c => c.primaryKey)) {
      assert.ok(
        !dropped.some(([, t, c]) => t === table.name && c === column.name),
        `${table.name}.${column.name} is a primary key and cannot be made nullable`
      );
    }
  }
});

test('a retro-added column carries its type and default, and none of the constraints it cannot', () => {
  // NOT NULL is refused on a populated table, PRIMARY KEY and UNIQUE describe a
  // table that was built with them, and CHECK would be tested against rows that
  // already exist. What is left is enough for the column to work.
  const cases = [
    ["TEXT DEFAULT 'draft' CHECK(status IN ('draft','active','closed'))", "TEXT DEFAULT 'draft'"],
    ['TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE', 'TEXT REFERENCES circles(id) ON DELETE CASCADE'],
    ['TEXT PRIMARY KEY', 'TEXT'],
    ['TEXT UNIQUE NOT NULL', 'TEXT'],
    ['INTEGER DEFAULT 0', 'INTEGER DEFAULT 0']
  ];

  for (const [given, expected] of cases) {
    assert.equal(reconcile.addableDefinition(given), expected, given);
  }
});

test('a CHECK with brackets inside it is removed whole', () => {
  // Matching up to the first ")" left a stray bracket on three ALTERs, and
  // Postgres refused all three. The boot said so out loud, which is why those
  // warnings are logged rather than swallowed.
  assert.equal(
    reconcile.stripCheck("TEXT CHECK(status IN ('a','b')) NOT NULL").replace(/\s+/g, ' ').trim(),
    'TEXT NOT NULL'
  );

  const cleaned = reconcile.addableDefinition("TEXT CHECK(status IN ('a','b')) DEFAULT 'a'");
  assert.equal(cleaned, "TEXT DEFAULT 'a'");
  assert.ok(!cleaned.includes(')'), 'no stray bracket may survive');
});

test('every repair the schema derives is one Postgres could accept', () => {
  // Shape only — the real proof is a boot against Postgres, which cannot run
  // here. What this catches is a malformed statement generated from a schema
  // edit, which is how the stray-bracket bug got in.
  for (const statement of reconcile.alterStatements(SCHEMA_POSTGRES)) {
    assert.match(statement, /^ALTER TABLE \w+ (ADD COLUMN IF NOT EXISTS \w+ .+|ALTER COLUMN \w+ DROP NOT NULL)$/);

    const open = (statement.match(/\(/g) || []).length;
    const close = (statement.match(/\)/g) || []).length;
    assert.equal(open, close, `unbalanced brackets: ${statement}`);
  }
});
