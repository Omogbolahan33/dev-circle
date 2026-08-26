// ─── Bringing an existing Postgres database forward ─────────
// The Postgres path applies one comprehensive schema on boot and marks every
// migration as already applied. That is right for an empty database and does
// nothing at all for one that already has tables: `CREATE TABLE IF NOT EXISTS`
// is a no-op the moment the table exists, so a column added to the schema
// later never lands, and a constraint relaxed later stays as it was.
//
// db/index.js used to claim this was handled "via ALTER TABLE IF NOT EXISTS in
// the ledger step". There was no such step. The ledger step inserts rows into
// schema_migrations and touches nothing else, so every deployment that had been
// live for more than one release was quietly behind the schema it was running.
//
// This is that step. It is derived from SCHEMA_POSTGRES rather than written out
// beside it, which is the only version that stays true: a column added to the
// schema is a column this adds to an old database, with no second edit and no
// chance of the two disagreeing.
//
// Everything it emits is idempotent, so it runs on every boot and is a no-op on
// a database that is already current.

// Split a comma-separated list at the top level, so that CHECK(x IN ('a','b'))
// and DECIMAL(10,2) are not cut in half by the commas inside them.
function topLevelParts(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  let quote = null;

  for (const char of body) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Anything in a CREATE TABLE body that describes the table rather than a column.
const TABLE_LEVEL = /^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT|EXCLUDE)\b/i;

function stripComments(sql) {
  return sql.split('\n').filter(line => !/^\s*--/.test(line)).join('\n');
}

// Every table the schema declares, and the columns of each.
function tablesIn(schemaSql) {
  const sql = stripComments(schemaSql);
  const tables = [];

  const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(/gi;
  let match;

  while ((match = re.exec(sql))) {
    const name = match[1];
    const open = match.index + match[0].length - 1;

    // Walk to the paren that closes the table body
    let depth = 0;
    let close = -1;
    for (let i = open; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) continue;

    const parts = topLevelParts(sql.slice(open + 1, close));

    // Columns named by a table-level PRIMARY KEY (a, b) are implicitly NOT NULL
    // in Postgres, and asking to drop that is an error rather than a no-op.
    const keyed = new Set();
    for (const part of parts) {
      const key = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(part);
      if (key) for (const col of key[1].split(',')) keyed.add(col.trim().toLowerCase());
    }

    const columns = [];
    for (const part of parts) {
      if (TABLE_LEVEL.test(part)) continue;

      const [, column, definition] = /^(\w+)\s+([\s\S]+)$/.exec(part) || [];
      if (!column) continue;

      const primaryKey = /\bPRIMARY\s+KEY\b/i.test(definition) || keyed.has(column.toLowerCase());

      columns.push({
        name: column,
        definition,
        primaryKey,
        notNull: primaryKey || /\bNOT\s+NULL\b/i.test(definition)
      });
    }

    tables.push({ name, columns });
  }

  return tables;
}

// What a retro-added column may carry.
//
// Deliberately less than the schema says. PRIMARY KEY and UNIQUE describe a
// table that was built with them and cannot be bolted onto one that was not —
// not safely, and not against rows that already exist. NOT NULL is refused
// outright by Postgres on a table with rows unless there is a default. CHECK
// would fail against whatever is already stored.
//
// What survives is the type, its default and its foreign key: enough for the
// column to appear and behave, which is the case this exists for. A column that
// genuinely needs a constraint added to a populated table is a migration
// somebody writes by hand, not something to infer.
function addableDefinition(definition) {
  return stripCheck(definition)
    .replace(/\bPRIMARY\s+KEY\b/gi, '')
    .replace(/\bNOT\s+NULL\b/gi, '')
    .replace(/\bUNIQUE\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// CHECK(status IN ('draft','active','closed')) has parentheses inside its
// parentheses, so it cannot be cut out by matching up to the first `)`. Doing
// that left a stray bracket on the end of three ALTERs and Postgres refused all
// three — which the boot log said out loud, and which is the reason those
// warnings are logged rather than swallowed.
function stripCheck(definition) {
  let out = '';
  let i = 0;

  while (i < definition.length) {
    const found = /\bCHECK\s*\(/i.exec(definition.slice(i));
    if (!found) { out += definition.slice(i); break; }

    out += definition.slice(i, i + found.index);

    let depth = 0;
    let j = i + found.index + found[0].length - 1;
    for (; j < definition.length; j++) {
      if (definition[j] === '(') depth++;
      else if (definition[j] === ')') { depth--; if (depth === 0) break; }
    }
    i = j + 1;
  }

  return out;
}

// The statements that bring an old database up to the schema.
function alterStatements(schemaSql) {
  const statements = [];

  for (const table of tablesIn(schemaSql)) {
    for (const column of table.columns) {
      const definition = addableDefinition(column.definition);
      if (definition) {
        statements.push(
          `ALTER TABLE ${table.name} ADD COLUMN IF NOT EXISTS ${column.name} ${definition}`
        );
      }

      // A column the schema now declares nullable, on a database where it is
      // still NOT NULL. This is what carries a relaxed constraint across —
      // users.name became nullable when an onboarding form was allowed to
      // decide it need not ask for one.
      if (!column.notNull) {
        statements.push(`ALTER TABLE ${table.name} ALTER COLUMN ${column.name} DROP NOT NULL`);
      }
    }
  }

  return statements;
}

module.exports = { tablesIn, alterStatements, topLevelParts, addableDefinition, stripCheck };
