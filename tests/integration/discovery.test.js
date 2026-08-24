const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const questions = require('../../src/services/questions');
const views = require('../../src/services/feedbackViews');

before(h.start);
after(h.stop);

let token;
let apiKey;

beforeEach(async () => {
  h.reset();
  h.makeRootCircle();
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: role });
  token = await h.loginAdmin(admin.email, admin.password);
  apiKey = h.makeApiKey(['*']);
});

async function makeSurvey(title, questionList) {
  const id = h.uuid();
  const withIds = await questions.attachToSurvey(questionList);
  const circleId = h.db.prepare('SELECT id FROM circles ORDER BY created_at LIMIT 1').get().id;
  h.db.prepare(`
    INSERT INTO surveys (id, title, questions, status, target_type, circle_id)
    VALUES (?, ?, ?, 'active', 'all', ?)
  `).run(id, title, JSON.stringify(withIds), circleId);
  return { id, title, circle_id: circleId, questions: withIds };
}

async function answer(user, survey, answers) {
  const verbatims = require('../../src/services/verbatims');
  return await verbatims.record(user.id, survey, answers);
}

// ─── Questions outlive the survey that carried them ─────────

test('a survey asks several questions, so a survey is not a question', async () => {
  const user = h.makeUser();
  const survey = await makeSurvey('Onboarding', [
    { type: 'rating', text: 'How easy was it?' },
    { type: 'text', text: 'What could we improve?' },
    { type: 'text', text: 'What nearly stopped you?' }
  ]);

  await answer(user, survey, {
    [survey.questions[1].id]: 'The docs assume Node.',
    [survey.questions[2].id]: 'KYB took a week.'
  });

  const bySurvey = await views.group('survey');
  const byQuestion = await views.group('question');

  assert.equal(bySurvey.length, 1, 'one survey');
  assert.equal(byQuestion.length, 2, 'two questions inside it');
  assert.equal(bySurvey[0].answer_count, 2);
});

test('reusing a question gathers answers from both surveys under one heading', async () => {
  const first = h.makeUser();
  const second = h.makeUser();

  const q1 = await makeSurvey('Q1 round', [{ type: 'text', text: 'What could we improve?' }]);
  const canonical = q1.questions[0].question_id;

  // The author chose to carry the question on
  const q2 = await makeSurvey('Q2 round', [
    { type: 'text', text: 'What could we improve?', question_id: canonical }
  ]);

  await answer(first, q1, { [q1.questions[0].id]: 'Said in the first round.' });
  await answer(second, q2, { [q2.questions[0].id]: 'Said in the second.' });

  const grouped = await views.group('question');
  assert.equal(grouped.length, 1, 'one question, two occasions');
  assert.equal(grouped[0].developer_count, 2);

  assert.equal((await questions.askedIn(canonical)).length, 2);
});

test('the same words in two surveys stay separate unless someone says otherwise', async () => {
  const a = await makeSurvey('Onboarding round', [{ type: 'text', text: 'Any other feedback?' }]);
  const b = await makeSurvey('Billing round', [{ type: 'text', text: 'Any other feedback?' }]);

  // Two initiatives can ask this about entirely different things. Merging is
  // unrecoverable; leaving them apart can be joined later.
  assert.notEqual(a.questions[0].question_id, b.questions[0].question_id);
});

test('a repeat is offered, never applied', async () => {
  await makeSurvey('First', [{ type: 'text', text: 'What could we improve?' }]);

  const res = await h.post('/api/admin/questions/suggest',
    { text: 'what could we improve', type: 'text' }, { token });

  assert.equal(res.status, 200);
  assert.equal(res.body.matches.length, 1, 'punctuation and case do not make it a different question');
  assert.match(res.body.matches[0].text, /What could we improve/);
});

// ─── Surveys run somewhere else ─────────────────────────────

test('answers from a form run elsewhere land against the developer', async () => {
  const user = h.makeUser({ email: 'ada@zilla.ng' });

  const res = await h.post('/api/integrations/survey-responses', {
    source_system: 'google_forms',
    external_survey_id: 'form_q3',
    survey_name: 'Q3 Developer Experience',
    response_id: 'resp_1',
    respondent: { email: 'ada@zilla.ng' },
    answers: [
      { question: 'Biggest friction going live?', answer: 'KYB with no visibility.' },
      { question: 'Rate the docs', answer: 4 }
    ]
  }, { apiKey });

  assert.equal(res.status, 201);
  assert.equal(res.body.filed.length, 1);
  // A rating from Google Forms is a measurement, same as one collected here
  assert.equal(res.body.skipped[0].reason, 'Not a written answer');

  const filed = h.db.prepare("SELECT * FROM feedback WHERE source = 'external_survey'").get();
  assert.equal(filed.user_id, user.id);
  assert.equal(filed.source_system, 'google_forms');
  assert.ok(filed.canonical_question_id);
});

