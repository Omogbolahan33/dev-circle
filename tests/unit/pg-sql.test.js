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

  test('json_array_length becomes jsonb_array_length', () => {
    const sql = pgSql('SELECT json_array_length(s.questions) FROM surveys s');
    assert.match(sql, /jsonb_array_length/);
    assert.doesNotMatch(sql, /json_array_length/);
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

  test('a membership CTE plus json_each still names the set json_each', () => {
    const sql = pgSql(`
      WITH scoped AS (
        SELECT u.* FROM users u
        JOIN circle_members cm ON cm.user_id = u.id AND cm.circle_id = ?
      )
      SELECT json_each.value, COUNT(*)
      FROM scoped, json_each(scoped.api_products)
      GROUP BY 1
    `);
    assert.match(sql, /WITH scoped AS/i);
    assert.match(sql, /jsonb_array_elements_text/);
    assert.match(sql, /AS json_each/);
    assert.doesNotMatch(sql, /json_each\s*\(/);
  });

  test('demography age bands and json_each survive the dialect shim', () => {
    const sql = pgSql(`
      SELECT 'age_band', CASE
        WHEN (julianday('now') - julianday(date_of_birth)) / 365.25 < 35 THEN '25–34'
        ELSE '45+'
      END, COUNT(*) FROM users GROUP BY 2
      UNION ALL
      SELECT 'api_products', json_each.value, COUNT(*)
      FROM users, json_each(users.api_products)
      GROUP BY 2
    `);
    assert.match(sql, /EXTRACT\(EPOCH FROM NOW\(\)\)/);
    assert.match(sql, /jsonb_array_elements_text/);
    assert.doesNotMatch(sql, /julianday/i);
    assert.doesNotMatch(sql, /json_each\s*\(/);
  });

  // ─── INSERT OR IGNORE ─────────────────────────────────────
  // "Insert this, and if it is already there do nothing" is how every joining
  // path in the codebase is written — adding somebody to a circle, to a cohort,
  // to the members of a gift. Twenty-four statements depend on it.
  //
  // The translation for it was dead code. It stripped the OR IGNORE and then
  // asked whether the *original* said `INSERT INTO` before adding ON CONFLICT —
  // and the original says `INSERT OR IGNORE INTO`, so the answer was always no.
  // Every one of those statements became a plain INSERT on Postgres, and the
  // second time any ran for the same pair it raised a duplicate key error
  // rather than doing nothing. Approving an onboarding applicant already in the
  // "All Members" cohort is one such second time, and it 500'd in production.

  test('INSERT OR IGNORE becomes ON CONFLICT DO NOTHING', () => {
    assert.equal(
      pgSql('INSERT OR IGNORE INTO user_cohorts (user_id, cohort_id) VALUES (?, ?)'),
      'INSERT INTO user_cohorts (user_id, cohort_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'
    );
  });

  test('no INSERT OR IGNORE survives the translation as a plain insert', () => {
    // The shape of the original bug: the OR IGNORE was removed and nothing put
    // in its place, so the statement looked fine and behaved differently.
    for (const sql of [
      'INSERT OR IGNORE INTO circle_members (circle_id, user_id) VALUES (?, ?)',
      'INSERT OR IGNORE INTO user_gifts (id, user_id, gift_id) VALUES (?, ?, ?)',
      'insert or ignore into circle_admins (circle_id, admin_id) values (?, ?)'
    ]) {
      const out = pgSql(sql);
      assert.doesNotMatch(out, /OR\s+IGNORE/i, 'the SQLite spelling must not reach Postgres');
      assert.match(out, /ON CONFLICT DO NOTHING/, `${sql} lost its "do nothing"`);
    }
  });

  test('it works on an insert fed by a select, not just by values', () => {
    const out = pgSql('INSERT OR IGNORE INTO feedback (id, user_id) SELECT ?, id FROM users WHERE email = ?');
    assert.match(out, /FROM users WHERE email = \$2 ON CONFLICT DO NOTHING$/);
  });

  test('ON CONFLICT lands before RETURNING, where Postgres will take it', () => {
    // Appended blindly it would follow RETURNING, which is a syntax error —
    // loud, unlike the bug this file is mostly about, but still wrong.
    const out = pgSql('INSERT OR IGNORE INTO t (a) VALUES (?) RETURNING id');
    assert.equal(out, 'INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id');
  });

  test('a statement that already says ON CONFLICT is left alone', () => {
    const sql = 'INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET a = EXCLUDED.a';
    assert.equal(pgSql(sql).match(/ON CONFLICT/g).length, 1, 'no second clause');
  });

  test('an ordinary insert is not given a conflict clause it never asked for', () => {
    const out = pgSql('INSERT INTO consent (id, channel) VALUES (?, ?)');
    assert.doesNotMatch(out, /ON CONFLICT/);
  });

  test('INSERT OR REPLACE refuses rather than silently becoming an insert', () => {
    // It needs a conflict target and a column list, and neither can be read off
    // the statement. Guessing is how the OR IGNORE bug happened; this says so
    // instead. Nothing reaches it today — its one use is the sandbox, which is
    // always SQLite.
    assert.throws(
      () => pgSql('INSERT OR REPLACE INTO sandbox_meta (key, value) VALUES (?, ?)'),
      /no direct Postgres translation/
    );
  });

});

  // ─── COUNT(*) is a number ─────────────────────────────────
  // node-postgres returns int8 as a *string*, because an int8 can exceed what a
  // JS number holds safely. A row count never will, and the string reached the
  // screen twice: `count ? badge(count) : ''` drew a badge reading 0, because
  // "0" is truthy, and summing counts concatenated them into "000".

  test('a count comes back as a number, so zero is falsy', () => {
    require('../../src/db/pg');
    const { types } = require('pg');
    const int8 = types.getTypeParser(20);

    assert.strictEqual(int8('0'), 0);
    assert.strictEqual(int8('42'), 42);
    assert.equal(typeof int8('7'), 'number');

    assert.equal(Boolean(int8('0')), false, 'a badge keyed on truthiness must not draw for zero');
  });

  test('counts add up instead of concatenating', () => {
    require('../../src/db/pg');
    const int8 = require('pg').types.getTypeParser(20);

    const counts = ['0', '0', '0'].map(int8);
    assert.strictEqual(counts.reduce((n, v) => n + v, 0), 0, 'this produced the string "000"');

    assert.strictEqual(['3', '4'].map(int8).reduce((n, v) => n + v, 0), 7);
  });

  test('numeric is left alone, because rounding money is worse', () => {
    require('../../src/db/pg');
    assert.equal(typeof require('pg').types.getTypeParser(1700)('12.50'), 'string');
  });
