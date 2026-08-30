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

// ─── The three rings ────────────────────────────────────────
// The rings were a fixed list of eight things, which was fine while every
// circle wanted the same eight. An onboarding form decides what its circle
// needs to know, so a circle that asks applicants where they work has a
// property the rings knew nothing about — and somebody who arrived by
// spreadsheet, by SSO, or by skipping an optional question never gets asked
// again.

const CREDENTIAL = [
  { type: 'text', text: 'Name', required: true, format: 'none', maps_to: 'name' },
  { type: 'text', text: 'Email', required: true, format: 'email', maps_to: 'email' },
  { type: 'text', text: 'Phone', required: true, format: 'phone', maps_to: 'phone' }
];

const publishForm = (questions, extra = {}) =>
  h.post('/api/admin/onboarding',
    { name: 'Intake', status: 'active', questions, ...extra },
    { token: adminToken });

const readinessFor = async user =>
  (await h.get('/api/users/readiness', { token: await h.loginUser(user.email) })).body;

const taskKeys = readiness =>
  readiness.rings.flatMap(r => r.tasks.map(t => t.key));

test('a member is asked for the eight things every member needs, whatever any form says', async () => {
  const user = h.makeUser();
  const readiness = await readinessFor(user);

  assert.equal(readiness.total_rings, 3);
  for (const key of [
    'name', 'phone', 'company', 'work_sector',
    'preferred_days', 'preferred_time',
    'preferred_channels', 'consent'
  ]) {
    assert.ok(taskKeys(readiness).includes(key), `${key} should be asked of everybody`);
  }
});

test('a property no form asks for is not in anybody\'s rings', async () => {
  const user = h.makeUser({ location_state: null, gender: null });
  const readiness = await readinessFor(user);

  for (const key of ['location_state', 'gender', 'date_of_birth']) {
    assert.ok(!taskKeys(readiness).includes(key),
      `nobody asked for ${key}, so nobody should be nagged about it`);
  }
});

test('a property the circle\'s form collects becomes a ring task when it is missing', async () => {
  // The circle says, on its onboarding form, that it needs to know where
  // people work. A member who has no location on file has an unfinished ring.
  const made = await publishForm([
    ...CREDENTIAL,
    { type: 'text', text: 'Where do you work from?', required: false, format: 'none', maps_to: 'location_state' }
  ]);
  assert.equal(made.status, 201, JSON.stringify(made.body));

  const user = h.makeUser({ location_state: null });
  const readiness = await readinessFor(user);

  assert.ok(taskKeys(readiness).includes('location_state'));

  const task = readiness.unfinished_tasks.find(t => t.task_key === 'location_state');
  assert.ok(task, 'and it should be listed as unfinished');
  assert.equal(task.ring_id, 'profile');
  assert.equal(task.asked_by_circle, true,
    'the member is owed the difference between "everyone needs this" and "your circle asks for this"');
});

test('the same property already on file closes rather than nags', async () => {
  await publishForm([
    ...CREDENTIAL,
    { type: 'text', text: 'Where do you work from?', required: false, format: 'none', maps_to: 'location_state' }
  ]);

  const user = h.makeUser({ location_state: 'Lagos' });
  const readiness = await readinessFor(user);

  const task = readiness.rings
    .flatMap(r => r.tasks)
    .find(t => t.key === 'location_state');

  assert.ok(task, 'it is still asked for');
  assert.equal(task.done, true);
  assert.equal(task.description, 'Lagos', 'what they said, once they have said it');
  assert.ok(!readiness.unfinished_tasks.some(t => t.task_key === 'location_state'));
});

test('a closed form stops asking', async () => {
  // A closed form is a thing the circle used to ask. Nagging somebody about a
  // question nobody is being asked any more is how a checklist stops being
  // believed.
  const made = await publishForm([
    ...CREDENTIAL,
    { type: 'text', text: 'Where do you work from?', required: false, format: 'none', maps_to: 'location_state' }
  ]);

  const user = h.makeUser({ location_state: null });
  assert.ok(taskKeys(await readinessFor(user)).includes('location_state'));

  await h.put(`/api/admin/onboarding/${made.body.form.id}`, { status: 'closed' }, { token: adminToken });
  assert.ok(!taskKeys(await readinessFor(user)).includes('location_state'));
});

test('a form in a circle the member is not in asks them nothing', async () => {
  const other = h.makeCircle('Lending Circle', 'lending');
  const role = h.makeRole('Lead', ['*']);
  const lead = h.makeAdmin({ email: 'lead@creditdirect.ng', roleId: role, circleId: other });
  const leadToken = await h.loginAdmin(lead.email, lead.password);

  await h.post('/api/admin/onboarding',
    {
      name: 'Lending intake', status: 'active',
      questions: [...CREDENTIAL, { type: 'text', text: 'Where?', required: false, format: 'none', maps_to: 'location_state' }]
    },
    { token: leadToken, headers: { 'X-Circle-Id': other } });

  // This member belongs to the first circle only
  const user = h.makeUser({ location_state: null });
  assert.ok(!taskKeys(await readinessFor(user)).includes('location_state'));
});

