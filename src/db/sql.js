// Split SQL scripts into statements for the Postgres adapter, which sends one
// statement per query. Strip whole-line comments *before* splitting on
// semicolons: comments may contain semicolons too, and splitting first can
// turn the remainder of a comment into invalid SQL.
function statementsIn(sql) {
  return String(sql || '')
    .split('\n')
    .filter(line => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);
}

module.exports = { statementsIn };
