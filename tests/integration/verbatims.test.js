const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const verbatims = require('../../src/services/verbatims');

before(h.start);
after(h.stop);

let adminToken;

beforeEach(async () => {
  h.reset();
  h.makeRootCircle();
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: role });
  adminToken = await h.loginAdmin(admin.email, admin.password);
});

const QUESTIONS = [
  { id: 'q1', type: 'rating', text: 'How clear are the docs?', scale: 5 },
  { id: 'q2', type: 'choice', text: 'What brought you here?', options: ['Integration', 'Evaluation'] },
  { id: 'q3', type: 'text', text: 'What could we improve?' },
  { id: 'q4', type: 'text', text: 'Anything else?' }
];

function makeSurvey({ status = 'active', questions = QUESTIONS, title = 'Docs feedback' } = {}) {
  const id = h.uuid();
  h.db.prepare(`
    INSERT INTO surveys (id, title, questions, status, target_type)
    VALUES (?, ?, ?, ?, 'all')
  `).run(id, title, JSON.stringify(questions), status);
  return { id, title, questions };
}

async function respond(user, survey, answers) {
  const token = await h.loginUser(user.email, 'dev-password');
  await h.post(`/api/users/surveys/${survey.id}/start`, {}, { token });
  return h.post(`/api/users/surveys/${survey.id}/respond`, { answers }, { token });
}

// ─── Filing ─────────────────────────────────────────────────

test('a written answer is filed as feedback against the member', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  const survey = makeSurvey();

  const res = await respond(user, survey, {
    q1: 4, q2: 'Integration', q3: 'The webhook retry intervals are undocumented.'
  });
  assert.equal(res.status, 200);

  const filed = h.db.prepare("SELECT * FROM feedback WHERE user_id = ? AND source = 'survey'").all(user.id);

  assert.equal(filed.length, 1);
  assert.equal(filed[0].content, 'The webhook retry intervals are undocumented.');
  assert.equal(filed[0].type, 'survey_response');
  assert.equal(filed[0].survey_id, survey.id);
  assert.equal(filed[0].question_id, 'q3');
});

test('the question is kept with the answer', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  const survey = makeSurvey();

  await respond(user, survey, { q3: 'About a week.' });

  const filed = h.db.prepare("SELECT prompt FROM feedback WHERE source = 'survey'").get();
  // "About a week." on its own says nothing; the prompt is what makes it mean something
  assert.equal(filed.prompt, 'What could we improve?');
});

test('ratings and picked options are not filed as verbatims', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  const survey = makeSurvey();

  await respond(user, survey, { q1: 5, q2: 'Evaluation' });

  const filed = h.db.prepare("SELECT COUNT(*) c FROM feedback WHERE source = 'survey'").get().c;
  // They are measurements, and filing them here would bury the sentences
  assert.equal(filed, 0);
});

test('several written answers in one response are filed separately', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  const survey = makeSurvey();

  await respond(user, survey, { q3: 'Rate limits are too tight.', q4: 'Otherwise good.' });

  const filed = h.db.prepare("SELECT question_id FROM feedback WHERE source = 'survey' ORDER BY question_id").all();
  assert.deepEqual(filed.map(f => f.question_id), ['q3', 'q4']);
});

test('an empty or whitespace answer is not filed', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  const survey = makeSurvey();

  await respond(user, survey, { q3: '   ', q4: '' });

  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM feedback WHERE source = 'survey'").get().c, 0);
});

test('answers are stored as written, not interpreted', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  const survey = makeSurvey();
  const written = '  429s even within the documented limits — during peak hours.  ';

  await respond(user, survey, { q3: written });

  const filed = h.db.prepare("SELECT content FROM feedback WHERE source = 'survey'").get();
  assert.equal(filed.content, written.trim(), 'only surrounding whitespace is touched');
});

test('filing the same response twice does not duplicate the verbatim', () => {
  const user = h.makeUser();
  const survey = makeSurvey();
  const answers = { q3: 'Said once.' };

  const first = verbatims.record(user.id, survey, answers);
  const second = verbatims.record(user.id, survey, answers);

  assert.equal(first.filed, 1);
  assert.equal(second.filed, 0, 'a replayed submission must not file the sentence again');
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM feedback WHERE source = 'survey'").get().c, 1);
});

