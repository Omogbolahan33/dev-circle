const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const responseImport = require('../../src/services/responseImport');
const { parseCSV } = require('../../src/utils/helpers');
const { parseXLSX } = require('../../src/utils/xlsx');

before(h.start);
after(h.stop);

let token;
let circleId;

beforeEach(async () => {
  h.reset();
  circleId = h.makeCircle();
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: role });
  token = await h.loginAdmin(admin.email, admin.password);
});

const create = (body = {}) => h.post('/api/admin/surveys', {
  title: 'Sandbox onboarding',
  questions: [
    { type: 'rating', text: 'How clear are the docs?', scale: 5, required: true },
    { type: 'text', text: 'What tripped you up?' }
  ],
  ...body
}, { token });

const made = async (body = {}) => (await create(body)).body.survey;

const importInto = (id, body) =>
  h.post(`/api/admin/surveys/${id}/responses/import`, body, { token });

const template = async (id, format) => {
  const res = await fetch(`${h.baseUrl()}/api/admin/surveys/${id}/responses/template?format=${format}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res;
};

// ─── Duplicating a survey ───────────────────────────────────

test('a copy is a draft, and no part of the original run comes with it', async () => {
  const survey = await made({ status: 'active' });

  const user = h.makeUser();
  const memberToken = await h.loginUser(user.email);
  await h.post(`/api/users/surveys/${survey.id}/start`, {}, { token: memberToken });
  await h.post(`/api/users/surveys/${survey.id}/respond`, {
    answers: { [survey.questions[0].id]: 4 }
  }, { token: memberToken });

  const res = await h.post(`/api/admin/surveys/${survey.id}/duplicate`, {}, { token });

  assert.equal(res.status, 201);
  assert.equal(res.body.survey.status, 'draft', 'a copy must never publish itself');
  assert.equal(res.body.survey.title, 'Sandbox onboarding (copy)');
  assert.equal(res.body.copied_from, survey.id);

  const responses = h.db.prepare('SELECT COUNT(*) c FROM survey_responses WHERE survey_id = ?')
    .get(res.body.survey.id).c;
  assert.equal(responses, 0, 'the original\'s answers belong to the original');
});

test('every question in a copy has its own id, and the branching follows', async () => {
  // A rule can only name a question that already exists, so the survey is
  // written first and the branching added against the ids it came back with —
  // which is exactly what the builder does
  const survey = await made({
    questions: [
      { type: 'choice', text: 'Did the sandbox work?', options: ['Yes', 'No'], required: true },
      { type: 'text', text: 'What went wrong?' }
    ]
  });

  await h.put(`/api/admin/surveys/${survey.id}`, {
    questions: [
      { ...survey.questions[0] },
      {
        ...survey.questions[1],
        visible_if: { match: 'all', rules: [{ question: survey.questions[0].id, op: 'is', value: 'No' }] }
      }
    ]
  }, { token });

  const original = (await h.get(`/api/admin/surveys/${survey.id}`, { token })).body.survey;
  const copy = (await h.post(`/api/admin/surveys/${survey.id}/duplicate`, {}, { token })).body.survey;

  const originalIds = original.questions.map(q => q.id);
  const copyIds = copy.questions.map(q => q.id);

  assert.equal(copyIds.length, 2);
  for (const id of copyIds) {
    assert.ok(!originalIds.includes(id), 'a shared slot id would index two surveys\' answers alike');
  }

  assert.equal(copy.questions[1].visible_if.rules[0].question, copy.questions[0].id,
    'a rule left pointing at the original would silently never fire');
});

test('a copy carries the canonical question, so both rounds read together', async () => {
  const survey = await made();
  const original = (await h.get(`/api/admin/surveys/${survey.id}`, { token })).body.survey;
  const copy = (await h.post(`/api/admin/surveys/${survey.id}/duplicate`, {}, { token })).body.survey;

  assert.ok(original.questions[0].question_id, 'the original question has an identity');
  assert.equal(copy.questions[0].question_id, original.questions[0].question_id);
});

test('a copy of a link survey gets its own link, never the original\'s', async () => {
  const survey = await made({ target_type: 'anonymous', status: 'active' });
  assert.ok(survey.public_token);

  const copy = (await h.post(`/api/admin/surveys/${survey.id}/duplicate`, {}, { token })).body.survey;

  assert.ok(copy.public_token);
  assert.notEqual(copy.public_token, survey.public_token,
    'someone holding the first link must keep reaching the survey they were given');
});

test('an expiry already in the past is not carried into the copy', async () => {
  const survey = await made({ expires_at: '2020-01-01 00:00:00' });
  const copy = (await h.post(`/api/admin/surveys/${survey.id}/duplicate`, {}, { token })).body.survey;
  assert.equal(copy.expires_at, null, 'a copy born closed is a trap');
});

test('a copy can be renamed and moved to another circle as it is made', async () => {
  const other = h.makeCircle('Partner Circle', 'partner-circle');
  const survey = await made();

  const res = await h.post(`/api/admin/surveys/${survey.id}/duplicate`,
    { title: 'Sandbox onboarding — Q3', circle_id: other }, { token });

  assert.equal(res.status, 201);
  assert.equal(res.body.survey.title, 'Sandbox onboarding — Q3');
  assert.equal(res.body.survey.circle_id, other);
});

test('duplicating a survey that does not exist says so', async () => {
  const res = await h.post('/api/admin/surveys/nope/duplicate', {}, { token });
  assert.equal(res.status, 404);
});

// ─── The template describes what the parser accepts ─────────

test('the template headings are exactly the columns the parser reads', async () => {
  const survey = await made();
  const stored = h.db.prepare('SELECT * FROM surveys WHERE id = ?').get(survey.id);

  const rows = parseCSV(responseImport.toCsvTemplate(stored));
  const spec = responseImport.columns(stored);
  const headings = responseImport.index(spec);

  for (const heading of Object.keys(rows[0])) {
    const matched = headings.get(responseImport.norm(heading)) ||
      headings.get(responseImport.unnumbered(heading));
    assert.ok(matched, `the template offers "${heading}" but the parser does not read it`);
  }
});

test('a section gets no column, and a grid gets one per row', async () => {
  const survey = await made({
    questions: [
      { type: 'section', text: 'Part one' },
      { type: 'matrix', text: 'Rate these', rows: ['Docs', 'Errors'], columns: ['Clear', 'Confusing'] }
    ]
  });
  const stored = h.db.prepare('SELECT * FROM surveys WHERE id = ?').get(survey.id);
  const offered = responseImport.offered(responseImport.columns(stored))
    .filter(c => c.kind === 'question');

  assert.deepEqual(offered.map(c => c.key),
    ['q1. Rate these [Docs]', 'q1. Rate these [Errors]']);
});

test('the downloaded CSV template imports cleanly without a single edit', async () => {
  const survey = await made({
    questions: [
      { type: 'rating', text: 'How clear are the docs?', scale: 5, required: true },
      { type: 'nps', text: 'How likely are you to recommend us?' },
      { type: 'choice', text: 'Which environment?', options: ['Sandbox', 'Production'] },
      { type: 'multi_choice', text: 'Which products?', options: ['Lending', 'Payments', 'Identity'], min_select: 2 },
      { type: 'ranking', text: 'Order these', options: ['Speed', 'Docs', 'Support'] },
      { type: 'matrix', text: 'Rate these', rows: ['Docs', 'Errors'], columns: ['Clear', 'Confusing'] },
      { type: 'number', text: 'How many calls a day?', min: 1, max: 5000, integer: true, unit: 'calls' },
      { type: 'date', text: 'When did you integrate?' },
      { type: 'boolean', text: 'Would you build again?', true_label: 'Definitely', false_label: 'No' },
      { type: 'text', text: 'Anything else?' },
      { type: 'text', text: 'Your work email', format: 'email' }
    ]
  });

  const res = await template(survey.id, 'csv');
  assert.equal(res.status, 200);

  const csv = (await res.text()).replace(/^﻿/, '');
  const result = await importInto(survey.id, { csv, dry_run: true });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.errors, [],
    'the example row must satisfy every rule the survey states about itself');
  assert.deepEqual(result.body.unmatched_columns, []);
  assert.equal(result.body.imported, 1);
});

test('the downloaded workbook imports cleanly, and carries a sheet explaining itself', async () => {
  const survey = await made();

  const res = await template(survey.id, 'xlsx');
  assert.equal(res.status, 200);

  const buffer = Buffer.from(await res.arrayBuffer());
  const rows = parseXLSX(buffer);
  assert.equal(rows.length, 1, 'one example row under the headings');

  const result = await importInto(survey.id, {
    xlsx_base64: buffer.toString('base64'), dry_run: true
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.errors, []);
  assert.equal(result.body.imported, 1);
});

test('the template names the file after the survey, and refuses an unknown format', async () => {
  const survey = await made();

  const csv = await template(survey.id, 'csv');
  assert.match(csv.headers.get('content-disposition'), /sandbox-onboarding-responses-template\.csv/);

  const bad = await h.get(`/api/admin/surveys/${survey.id}/responses/template?format=pdf`, { token });
  assert.equal(bad.status, 400);
});

test('the column spec is served so a screen never keeps its own copy', async () => {
  const survey = await made();
  const res = await h.get(`/api/admin/surveys/${survey.id}/responses/columns`, { token });

  assert.equal(res.status, 200);
  const rating = res.body.columns.find(c => c.type === 'rating');
  assert.ok(rating.required);
  assert.match(rating.accepts, /1 to 5/);
  assert.ok(res.body.guidance.length);
});

// ─── Importing ──────────────────────────────────────────────

test('a sheet of collected answers becomes responses the survey can report on', async () => {
  const survey = await made();
  const [rating, text] = survey.questions;

  const member = h.makeUser({ email: 'ada@zilla.ng', name: 'Ada Obi' });

  const csv = [
    'email,submitted_at,q1. How clear are the docs?,q2. What tripped you up?',
    `${member.email},2026-03-14 09:20,4,The webhook signing docs`,
    ',2026-03-15,5,Nothing at all'
  ].join('\n');

  const res = await importInto(survey.id, { csv, source_system: 'google_forms' });

  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 2);
  assert.equal(res.body.matched_members, 1);
  assert.equal(res.body.anonymous, 1);
  assert.equal(res.body.flagged.length, 1, 'the row with no email is worth a second look');

  const stored = h.db.prepare(
    'SELECT * FROM survey_responses WHERE survey_id = ? ORDER BY completed_at'
  ).all(survey.id);

  assert.equal(stored.length, 2);
  assert.equal(stored[0].user_id, member.id);
  assert.equal(stored[0].respondent_kind, 'member');
  assert.equal(stored[0].triggered_by, 'import');
  assert.equal(stored[0].source_system, 'google_forms');
  assert.equal(stored[0].completed_at, '2026-03-14 09:20:00');
  assert.deepEqual(JSON.parse(stored[0].answers), {
    [rating.id]: 4, [text.id]: 'The webhook signing docs'
  });

  assert.equal(stored[1].user_id, null);
  assert.equal(stored[1].respondent_kind, 'external',
    'nobody answered this under a promise of anonymity');

  // And the survey now reports them
  const listed = (await h.get('/api/admin/surveys', { token })).body.surveys
    .find(s => s.id === survey.id);
  assert.equal(listed.completed_count, 2);
});

test('a written answer that arrived in a sheet is filed as feedback, stamped with where it came from', async () => {
  const survey = await made();
  const member = h.makeUser({ email: 'ada@zilla.ng' });

  await importInto(survey.id, {
    csv: `email,q1. How clear are the docs?,q2. What tripped you up?\n${member.email},3,The error codes are undocumented`,
    source_system: 'google_forms'
  });

  const filed = h.db.prepare('SELECT * FROM feedback WHERE user_id = ?').all(member.id);
  assert.equal(filed.length, 1);
  assert.equal(filed[0].content, 'The error codes are undocumented');
  assert.equal(filed[0].source, 'external_survey');
  assert.equal(filed[0].source_system, 'google_forms');
  assert.equal(filed[0].survey_id, survey.id);
});

test('a respondent this workspace has never met is created, not refused', async () => {
  const survey = await made();

  const res = await importInto(survey.id, {
    csv: 'email,name,company,q1. How clear are the docs?\nada.obi@zilla.ng,Ada Obi,Zilla,4'
  });

  assert.equal(res.body.imported, 1);
  assert.equal(res.body.created_members, 1);
  assert.match(res.body.message, /1 new member/);

  const made_ = h.db.prepare('SELECT * FROM users WHERE email = ?').get('ada.obi@zilla.ng');
  assert.equal(made_.name, 'Ada Obi');
  assert.equal(made_.company, 'Zilla');
  assert.equal(made_.password_hash, '!', 'members sign in with a one-time code, never a password');

  // and they are in the workspace whose survey they answered
  const inCircle = h.db.prepare(
    'SELECT COUNT(*) c FROM circle_members WHERE user_id = ? AND circle_id = ?'
  ).get(made_.id, circleId).c;
  assert.equal(inCircle, 1);

  const logged = h.db.prepare(
    "SELECT metadata FROM engagement_history WHERE user_id = ? AND type = 'account_created'"
  ).get(made_.id);
  assert.equal(JSON.parse(logged.metadata).via, 'survey_response_import');

  const response = h.db.prepare('SELECT user_id FROM survey_responses WHERE survey_id = ?').get(survey.id);
  assert.equal(response.user_id, made_.id);
});

test('a respondent with no name is created under the one thing the sheet gave us', async () => {
  const survey = await made();

  await importInto(survey.id, {
    csv: 'email,q1. How clear are the docs?\nkunle@wemabank.dev,4'
  });

  const created = h.db.prepare('SELECT name FROM users WHERE email = ?').get('kunle@wemabank.dev');
  assert.equal(created.name, 'kunle');
});

test('a member who already exists keeps the name they gave us', async () => {
  const survey = await made();
  const member = h.makeUser({ email: 'ada@zilla.ng', name: 'Ada Obi', company: 'Zilla' });

  await importInto(survey.id, {
    csv: `email,name,company,q1. How clear are the docs?\n${member.email},A. Obi,Zila,4`
  });

  const after = h.db.prepare('SELECT name, company FROM users WHERE id = ?').get(member.id);
  assert.equal(after.name, 'Ada Obi', 'a transcription error must not rewrite a profile');
  assert.equal(after.company, 'Zilla');
});

test('a Credit Direct address is refused — staff are made under Roles', async () => {
  const survey = await made();

  const res = await importInto(survey.id, {
    csv: 'email,q1. How clear are the docs?\nnew.hire@creditdirect.ng,4'
  });

  assert.equal(res.body.imported, 0);
  assert.equal(res.body.created_members, 0);
  assert.match(res.body.errors[0].error, /staff are added under Roles/i);
});

test('an address that is not an address is refused rather than made into a member', async () => {
  const survey = await made();

  const res = await importInto(survey.id, {
    csv: 'email,q1. How clear are the docs?\nnot-an-email,4'
  });

  assert.equal(res.body.imported, 0);
  assert.equal(res.body.created_members, 0);
  assert.match(res.body.errors[0].error, /not a valid email/);
});

test('create_missing off puts the old refusal back, for an import that must not make people', async () => {
  const survey = await made();

  const res = await importInto(survey.id, {
    csv: 'email,q1. How clear are the docs?\nstranger@nowhere.ng,4',
    create_missing: false
  });

  assert.equal(res.body.imported, 0);
  assert.equal(res.body.created_members, 0);
  assert.match(res.body.errors[0].error, /not a member here/);
  assert.match(res.body.errors[0].error, /clear the email/);
});

test('a member of another workspace joins this one rather than being duplicated', async () => {
  const survey = await made();

  const elsewhere = h.makeCircle('Partner Circle', 'partner-circle');
  const outsider = h.makeUser({ email: 'kunle@wemabank.dev', circleId: elsewhere });
  h.db.prepare('DELETE FROM circle_members WHERE user_id = ? AND circle_id = ?').run(outsider.id, circleId);

  const res = await importInto(survey.id, {
    csv: `email,q1. How clear are the docs?\n${outsider.email},4`
  });

  assert.equal(res.body.imported, 1);
  assert.equal(res.body.added_to_circle, 1);
  assert.equal(res.body.created_members, 0, 'they already exist — a second profile would split them in two');

  const accounts = h.db.prepare('SELECT COUNT(*) c FROM users WHERE email = ?').get(outsider.email).c;
  assert.equal(accounts, 1);

  const joined = h.db.prepare(
    'SELECT COUNT(*) c FROM circle_members WHERE user_id = ? AND circle_id = ?'
  ).get(outsider.id, circleId).c;
  assert.equal(joined, 1, 'importing their answer is an assertion that they were in the audience');
});

test('with create_missing off, an outsider stays outside', async () => {
  const survey = await made();

  const elsewhere = h.makeCircle('Partner Circle', 'partner-circle');
  const outsider = h.makeUser({ email: 'kunle@wemabank.dev', circleId: elsewhere });
  h.db.prepare('DELETE FROM circle_members WHERE user_id = ? AND circle_id = ?').run(outsider.id, circleId);

  const res = await importInto(survey.id, {
    csv: `email,q1. How clear are the docs?\n${outsider.email},4`,
    create_missing: false
  });

  assert.equal(res.body.imported, 0);
  assert.match(res.body.errors[0].error, /another workspace/);
});

// ─── A row with nobody on it ────────────────────────────────

test('a blank email on a survey put to named people is flagged, not silently accepted', async () => {
  const survey = await made();

  const res = await importInto(survey.id, {
    csv: 'email,q1. How clear are the docs?\n,4'
  });

  assert.equal(res.body.imported, 1, 'the answer is real either way');
  assert.equal(res.body.anonymous, 1);
  assert.equal(res.body.flagged.length, 1);
  assert.equal(res.body.flagged[0].line, 2);
  assert.match(res.body.flagged[0].reason, /column/);

  const stored = h.db.prepare('SELECT respondent_kind FROM survey_responses WHERE survey_id = ?').get(survey.id);
  assert.equal(stored.respondent_kind, 'external',
    'nobody answered this under a promise of anonymity');
});

test('a blank email on a link survey is the point of it, and is not flagged', async () => {
  const survey = await made({ target_type: 'anonymous' });

  const res = await importInto(survey.id, {
    csv: 'q1. How clear are the docs?\n4'
  });

  assert.equal(res.body.imported, 1);
  assert.deepEqual(res.body.flagged, []);

  const stored = h.db.prepare('SELECT respondent_kind FROM survey_responses WHERE survey_id = ?').get(survey.id);
  assert.equal(stored.respondent_kind, 'anonymous');
});

test('a check that would create people writes none of them', async () => {
  const survey = await made();

  const res = await importInto(survey.id, {
    csv: 'email,name,q1. How clear are the docs?\nada.obi@zilla.ng,Ada Obi,4',
    dry_run: true
  });

  assert.equal(res.body.created_members, 1, 'it says who it would create');
  assert.equal(res.body.preview[0].new_member, true);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM users').get().c, 0, 'and creates nobody');
});

test('a member who has already answered is skipped rather than counted twice', async () => {
  const survey = await made({ status: 'active' });
  const member = h.makeUser({ email: 'ada@zilla.ng' });
  const memberToken = await h.loginUser(member.email);

  await h.post(`/api/users/surveys/${survey.id}/start`, {}, { token: memberToken });
  await h.post(`/api/users/surveys/${survey.id}/respond`, {
    answers: { [survey.questions[0].id]: 2 }
  }, { token: memberToken });

  const res = await importInto(survey.id, {
    csv: `email,q1. How clear are the docs?\n${member.email},5`
  });

  assert.equal(res.body.imported, 0);
  assert.equal(res.body.skipped, 1);

  const stored = h.db.prepare('SELECT answers FROM survey_responses WHERE survey_id = ?').all(survey.id);
  assert.equal(stored.length, 1);
  assert.equal(JSON.parse(stored[0].answers)[survey.questions[0].id], 2,
    'what they actually submitted stands');
});

test('an invitation waiting on a member is completed, not joined by a second response', async () => {
  const survey = await made({ status: 'active' });
  const member = h.makeUser({ email: 'ada@zilla.ng' });
  h.grantConsent(member.id, 'email');

  await h.post(`/api/admin/surveys/${survey.id}/invite`, {}, { token });
  const invited = h.db.prepare('SELECT COUNT(*) c FROM survey_responses WHERE survey_id = ?').get(survey.id).c;
  assert.equal(invited, 1);

  const res = await importInto(survey.id, {
    csv: `email,q1. How clear are the docs?\n${member.email},5`
  });

  assert.equal(res.body.imported, 1);

  const stored = h.db.prepare('SELECT * FROM survey_responses WHERE survey_id = ?').all(survey.id);
  assert.equal(stored.length, 1, 'a second row would report an invitation that was never sent');
  assert.ok(stored[0].completed_at);
  assert.equal(stored[0].triggered_by, 'import');
});

test('a heading that matched nothing is reported, once for the sheet', async () => {
  const survey = await made();

  const res = await importInto(survey.id, {
    csv: [
      'email,q1. How clear are the docs?,How was the weather?',
      ',4,Sunny',
      ',5,Wet'
    ].join('\n')
  });

  assert.equal(res.body.imported, 2);
  assert.deepEqual(res.body.unmatched_columns, ['how_was_the_weather?']);
});

test('a row missing a required answer is refused, naming the question', async () => {
  const survey = await made();

  const res = await importInto(survey.id, {
    csv: 'email,q2. What tripped you up?\n,Nothing much'
  });

  assert.equal(res.body.imported, 0);
  assert.match(res.body.errors[0].error, /How clear are the docs\?/);
  assert.match(res.body.errors[0].error, /required/i);
});

test('an imported answer is held to the same rules as a typed one', async () => {
  const survey = await made();

  const res = await importInto(survey.id, {
    csv: 'q1. How clear are the docs?\n9'
  });

  assert.equal(res.body.imported, 0);
  assert.match(res.body.errors[0].error, /1 to 5/);
});

test('importing the same file twice lands nothing the second time', async () => {
  const survey = await made();
  const csv = 'response_id,q1. How clear are the docs?\ngf-1,4\ngf-2,5';

  const first = await importInto(survey.id, { csv, source_system: 'google_forms' });
  assert.equal(first.body.imported, 2);

  const second = await importInto(survey.id, { csv, source_system: 'google_forms' });
  assert.equal(second.body.imported, 0);
  assert.equal(second.body.skipped, 2);

  const stored = h.db.prepare('SELECT COUNT(*) c FROM survey_responses WHERE survey_id = ?').get(survey.id).c;
  assert.equal(stored, 2);
});

test('a reference repeated inside one sheet is caught before it reaches the index', async () => {
  const survey = await made();

  const res = await importInto(survey.id, {
    csv: 'response_id,q1. How clear are the docs?\ngf-1,4\ngf-1,5'
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.skipped, 1);
});

test('a check leaves nothing behind', async () => {
  const survey = await made();
  const member = h.makeUser({ email: 'ada@zilla.ng' });

  const res = await importInto(survey.id, {
    csv: `email,q1. How clear are the docs?,q2. What tripped you up?\n${member.email},4,The docs`,
    dry_run: true
  });

  assert.equal(res.body.dry_run, true);
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.preview[0].email, member.email);

  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM survey_responses').get().c, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM feedback').get().c, 0);
});

test('an imported response is history, not activity — the streak is left alone', async () => {
  const survey = await made();
  const member = h.makeUser({ email: 'ada@zilla.ng' });

  await importInto(survey.id, {
    csv: `email,submitted_at,q1. How clear are the docs?\n${member.email},2026-03-14,4`
  });

  const after = h.db.prepare('SELECT engagement_streak FROM users WHERE id = ?').get(member.id);
  assert.equal(after.engagement_streak, 0,
    'a form filled in last March is not something the member did today');

  const logged = h.db.prepare(
    "SELECT * FROM engagement_history WHERE user_id = ? AND type = 'survey_completed'"
  ).all(member.id);
  assert.equal(logged.length, 1, 'the history still gains the event');
  assert.equal(JSON.parse(logged[0].metadata).via, 'import');
});

test('a survey with no questions has nothing for a sheet to line up against', async () => {
  const survey = await made({ questions: [] });

  const res = await importInto(survey.id, { csv: 'email\nada@zilla.ng' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /no questions/i);
});

test('a sheet with headings and no rows under them is refused plainly', async () => {
  const survey = await made();
  const res = await importInto(survey.id, { csv: 'email,q1. How clear are the docs?' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /No data rows/);
});

// ─── The round trip the whole thing exists for ──────────────

test('last round\'s export imports straight into this round\'s copy', async () => {
  const survey = await made({
    status: 'active',
    questions: [
      { type: 'rating', text: 'How clear are the docs?', scale: 5, required: true },
      { type: 'multi_choice', text: 'Which products?', options: ['Lending', 'Payments', 'Identity'] },
      { type: 'ranking', text: 'Order these', options: ['Speed', 'Docs', 'Support'] },
      { type: 'matrix', text: 'Rate these', rows: ['Docs', 'Errors'], columns: ['Clear', 'Confusing'] },
      { type: 'boolean', text: 'Would you build again?' },
      { type: 'text', text: 'Anything else?' }
    ]
  });
  const [rating, products, order, grid, again, comment] = survey.questions;

  const member = h.makeUser({ email: 'ada@zilla.ng' });
  const memberToken = await h.loginUser(member.email);
  await h.post(`/api/users/surveys/${survey.id}/start`, {}, { token: memberToken });

  const answers = {
    [rating.id]: 4,
    [products.id]: ['Lending', 'Identity'],
    [order.id]: ['Docs', 'Speed', 'Support'],
    [grid.id]: { Docs: 'Clear', Errors: 'Confusing' },
    [again.id]: true,
    [comment.id]: 'The sandbox keys worked first time.'
  };
  const submitted = await h.post(`/api/users/surveys/${survey.id}/respond`, { answers }, { token: memberToken });
  assert.equal(submitted.status, 200);

  // Export the round that just finished…
  const exported = await fetch(`${h.baseUrl()}/api/admin/surveys/${survey.id}/export`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const csv = await exported.text();

  // …duplicate the survey for the next one, and bring the answers across
  const copy = (await h.post(`/api/admin/surveys/${survey.id}/duplicate`, {}, { token })).body.survey;

  const result = await importInto(copy.id, { csv });

  assert.deepEqual(result.body.errors, []);
  assert.equal(result.body.imported, 1);

  const landed = h.db.prepare('SELECT * FROM survey_responses WHERE survey_id = ?').get(copy.id);
  const restored = JSON.parse(landed.answers);
  const byText = text => copy.questions.find(q => q.text === text).id;

  assert.equal(restored[byText('How clear are the docs?')], 4);
  assert.deepEqual(restored[byText('Which products?')], ['Lending', 'Identity']);
  assert.deepEqual(restored[byText('Order these')], ['Docs', 'Speed', 'Support']);
  assert.deepEqual(restored[byText('Rate these')], { Docs: 'Clear', Errors: 'Confusing' });
  assert.equal(restored[byText('Would you build again?')], true);
  assert.equal(restored[byText('Anything else?')], 'The sandbox keys worked first time.');
  assert.equal(landed.user_id, member.id, 'the export named them, so the import found them');
});

// ─── Reading what a sheet wrote ─────────────────────────────

test('a Google Forms export keeps the day it was answered, not the day it was typed in', async () => {
  const survey = await made();

  const res = await importInto(survey.id, {
    csv: 'Timestamp,How clear are the docs?\n14/03/2026 09:20:15,4',
    source_system: 'google_forms'
  });

  assert.equal(res.body.imported, 1);
  assert.deepEqual(res.body.unmatched_columns, []);

  const stored = h.db.prepare('SELECT completed_at FROM survey_responses WHERE survey_id = ?').get(survey.id);
  assert.equal(stored.completed_at, '2026-03-14 09:20:15', 'the clock time survives too');
});

test('a date arrives however the spreadsheet wrote it', () => {
  assert.equal(responseImport.toISODate('2026-03-14'), '2026-03-14');
  assert.equal(responseImport.toISODate('14/03/2026'), '2026-03-14', 'day first, as a Nigerian sheet means it');
  assert.equal(responseImport.toISODate('45730'), '2025-03-14', 'a date-formatted Excel cell');
  assert.equal(responseImport.toISODate('not a date'), null);
});

test('a heading is matched by wording, by position or by slot id', async () => {
  const survey = await made();
  const stored = h.db.prepare('SELECT * FROM surveys WHERE id = ?').get(survey.id);
  const headings = responseImport.index(responseImport.columns(stored));

  const read = heading => responseImport.readRow(headings, { [heading]: '4' }).answers;

  assert.deepEqual(read('How clear are the docs?'), { [survey.questions[0].id]: '4' });
  assert.deepEqual(read('q1'), { [survey.questions[0].id]: '4' });
  assert.deepEqual(read(survey.questions[0].id), { [survey.questions[0].id]: '4' });
  assert.deepEqual(read('q1. How clear are the docs?'), { [survey.questions[0].id]: '4' });
});

test('two questions worded the same are told apart by position, never guessed at', async () => {
  const survey = await made({
    questions: [
      { type: 'text', text: 'Any other feedback?' },
      { type: 'section', text: 'Billing' },
      { type: 'text', text: 'Any other feedback?' }
    ]
  });
  const stored = h.db.prepare('SELECT * FROM surveys WHERE id = ?').get(survey.id);
  const headings = responseImport.index(responseImport.columns(stored));

  const first = survey.questions[0].id;
  const second = survey.questions[2].id;

  // The wording alone cannot say which, so it addresses neither
  assert.deepEqual(responseImport.readRow(headings, { 'Any other feedback?': 'Yes' }).answers, {});

  assert.deepEqual(responseImport.readRow(headings, { 'q1. Any other feedback?': 'One' }).answers,
    { [first]: 'One' });
  assert.deepEqual(responseImport.readRow(headings, { 'q2. Any other feedback?': 'Two' }).answers,
    { [second]: 'Two' });
});

test('a grid arrives either as a column per row or as one packed cell', async () => {
  const survey = await made({
    questions: [{ type: 'matrix', text: 'Rate these', rows: ['Docs', 'Errors'], columns: ['Clear', 'Confusing'] }]
  });
  const stored = h.db.prepare('SELECT * FROM surveys WHERE id = ?').get(survey.id);
  const headings = responseImport.index(responseImport.columns(stored));
  const id = survey.questions[0].id;

  assert.deepEqual(
    responseImport.readRow(headings, { 'Rate these [Docs]': 'Clear', 'Rate these [Errors]': 'Confusing' }).answers,
    { [id]: { Docs: 'Clear', Errors: 'Confusing' } }
  );

  assert.deepEqual(
    responseImport.readRow(headings, { 'q1. Rate these': 'Docs: Clear; Errors: Confusing' }).answers,
    { [id]: { Docs: 'Clear', Errors: 'Confusing' } }
  );
});

// ─── Who may do any of it ───────────────────────────────────

test('reading a survey is not enough to write answers into it', async () => {
  const survey = await made();

  const readerRole = h.makeRole('Reader', ['surveys.read']);
  const reader = h.makeAdmin({ email: 'reader@creditdirect.ng', roleId: readerRole });
  const readerToken = await h.loginAdmin(reader.email, reader.password);

  const imported = await h.post(`/api/admin/surveys/${survey.id}/responses/import`,
    { csv: 'q1. How clear are the docs?\n4' }, { token: readerToken });
  assert.equal(imported.status, 403);

  const duplicated = await h.post(`/api/admin/surveys/${survey.id}/duplicate`, {}, { token: readerToken });
  assert.equal(duplicated.status, 403);

  // But the template is part of reading a survey
  const spec = await h.get(`/api/admin/surveys/${survey.id}/responses/columns`, { token: readerToken });
  assert.equal(spec.status, 200);
});