test('re-delivering the same submission does not duplicate it', async () => {
  h.makeUser({ email: 'ada@zilla.ng' });
  const payload = {
    source_system: 'google_forms', external_survey_id: 'form_q3', response_id: 'resp_1',
    respondent: { email: 'ada@zilla.ng' },
    answers: [{ question: 'Biggest friction?', answer: 'KYB.' }]
  };

  await h.post('/api/integrations/survey-responses', payload, { apiKey });
  const second = await h.post('/api/integrations/survey-responses', payload, { apiKey });

  assert.equal(second.body.filed.length, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM feedback').get().c, 1);
});

test('an unknown respondent is queued rather than dropped', async () => {
  const res = await h.post('/api/integrations/survey-responses', {
    source_system: 'microsoft_forms',
    respondent: { email: 'stranger@nowhere.ng' },
    answers: [{ question: 'Thoughts?', answer: 'Worth keeping.' }]
  }, { apiKey });

  assert.equal(res.status, 404);
  assert.equal(res.body.queued, true);
  // Someone took the time to write it; it waits for the developer to exist
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM integration_events WHERE processed = 0").get().c, 1);
});

test('two different forms asking the same words stay separate', async () => {
  h.makeUser({ email: 'ada@zilla.ng' });

  for (const form of ['form_a', 'form_b']) {
    await h.post('/api/integrations/survey-responses', {
      source_system: 'google_forms', external_survey_id: form, response_id: `r_${form}`,
      respondent: { email: 'ada@zilla.ng' },
      answers: [{ question: 'Any other feedback?', answer: `From ${form}.` }]
    }, { apiKey });
  }

  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM questions').get().c, 2);
});

// ─── Ways of looking ────────────────────────────────────────

test('every axis groups without error and counts developers, not messages', async () => {
  const loud = h.makeUser({ work_sector: 'Fintech', company: 'Zilla' });
  const quiet = h.makeUser({ work_sector: 'Banking', company: 'Wema' });
  const survey = await makeSurvey('Round', [
    { type: 'text', text: 'One?' }, { type: 'text', text: 'Two?' }, { type: 'text', text: 'Three?' }
  ]);

  // One developer says three things; another says one
  await answer(loud, survey, Object.fromEntries(survey.questions.map((q, i) => [q.id, `Loud ${i}`])));
  await answer(quiet, survey, { [survey.questions[0].id]: 'Quiet one' });

  const res = await h.get('/api/admin/feedback/axes', { token });
  assert.ok(res.body.axes.length >= 10);

  for (const axis of res.body.axes) {
    const grouped = await h.get(`/api/admin/feedback/grouped?group_by=${axis.key}`, { token });
    assert.equal(grouped.status, 200, `${axis.key} failed`);
    for (const g of grouped.body.groups) {
      assert.ok(g.developer_count <= g.answer_count, `${axis.key}: developers cannot exceed answers`);
    }
  }

  const byQuestion = await h.get('/api/admin/feedback/grouped?group_by=question', { token });
  const first = byQuestion.body.groups.find(g => g.label === 'One?');
  assert.equal(first.developer_count, 2);
  assert.equal(first.answer_count, 2);
});

test('grouping and filtering compose', async () => {
  const fintech = h.makeUser({ work_sector: 'Fintech' });
  const banking = h.makeUser({ work_sector: 'Banking' });
  const survey = await makeSurvey('Round', [{ type: 'text', text: 'What could we improve?' }]);

  await answer(fintech, survey, { [survey.questions[0].id]: 'From fintech.' });
  await answer(banking, survey, { [survey.questions[0].id]: 'From banking.' });

  const res = await h.get('/api/admin/feedback/grouped?group_by=question&work_sector=Fintech', { token });
  assert.equal(res.body.groups[0].developer_count, 1);
  assert.equal(res.body.totals.developers, 1);
});

test('an unknown grouping is refused with the list of real ones', async () => {
  const res = await h.get('/api/admin/feedback/grouped?group_by=colour', { token });
  assert.equal(res.status, 400);
  assert.ok(res.body.available.includes('question'));
});

test('drilling into a group returns exactly that group', async () => {
  const user = h.makeUser();
  const survey = await makeSurvey('Round', [{ type: 'text', text: 'A?' }, { type: 'text', text: 'B?' }]);
  await answer(user, survey, { [survey.questions[0].id]: 'Answer A', [survey.questions[1].id]: 'Answer B' });

  const grouped = await h.get('/api/admin/feedback/grouped?group_by=question', { token });
  const groupA = grouped.body.groups.find(g => g.label === 'A?');

  const items = await h.get(`/api/admin/feedback/items?question_id=${groupA.key}`, { token });
  assert.equal(items.body.items.length, 1);
  assert.equal(items.body.items[0].content, 'Answer A');
});

// ─── Export ─────────────────────────────────────────────────

test('the export contains what the screen is showing', async () => {
  const user = h.makeUser({ work_sector: 'Fintech' });
  h.makeUser({ work_sector: 'Banking' });
  const survey = await makeSurvey('Round', [{ type: 'text', text: 'What could we improve?' }]);
  await answer(user, survey, { [survey.questions[0].id]: 'Only this one should appear.' });

  const onScreen = await h.get('/api/admin/feedback/items?work_sector=Fintech', { token });
  const counted = await h.get('/api/admin/feedback/export/count?work_sector=Fintech', { token });

  const res = await fetch(`${h.baseUrl()}/api/admin/feedback/export?format=csv&work_sector=Fintech`,
    { headers: { Authorization: `Bearer ${token}` } });
  const { parseCSV } = require('../../src/utils/helpers');
  const rows = parseCSV((await res.text()).replace(/^﻿/, ''));

  assert.equal(rows.length, onScreen.body.items.length);
  assert.equal(rows.length, counted.body.total);
  assert.equal(rows[0].answer, 'Only this one should appear.');
});

test('a grouped export puts each group on its own sheet behind a contents tab', async () => {
  const user = h.makeUser();
  const survey = await makeSurvey('Round', [{ type: 'text', text: 'A?' }, { type: 'text', text: 'B?' }]);
  await answer(user, survey, { [survey.questions[0].id]: 'Answer A', [survey.questions[1].id]: 'Answer B' });

  const res = await fetch(`${h.baseUrl()}/api/admin/feedback/export?format=xlsx&group_by=question`,
    { headers: { Authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());

  // Sheet names live in the workbook part
  const zlib = require('zlib');
  const text = buf.toString('latin1');
  assert.ok(text.includes('xl/worksheets/sheet3.xml'), 'contents tab plus one sheet per question');
  assert.match(res.headers.get('content-disposition'), /by-question\.xlsx/);
});

test('exporting feedback needs export.read', async () => {
  const role = h.makeRole('Reader', ['feedback.read']);
  const reader = h.makeAdmin({ email: 'reader@creditdirect.ng', roleId: role });
  const readerToken = await h.loginAdmin(reader.email, reader.password);

  assert.equal((await h.get('/api/admin/feedback/export', { token: readerToken })).status, 403);
  // Reading on screen is a different permission from taking it away
  assert.equal((await h.get('/api/admin/feedback/grouped', { token: readerToken })).status, 200);
});

// ─── One developer, whole ───────────────────────────────────

test('the timeline merges what a developer did, said and was sent', async () => {
  const user = h.makeUser({ email: 'ada@zilla.ng', password: 'dev-password' });
  const survey = await makeSurvey('Round', [{ type: 'text', text: 'What could we improve?' }]);

  const engagement = require('../../src/services/engagement');
  await engagement.log(user.id, 'account_created');
  await engagement.log(user.id, 'first_production_call');
  await answer(user, survey, { [survey.questions[0].id]: 'Something they wrote.' });

  const res = await h.get(`/api/admin/members/${user.id}/timeline`, { token });

  assert.equal(res.status, 200);
  assert.equal(res.body.counts.said, 1);
  assert.equal(res.body.counts.did, 2);
  assert.equal(res.body.counts.questions_answered, 1);

  const kinds = [...new Set(res.body.timeline.map(e => e.kind))];
  assert.ok(kinds.includes('said') && kinds.includes('did'));

  // Newest first, so the stream reads as a history
  const times = res.body.timeline.map(e => e.at);
  assert.deepEqual(times, [...times].sort().reverse());
});

test('the timeline gathers every source into one stream', async () => {
  const user = h.makeUser({ email: 'ada@zilla.ng' });
  const survey = await makeSurvey('Round', [{ type: 'text', text: 'What could we improve?' }]);

  await answer(user, survey, { [survey.questions[0].id]: 'Said in a survey.' });
  h.db.prepare(`
    INSERT INTO feedback (id, user_id, type, content, source, external_ticket_id)
    VALUES (?, ?, 'feex_complaint', 'Raised in Feex.', 'feex', 'FEEX-1')
  `).run(h.uuid(), user.id);
  await h.post('/api/integrations/survey-responses', {
    source_system: 'google_forms', response_id: 'r1',
    respondent: { email: 'ada@zilla.ng' },
    answers: [{ question: 'Anything else?', answer: 'Said in a Google Form.' }]
  }, { apiKey });

  const res = await h.get(`/api/admin/members/${user.id}/timeline`, { token });
  const sources = res.body.timeline.filter(e => e.kind === 'said').map(e => e.source);

  assert.deepEqual([...new Set(sources)].sort(), ['external_survey', 'feex', 'survey']);
});

// ─── Notifications go somewhere ─────────────────────────────

test('a notification about a session opens that session', async () => {
  const user = h.makeUser();
  await require('../../src/services/circles').join(user.id);

  const when = new Date(Date.now() + 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const session = await h.post('/api/admin/sessions', {
    title: 'Office hours', scheduled_for: when, target_type: 'all', channels: ['in_portal']
  }, { token });

  await h.post(`/api/admin/sessions/${session.body.session.id}/announce`, {}, { token });

  const note = h.db.prepare('SELECT action_url FROM notifications WHERE user_id = ?').get(user.id);
  // Pointing back at the inbox it was read in would be a round trip to nowhere
  assert.match(note.action_url, /^\/member\/sessions\.html\?id=/);
});

test('a survey invitation opens that survey', async () => {
  const user = h.makeUser();
  await require('../../src/services/circles').join(user.id);

  const survey = await h.post('/api/admin/surveys', {
    title: 'Docs', questions: [{ type: 'text', text: 'Thoughts?' }], engagement_mode: 'in_portal'
  }, { token });
  await h.put(`/api/admin/surveys/${survey.body.survey.id}`, { status: 'active' }, { token });
  await h.post(`/api/admin/surveys/${survey.body.survey.id}/invite`, {}, { token });

  const note = h.db.prepare('SELECT action_url FROM notifications WHERE user_id = ?').get(user.id);
  assert.equal(note.action_url, `/member/survey.html?id=${survey.body.survey.id}`);
});

test('every destination a notification carries is a page that exists', async () => {
  const user = h.makeUser();
  await require('../../src/services/circles').join(user.id);

  const survey = await h.post('/api/admin/surveys', {
    title: 'Docs', questions: [{ type: 'text', text: 'Thoughts?' }], engagement_mode: 'in_portal'
  }, { token });
  await h.put(`/api/admin/surveys/${survey.body.survey.id}`, { status: 'active' }, { token });
  await h.post(`/api/admin/surveys/${survey.body.survey.id}/invite`, {}, { token });

  const urls = h.db.prepare('SELECT DISTINCT action_url FROM notifications WHERE action_url IS NOT NULL')
    .all().map(r => r.action_url);

  assert.ok(urls.length);
  for (const url of urls) {
    const res = await fetch(h.baseUrl() + url.split('?')[0]);
    assert.equal(res.status, 200, `${url} does not resolve`);
  }
});

test('a broadcast carries no destination, since the inbox is already the place', async () => {
  const user = h.makeUser();
  await require('../../src/services/circles').join(user.id);

  const blast = await h.post('/api/admin/blasts', {
    subject: 'Notice', content: 'Something for everyone.', channel: 'in_portal', target_type: 'all'
  }, { token });
  await h.post(`/api/admin/blasts/${blast.body.blast.id}/send`, {}, { token });

  const note = h.db.prepare('SELECT action_url FROM notifications WHERE user_id = ?').get(user.id);
  assert.equal(note.action_url, null);
});