test('two members answering the same question are filed separately', () => {
  const first = h.makeUser();
  const second = h.makeUser();
  const survey = makeSurvey();

  verbatims.record(first.id, survey, { q3: 'Docs are unclear.' });
  verbatims.record(second.id, survey, { q3: 'Docs are unclear.' });

  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM feedback WHERE source = 'survey'").get().c, 2);
});

// ─── Reading ────────────────────────────────────────────────

test('one query returns everything a member has told us, from every source', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  const token = await h.loginUser(user.email, 'dev-password');
  const survey = makeSurvey();

  // Said unprompted in Dev Circle
  await h.post('/api/feedback', { content: 'The sandbox is slow.', category: 'sandbox' }, { token });
  // Answered in a survey
  await respond(user, survey, { q3: 'Retry intervals are undocumented.' });
  // Raised through Feex
  h.db.prepare(`
    INSERT INTO feedback (id, user_id, type, content, source, external_ticket_id, feex_status)
    VALUES (?, ?, 'feex_complaint', 'KYB took eight days.', 'feex', 'FEEX-1', 'open')
  `).run(h.uuid(), user.id);

  const all = verbatims.forUser(user.id);

  assert.equal(all.length, 3);
  assert.deepEqual([...new Set(all.map(f => f.source))].sort(), ['dev_circle', 'feex', 'survey']);
});

test('the member detail view carries the source and question of each thing said', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  const survey = makeSurvey();
  await respond(user, survey, { q3: 'Retry intervals are undocumented.' });

  const res = await h.get(`/api/admin/members/${user.id}`, { token: adminToken });
  const fromSurvey = res.body.feedback.find(f => f.source === 'survey');

  assert.ok(fromSurvey);
  assert.equal(fromSurvey.prompt, 'What could we improve?');
  assert.equal(fromSurvey.survey_title, 'Docs feedback');
});

test('feedback can be filtered to a single source', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  const token = await h.loginUser(user.email, 'dev-password');
  await h.post('/api/feedback', { content: 'Said in Dev Circle.' }, { token });
  await respond(user, makeSurvey(), { q3: 'Said in a survey.' });

  const surveyOnly = await h.get('/api/admin/feedback?source=survey', { token: adminToken });
  const circleOnly = await h.get('/api/admin/feedback?source=dev_circle', { token: adminToken });

  assert.equal(surveyOnly.body.feedback.length, 1);
  assert.equal(surveyOnly.body.feedback[0].content, 'Said in a survey.');
  assert.equal(circleOnly.body.feedback.length, 1);
});

test('the feedback list reports what each source has contributed', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  await respond(user, makeSurvey(), { q3: 'One.', q4: 'Two.' });

  const res = await h.get('/api/admin/feedback', { token: adminToken });
  const survey = res.body.sources.find(s => s.source === 'survey');

  assert.equal(survey.count, 2);
});

// ─── Triage ─────────────────────────────────────────────────

test('a survey answer cannot be marked resolved', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  await respond(user, makeSurvey(), { q3: 'Something they said.' });

  const filed = h.db.prepare("SELECT id FROM feedback WHERE source = 'survey'").get();
  const res = await h.put(`/api/admin/feedback/${filed.id}`, { status: 'resolved' }, { token: adminToken });

  // It is a record of what someone said, not an item to work through
  assert.equal(res.status, 409);
  assert.match(res.body.error, /record of what the member said/);
});

test('feedback raised in Dev Circle can still be triaged', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  const token = await h.loginUser(user.email, 'dev-password');
  const created = await h.post('/api/feedback', { content: 'Still triageable.' }, { token });

  const res = await h.put(`/api/admin/feedback/${created.body.feedback.id}`,
    { status: 'reviewed' }, { token: adminToken });
  assert.equal(res.status, 200);
});

// ─── The survey's own results are untouched ─────────────────

test('the response keeps its answers, so survey results are unaffected', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  const survey = makeSurvey();

  await respond(user, survey, { q1: 4, q3: 'Filed as feedback too.' });

  const response = h.db.prepare('SELECT answers FROM survey_responses WHERE user_id = ?').get(user.id);
  const answers = JSON.parse(response.answers);

  // Filing a copy as feedback must not move it out of the survey it belongs to
  assert.equal(answers.q1, 4);
  assert.equal(answers.q3, 'Filed as feedback too.');
});

