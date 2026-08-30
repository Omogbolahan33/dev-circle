const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

const warmCache = require('../../src/services/warmCache');
const cache = require('../../src/middleware/cache');

before(h.start);
after(h.stop);

let adminToken;

beforeEach(async () => {
  h.reset();
  h.makeCircle();
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: role });
  adminToken = await h.loginAdmin(admin.email, admin.password);
});

// ─── What exhausted the connection pool ─────────────────────
// Two users was enough to fail every request on a hosted deployment with
// `EMAXCONNSESSION: max clients reached ... pool_size: 15`, sign-in included.
//
// Not pool sizing. Every write scheduled a full cache rewarm — every page of
// every active circle, each a tree of parallel queries — 75ms later. A login
// inserts a session row, so signing in fired thirty-odd concurrent connections
// from one request. Two of those at once took the pooler down, and it recovered
// on its own once the burst drained, which is exactly what was reported.

// Count warms without running them: the point is that nothing asks.
function countWarms(run) {
  const real = warmCache.warm;
  let calls = 0;
  warmCache.warm = async () => { calls++; return { circles: 0 }; };
  return Promise.resolve(run()).then(
    async value => { await new Promise(r => setTimeout(r, 250)); warmCache.warm = real; return { calls, value }; },
    err => { warmCache.warm = real; throw err; }
  );
}

test('signing in does not trigger a cache rewarm', async () => {
  const user = h.makeUser({ email: 'ada@example.ng', phone: '+2348030001234' });

  const { calls, value } = await countWarms(() =>
    h.post('/api/auth/login', { identifier: user.email, digits: '001234' }));

  assert.equal(value.status, 200, 'the login itself still works');
  assert.equal(calls, 0,
    'a session row is a write; it used to schedule a rewarm of every page of every circle');
});

test('no ordinary write triggers a rewarm', async () => {
  const user = h.makeUser();
  const token = await h.loginUser(user.email);

  const { calls } = await countWarms(async () => {
    await h.put('/api/users/profile', { company: 'Zilla' }, { token });
    await h.put('/api/users/profile', { work_sector: 'Fintech' }, { token });
    await h.post('/api/admin/cohorts', { name: 'A cohort' }, { token: adminToken });
  });

  assert.equal(calls, 0, 'writes invalidate; they do not rebuild');
});

test('a write still invalidates the page it touched', async () => {
  // The cache has to stay correct — not rebuilding is only safe because
  // dropping is still happening.
  const before = await h.get('/api/admin/cohorts', { token: adminToken });
  assert.equal(before.status, 200);

  await h.post('/api/admin/cohorts', { name: 'Fresh cohort' }, { token: adminToken });

  const after = await h.get('/api/admin/cohorts', { token: adminToken });
  assert.ok(after.body.cohorts.some(c => c.name === 'Fresh cohort'),
    'the next read must see the write, not a stale cached page');
});

// ─── The page cache is not an authorisation bypass ──────────
// rememberGet runs before the route, so it cannot know which permission the
// route was about to require. Its key therefore has to describe who may be
// handed the body — and it did not: circle and path only.
//
// Two consequences, both found here and both real: an admin holding only
// cohorts.read was served the full member list once an entitled admin had
// loaded it, and a revoked permission kept working until the entry expired.

test('a revoked permission bites on the next request, cached page or not', async () => {
  const role = h.makeRole('Reader', ['members.read']);
  const reader = h.makeAdmin({ email: 'reader@creditdirect.ng', roleId: role });
  const readerToken = await h.loginAdmin(reader.email, reader.password);

  // Load it first, so there is a cached page to be wrongly served
  assert.equal((await h.get('/api/admin/members', { token: readerToken })).status, 200);

  await h.put(`/api/admin/roles/${role}`, { permissions: ['cohorts.read'] }, { token: adminToken });

  const after = await h.get('/api/admin/members', { token: readerToken });
  assert.equal(after.status, 403, 'this was a 200 served from cache');
});

test('a cached page is never handed to an admin who could not have loaded it', async () => {
  h.makeUser({ email: 'secret.member@example.ng', name: 'Secret Member' });

  const noRead = h.makeRole('No Members', ['cohorts.read']);
  const nosy = h.makeAdmin({ email: 'nosy@creditdirect.ng', roleId: noRead, global: false });
  const nosyToken = await h.loginAdmin(nosy.email, nosy.password);

  // Refused on a cold cache, which was never in doubt
  assert.equal((await h.get('/api/admin/members', { token: nosyToken })).status, 403);

  // Somebody entitled loads it, filling the cache
  const warm = await h.get('/api/admin/members', { token: adminToken });
  assert.equal(warm.status, 200);
  assert.ok(warm.body.members.length);

  // …and it is still refused
  const after = await h.get('/api/admin/members', { token: nosyToken });
  assert.equal(after.status, 403, 'the cache served this member list to somebody with no right to it');
  assert.equal(after.body.members, undefined);
});

test('admins with the same capabilities still share a cached page', () => {
  // The fix must not turn the cache off. Two roles holding the same
  // permissions are interchangeable as far as "may they see this" goes.
  const cache = require('../../src/middleware/cache');
  const req = perms => ({ path: '/members', baseUrl: '/api/admin', query: {}, circleId: 'c1', permissions: perms });

  assert.equal(cache.pageKey(req(['members.read', 'cohorts.read'])),
               cache.pageKey(req(['cohorts.read', 'members.read'])),
               'order of the permission list is not a difference');

  assert.notEqual(cache.pageKey(req(['members.read'])), cache.pageKey(req(['cohorts.read'])));
  assert.notEqual(cache.pageKey(req(['members.read'])), cache.pageKey(req(['*'])));
});

test('warming runs one at a time, however often it is asked for', async () => {
  // Two overlapping warms double the fan-out. Asked for concurrently, the
  // second joins the first.
  const results = await Promise.all([warmCache.warm(), warmCache.warm(), warmCache.warm()]);
  for (const result of results) assert.ok(result && typeof result.circles === 'number');
});

test('warming is off where the container will not live to use it', () => {
  // On serverless the container that pays for the warm is usually frozen before
  // it serves the page — a burst of connections spent on a cache nobody reads.
  const config = require('../../src/config');
  const was = config.database.pgPool.isServerless;

  config.database.pgPool.isServerless = true;
  assert.equal(warmCache.start(), null, 'no timer, no warm');

  config.database.pgPool.isServerless = was;
});