test('several forms in a circle ask for the union of what they collect', async () => {
  await publishForm([
    ...CREDENTIAL,
    { type: 'text', text: 'Where?', required: false, format: 'none', maps_to: 'location_state' }
  ]);
  await publishForm([
    ...CREDENTIAL,
    { type: 'date', text: 'Born?', required: false, maps_to: 'date_of_birth' }
  ], { name: 'Second intake' });

  const user = h.makeUser({ location_state: null, date_of_birth: null });
  const keys = taskKeys(await readinessFor(user));

  assert.ok(keys.includes('location_state'));
  assert.ok(keys.includes('date_of_birth'));
});

test('an added task holds the ring open until it is answered', async () => {
  await publishForm([
    ...CREDENTIAL,
    { type: 'text', text: 'Where?', required: false, format: 'none', maps_to: 'location_state' }
  ]);

  // Everything the original eight wanted, and nothing the circle added
  const user = h.makeUser({
    name: 'Ada Obi', company: 'Zilla', work_sector: 'Fintech',
    preferred_days: ['tue'], preferred_channels: ['email'],
    preferred_time_start: '10:00', preferred_time_end: '14:00',
    location_state: null
  });
  h.grantConsent(user.id, 'email');

  const readiness = await readinessFor(user);
  const profile = readiness.rings.find(r => r.id === 'profile');

  assert.equal(profile.is_complete, false, 'the circle asked for something it has not got');
  assert.equal(readiness.is_complete, false);
  assert.ok(readiness.overall_percentage < 100);
});

test('filling the added property in closes the ring', async () => {
  await publishForm([
    ...CREDENTIAL,
    { type: 'text', text: 'Where?', required: false, format: 'none', maps_to: 'location_state' }
  ]);

  const user = h.makeUser({
    name: 'Ada Obi', company: 'Zilla', work_sector: 'Fintech',
    preferred_days: ['tue'], preferred_channels: ['email'],
    preferred_time_start: '10:00', preferred_time_end: '14:00',
    location_state: null
  });
  h.grantConsent(user.id, 'email');
  const token = await h.loginUser(user.email);

  // …and the member can actually do it from their own profile, which is the
  // whole point of putting it in front of them.
  const saved = await h.put('/api/users/profile', { location_state: 'Lagos' }, { token });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.readiness.is_complete, true, 'all three rings closed');
});

test('a member onboarded through the form arrives with those rings already closed', async () => {
  // The other half of the same idea: what the form did collect is not asked
  // for again.
  const made = await publishForm([
    ...CREDENTIAL,
    { type: 'text', text: 'Company?', required: true, format: 'none', maps_to: 'company' },
    { type: 'text', text: 'Where?', required: true, format: 'none', maps_to: 'location_state' }
  ]);
  const form = made.body.form;

  const started = await h.post(`/api/onboarding/${form.public_token}/start`, {});
  const ids = Object.fromEntries(started.body.form.questions.map(q => [q.text, q.id]));
  await h.post(`/api/onboarding/${form.public_token}/submit`, {
    session_key: started.body.session_key,
    answers: {
      [ids.Name]: 'Ada Obi', [ids.Email]: 'ada@zilla.ng', [ids.Phone]: '0803 111 2222',
      [ids['Company?']]: 'Zilla', [ids['Where?']]: 'Lagos'
    }
  });

  const queued = await h.get('/api/admin/onboarding-applications?status=pending', { token: adminToken });
  await h.post(`/api/admin/onboarding-applications/${queued.body.applications[0].id}/approve`,
    {}, { token: adminToken });

  const readiness = await readinessFor({ email: 'ada@zilla.ng' });
  const byKey = Object.fromEntries(readiness.rings.flatMap(r => r.tasks).map(t => [t.key, t]));

  assert.equal(byKey.location_state.done, true, 'the form already asked, and they already answered');
  assert.equal(byKey.company.done, true);
  assert.equal(byKey.name.done, true);
  assert.equal(byKey.phone.done, true);

  // What the form did not collect is still owed
  assert.equal(byKey.preferred_days.done, false);
});

test('a property that no member can edit is never made a task', async () => {
  // An onboarding form can collect the Developer Hub id. It is written by the
  // Hub and editable by nobody, so a ring task for it would be a prompt with
  // nowhere to go.
  await publishForm([
    ...CREDENTIAL,
    { type: 'text', text: 'Hub id?', required: false, format: 'none', maps_to: 'dev_hub_user_id' }
  ]);

  const user = h.makeUser();
  assert.ok(!taskKeys(await readinessFor(user)).includes('dev_hub_user_id'));
});