test('survey responses still export with their verbatims', async () => {
  const user = h.makeUser({ password: 'dev-password' });
  const survey = makeSurvey();
  await respond(user, survey, { q1: 5, q3: 'In the export as well.' });

  const res = await fetch(`${h.baseUrl()}/api/admin/surveys/${survey.id}/export`,
    { headers: { Authorization: `Bearer ${adminToken}` } });
  const csv = await res.text();

  assert.ok(csv.includes('In the export as well.'));
});

// ─── Backfill ───────────────────────────────────────────────

test('answers collected before this existed are filed retrospectively', () => {
  const user = h.makeUser();
  const survey = makeSurvey();

  // A response written the old way: the sentence exists only inside the JSON
  h.db.prepare(`
    INSERT INTO survey_responses (id, survey_id, user_id, answers, completed_at)
    VALUES (?, ?, ?, ?, datetime('now', '-40 days'))
  `).run(h.uuid(), survey.id, user.id, JSON.stringify({ q3: 'Said long before anyone could search it.' }));

  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM feedback WHERE source = 'survey'").get().c, 0);

  // The migration's backfill, applied to this response
  const { filed } = verbatims.record(user.id, survey,
    JSON.parse(h.db.prepare('SELECT answers FROM survey_responses WHERE user_id = ?').get(user.id).answers));

  assert.equal(filed, 1);
  assert.equal(
    h.db.prepare("SELECT content FROM feedback WHERE source = 'survey'").get().content,
    'Said long before anyone could search it.'
  );
});

test('the migration backfills a database that predates it', () => {
  const Database = require('better-sqlite3');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const migrations = require('../../src/db/migrations');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devcircle-backfill-'));
  const old = new Database(path.join(dir, 'old.db'));

  try {
    // A database with the base schema and a response written the old way:
    // the sentence lives only inside the answers JSON
    old.exec(require('../../src/db/schema').SCHEMA);

    const userId = h.uuid();
    const surveyId = h.uuid();

    old.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, 'a@b.ng', 'Ada Obi', 'x')")
      .run(userId);
    old.prepare("INSERT INTO surveys (id, title, questions, status) VALUES (?, 'Docs feedback', ?, 'active')")
      .run(surveyId, JSON.stringify([
        { id: 'q1', type: 'rating', text: 'Score?' },
        { id: 'q2', type: 'text', text: 'What could we improve?' }
      ]));
    old.prepare(`
      INSERT INTO survey_responses (id, survey_id, user_id, answers, completed_at)
      VALUES (?, ?, ?, ?, datetime('now', '-20 days'))
    `).run(h.uuid(), surveyId, userId,
      JSON.stringify({ q1: 3, q2: 'Webhook retry intervals are undocumented.' }));

    assert.equal(old.prepare('SELECT COUNT(*) c FROM feedback').get().c, 0);

    migrations.run(old);

    const filed = old.prepare("SELECT * FROM feedback WHERE source = 'survey'").all();
    assert.equal(filed.length, 1, 'answers collected before this existed must be brought forward');
    assert.equal(filed[0].content, 'Webhook retry intervals are undocumented.');
    assert.equal(filed[0].prompt, 'What could we improve?');
    assert.equal(filed[0].user_id, userId);
    // Dated when it was said, not when the migration happened
    assert.ok(filed[0].created_at < new Date().toISOString().slice(0, 10));

    // Ratings stay out, and re-running changes nothing
    assert.equal(migrations.run(old).length, 0);
    assert.equal(old.prepare("SELECT COUNT(*) c FROM feedback WHERE source = 'survey'").get().c, 1);
  } finally {
    old.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a survey with no written questions files nothing', () => {
  const user = h.makeUser();
  const survey = makeSurvey({ questions: [{ id: 'q1', type: 'rating', text: 'Score?', scale: 5 }] });

  const { filed } = verbatims.record(user.id, survey, { q1: 5 });
  assert.equal(filed, 0);
});

test('a malformed questions blob does not throw', () => {
  const user = h.makeUser();
  assert.doesNotThrow(() => verbatims.record(user.id, { id: h.uuid(), questions: 'not json' }, { q3: 'x' }));
});
