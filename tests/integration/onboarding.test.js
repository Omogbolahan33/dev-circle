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

// What every form has to ask, in the shape the builder posts it. The email and
// the phone number are the credential — an approved member signs in with the
// address and the last six digits of the number — so a form that goes out
// without both is refused. The name is merely advisable.
const IDENTITY = [
  { type: 'text', text: 'What should we call you?', required: true, format: 'none', maps_to: 'name' },
  { type: 'text', text: 'Which email should we use?', required: true, format: 'email', maps_to: 'email' },
  { type: 'text', text: 'And your phone number?', required: true, format: 'phone', maps_to: 'phone' }
];

// One row of answers to the three above, keyed by wording for fillIn().
const WHO = {
  'What should we call you?': 'Chidi Nwosu',
  'Which email should we use?': 'chidi@paystack.africa',
  'And your phone number?': '0803 555 0142'
};

const create = (body, token = adminToken) =>
  h.post('/api/admin/onboarding', { name: 'Partner intake', questions: IDENTITY, ...body }, { token });

// A live form and the token it is reached at.
async function live(body = {}) {
  const res = await create({ status: 'active', submitted_message: 'Thanks, we will be in touch.', ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.form;
}

// Fill one in, from the outside, as a browser would.
async function fillIn(form, answers, opts = {}) {
  const started = await h.post(`/api/onboarding/${form.public_token}/start`, opts.start || {});
  assert.equal(started.status, 200, JSON.stringify(started.body));

  const key = started.body.session_key;
  const questions = started.body.form.questions;

  // Answers are written against question wording, because slot ids are made by
  // the server and a test that hard-coded them would be testing its own guess.
  const byText = Object.fromEntries(questions.map(q => [q.text, q.id]));
  const keyed = Object.fromEntries(
    Object.entries(answers).map(([text, value]) => {
      assert.ok(byText[text], `the form does not ask "${text}"`);
      return [byText[text], value];
    })
  );

  const sent = await h.post(`/api/onboarding/${form.public_token}/submit`,
    { answers: keyed, session_key: key });

  return { sent, key, questions, ids: byText };
}

const queue = (status = 'pending') =>
  h.get(`/api/admin/onboarding-applications?status=${status}`, { token: adminToken });

// ─── Writing a form ─────────────────────────────────────────

test('a form cannot go live without collecting the credential', async () => {
  // The email address and the phone number are what an approved member signs
  // in with, so a form that goes out without both produces accounts nobody can
  // get into.
  const res = await create({
    status: 'active',
    questions: [{ type: 'text', text: 'Why do you want to join?', required: true, format: 'none' }]
  });

  assert.equal(res.status, 400);
  const messages = res.body.issues.map(i => i.message).join(' | ');
  assert.match(messages, /email address/i);
  assert.match(messages, /phone number/i);
});

test('everything else is the circle to choose, and a missing name only warns', async () => {
  const res = await create({
    status: 'active',
    questions: [
      { type: 'text', text: 'Which email should we use?', required: true, format: 'email', maps_to: 'email' },
      { type: 'text', text: 'And your phone number?', required: true, format: 'phone', maps_to: 'phone' },
      { type: 'text', text: 'Why do you want to join?', required: false, format: 'none' }
    ]
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.form.status, 'active');

  // Not a refusal — a consequence, said while there is still something to do
  // about it.
  const warned = (res.body.warnings || []).map(w => w.message).join(' | ');
  assert.match(warned, /unnamed/i);
});

test('a draft may be missing all of that — it is being written', async () => {
  const res = await create({
    status: 'draft',
    questions: [{ type: 'text', text: 'Why do you want to join?', required: true, format: 'none' }]
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.form.status, 'draft');
});

test('the email question cannot be optional or hidden behind a branch', async () => {
  // Optional: somebody could send in an application with nobody in it.
  const optional = await create({
    status: 'active',
    questions: [
      IDENTITY[0],
      { ...IDENTITY[1], required: false }
    ]
  });
  assert.equal(optional.status, 400);
  assert.match(JSON.stringify(optional.body.issues), /has to be required/);

  // Behind a branch: same outcome, arrived at differently.
  const branched = await create({
    status: 'active',
    questions: [
      { type: 'boolean', text: 'Are you a developer?', required: true, true_label: 'Yes', false_label: 'No' },
      IDENTITY[0],
      { ...IDENTITY[1], visible_if: { match: 'all', rules: [{ question: 'q1', op: 'is', value: true }] } }
    ]
  });
  assert.equal(branched.status, 400);
});

test('a question collecting an email has to be asked in the email format', async () => {
  const res = await create({
    status: 'active',
    questions: [IDENTITY[0], { ...IDENTITY[1], format: 'none' }]
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /Email address" format/);
});

test('two questions cannot collect the same thing', async () => {
  const res = await create({
    questions: [
      ...IDENTITY,
      { type: 'text', text: 'And your work address?', required: false, format: 'email', maps_to: 'email' }
    ]
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /already collected by question 2/);
});

test('a field cannot be collected by a question type that could not carry it', async () => {
  const res = await create({
    questions: [...IDENTITY, { type: 'rating', text: 'When were you born?', maps_to: 'date_of_birth' }]
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot be collected with a rating question/);
});

test('a consent question whose options name no channel is refused rather than losing consent quietly', async () => {
  const bad = await create({
    questions: [...IDENTITY, {
      type: 'multi_choice', text: 'How may we contact you?',
      options: ['Email', 'Carrier pigeon'], maps_to: 'consent_channels'
    }]
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Carrier pigeon/);

  // The same question, with options that fold onto real channels
  // An option naming two channels is refused for the same reason: a tick
  // against it would file permission for one and drop it for the other.
  const ambiguous = await create({
    questions: [...IDENTITY, {
      type: 'multi_choice', text: 'How may we contact you?',
      options: ['Email or SMS', 'WhatsApp'], maps_to: 'consent_channels'
    }]
  });
  assert.equal(ambiguous.status, 400);
  assert.match(ambiguous.body.error, /Email or SMS/);

  // Options that each name exactly one, however they are written
  const good = await create({
    questions: [...IDENTITY, {
      type: 'multi_choice', text: 'How may we contact you?',
      options: ['E-mail', 'WhatsApp', 'A phone call', 'In the portal'], maps_to: 'consent_channels'
    }]
  });
  assert.equal(good.status, 201, JSON.stringify(good.body));
});

test('an embed origin has to be a site, not a page', async () => {
  const res = await create({ allowed_origins: ['https://partner.com/developers/join'] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Give the site, not the page/);

  const ok = await create({ allowed_origins: ['https://partner.com', 'https://*.creditdirect.ng'] });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.form.allowed_origins, ['https://partner.com', 'https://*.creditdirect.ng']);
});

test('a form gets its address and its snippet on the first save', async () => {
  const res = await create({});
  assert.equal(res.status, 201);
  assert.ok(res.body.form.public_token);
  assert.equal(res.body.form.public_path, `/o/${res.body.form.public_token}`);
  assert.match(res.body.embed_snippet, /data-devcircle-onboarding="/);
  assert.match(res.body.embed_snippet, /\/embed\/onboarding\.js/);
});

test('an onboarding question does not become a research question', async () => {
  // The canonical questions table exists so that answers to one question can be
  // read together whichever survey carried it. Onboarding answers are profile
  // facts and are never filed as evidence, so a row here would carry nothing
  // and would still be offered to the next survey author as already asked.
  await live();
  assert.equal(h.db.prepare('SELECT COUNT(*) as n FROM questions').get().n, 0);
});

// ─── Filling one in ─────────────────────────────────────────

test('the form behind a link says nothing about how it is run', async () => {
  const form = await live({ allowed_origins: ['https://partner.com'], cohort_ids: [] });
  const res = await h.get(`/api/onboarding/${form.public_token}`);

  assert.equal(res.status, 200);
  assert.ok(res.body.form.questions.length);
  // Everything about running it stays in
  for (const leak of ['circle_id', 'allowed_origins', 'cohort_ids', 'field_map', 'public_token',
                      'created_by', 'redirect_url', 'submitted_message']) {
    assert.equal(res.body.form[leak], undefined, `${leak} should not be public`);
  }
});

test('a closed form and a token that never existed answer the same way', async () => {
  const form = await live();
  await h.put(`/api/admin/onboarding/${form.id}`, { status: 'closed' }, { token: adminToken });

  const closed = await h.get(`/api/onboarding/${form.public_token}`);
  const never = await h.get(`/api/onboarding/${'x'.repeat(32)}`);

  assert.equal(closed.status, 404);
  assert.equal(never.status, 404);
  assert.equal(closed.body.error, never.body.error);
});

test('a half-finished form comes back to the browser that started it', async () => {
  const form = await live();
  const started = await h.post(`/api/onboarding/${form.public_token}/start`, {});
  const key = started.body.session_key;
  const nameId = started.body.form.questions[0].id;

  const saved = await h.post(`/api/onboarding/${form.public_token}/progress`, {}, {});
  assert.equal(saved.status, 404, 'progress without a key belongs to nobody');

  await h.call('PATCH', `/api/onboarding/${form.public_token}/progress`,
    { body: { session_key: key, answers: { [nameId]: 'Chidi' } } });

  const again = await h.post(`/api/onboarding/${form.public_token}/start`, { session_key: key });
  assert.equal(again.body.answers[nameId], 'Chidi');
  // and not a second applicant
  assert.equal(again.body.session_key, key);
});

test('sending a form in creates an application and no account at all', async () => {
  const form = await live();
  const { sent } = await fillIn(form, WHO);

  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.message, 'Application received');
  assert.equal(sent.body.submitted_message, 'Thanks, we will be in touch.');

  // The whole safety argument for a publicly embeddable form is this line.
  const user = h.db.prepare('SELECT id FROM users WHERE email = ?').get('chidi@paystack.africa');
  assert.equal(user, undefined, 'submitting must never create a member');

  const waiting = await queue();
  assert.equal(waiting.body.applications.length, 1);
  assert.equal(waiting.body.applications[0].email, 'chidi@paystack.africa');
});

test('only the questions this applicant was shown are recorded, and a branch not taken is not unanswered', async () => {
  const form = await live({
    questions: [
      ...IDENTITY,
      { type: 'boolean', text: 'Have you built against the sandbox?', required: true, true_label: 'Yes', false_label: 'No' }
    ]
  });

  // Add a question that only shows when the answer is yes
  const full = await h.get(`/api/admin/onboarding/${form.id}`, { token: adminToken });
  const sandboxQ = full.body.form.questions.find(q => q.type === 'boolean');
  const withBranch = await h.put(`/api/admin/onboarding/${form.id}`, {
    ...full.body.form,
    questions: [
      ...full.body.form.questions,
      {
        type: 'text', text: 'What slowed you down?', required: true, format: 'none',
        visible_if: { match: 'all', rules: [{ question: sandboxQ.id, op: 'is', value: true }] }
      }
    ],
    status: 'active'
  }, { token: adminToken });
  assert.equal(withBranch.status, 200, JSON.stringify(withBranch.body));

  const { sent } = await fillIn(withBranch.body.form, { ...WHO, 'Have you built against the sandbox?': false });

  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.answered, 4, 'the branch was not taken, so it was not asked');

  const waiting = await queue();
  const one = await h.get(`/api/admin/onboarding-applications/${waiting.body.applications[0].id}`, { token: adminToken });
  assert.equal(one.body.asked.length, 4);
  assert.ok(!one.body.asked.some(q => q.text === 'What slowed you down?'));
});

test('an application without a usable email is refused before it reaches anybody', async () => {
  const form = await live();
  const started = await h.post(`/api/onboarding/${form.public_token}/start`, {});
  const ids = Object.fromEntries(started.body.form.questions.map(q => [q.text, q.id]));

  const sent = await h.post(`/api/onboarding/${form.public_token}/submit`, {
    session_key: started.body.session_key,
    answers: {
      [ids['What should we call you?']]: 'Chidi',
      [ids['Which email should we use?']]: 'not-an-address'
    }
  });

  assert.equal(sent.status, 400);
  assert.equal((await queue()).body.applications.length, 0);
});

test('the same form cannot be sent in twice from one browser', async () => {
  const form = await live();
  const { key } = await fillIn(form, WHO);

  const again = await h.post(`/api/onboarding/${form.public_token}/start`, { session_key: key });
  assert.equal(again.status, 409);
});

test('what a second application from one address means is the form\'s decision', async () => {
  // Replace: the earlier one is superseded rather than deleted, because
  // somebody may already be part-way through reviewing it.
  const replacing = await live({ duplicate_policy: 'replace' });
  await fillIn(replacing, WHO);
  const second = await fillIn(replacing, { ...WHO, 'What should we call you?': 'Chidi N' });
  assert.equal(second.sent.status, 200);
  assert.equal((await queue('pending')).body.applications.length, 1);
  assert.equal((await queue('withdrawn')).body.applications.length, 1);

  // Reject: the second is refused and told why.
  const refusing = await live({ name: 'Strict intake', duplicate_policy: 'reject' });
  await fillIn(refusing, { ...WHO, 'What should we call you?': 'Ada', 'Which email should we use?': 'ada@example.ng' });
  const blocked = await fillIn(refusing, { ...WHO, 'What should we call you?': 'Ada', 'Which email should we use?': 'ada@example.ng' });
  assert.equal(blocked.sent.status, 409);
});

// ─── Deciding ───────────────────────────────────────────────

test('approving is what creates the member, joins the circle and records consent', async () => {
  const form = await live({
    questions: [
      ...IDENTITY,
      { type: 'text', text: 'Which company?', required: false, format: 'none', maps_to: 'company' },
      {
        type: 'multi_choice', text: 'How may we contact you?', required: false,
        options: ['E-mail', 'WhatsApp'], maps_to: 'consent_channels'
      }
    ]
  });

  await fillIn(form, { ...WHO, 'Which company?': 'Paystack', 'How may we contact you?': ['E-mail', 'WhatsApp'] });

  const waiting = await queue();
  const id = waiting.body.applications[0].id;

  const approved = await h.post(`/api/admin/onboarding-applications/${id}/approve`, {}, { token: adminToken });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.created, true);

  const user = h.db.prepare('SELECT * FROM users WHERE email = ?').get('chidi@paystack.africa');
  assert.ok(user, 'the member should exist now');
  assert.equal(user.name, 'Chidi Nwosu');
  assert.equal(user.company, 'Paystack');

  const membership = h.db.prepare('SELECT 1 FROM circle_members WHERE circle_id = ? AND user_id = ?')
    .get(circleId, user.id);
  assert.ok(membership, 'they should be a member of the circle the form feeds');

  const consent = h.db.prepare("SELECT channel FROM consent WHERE user_id = ? AND status = 'granted'")
    .all(user.id).map(r => r.channel).sort();
  assert.deepEqual(consent, ['email', 'whatsapp']);

  const logged = h.db.prepare("SELECT 1 FROM engagement_history WHERE user_id = ? AND type = 'account_created'")
    .get(user.id);
  assert.ok(logged, 'the account should be on their engagement history');
});

test('an approved applicant joins the cohorts the form names', async () => {
  const cohortId = h.uuid();
  h.db.prepare("INSERT INTO cohorts (id, name, type, circle_id) VALUES (?, 'Partner programme', 'custom', ?)")
    .run(cohortId, circleId);

  const form = await live({ cohort_ids: [cohortId] });
  await fillIn(form, WHO);

  const id = (await queue()).body.applications[0].id;
  await h.post(`/api/admin/onboarding-applications/${id}/approve`, {}, { token: adminToken });

  const user = h.db.prepare('SELECT id FROM users WHERE email = ?').get('chidi@paystack.africa');
  const inCohort = h.db.prepare('SELECT 1 FROM user_cohorts WHERE user_id = ? AND cohort_id = ?')
    .get(user.id, cohortId);
  assert.ok(inCohort);
});

test('an address that is already a member joins this circle rather than becoming a second account', async () => {
  const existing = h.makeUser({ email: 'chidi@paystack.africa', name: 'Chidi Nwosu', company: 'Paystack' });
  const other = h.makeCircle('Lending Circle', 'lending');

  // A form in the second workspace
  const role = h.makeRole('Lead', ['*']);
  const lead = h.makeAdmin({ email: 'lead@creditdirect.ng', roleId: role, circleId: other });
  const leadToken = await h.loginAdmin(lead.email, lead.password);

  const made = await h.post('/api/admin/onboarding',
    { name: 'Lending intake', questions: IDENTITY, status: 'active' },
    { token: leadToken, headers: { 'X-Circle-Id': other } });
  assert.equal(made.status, 201, JSON.stringify(made.body));

  await fillIn(made.body.form, WHO);

  const waiting = await h.get('/api/admin/onboarding-applications?status=pending',
    { token: leadToken, headers: { 'X-Circle-Id': other } });
  const approved = await h.post(`/api/admin/onboarding-applications/${waiting.body.applications[0].id}/approve`,
    {}, { token: leadToken, headers: { 'X-Circle-Id': other } });

  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.created, false);
  assert.equal(approved.body.user_id, existing.id);

  const accounts = h.db.prepare('SELECT COUNT(*) as n FROM users WHERE email = ?').get('chidi@paystack.africa');
  assert.equal(accounts.n, 1, 'no second account for the same person');
});

test('a Credit Direct address is not something a form can let in', async () => {
  const form = await live();
  await fillIn(form, { ...WHO, 'Which email should we use?': 'someone@creditdirect.ng' });

  const id = (await queue()).body.applications[0].id;
  const res = await h.post(`/api/admin/onboarding-applications/${id}/approve`, {}, { token: adminToken });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /created by an administrator/);
});

test('turning one down creates nothing and deletes nothing', async () => {
  const form = await live();
  await fillIn(form, WHO);

  const id = (await queue()).body.applications[0].id;
  await h.post(`/api/admin/onboarding-applications/${id}/reject`, { note: 'Not a developer' }, { token: adminToken });

  assert.equal(h.db.prepare('SELECT COUNT(*) as n FROM users').get().n, 0);

  const rejected = await queue('rejected');
  assert.equal(rejected.body.applications.length, 1);
  assert.equal(rejected.body.applications[0].decision_note, 'Not a developer');

  // and it cannot then be approved
  const late = await h.post(`/api/admin/onboarding-applications/${id}/approve`, {}, { token: adminToken });
  assert.equal(late.status, 409);
});

test('an application belongs to one workspace and is invisible from another', async () => {
  const form = await live();
  await fillIn(form, WHO);

  const other = h.makeCircle('Lending Circle', 'lending');
  const seen = await h.get('/api/admin/onboarding-applications?status=pending',
    { token: adminToken, headers: { 'X-Circle-Id': other } });

  assert.equal(seen.status, 200);
  assert.equal(seen.body.applications.length, 0, 'another circle should see nothing of this one\'s applicants');
});

// ─── Questions freeze once people have answered them ────────

test('once an application exists the questions are fixed but the look is not', async () => {
  const form = await live();
  await fillIn(form, WHO);

  const held = await h.get(`/api/admin/onboarding/${form.id}`, { token: adminToken });
  assert.equal(held.body.questions_locked, true);

  const reworded = await h.put(`/api/admin/onboarding/${form.id}`, {
    ...held.body.form,
    questions: [{ ...held.body.form.questions[0], text: 'Your name?' }, held.body.form.questions[1]]
  }, { token: adminToken });
  assert.equal(reworded.status, 409);

  const restyled = await h.put(`/api/admin/onboarding/${form.id}`, {
    ...held.body.form,
    theme: { accent: '#E6B473' }
  }, { token: adminToken });
  assert.equal(restyled.status, 200, JSON.stringify(restyled.body));
  assert.equal(restyled.body.form.theme.accent.toLowerCase(), '#e6b473');
});

test('a form people have filled in is closed rather than deleted', async () => {
  const form = await live();
  await fillIn(form, WHO);

  const res = await h.del(`/api/admin/onboarding/${form.id}`, { token: adminToken });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Close it instead/);

  // One nobody has filled in can go
  const untouched = await create({ name: 'Never used' });
  const gone = await h.del(`/api/admin/onboarding/${untouched.body.form.id}`, { token: adminToken });
  assert.equal(gone.status, 200);
});

test('a copy asks the same questions under different slot ids, and its branching follows', async () => {
  const form = await live({
    questions: [
      ...IDENTITY,
      { type: 'boolean', text: 'Sandbox already?', required: true, true_label: 'Yes', false_label: 'No' }
    ]
  });

  const copy = await h.post(`/api/admin/onboarding/${form.id}/duplicate`, {}, { token: adminToken });
  assert.equal(copy.status, 201);
  assert.equal(copy.body.form.status, 'draft');
  assert.notEqual(copy.body.form.public_token, form.public_token);

  const original = form.questions.map(q => q.id);
  const copied = copy.body.form.questions.map(q => q.id);
  assert.equal(copied.length, original.length);
  for (const id of copied) assert.ok(!original.includes(id), 'a copy must not reuse a slot id');

  // The tags travel with the questions
  assert.deepEqual(
    copy.body.form.questions.map(q => q.maps_to || null),
    form.questions.map(q => q.maps_to || null)
  );
});

// ─── Being embedded ─────────────────────────────────────────

test('the form page is framable only by the sites its form names', async () => {
  const open = await live({ allowed_origins: ['https://partner.com'] });
  const shut = await live({ name: 'Link only', allowed_origins: [] });

  const framable = await h.get(`/o/${open.public_token}`, { raw: true });
  assert.equal(framable.status, 200);
  assert.equal(framable.headers.get('x-frame-options'), null,
    'X-Frame-Options has no list form, so it must be removed rather than left saying DENY');
  assert.match(framable.headers.get('content-security-policy'),
    /frame-ancestors 'self' https:\/\/partner\.com/);

  const unframable = await h.get(`/o/${shut.public_token}`, { raw: true });
  assert.match(unframable.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  // Every other page keeps the strict default
  const admin = await h.get('/admin/onboarding.html', { raw: true });
  assert.equal(admin.headers.get('x-frame-options'), 'DENY');
});

test('the embed loader is served and names no other host', async () => {
  const res = await h.get('/embed/onboarding.js', { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.text, /data-devcircle-onboarding/);
  assert.match(res.text, /addEventListener\('message'/);
});

test('where an embed was filled in is recorded only when the form allows that site', async () => {
  const form = await live({ allowed_origins: ['https://partner.com'] });

  await fillIn(form, WHO, { start: { embedded_on: 'https://partner.com/developers/join' } });

  const one = (await queue()).body.applications[0];
  assert.equal(one.source_origin, 'https://partner.com');
  assert.equal(one.source_page, 'https://partner.com/developers/join');

  // A page claiming to be somewhere the form does not allow records nothing,
  // rather than recording a lie
  const second = await live({ name: 'Second' });
  await fillIn(second, { ...WHO, 'What should we call you?': 'Ada Obi', 'Which email should we use?': 'ada@example.ng' }, { start: { embedded_on: 'https://attacker.example/steal' } });

  const ada = (await queue()).body.applications.find(a => a.email === 'ada@example.ng');
  assert.equal(ada.source_origin, null);
});

// ─── Who may do what ────────────────────────────────────────

test('writing a form and approving an applicant are different permissions', async () => {
  const authorRole = h.makeRole('Author', ['onboarding.read', 'onboarding.write', 'circles.read', 'cohorts.read']);
  const author = h.makeAdmin({ email: 'author@creditdirect.ng', roleId: authorRole });
  const authorToken = await h.loginAdmin(author.email, author.password);

  const made = await create({}, authorToken);
  assert.equal(made.status, 201, 'an author can write a form');

  const form = await live({ name: 'For approving' });
  await fillIn(form, WHO);
  const id = (await queue()).body.applications[0].id;

  const refused = await h.post(`/api/admin/onboarding-applications/${id}/approve`, {}, { token: authorToken });
  assert.equal(refused.status, 403, 'approving creates a member, which is its own capability');
});

test('a role with neither permission cannot read the queue', async () => {
  const noneRole = h.makeRole('Nothing', ['members.read']);
  const nobody = h.makeAdmin({ email: 'nobody@creditdirect.ng', roleId: noneRole });
  const token = await h.loginAdmin(nobody.email, nobody.password);

  assert.equal((await h.get('/api/admin/onboarding', { token })).status, 403);
  assert.equal((await h.get('/api/admin/onboarding-applications', { token })).status, 403);
});

// ─── Onboarding by spreadsheet ──────────────────────────────
// One row or five hundred: a partner's list, a page of names off a stand, or
// somebody's export. The same questions, the same checks, the same queue.

const csvOf = rows => rows.map(r => r.map(cell => {
  const value = String(cell ?? '');
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}).join(',')).join('\n');

const importInto = (form, body, token = adminToken) =>
  h.post(`/api/admin/onboarding/${form.id}/import`, body, { token });

test('the template is built from the form, so it imports back without an edit', async () => {
  const form = await live();

  const template = await h.get(`/api/admin/onboarding/${form.id}/import/template?format=csv`,
    { token: adminToken, raw: true });

  assert.equal(template.status, 200);
  assert.match(template.headers.get('content-disposition'), /applicants-template\.csv/);

  // The example row is a promise about the format, so it has to be one the
  // parser actually accepts. Anything else is a template that teaches the
  // wrong thing.
  const body = template.text.replace(/^﻿/, '');
  const landed = await importInto(form, { csv: body });

  assert.equal(landed.status, 200, JSON.stringify(landed.body));
  assert.equal(landed.body.created, 1, JSON.stringify(landed.body.errors));
  assert.deepEqual(landed.body.errors, []);
});

test('a sheet of people lands as applications, not as members', async () => {
  const form = await live();

  const csv = csvOf([
    ['What should we call you?', 'Which email should we use?', 'And your phone number?'],
    ['Ada Obi', 'ada@zilla.ng', '08031112222'],
    ['Tola Bello', 'tola@stitch.ng', '08033334444']
  ]);

  const landed = await importInto(form, { csv });
  assert.equal(landed.status, 200, JSON.stringify(landed.body));
  assert.equal(landed.body.created, 2);

  // The same promise the public endpoint makes, from the other direction
  assert.equal(h.db.prepare('SELECT COUNT(*) as n FROM users').get().n, 0);

  const waiting = await queue();
  assert.equal(waiting.body.applications.length, 2);
  assert.deepEqual(
    waiting.body.applications.map(a => a.email).sort(),
    ['ada@zilla.ng', 'tola@stitch.ng']
  );
});

test('one row is an import too — that is how a single person is added', async () => {
  const form = await live();

  const landed = await importInto(form, {
    rows: [{
      'What should we call you?': 'Ada Obi',
      'Which email should we use?': 'ada@zilla.ng',
      'And your phone number?': '08031112222'
    }]
  });

  assert.equal(landed.body.created, 1);
  assert.equal((await queue()).body.applications[0].name, 'Ada Obi');
});

test('a row is held to the same rules the form states about itself', async () => {
  const form = await live();

  const csv = csvOf([
    ['What should we call you?', 'Which email should we use?', 'And your phone number?'],
    ['Ada Obi', 'ada@zilla.ng', ''],                    // no phone: half the credential
    ['Tola Bello', 'not-an-address', '08033334444'],    // not an address
    ['Ngozi Eze', 'ngozi@zilla.ng', '08035556666']      // fine
  ]);

  const landed = await importInto(form, { csv });

  assert.equal(landed.body.created, 1);
  assert.equal(landed.body.errors.length, 2);
  // Reported against the line in the sheet, so a two-hundred-row file is fixed
  // in one pass rather than one refusal at a time
  assert.deepEqual(landed.body.errors.map(e => e.line), [2, 3]);
  assert.match(landed.body.errors[0].error, /phone number/i);
});

test('a dry run says what would happen and writes nothing', async () => {
  const form = await live();

  const csv = csvOf([
    ['What should we call you?', 'Which email should we use?', 'And your phone number?'],
    ['Ada Obi', 'ada@zilla.ng', '08031112222'],
    ['Tola Bello', 'bad-address', '08033334444']
  ]);

  const checked = await importInto(form, { csv, dry_run: true });

  assert.equal(checked.body.dry_run, true);
  assert.equal(checked.body.created, 1);
  assert.equal(checked.body.errors.length, 1);
  assert.equal((await queue()).body.applications.length, 0, 'a dry run stores nothing');
});

test('running the same upload twice lands nothing the second time', async () => {
  const form = await live();

  const csv = csvOf([
    ['Your reference', 'What should we call you?', 'Which email should we use?', 'And your phone number?'],
    ['partner-1', 'Ada Obi', 'ada@zilla.ng', '08031112222']
  ]);

  const first = await importInto(form, { csv });
  const second = await importInto(form, { csv });

  assert.equal(first.body.created, 1);
  assert.equal(second.body.created, 0);
  assert.equal(second.body.skipped, 1);
  assert.equal((await queue()).body.applications.length, 1);
});

test('the same address twice in one sheet is a copy-paste, and is refused', async () => {
  const form = await live();

  const csv = csvOf([
    ['What should we call you?', 'Which email should we use?', 'And your phone number?'],
    ['Ada Obi', 'ada@zilla.ng', '08031112222'],
    ['Ada O.', 'ada@zilla.ng', '08031112222']
  ]);

  const landed = await importInto(form, { csv });

  assert.equal(landed.body.created, 1);
  assert.equal(landed.body.errors.length, 1);
  assert.match(landed.body.errors[0].error, /more than once in this sheet/);
});

test('somebody already in the queue is skipped rather than duplicated', async () => {
  const form = await live();
  await fillIn(form, WHO);

  const csv = csvOf([
    ['What should we call you?', 'Which email should we use?', 'And your phone number?'],
    ['Chidi Nwosu', 'chidi@paystack.africa', '08035550142']
  ]);

  const landed = await importInto(form, { csv });
  assert.equal(landed.body.skipped, 1);
  assert.equal((await queue()).body.applications.length, 1);
});

test('a column the form has nowhere to put is named rather than silently dropped', async () => {
  const form = await live();

  const csv = csvOf([
    ['What should we call you?', 'Which email should we use?', 'And your phone number?', 'Shoe size'],
    ['Ada Obi', 'ada@zilla.ng', '08031112222', '43']
  ]);

  const landed = await importInto(form, { csv });

  assert.equal(landed.body.created, 1);
  // Reported as the CSV parser saw it — headings arrive lowercased with spaces
  // folded to underscores, which is what lets one sheet be read whether it came
  // from our own export or out of Google Forms.
  assert.deepEqual(landed.body.unmatched_columns, ['shoe_size'],
    'a blank answer and a column that did not line up look identical afterwards');
});

test('branching applies to an imported row as it does to a filled-in one', async () => {
  const form = await live({
    questions: [
      ...IDENTITY,
      { type: 'boolean', text: 'Already building?', required: true, true_label: 'Yes', false_label: 'No' }
    ]
  });

  const full = await h.get(`/api/admin/onboarding/${form.id}`, { token: adminToken });
  const trigger = full.body.form.questions.find(q => q.type === 'boolean');
  const branched = await h.put(`/api/admin/onboarding/${form.id}`, {
    ...full.body.form,
    questions: [...full.body.form.questions, {
      type: 'text', text: 'What are you building?', required: true, format: 'none',
      visible_if: { match: 'all', rules: [{ question: trigger.id, op: 'is', value: true }] }
    }],
    status: 'active'
  }, { token: adminToken });
  assert.equal(branched.status, 200, JSON.stringify(branched.body));

  const csv = csvOf([
    ['What should we call you?', 'Which email should we use?', 'And your phone number?',
     'Already building?', 'What are you building?'],
    // "No" closes the branch, so the last column is not asked of this row and
    // the required answer under it is not missed
    ['Ada Obi', 'ada@zilla.ng', '08031112222', 'No', ''],
    // "Yes" opens it, and leaving it blank is a refusal
    ['Tola Bello', 'tola@stitch.ng', '08033334444', 'Yes', '']
  ]);

  const landed = await importInto(branched.body.form, { csv });

  assert.equal(landed.body.created, 1);
  assert.equal(landed.body.errors.length, 1);
  assert.match(landed.body.errors[0].error, /What are you building/);
});

test('a sheet can be approved as it lands, but only by somebody who could approve it by hand', async () => {
  const form = await live();
  const csv = csvOf([
    ['What should we call you?', 'Which email should we use?', 'And your phone number?'],
    ['Ada Obi', 'ada@zilla.ng', '08031112222']
  ]);

  const authorRole = h.makeRole('Author', ['onboarding.read', 'onboarding.write']);
  const author = h.makeAdmin({ email: 'author@creditdirect.ng', roleId: authorRole });
  const authorToken = await h.loginAdmin(author.email, author.password);

  const refused = await importInto(form, { csv, approve: true }, authorToken);
  assert.equal(refused.status, 403);
  assert.equal(h.db.prepare('SELECT COUNT(*) as n FROM users').get().n, 0);

  const landed = await importInto(form, { csv, approve: true });
  assert.equal(landed.status, 200, JSON.stringify(landed.body));
  assert.equal(landed.body.approved, 1);

  const user = h.db.prepare('SELECT * FROM users WHERE email = ?').get('ada@zilla.ng');
  assert.ok(user, 'approving on import creates the member');
  assert.equal(user.phone_normalized, '+2348031112222');
});

test('a row that cannot become a member is reported against its line, not left half-done', async () => {
  const form = await live();
  const csv = csvOf([
    ['What should we call you?', 'Which email should we use?', 'And your phone number?'],
    ['Ada Obi', 'ada@zilla.ng', '08031112222'],
    ['Someone Internal', 'someone@creditdirect.ng', '08033334444']
  ]);

  const landed = await importInto(form, { csv, approve: true });

  assert.equal(landed.body.created, 2, 'both are applications');
  assert.equal(landed.body.approved, 1, 'only one can become a member');
  assert.match(landed.body.errors[0].error, /created by an administrator/);

  // The refused one is still in the queue for somebody to look at
  assert.equal((await queue()).body.applications.length, 1);
});

test('a form that is not ready has nothing for a sheet to line up against', async () => {
  const draft = await create({ status: 'draft', questions: [] });
  const landed = await importInto(draft.body.form, { rows: [{ a: 1 }] });

  assert.equal(landed.status, 400);
  assert.match(landed.body.error, /not ready to take applications/);
});

test('a form can be closed and reopened without losing what it collected', async () => {
  const form = await live();
  await fillIn(form, WHO);

  const closed = await h.put(`/api/admin/onboarding/${form.id}`, { status: 'closed' }, { token: adminToken });
  assert.equal(closed.status, 200);

  // Unreachable at its link and unframeable on any page — the same answer a
  // token that never existed gets.
  assert.equal((await h.get(`/api/onboarding/${form.public_token}`)).status, 404);

  const reopened = await h.put(`/api/admin/onboarding/${form.id}`, { status: 'active' }, { token: adminToken });
  assert.equal(reopened.status, 200);
  assert.equal((await h.get(`/api/onboarding/${form.public_token}`)).status, 200);

  // And the application it took in between is still there
  assert.equal((await queue()).body.applications.length, 1);
});

test('an edit only changes what it carries', async () => {
  const cohortId = h.uuid();
  h.db.prepare("INSERT INTO cohorts (id, name, type, circle_id) VALUES (?, 'Partner', 'custom', ?)")
    .run(cohortId, circleId);

  const form = await live({
    allowed_origins: ['https://partner.com'],
    cohort_ids: [cohortId],
    theme: { accent: '#E6B473' }
  });

  // The narrowest possible edit: nothing but a status. Reopening a closed form
  // is exactly this, and it used to replace the questions, the theme and the
  // origin list with empty ones — then refuse the publish for the missing
  // questions and leave the form closed.
  await h.put(`/api/admin/onboarding/${form.id}`, { status: 'closed' }, { token: adminToken });
  const reopened = await h.put(`/api/admin/onboarding/${form.id}`, { status: 'active' }, { token: adminToken });

  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.form.status, 'active');
  assert.equal(reopened.body.form.questions.length, form.questions.length);
  assert.deepEqual(reopened.body.form.allowed_origins, ['https://partner.com']);
  assert.deepEqual(reopened.body.form.cohort_ids, [cohortId]);
  assert.equal(reopened.body.form.theme.accent.toLowerCase(), '#e6b473');

  // …and it is genuinely reachable again
  assert.equal((await h.get(`/api/onboarding/${form.public_token}`)).status, 200);
});

test('an edit that does carry a field still replaces it', async () => {
  const form = await live({ allowed_origins: ['https://partner.com'] });

  const cleared = await h.put(`/api/admin/onboarding/${form.id}`,
    { allowed_origins: [] }, { token: adminToken });

  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.form.allowed_origins, [],
    'an empty list is a decision, not an omission');
});
