const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

before(h.start);
after(h.stop);

let adminToken;
let circleId;

beforeEach(async () => {
  h.reset();
  circleId = h.makeCircle();
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: role });
  adminToken = await h.loginAdmin(admin.email, admin.password);
});

const create = (body, token = adminToken) =>
  h.post('/api/admin/surveys', { title: 'Discovery', ...body }, { token });

async function answering(survey) {
  const user = h.makeUser();
  const token = await h.loginUser(user.email);
  const started = await h.post(`/api/users/surveys/${survey.id}/start`, {}, { token });
  return { user, token, survey: started.body.survey, answers: started.body.answers };
}

const respond = (survey, token, answers) =>
  h.post(`/api/users/surveys/${survey.id}/respond`, { answers }, { token });

// ─── Writing a survey ───────────────────────────────────────

test('a survey that cannot be answered is refused, with a reason per question', async () => {
  const res = await create({
    questions: [
      { type: 'rating', text: 'How clear are the docs?' },
      { type: 'choice', text: 'Which environment?', options: ['Sandbox'] },
      { type: 'number', text: 'How many calls?', min: 100, max: 1 }
    ]
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.issues.length, 2);
  assert.deepEqual(res.body.issues.map(i => i.number), [2, 3]);
  assert.match(res.body.error, /Question 2/);
});

test('every question type survives the round trip with its settings', async () => {
  const res = await create({
    questions: [
      { type: 'nps', text: 'Would you recommend us?' },
      { type: 'matrix', text: 'Rate each', rows: ['Docs', 'Sandbox'], columns: ['Poor', 'Fine', 'Great'] },
      { type: 'ranking', text: 'In order', options: ['Speed', 'Price', 'Support'] },
      { type: 'number', text: 'Calls a day?', min: 0, max: 100000, integer: true, unit: 'calls' },
      { type: 'date', text: 'When did you go live?' },
      { type: 'boolean', text: 'In production?', true_label: 'Yes, live' },
      { type: 'dropdown', text: 'Where?', options: ['Lagos', 'Abuja'] },
      { type: 'section', text: 'Nearly done' },
      { type: 'text', text: 'Best email?', format: 'email' }
    ]
  });

  assert.equal(res.status, 201);
  const stored = res.body.survey.questions;
  assert.deepEqual(stored.map(q => q.type), [
    'nps', 'matrix', 'ranking', 'number', 'date', 'boolean', 'dropdown', 'section', 'text'
  ]);
  assert.equal(stored[0].scale, 10);
  assert.equal(stored[3].unit, 'calls');
  assert.equal(stored[8].format, 'email');
  assert.ok(stored.every(q => q.id), 'every question gets a stable id');
});

test('a section is not filed as a question anyone has been asked', async () => {
  await create({
    questions: [
      { type: 'section', text: 'About your integration' },
      { type: 'text', text: 'How did it go?' }
    ]
  });

  const asked = h.db.prepare('SELECT text FROM questions').all().map(q => q.text);
  assert.deepEqual(asked, ['How did it go?']);
});

test('publishing on creation actually publishes', async () => {
  // The status arrived, was dropped, and every survey was written as a draft
  const res = await create({
    status: 'active',
    questions: [{ type: 'text', text: 'How is it going?' }]
  });
  assert.equal(res.body.survey.status, 'active');
});

test('a draft may be empty, but an empty survey cannot go out', async () => {
  const draft = await create({ questions: [] });
  assert.equal(draft.status, 201);

  const published = await h.put(`/api/admin/surveys/${draft.body.survey.id}`,
    { status: 'active' }, { token: adminToken });
  assert.equal(published.status, 400);
  assert.match(published.body.error, /at least one question/i);
});

test('a branch pointing at a later question is refused', async () => {
  const res = await create({
    questions: [
      {
        id: 'q1', type: 'text', text: 'Why?',
        visible_if: { match: 'all', rules: [{ question: 'q2', op: 'is', value: 'Sandbox' }] }
      },
      { id: 'q2', type: 'choice', text: 'Which environment?', options: ['Sandbox', 'Production'] }
    ]
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /asked earlier/i);
});

// ─── Answering ──────────────────────────────────────────────

const BRANCHING = [
  { id: 'q1', type: 'nps', text: 'Would you recommend our APIs?', required: true },
  {
    id: 'q2', type: 'multi_choice', text: 'What went wrong?',
    options: ['Docs', 'Errors', 'Latency'], required: true, min_select: 1, max_select: 2,
    visible_if: { match: 'all', rules: [{ question: 'q1', op: 'lte', value: 6 }] }
  },
  { id: 'q3', type: 'text', text: 'Anything else?' }
];

async function published(questions = BRANCHING) {
  const res = await create({ questions, status: 'active' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.survey;
}

test('a required answer that was not given is refused', async () => {
  const survey = await published();
  const { token } = await answering(survey);

  const res = await respond(survey, token, { q3: 'Nothing to add' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.missing, [survey.questions[0].id]);
});

test('a required question inside a branch nobody took does not block them', async () => {
  const survey = await published();
  const { token } = await answering(survey);
  const [nps] = survey.questions;

  const res = await respond(survey, token, { [nps.id]: 10 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.answered, 2, 'the promoter was asked two questions, not three');
});

test('a required question inside the branch they did take blocks them', async () => {
  const survey = await published();
  const { token } = await answering(survey);
  const [nps] = survey.questions;

  const res = await respond(survey, token, { [nps.id]: 3 });
  assert.equal(res.status, 400);
  assert.equal(res.body.missing.length, 1);
});

test('an answer to a branch they backed out of is discarded, not stored', async () => {
  const survey = await published();
  const { token, user } = await answering(survey);
  const [nps, blockers] = survey.questions;

  const res = await respond(survey, token, { [nps.id]: 9, [blockers.id]: ['Docs'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.discarded, 1);

  const stored = JSON.parse(h.db.prepare(
    'SELECT answers FROM survey_responses WHERE user_id = ?'
  ).get(user.id).answers);
  assert.equal(stored[blockers.id], undefined, 'a retracted answer must not be recorded');
});

test('an answer the question does not accept is refused, whatever the client sent', async () => {
  const survey = await published([
    { type: 'rating', text: 'How clear are the docs?', scale: 5 },
    { type: 'choice', text: 'Which environment?', options: ['Sandbox', 'Production'] },
    { type: 'multi_choice', text: 'Which products?', options: ['Lending', 'Payments'], max_select: 1 }
  ]);
  const { token } = await answering(survey);
  const [rating, choice, multi] = survey.questions;

  const res = await respond(survey, token, {
    [rating.id]: 9,
    [choice.id]: 'Staging',
    [multi.id]: ['Lending', 'Payments']
  });

  assert.equal(res.status, 400);
  assert.equal(Object.keys(res.body.errors).length, 3);
  assert.match(res.body.errors[rating.id], /1 to 5/);
  assert.match(res.body.errors[choice.id], /Pick one of the options/);
  assert.match(res.body.errors[multi.id], /at most 1/);
});

test('answers are stored in the shape the question describes, not as sent', async () => {
  const survey = await published([
    { type: 'rating', text: 'How clear?', scale: 5 },
    { type: 'choice', text: 'Which?', options: ['Sandbox', 'Production'] }
  ]);
  const { token, user } = await answering(survey);
  const [rating, choice] = survey.questions;

  // A form field sends "4", and a member types the option in lower case
  await respond(survey, token, { [rating.id]: '4', [choice.id]: 'sandbox' });

  const stored = JSON.parse(h.db.prepare(
    'SELECT answers FROM survey_responses WHERE user_id = ?'
  ).get(user.id).answers);
  assert.strictEqual(stored[rating.id], 4, 'stored as a number, so it can be averaged');
  assert.strictEqual(stored[choice.id], 'Sandbox', 'stored as the option, so it can be tallied');
});

test('an answer to a question the survey does not contain is rejected outright', async () => {
  const survey = await published();
  const { token } = await answering(survey);

  const res = await respond(survey, token, { [survey.questions[0].id]: 9, q_made_up: 'x' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.questions, ['q_made_up']);
});

// ─── Ending early ───────────────────────────────────────────
// The use case that called for this: a consent question that carries the
// terms as a link and ends the survey, in its own words, when the answer is
// no.
const CONSENT = [
  {
    id: 'q1', type: 'boolean', text: 'Do you agree to the [Terms & Conditions](https://example.com/terms)?',
    required: true, true_label: 'Yes, I agree', false_label: 'No',
    branch_to: {
      rules: [{
        op: 'is', value: false, end: true,
        message: 'We can\'t continue without your agreement with the Terms & Conditions.'
      }]
    }
  },
  { id: 'q2', type: 'text', text: 'Tell us about your integration.', required: true }
];

test('a link in the wording is stored as written, and one that is not a web address is refused', async () => {
  const ok = await create({ questions: CONSENT });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.match(ok.body.survey.questions[0].text, /\[Terms & Conditions\]\(https:\/\/example\.com\/terms\)/);

  const bad = await create({
    questions: [{ type: 'boolean', text: 'Agree to the [Terms](javascript:alert(1))?' }]
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /http/i);
});

test('a no to the consent question ends the survey there, in its own words', async () => {
  const res = await create({ questions: CONSENT, status: 'active' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const survey = res.body.survey;
  const { token, user } = await answering(survey);
  const [consent] = survey.questions;

  const done = await respond(survey, token, { [consent.id]: false });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.answered, 1, 'the rest of the survey was never asked');
  assert.equal(done.body.ended, true);
  assert.equal(done.body.end_message, 'We can\'t continue without your agreement with the Terms & Conditions.');

  const stored = JSON.parse(h.db.prepare(
    'SELECT answers FROM survey_responses WHERE user_id = ?'
  ).get(user.id).answers);
  assert.deepEqual(stored, { [consent.id]: false }, 'only what was asked is recorded');
});

test('a yes to the consent question still asks the rest, and the rest still has to be answered', async () => {
  const res = await create({ questions: CONSENT, status: 'active' });
  const survey = res.body.survey;
  const { token } = await answering(survey);
  const [consent, followup] = survey.questions;

  const refused = await respond(survey, token, { [consent.id]: true });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body.missing, [followup.id], 'the branch they took still has to be answered');

  const done = await respond(survey, token, { [consent.id]: true, [followup.id]: 'Sandbox to production' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.ended, false, 'the survey ran to its end');
  assert.equal(done.body.end_message, null);
});

test('an option can carry a line under it — text, a link, a picture — and the answer stays the word', async () => {
  const res = await create({
    status: 'active',
    theme: { layout: 'n_per_page', page_size: 2 },
    questions: [
      {
        id: 'q1', type: 'choice', required: true,
        text: 'Which environment do you use most?',
        options: [
          { label: 'Sandbox', subtext: 'Staging for tests — see [the docs](https://example.com/sandbox)' },
          { label: 'Production', subtext: 'Live traffic · ![the flow](https://example.com/flow.png)' },
          { label: 'Both', subtext: 'Pick one · ![the diagram](/uploads/the-diagram-ab12cd34ef56.png)' }
        ]
      },
      { id: 'q2', type: 'text', text: 'Anything else?', required: false }
    ]
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const survey = res.body.survey;
  const { token } = await answering(survey);

  const served = (await h.post(`/api/users/surveys/${survey.id}/start`, {}, { token })).body.survey
    .questions.find(q => q.id === 'q1');
  assert.equal(served.options[1].subtext, 'Live traffic · ![the flow](https://example.com/flow.png)',
    'the subtext goes out as it was written');
  assert.equal(served.options[2].subtext, 'Pick one · ![the diagram](/uploads/the-diagram-ab12cd34ef56.png)',
    'a picture uploaded from the device goes out the same way');

  // and an address that is neither a web address nor one of the platform's
  // uploads is refused at save, with the option named
  const notOurs = await create({
    status: 'draft',
    questions: [{
      id: 'q1', type: 'choice', text: 'Pick',
      options: [
        { label: 'A', subtext: '![x](/etc/passwd)' },
        { label: 'B' }
      ]
    }]
  });
  assert.equal(notOurs.status, 400, JSON.stringify(notOurs.body));
  assert.match(notOurs.body.error, /Option "A"/);

  const done = await respond(survey, token, { q1: 'Production' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.answered, 2);
});

test('"N per page" without its N is refused — the number is set by the person writing the questions', async () => {
  const res = await create({
    status: 'active',
    theme: { layout: 'n_per_page' },
    questions: [{ type: 'text', text: 'One question?' }]
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /needs N/i);
});

test('a branch can jump the survey to a later question, and the skipped ones are not asked', async () => {
  const res = await create({
    status: 'active',
    questions: [
      {
        id: 'q1', type: 'choice', text: 'What are you building?', options: ['Public API', 'Internal tool'],
        required: true,
        branch_to: { rules: [{ op: 'is', value: 'Internal tool', goto: 'q4' }] }
      },
      { id: 'q2', type: 'text', text: 'Which endpoint first?', required: true },
      { id: 'q3', type: 'text', text: 'Sandbox or production?', required: true },
      { id: 'q4', type: 'text', text: 'What breaks in your setup first?', required: true }
    ]
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const survey = res.body.survey;
  const { token } = await answering(survey);

  // The jump lands on q4, so q2 and q3 were never asked and do not block
  const done = await respond(survey, token, { q1: 'Internal tool', q4: 'The CI step' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.answered, 2, 'only the questions the jump left behind were asked');
  assert.equal(done.body.ended, false);

  const open = await create({
    status: 'active',
    questions: [
      {
        id: 'p1', type: 'choice', text: 'What are you building?', options: ['Public API', 'Internal tool'],
        required: true,
        branch_to: { rules: [{ op: 'is', value: 'Internal tool', goto: 'p4' }] }
      },
      { id: 'p2', type: 'text', text: 'Which endpoint first?', required: true },
      { id: 'p3', type: 'text', text: 'Sandbox or production?', required: true },
      { id: 'p4', type: 'text', text: 'What breaks in your setup first?', required: true }
    ]
  });
  const survey2 = open.body.survey;
  const { token: token2 } = await answering(survey2);

  // The jump can be declined by answering the other way — then the skipped
  // questions are asked again, and they are required
  const refused = await respond(survey2, token2, { p1: 'Public API', p4: 'x' });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body.missing, ['p2', 'p3']);
});

test('a jump that points past the end of the survey is refused at save time', async () => {
  const res = await create({
    status: 'active',
    questions: [
      { id: 'q1', type: 'boolean', text: 'Branch?', branch_to: { rules: [{ op: 'is', value: true, goto: 'no_such_question' }] } }
    ]
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /later in the survey/i);
});

// ─── Coming back to it ──────────────────────────────────────

test('answers are kept between sittings', async () => {
  const survey = await published();
  const { token } = await answering(survey);
  const [nps] = survey.questions;

  const saved = await h.call('PATCH', `/api/users/surveys/${survey.id}/progress`,
    { token, body: { answers: { [nps.id]: 4 } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.saved, 1);

  // Starting again is picking up, not beginning again
  const again = await h.post(`/api/users/surveys/${survey.id}/start`, {}, { token });
  assert.deepEqual(again.body.answers, { [nps.id]: 4 });
});

test('progress holds a half-finished answer that submission would refuse', async () => {
  // Which is the point: validation belongs where the member says they are done
  const survey = await published([{ type: 'text', text: 'Best email?', format: 'email' }]);
  const { token } = await answering(survey);

  const saved = await h.call('PATCH', `/api/users/surveys/${survey.id}/progress`,
    { token, body: { answers: { [survey.questions[0].id]: 'ada@' } } });
  assert.equal(saved.status, 200);
});

test('progress has a ceiling, since it is the one place answers go unchecked', async () => {
  const survey = await published([{ type: 'text', text: 'Anything else?' }]);
  const { token } = await answering(survey);

  const saved = await h.call('PATCH', `/api/users/surveys/${survey.id}/progress`, {
    token,
    body: { answers: { [survey.questions[0].id]: 'x'.repeat(200000) } }
  });
  assert.equal(saved.status, 413);
});

test('progress cannot be saved against a survey already submitted', async () => {
  const survey = await published([{ type: 'text', text: 'Anything else?' }]);
  const { token } = await answering(survey);
  await respond(survey, token, { [survey.questions[0].id]: 'All good' });

  const saved = await h.call('PATCH', `/api/users/surveys/${survey.id}/progress`,
    { token, body: { answers: {} } });
  assert.equal(saved.status, 409);
});

// ─── Themes ─────────────────────────────────────────────────

test('a theme is stored, and only where it differs from the default', async () => {
  const res = await create({
    questions: [{ type: 'text', text: 'How is it going?' }],
    theme: { accent: '#E6B473', progress: 'bar', layout: 'all_at_once' }
  });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body.survey.theme, { accent: '#e6b473', layout: 'all_at_once' });
});

test('a theme that could carry script is refused before it is stored', async () => {
  const res = await create({
    questions: [{ type: 'text', text: 'How is it going?' }],
    theme: { accent: 'javascript:alert(1)' }
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /hex/i);
});

test('a survey inherits its circle\'s look, and overrides it where it has an opinion', async () => {
  await h.put(`/api/admin/circles/${circleId}`,
    { survey_theme: { accent: '#0D9488', logo_url: '/assets/partner.png' } }, { token: adminToken });

  const survey = await published([{ type: 'text', text: 'How is it going?' }]);
  await h.put(`/api/admin/surveys/${survey.id}`, { theme: { accent: '#E6B473' } }, { token: adminToken });

  // Resolved on the way out, so the member's page never has to know the order
  const { survey: asMemberSees } = await answering(survey);

  assert.equal(asMemberSees.theme.accent, '#e6b473', 'the survey wins where it has an opinion');
  assert.equal(asMemberSees.theme.logo_url, '/assets/partner.png', 'and inherits where it has none');
});

test('the look can still be changed after members have answered', async () => {
  const survey = await published([{ type: 'text', text: 'Anything else?' }]);
  const { token } = await answering(survey);
  await respond(survey, token, { [survey.questions[0].id]: 'All good' });

  const themed = await h.put(`/api/admin/surveys/${survey.id}`,
    { theme: { accent: '#8B7CF6' } }, { token: adminToken });
  assert.equal(themed.status, 200, 'it changes how the rest see it, not what anyone was asked');

  const rewritten = await h.put(`/api/admin/surveys/${survey.id}`,
    { questions: [{ type: 'text', text: 'Something else entirely?' }] }, { token: adminToken });
  assert.equal(rewritten.status, 409, 'but the questions are fixed');
});

// ─── Brand assets ───────────────────────────────────────────

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(32).fill(0)])
  .toString('base64');

test('a themed survey carries an uploaded file, not a link to one', async () => {
  const uploaded = await h.post('/api/admin/uploads', { file: PNG_BYTES, kind: 'image' }, { token: adminToken });
  assert.equal(uploaded.status, 201);
  assert.match(uploaded.body.asset.path, /^\/uploads\/[a-f0-9]{32}\.png$/);

  const res = await create({
    questions: [{ type: 'text', text: 'How is it going?' }],
    theme: { logo_url: uploaded.body.asset.path, background_color: '#0B3D2E', text_color: '#F5EFE0' }
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.survey.theme.logo_url, uploaded.body.asset.path);
});

test('a remote address is refused in favour of uploading', async () => {
  const res = await create({
    questions: [{ type: 'text', text: 'How is it going?' }],
    theme: { logo_url: 'https://cdn.example.ng/logo.png' }
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /upload/i);
});

test('an uploaded asset is served back with the type its bytes say', async () => {
  const uploaded = await h.post('/api/admin/uploads', { file: PNG_BYTES }, { token: adminToken });
  const served = await h.get(uploaded.body.asset.path, { raw: true });

  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
});

test('an asset is reachable without a session, since a public survey needs its logo', async () => {
  const uploaded = await h.post('/api/admin/uploads', { file: PNG_BYTES }, { token: adminToken });
  const served = await h.get(uploaded.body.asset.path, { raw: true });
  assert.equal(served.status, 200, 'no credential was sent');
});

test('uploading needs the permission that writing a survey needs', async () => {
  const role = h.makeRole('Reader', ['surveys.read']);
  const reader = h.makeAdmin({ email: 'reader@creditdirect.ng', roleId: role });
  const token = await h.loginAdmin(reader.email, reader.password);

  const res = await h.post('/api/admin/uploads', { file: PNG_BYTES }, { token });
  assert.equal(res.status, 403);
});

test('HTML dressed up as an image never becomes a file on this origin', async () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
  const res = await h.post('/api/admin/uploads', { file: html, kind: 'image' }, { token: adminToken });
  assert.equal(res.status, 400);
});

test('a survey can be set in a brand\'s own typeface', async () => {
  const font = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(48)]).toString('base64');
  const uploaded = await h.post('/api/admin/uploads', { file: font, kind: 'font' }, { token: adminToken });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.asset.mime, 'font/woff2');

  const res = await create({
    questions: [{ type: 'text', text: 'How is it going?' }],
    theme: { font: 'brand', brand_font: uploaded.body.asset.path, brand_font_name: 'Acme Grotesk' }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.survey.theme.brand_font_name, 'Acme Grotesk');
});

// ─── Results ────────────────────────────────────────────────

test('the export flattens every answer shape and leaves unasked questions empty', async () => {
  const survey = await published([
    { id: 'q1', type: 'nps', text: 'Would you recommend us?', required: true },
    {
      id: 'q2', type: 'ranking', text: 'In order', options: ['Speed', 'Price'],
      visible_if: { match: 'all', rules: [{ question: 'q1', op: 'lte', value: 6 }] }
    },
    { id: 'q3', type: 'matrix', text: 'Rate each', rows: ['Docs'], columns: ['Poor', 'Fine'] },
    { id: 'q4', type: 'section', text: 'Thanks' }
  ]);
  const [nps, ranking, grid] = survey.questions;

  const promoter = await answering(survey);
  await respond(survey, promoter.token, { [nps.id]: 10, [grid.id]: { Docs: 'Fine' } });

  const detractor = await answering(survey);
  await respond(survey, detractor.token, {
    [nps.id]: 2, [ranking.id]: ['Price', 'Speed'], [grid.id]: { Docs: 'Poor' }
  });

  const csv = await h.get(`/api/admin/surveys/${survey.id}/export`, { token: adminToken, raw: true });
  const lines = csv.text.split('\r\n');

  assert.ok(!lines[0].includes('Thanks'), 'a section holds no answer, so it holds no column');
  assert.ok(csv.text.includes('1. Price; 2. Speed'), 'a ranking reads as an order');
  assert.ok(csv.text.includes('Docs: Fine'), 'a grid reads row by row');

  const promoterRow = lines.find(line => line.includes('10/10'));
  assert.ok(promoterRow.includes(',,'), 'the question they were never shown is left empty');
});

test('responses say which questions each member was actually shown', async () => {
  const survey = await published();
  const { token } = await answering(survey);
  await respond(survey, token, { [survey.questions[0].id]: 10 });

  const res = await h.get(`/api/admin/surveys/${survey.id}/responses`, { token: adminToken });
  const completed = res.body.responses.find(r => r.completed_at);
  assert.equal(completed.asked.length, 2, 'without this, "1 of 3 answered" is a lie');
});

// ─── Answering over a link ──────────────────────────────────

async function openToAnyone(questions = [{ type: 'text', text: 'What stopped you?' }]) {
  const res = await create({ questions, status: 'active', target_type: 'anonymous' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.survey;
}

const link = (survey, path = '', body) =>
  body === undefined
    ? h.get(`/api/public/surveys/${survey.public_token}${path}`)
    : h.post(`/api/public/surveys/${survey.public_token}${path}`, body);

test('a link audience gets a link, and it takes no credential to open', async () => {
  const survey = await openToAnyone();
  assert.ok(survey.public_token, 'the link exists as soon as the survey does');
  assert.equal(survey.public_path, `/s/${survey.public_token}`);

  const opened = await link(survey);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.survey.title, 'Discovery');
});

test('the link shows a respondent nothing about how the survey is run', async () => {
  const survey = await openToAnyone();
  const { body } = await link(survey);

  for (const leak of ['target_type', 'target_ids', 'circle_id', 'created_by', 'public_token', 'status']) {
    assert.equal(body.survey[leak], undefined, `${leak} is nobody's business over a public link`);
  }
  assert.ok(body.survey.questions, 'what they do need is there');
});

test('someone with no account can answer, and it is recorded as anonymous', async () => {
  const survey = await openToAnyone([
    { id: 'q1', type: 'rating', text: 'How was it?', scale: 5, required: true },
    { id: 'q2', type: 'text', text: 'What stopped you?' }
  ]);

  const started = await link(survey, '/start', {});
  assert.equal(started.status, 200);
  assert.ok(started.body.response_key, 'the submission is owned by a key, not an account');

  const done = await link(survey, '/respond', {
    response_key: started.body.response_key,
    answers: { q1: 4, q2: 'The webhook docs stop halfway.' }
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  const stored = h.db.prepare('SELECT * FROM survey_responses WHERE survey_id = ?').get(survey.id);
  assert.equal(stored.user_id, null, 'no member is invented to hold it');
  assert.equal(stored.respondent_kind, 'anonymous');
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM users').get().c, 0, 'and no account is created');
});

test('a link survey can end early too, with the same words on the same ending', async () => {
  const survey = await openToAnyone(CONSENT);
  const started = await link(survey, '/start', {});
  assert.equal(started.status, 200);

  const done = await link(survey, '/respond', {
    response_key: started.body.response_key,
    answers: { q1: false }
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.ended, true);
  assert.equal(done.body.end_message, 'We can\'t continue without your agreement with the Terms & Conditions.');
});

test('what an anonymous respondent writes is still filed as evidence', async () => {
  const survey = await openToAnyone([{ id: 'q1', type: 'text', text: 'What stopped you?' }]);
  const started = await link(survey, '/start', {});
  await link(survey, '/respond', {
    response_key: started.body.response_key,
    answers: { q1: 'The sandbox returned 500s for an hour and nothing said why.' }
  });

  const filed = h.db.prepare("SELECT * FROM feedback WHERE source = 'survey'").all();
  assert.equal(filed.length, 1, 'dropping it would lose exactly the words this exists to collect');
  assert.equal(filed[0].user_id, null);
  assert.ok(filed[0].response_id, 'traceable to the submission that carried it');
});

test('the same checks apply as for a member', async () => {
  const survey = await openToAnyone([
    { id: 'q1', type: 'rating', text: 'How was it?', scale: 5, required: true },
    { id: 'q2', type: 'choice', text: 'Which?', options: ['A', 'B'] }
  ]);
  const started = await link(survey, '/start', {});
  const key = started.body.response_key;

  const missing = await link(survey, '/respond', { response_key: key, answers: { q2: 'A' } });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.missing, ['q1']);

  const bad = await link(survey, '/respond', { response_key: key, answers: { q1: 9, q2: 'C' } });
  assert.equal(bad.status, 400);
  assert.equal(Object.keys(bad.body.errors).length, 2);
});

test('one key holds one submission, and cannot be used twice', async () => {
  const survey = await openToAnyone([{ id: 'q1', type: 'text', text: 'Thoughts?' }]);
  const started = await link(survey, '/start', {});
  const key = started.body.response_key;

  await link(survey, '/respond', { response_key: key, answers: { q1: 'Once' } });
  const again = await link(survey, '/respond', { response_key: key, answers: { q1: 'Twice' } });
  assert.equal(again.status, 409);

  const reopened = await link(survey, '/start', { response_key: key });
  assert.equal(reopened.status, 409, 'and reopening it says so rather than starting a second');
});

test('a key resumes its own submission and reaches no other', async () => {
  const survey = await openToAnyone([{ id: 'q1', type: 'text', text: 'Thoughts?' }]);
  const first = (await link(survey, '/start', {})).body.response_key;
  const second = (await link(survey, '/start', {})).body.response_key;
  assert.notEqual(first, second, 'two people are two submissions');

  await h.call('PATCH', `/api/public/surveys/${survey.public_token}/progress`,
    { body: { response_key: first, answers: { q1: 'Half a thought' } } });

  const resumed = await link(survey, '/start', { response_key: first });
  assert.deepEqual(resumed.body.answers, { q1: 'Half a thought' });

  const other = await link(survey, '/start', { response_key: second });
  assert.deepEqual(other.body.answers, {}, 'one key cannot read another submission');
});

test('the key is never stored in a form that could be handed back out', async () => {
  const survey = await openToAnyone();
  const key = (await link(survey, '/start', {})).body.response_key;

  const row = h.db.prepare('SELECT * FROM survey_responses WHERE survey_id = ?').get(survey.id);
  assert.notEqual(row.anonymous_key_hash, key, 'stored hashed, like every other bearer secret');
  assert.ok(row.anonymous_key_hash.length === 64);
});

test('a closed, expired or invented link is refused the same way', async () => {
  const survey = await openToAnyone();

  const invented = await h.get('/api/public/surveys/not-a-real-token-at-all');
  assert.equal(invented.status, 404);

  await h.put(`/api/admin/surveys/${survey.id}`, { status: 'closed' }, { token: adminToken });
  const closed = await link(survey);
  assert.equal(closed.status, 404);
  assert.equal(closed.body.error, invented.body.error,
    'indistinguishable, so the endpoint cannot be used to find real tokens');
});

test('a members-only survey is not reachable over a link', async () => {
  const members = await published([{ type: 'text', text: 'Anything else?' }]);
  h.db.prepare('UPDATE surveys SET public_token = ? WHERE id = ?').run('borrowed-token-1234567890', members.id);

  const res = await h.get('/api/public/surveys/borrowed-token-1234567890');
  assert.equal(res.status, 404, 'the audience decides, not the presence of a token');
});

test('there is nobody to invite on a link survey, and it says so', async () => {
  const survey = await openToAnyone();
  const res = await h.post(`/api/admin/surveys/${survey.id}/invite`, {}, { token: adminToken });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /share the link/i);
});

test('anonymous answers appear in the results, named as such', async () => {
  const survey = await openToAnyone([{ id: 'q1', type: 'text', text: 'Thoughts?' }]);
  const started = await link(survey, '/start', {});
  await link(survey, '/respond', { response_key: started.body.response_key, answers: { q1: 'Plenty' } });

  const res = await h.get(`/api/admin/surveys/${survey.id}/responses`, { token: adminToken });
  const completed = res.body.responses.find(r => r.completed_at);
  assert.equal(completed.user_id, null);
  assert.equal(completed.respondent_kind, 'anonymous');

  const csv = await h.get(`/api/admin/surveys/${survey.id}/export`, { token: adminToken, raw: true });
  assert.ok(csv.text.includes('Anonymous'), 'an empty name column would read as a fault in the export');
});

test('switching an existing survey to a link audience mints one', async () => {
  const survey = await published([{ type: 'text', text: 'Anything else?' }]);
  assert.equal(survey.public_token, null);

  const switched = await h.put(`/api/admin/surveys/${survey.id}`,
    { target_type: 'anonymous' }, { token: adminToken });
  assert.equal(switched.status, 200);
  assert.ok(switched.body.survey.public_token);

  // Switching away leaves it alone: somebody may be holding it
  const back = await h.put(`/api/admin/surveys/${survey.id}`, { target_type: 'all' }, { token: adminToken });
  assert.equal(back.body.survey.public_token, switched.body.survey.public_token);
});

// ─── Free text ──────────────────────────────────────────────

test('what a member writes in "something else" is filed as feedback in their words', async () => {
  const survey = await published([
    {
      type: 'multi_choice', text: 'What blocked you?',
      options: ['Docs', 'Errors'], allow_other: true
    }
  ]);
  const { token, user } = await answering(survey);

  await respond(survey, token, {
    [survey.questions[0].id]: ['Docs', 'The webhook retry policy is undocumented']
  });

  const filed = h.db.prepare(
    "SELECT content FROM feedback WHERE user_id = ? AND source = 'survey'"
  ).all(user.id);
  assert.equal(filed.length, 1);
  assert.equal(filed[0].content, 'The webhook retry policy is undocumented');
});

test('an email answer is not filed as something the member told us', async () => {
  // It is a field, not a verbatim, and filing it would put contact details in
  // the middle of a page of quotes
  const survey = await published([{ type: 'text', text: 'Best address?', format: 'email' }]);
  const { token, user } = await answering(survey);

  await respond(survey, token, { [survey.questions[0].id]: 'ada@example.ng' });

  const filed = h.db.prepare("SELECT id FROM feedback WHERE user_id = ? AND source = 'survey'").all(user.id);
  assert.equal(filed.length, 0);
});
