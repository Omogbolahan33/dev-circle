const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const { SCHEMA } = require('../../src/db/schema');
const migrations = require('../../src/db/migrations');

// ─── Migrations ─────────────────────────────────────────────
// The ones that rebuild a table are the ones worth a test. SQLite cannot drop
// a NOT NULL or widen a CHECK in place, so those columns are carried across a
// new table by hand — and a column left off that list is data that silently
// stops being written, which nobody notices until they go looking for it.

function databaseAt(upTo) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devcircle-mig-')), 'test.db');
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // Run the real migrations, stopping where the test wants to stand
  const all = migrations.define(db);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT (datetime('now')))`);

  // Applied the way the runner applies them, enforcement and all, so a test
  // cannot pass under conditions the real thing never gets
  for (const migration of all) {
    if (migration.id > upTo) break;
    apply(db, migration);
  }

  return { db, file };
}

// One migration, under the same rules the runner uses: enforcement off for the
// rebuild, then a full integrity scan to prove nothing was stranded.
function apply(db, migration) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      migration.up();
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(migration.id, migration.name);
    })();
    assert.deepEqual(db.pragma('foreign_key_check'), [],
      `migration ${migration.id} must not strand a row`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

test('the anonymous-respondent rebuild carries every row and column across', () => {
  const { db } = databaseAt(24);

  // A database as it stood before: a member, a survey, a response, a verbatim
  const userId = crypto.randomUUID();
  const surveyId = crypto.randomUUID();
  const responseId = crypto.randomUUID();

  db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`)
    .run(userId, 'ada@example.ng', 'Ada', 'x');
  db.prepare(`INSERT INTO surveys (id, title, questions, target_type, status)
              VALUES (?, ?, ?, 'cohort', 'active')`)
    .run(surveyId, 'Docs', JSON.stringify([{ id: 'q1', type: 'text', text: 'How?' }]));
  db.prepare(`INSERT INTO survey_responses (id, survey_id, user_id, answers, completed_at)
              VALUES (?, ?, ?, ?, datetime('now'))`)
    .run(responseId, surveyId, userId, JSON.stringify({ q1: 'The docs assume Node.' }));
  db.prepare(`INSERT INTO feedback (id, user_id, content, source, survey_id, question_id, prompt)
              VALUES (?, ?, ?, 'survey', ?, 'q1', 'How?')`)
    .run(crypto.randomUUID(), userId, 'The docs assume Node.', surveyId);

  const columnsBefore = {
    surveys: db.prepare('PRAGMA table_info(surveys)').all().map(c => c.name),
    survey_responses: db.prepare('PRAGMA table_info(survey_responses)').all().map(c => c.name),
    feedback: db.prepare('PRAGMA table_info(feedback)').all().map(c => c.name)
  };

  // Apply the migration under test
  apply(db, migrations.define(db).find(m => m.id === 25));

  for (const [table, before] of Object.entries(columnsBefore)) {
    const after = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    for (const column of before) {
      assert.ok(after.includes(column), `${table}.${column} must survive the rebuild`);
    }
  }

  assert.equal(db.prepare('SELECT COUNT(*) c FROM surveys').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM survey_responses').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM feedback').get().c, 1);

  const response = db.prepare('SELECT * FROM survey_responses WHERE id = ?').get(responseId);
  assert.equal(JSON.parse(response.answers).q1, 'The docs assume Node.', 'answers came across intact');
  assert.equal(response.respondent_kind, 'member', 'everyone who answered before was a member');
  assert.equal(response.user_id, userId);

  assert.deepEqual(db.pragma('foreign_key_check'), [], 'no reference is left dangling');
});

test('after the rebuild, a respondent with no account is storable', () => {
  const { db } = databaseAt(25);
  const surveyId = crypto.randomUUID();

  db.prepare(`INSERT INTO surveys (id, title, questions, target_type, status, public_token)
              VALUES (?, 'Open to anyone', '[]', 'anonymous', 'active', 'tok_abc')`).run(surveyId);

  db.prepare(`INSERT INTO survey_responses (id, survey_id, user_id, respondent_kind, triggered_by)
              VALUES (?, ?, NULL, 'anonymous', 'link')`).run(crypto.randomUUID(), surveyId);

  db.prepare(`INSERT INTO feedback (id, user_id, content, source, survey_id, question_id, response_id)
              VALUES (?, NULL, 'No account, still had something to say', 'survey', ?, 'q1', 'r1')`)
    .run(crypto.randomUUID(), surveyId);

  assert.equal(db.prepare("SELECT COUNT(*) c FROM survey_responses WHERE user_id IS NULL").get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM feedback WHERE user_id IS NULL').get().c, 1);
});

test('two members can still only answer a question once each, and so can two submissions', () => {
  const { db } = databaseAt(25);
  const surveyId = crypto.randomUUID();
  const userId = crypto.randomUUID();

  db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, 'a@b.ng', 'A', 'x')`).run(userId);
  db.prepare(`INSERT INTO surveys (id, title, questions) VALUES (?, 'S', '[]')`).run(surveyId);

  const file = (id, user, response) => db.prepare(
    `INSERT INTO feedback (id, user_id, content, source, survey_id, question_id, response_id)
     VALUES (?, ?, 'x', 'survey', ?, 'q1', ?)`
  ).run(id, user, surveyId, response);

  file(crypto.randomUUID(), userId, null);
  assert.throws(() => file(crypto.randomUUID(), userId, null), /UNIQUE/,
    'a member answering the same question twice is one answer');

  file(crypto.randomUUID(), null, 'response-1');
  assert.throws(() => file(crypto.randomUUID(), null, 'response-1'), /UNIQUE/,
    'one submission holds one answer per question');
  file(crypto.randomUUID(), null, 'response-2');   // a different submission is a different person
});
