const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

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

// ─── Authentication ─────────────────────────────────────────

const OPEN_ENDPOINTS = [
  ['/api/integrations/landing-page/ingest', { email: 'x@y.ng', name: 'X' }],
  ['/api/integrations/customerio/webhook', { event_type: 'kyb_completed', user_id: 'hub_x' }],
  ['/api/integrations/feex/webhook', { ticket_id: 'T1', user_email: 'x@y.ng' }],
  ['/api/integrations/events', { event_type: 'kyb_completed', user_identifier: 'x@y.ng' }]
];

for (const [endpoint, body] of OPEN_ENDPOINTS) {
  test(`${endpoint} rejects an unauthenticated caller`, async () => {
    // Every one of these was reachable by anyone on the internet
    const res = await h.post(endpoint, body);
    assert.equal(res.status, 401);
  });
}

test('an API key is rejected once revoked', async () => {
  const keyRow = h.db.prepare('SELECT id FROM api_keys LIMIT 1').get();
  await h.del(`/api/admin/api-keys/${keyRow.id}`, { token });

  const res = await h.post('/api/integrations/landing-page/ingest',
    { email: 'x@y.ng', name: 'X' }, { apiKey });
  assert.equal(res.status, 401);
});

test('an API key is confined to its scopes', async () => {
  const feexOnly = h.makeApiKey(['feex']);

  const allowed = await h.post('/api/integrations/feex/webhook',
    { ticket_id: 'T1', user_email: 'nobody@y.ng' }, { apiKey: feexOnly });
  assert.notEqual(allowed.status, 403);

  const denied = await h.post('/api/integrations/landing-page/ingest',
    { email: 'x@y.ng', name: 'X' }, { apiKey: feexOnly });
  assert.equal(denied.status, 403);
});

test('the plaintext key is never stored', async () => {
  const res = await h.post('/api/admin/api-keys', { name: 'CI', scopes: ['events'] }, { token });
  assert.equal(res.status, 201);

  const stored = h.db.prepare('SELECT key_hash FROM api_keys WHERE name = ?').get('CI');
  assert.notEqual(stored.key_hash, res.body.key);
});

// ─── Landing page ───────────────────────────────────────────

test('a landing-page registration creates a profile, cohort and circle membership', async () => {
  const res = await h.post('/api/integrations/landing-page/ingest', {
    email: 'tola@stitch.ng', name: 'Tola Bello', company: 'Stitch', phone: '0803 111 2222',
    work_sector: 'Fintech', location_state: 'Lagos', api_products: ['payments'],
    consent_channels: ['email', 'in_portal']
  }, { apiKey });

  assert.equal(res.status, 201);

  const user = h.db.prepare('SELECT * FROM users WHERE email = ?').get('tola@stitch.ng');
  assert.equal(user.location_state, 'Lagos');
  assert.deepEqual(JSON.parse(user.api_products), ['payments']);

  const consent = h.db.prepare("SELECT channel FROM consent WHERE user_id = ? AND status = 'granted'")
    .all(user.id).map(r => r.channel).sort();
  assert.deepEqual(consent, ['email', 'in_portal']);

  const inCircle = h.db.prepare('SELECT COUNT(*) as c FROM circle_members WHERE user_id = ?').get(user.id).c;
  assert.equal(inCircle, 1);

  // Registration hands out no credential — the member signs in with a code,
  // on either the address or the number they gave
  assert.equal(res.body.temp_password, undefined);
  assert.equal(user.phone_normalized, '+2348031112222');

  assert.ok(await h.loginUser('tola@stitch.ng'));
  assert.ok(await h.loginUser('+234 803 111 2222'));
});

test('a Credit Direct address cannot arrive as a landing-page registration', async () => {
  const res = await h.post('/api/integrations/landing-page/ingest',
    { email: 'tunde@creditdirect.ng', name: 'Tunde Bakare' }, { apiKey });

  assert.equal(res.status, 400);
  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM users').get().c, 0);
});

test('a duplicate registration is refused rather than creating a second profile', async () => {
  h.makeUser({ email: 'dupe@stitch.ng' });
  const res = await h.post('/api/integrations/landing-page/ingest',
    { email: 'dupe@stitch.ng', name: 'Dupe' }, { apiKey });

  assert.equal(res.status, 409);
  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM users').get().c, 1);
});

// ─── Event bridge ───────────────────────────────────────────

test('a Developer Hub event updates state and fires the survey wired to it', async () => {
  const user = h.makeUser({ email: 'dev@hub.ng', kyb_completed: 0 });
  h.grantConsent(user.id, 'email');

  const survey = await h.post('/api/admin/surveys', {
    title: 'KYB feedback', questions: [{ type: 'rating', text: 'How was it?' }],
    trigger_event: 'kyb_completed', engagement_mode: 'email'
  }, { token });
  await h.put(`/api/admin/surveys/${survey.body.survey.id}`, { status: 'active' }, { token });

  const res = await h.post('/api/integrations/events', {
    event_type: 'kyb_completed', user_identifier: 'dev@hub.ng', user_identifier_type: 'email'
  }, { apiKey });

  assert.equal(res.status, 200);
  assert.equal(res.body.surveys_triggered.length, 1);

  const updated = h.db.prepare('SELECT kyb_completed FROM users WHERE id = ?').get(user.id);
  assert.equal(updated.kyb_completed, 1);

  const invited = h.db.prepare('SELECT COUNT(*) as c FROM survey_responses WHERE user_id = ?').get(user.id).c;
  assert.equal(invited, 1);

  const notified = h.db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ?').get(user.id).c;
  assert.equal(notified, 1);
});

