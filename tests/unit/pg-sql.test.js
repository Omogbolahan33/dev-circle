const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const pg = require('../../src/db/pg');

function pgSql(sql) {
  return pg.translateSqliteToPostgres(pg.translatePlaceholders(sql));
}

describe('SQLite → Postgres SQL', () => {
  test('keeps the offset on datetime(\'now\', …)', () => {
    const sql = pgSql("SELECT COUNT(*) as c FROM users WHERE created_at > datetime('now', '-7 days')");
    assert.match(sql, /INTERVAL '-7 days'/);
    assert.doesNotMatch(sql, /datetime/i);
    // The old shim turned every offset into NOW(), so "this week" counted everyone
    assert.doesNotMatch(sql, /created_at > NOW\(\)\s*$/);
  });

  test('datetime(\'now\') alone is NOW()', () => {
    assert.equal(pgSql("SELECT datetime('now')"), 'SELECT NOW()');
  });

  test('a bound datetime offset becomes an interval parameter', () => {
    const sql = pgSql("INSERT INTO x (t) VALUES (datetime('now', ?))");
    assert.match(sql, /NOW\(\) \+ \(\$1\)::interval/);
  });

  test('julianday difference becomes an epoch ratio', () => {
    const sql = pgSql(
      "SELECT CAST((julianday('now') - julianday(u.date_of_birth)) / 365.25 AS INTEGER) as age FROM users u"
    );
    assert.match(sql, /EXTRACT\(EPOCH FROM NOW\(\)\)/);
    assert.match(sql, /EXTRACT\(EPOCH FROM \(u\.date_of_birth\)::timestamptz\)/);
    assert.doesNotMatch(sql, /julianday/i);
  });

  test('julianday keeps nested parentheses', () => {
    const sql = pgSql(
      "SELECT julianday(COALESCE(u.last_active_at, u.created_at)) FROM users u"
    );
    assert.match(sql, /COALESCE\(u\.last_active_at, u\.created_at\)/);
    assert.doesNotMatch(sql, /julianday/i);
  });

  test('json_each becomes a jsonb set aliased json_each', () => {
    const sql = pgSql(`
      SELECT json_each.value as label, COUNT(*) as count
      FROM users, json_each(users.api_products)
      GROUP BY 1
    `);
    assert.match(sql, /jsonb_array_elements_text/);
    assert.match(sql, /AS json_each/);
    assert.match(sql, /json_each\.value/);
    assert.doesNotMatch(sql, /json_each\s*\(/);
  });

  test('EXISTS json_each still names the set json_each', () => {
    const sql = pgSql(
      'SELECT 1 FROM users u WHERE EXISTS (SELECT 1 FROM json_each(u.api_products) WHERE json_each.value = ?)'
    );
    assert.match(sql, /FROM LATERAL jsonb_array_elements_text/);
    assert.match(sql, /json_each\.value = \$1/);
  });

  test('GROUP_CONCAT becomes string_agg', () => {
    const sql = pgSql(
      "SELECT GROUP_CONCAT(c.name, '; ') as cohorts FROM cohorts c WHERE c.id = ?"
    );
    assert.match(sql, /string_agg\(c\.name, '; '\)/);
    assert.match(sql, /\$1/);
  });

  test('translateSql caches the same statement', () => {
    const sql = "SELECT * FROM users WHERE created_at > datetime('now', '-7 days')";
    assert.equal(pg.translateSql(sql), pg.translateSql(sql));
  });
});