test('the same event twice does not invite a member twice', async () => {
  h.makeUser({ email: 'dev@hub.ng' });

  const survey = await h.post('/api/admin/surveys', {
    title: 'KYB feedback', questions: [{ type: 'text', text: 'x' }], trigger_event: 'kyb_completed'
  }, { token });
  await h.put(`/api/admin/surveys/${survey.body.survey.id}`, { status: 'active' }, { token });

  const payload = { event_type: 'kyb_completed', user_identifier: 'dev@hub.ng', user_identifier_type: 'email' };
  await h.post('/api/integrations/events', payload, { apiKey });
  const second = await h.post('/api/integrations/events', payload, { apiKey });

  assert.equal(second.body.surveys_triggered.length, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM survey_responses').get().c, 1);
});

test('an event for an unknown member is queued for replay, not lost', async () => {
  const res = await h.post('/api/integrations/events', {
    event_type: 'kyb_completed', user_identifier: 'ghost@nowhere.ng'
  }, { apiKey });

  assert.equal(res.status, 404);
  assert.equal(res.body.queued, true);

  const pending = await h.get('/api/integrations/events/pending', { apiKey });
  assert.equal(pending.body.count, 1);
});

test('a production call promotes the member and re-syncs rule-based cohorts', async () => {
  const user = h.makeUser({ email: 'dev@hub.ng', api_status: 'sandbox' });
  require('../../src/services/circles').join(user.id);

  const cohort = await h.post('/api/admin/cohorts', {
    name: 'Production', auto_sync: true,
    filter_rules: [{ field: 'api_status', op: 'eq', value: 'production' }]
  }, { token });
  assert.equal(cohort.body.sync.added, 0);

  await h.post('/api/integrations/events', {
    event_type: 'first_production_call', user_identifier: 'dev@hub.ng'
  }, { apiKey });

  const members = h.db.prepare('SELECT COUNT(*) as c FROM user_cohorts WHERE cohort_id = ?')
    .get(cohort.body.cohort.id).c;
  assert.equal(members, 1, 'cohort membership should follow the state change automatically');
});

// ─── Feex ───────────────────────────────────────────────────

test('a Feex complaint is ingested against the member with its ticket state mirrored', async () => {
  const user = h.makeUser({ email: 'dev@hub.ng' });

  const res = await h.post('/api/integrations/feex/webhook', {
    ticket_id: 'FEEX-1', user_email: 'dev@hub.ng', subject: 'Rate limits',
    description: '429s within documented limits', status: 'open', priority: 'high',
    ticket_url: 'https://feex.example/tickets/FEEX-1'
  }, { apiKey });

  assert.equal(res.status, 201);

  const fb = h.db.prepare('SELECT * FROM feedback WHERE external_ticket_id = ?').get('FEEX-1');
  assert.equal(fb.user_id, user.id);
  assert.equal(fb.feex_status, 'open');
  assert.equal(fb.feex_priority, 'high');

  const logged = h.db.prepare("SELECT COUNT(*) as c FROM engagement_history WHERE user_id = ? AND type = 'complaint_received'")
    .get(user.id).c;
  assert.equal(logged, 1, 'the complaint is the engagement signal Dev Circle is here to capture');
});

test('a second callback on the same ticket updates it instead of duplicating it', async () => {
  h.makeUser({ email: 'dev@hub.ng' });
  const payload = { ticket_id: 'FEEX-1', user_email: 'dev@hub.ng', subject: 'Rate limits' };

  await h.post('/api/integrations/feex/webhook', { ...payload, status: 'open' }, { apiKey });
  await h.post('/api/integrations/feex/webhook', { ...payload, status: 'resolved' }, { apiKey });

  assert.equal(h.db.prepare('SELECT COUNT(*) as c FROM feedback').get().c, 1);
  assert.equal(h.db.prepare('SELECT feex_status FROM feedback').get().feex_status, 'resolved');
});

test('Dev Circle will not edit a ticket that belongs to Feex', async () => {
  h.makeUser({ email: 'dev@hub.ng' });
  await h.post('/api/integrations/feex/webhook',
    { ticket_id: 'FEEX-1', user_email: 'dev@hub.ng', subject: 'x', status: 'open' }, { apiKey });

  const fb = h.db.prepare('SELECT id FROM feedback').get();
  const res = await h.put(`/api/admin/feedback/${fb.id}`, { status: 'resolved' }, { token });

  // Feex handles the ticket end to end; Dev Circle only mirrors it
  assert.equal(res.status, 409);
  assert.equal(h.db.prepare('SELECT feex_status FROM feedback').get().feex_status, 'open');
});

test('feedback raised inside Dev Circle can still be triaged', async () => {
  const user = h.makeUser();
  const userToken = await h.loginUser(user.email);

  const created = await h.post('/api/feedback',
    { content: 'The webhook retry intervals are undocumented.', category: 'documentation' },
    { token: userToken });
  assert.equal(created.status, 201);

  const res = await h.put(`/api/admin/feedback/${created.body.feedback.id}`,
    { status: 'reviewed' }, { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.feedback.status, 'reviewed');
});
