const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

before(h.start);
after(h.stop);

let readOnlyToken;
let superToken;

beforeEach(async () => {
  h.reset();
  h.makeRootCircle();

  const readOnlyRole = h.makeRole('Read Only', ['members.read', 'cohorts.read', 'surveys.read']);
  const superRole = h.makeRole('Super Admin', ['*']);

  const readOnly = h.makeAdmin({ email: 'viewer@creditdirect.ng', roleId: readOnlyRole });
  const superAdmin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: superRole });

  readOnlyToken = await h.loginAdmin(readOnly.email, readOnly.password);
  superToken = await h.loginAdmin(superAdmin.email, superAdmin.password);
});

// Every one of these was permitted before permissions were enforced —
// requirePermission existed but no route used it.
const FORBIDDEN_FOR_READ_ONLY = [
  ['POST', '/api/admin/surveys', { title: 'x', questions: [] }],
  ['POST', '/api/admin/cohorts', { name: 'x' }],
  ['POST', '/api/admin/blasts', { content: 'x', channel: 'email', target_type: 'all' }],
  ['POST', '/api/admin/roles', { name: 'x', permissions: ['members.read'] }],
  ['POST', '/api/admin/api-keys', { name: 'x' }],
  ['POST', '/api/admin/import', { users: [] }],
  ['POST', '/api/admin/gifts', { name: 'x' }],
  ['POST', '/api/admin/sessions', { title: 'x', scheduled_for: '2027-01-01 10:00:00' }]
];

for (const [method, endpoint] of FORBIDDEN_FOR_READ_ONLY) {
  test(`a read-only role cannot ${method} ${endpoint}`, async () => {
    const body = FORBIDDEN_FOR_READ_ONLY.find(r => r[1] === endpoint)[2];
    const res = await h.call(method, endpoint, { token: readOnlyToken, body });
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });
}

test('a read-only role cannot export member data', async () => {
  const res = await h.get('/api/admin/export?format=csv', { token: readOnlyToken });
  assert.equal(res.status, 403);
});

test('a read-only role cannot sign a member out of their devices', async () => {
  const user = h.makeUser();
  const res = await h.post(`/api/admin/members/${user.id}/sign-out`, {}, { token: readOnlyToken });
  assert.equal(res.status, 403);
});

test('a read-only role can still read what it is allowed to read', async () => {
  h.makeUser();
  const members = await h.get('/api/admin/members', { token: readOnlyToken });
  assert.equal(members.status, 200);
  assert.equal(members.body.members.length, 1);
});

test('a super admin passes every gate', async () => {
  for (const [method, endpoint, body] of FORBIDDEN_FOR_READ_ONLY) {
    const res = await h.call(method, endpoint, { token: superToken, body });
    assert.notEqual(res.status, 403, `super admin was blocked from ${method} ${endpoint}`);
  }
});

test('a member token cannot reach admin endpoints at all', async () => {
  const user = h.makeUser();
  const token = await h.loginUser(user.email);

  const res = await h.get('/api/admin/members', { token });
  assert.equal(res.status, 403);
});

test('changing an admin role takes effect immediately, not at token expiry', async () => {
  const role = h.makeRole('Editor', ['members.read', 'surveys.read', 'surveys.write']);
  const editor = h.makeAdmin({ email: 'editor@creditdirect.ng', roleId: role });
  const token = await h.loginAdmin(editor.email, editor.password);

  const before = await h.post('/api/admin/surveys', { title: 'x', questions: [] }, { token });
  assert.equal(before.status, 201);

  const readOnlyRole = h.db.prepare("SELECT id FROM roles WHERE name = 'Read Only'").get().id;
  await h.put(`/api/admin/admins/${editor.id}`, { role_id: readOnlyRole }, { token: superToken });

  const after = await h.post('/api/admin/surveys', { title: 'y', questions: [] }, { token });
  assert.equal(after.status, 401, 'the old session must be revoked when the role changes');
});

test('a role cannot be built from a permission that gates nothing', async () => {
  const res = await h.post('/api/admin/roles',
    { name: 'Ghost', permissions: ['members.read', 'members.teleport'] },
    { token: superToken });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /members\.teleport/);
});

test('an admin cannot deactivate their own account', async () => {
  const me = h.db.prepare("SELECT id FROM admin_users WHERE email = 'boss@creditdirect.ng'").get();
  const res = await h.put(`/api/admin/admins/${me.id}`, { status: 'inactive' }, { token: superToken });
  assert.equal(res.status, 400);
});

test('a system role cannot be edited or deleted', async () => {
  const id = h.uuid();
  h.db.prepare('INSERT INTO roles (id, name, permissions, is_system) VALUES (?, ?, ?, 1)')
    .run(id, 'Locked', JSON.stringify(['*']));

  const edit = await h.put(`/api/admin/roles/${id}`, { name: 'Renamed' }, { token: superToken });
  assert.equal(edit.status, 400);

  const remove = await h.del(`/api/admin/roles/${id}`, { token: superToken });
  assert.equal(remove.status, 400);
});

test('a role still assigned to an admin cannot be deleted', async () => {
  const role = h.makeRole('Temp', ['members.read']);
  h.makeAdmin({ email: 'temp@creditdirect.ng', roleId: role });

  const res = await h.del(`/api/admin/roles/${role}`, { token: superToken });
  assert.equal(res.status, 409);
});

// ─── Giving a role to somebody ──────────────────────────────
// A role nobody holds is a list of words. These are the paths the Roles page
// drives to turn one into access a colleague actually has.

test('an administrator is created with a role and can sign in with it', async () => {
  const role = h.makeRole('Engagement lead', ['members.read', 'surveys.write']);

  const created = await h.post('/api/admin/admins', {
    name: 'Tunde Bakare', email: 'tunde@creditdirect.ng',
    password: 'a-long-enough-password', role_id: role
  }, { token: superToken });

  assert.equal(created.status, 201);

  const login = await h.post('/api/auth/login', {
    identifier: 'tunde@creditdirect.ng', password: 'a-long-enough-password'
  });
  assert.equal(login.status, 200);
  assert.deepEqual(login.body.permissions.sort(), ['members.read', 'surveys.write']);

  // and the role now reports who holds it
  const roles = await h.get('/api/admin/roles', { token: superToken });
  assert.equal(roles.body.roles.find(r => r.id === role).admin_count, 1);
});

test('an administrator on a non-Credit Direct domain is refused', async () => {
  const role = h.makeRole('Contractor', ['members.read']);

  // The sign-in page reads the domain to decide whether to ask for a password,
  // so this account could never be used
  const res = await h.post('/api/admin/admins', {
    name: 'Outside Consultant', email: 'consultant@agency.ng',
    password: 'a-long-enough-password', role_id: role
  }, { token: superToken });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /Credit Direct/);
});

test('a weak or roleless administrator is refused', async () => {
  const role = h.makeRole('Helper', ['members.read']);

  const weak = await h.post('/api/admin/admins', {
    name: 'Ada', email: 'ada@creditdirect.ng', password: 'short', role_id: role
  }, { token: superToken });
  assert.equal(weak.status, 400);

  const roleless = await h.post('/api/admin/admins', {
    name: 'Ada', email: 'ada@creditdirect.ng', password: 'a-long-enough-password'
  }, { token: superToken });
  assert.equal(roleless.status, 400);
});

test('reassigning a role takes effect on the next sign-in, not at token expiry', async () => {
  const limited = h.makeRole('Limited', ['members.read']);
  const wide = h.makeRole('Wide', ['members.read', 'surveys.write']);
  const colleague = h.makeAdmin({ email: 'ada@creditdirect.ng', roleId: limited });

  const before = await h.loginAdmin(colleague.email, colleague.password);
  assert.equal((await h.post('/api/admin/surveys', { title: 'x', questions: [] }, { token: before })).status, 403);

  await h.put(`/api/admin/admins/${colleague.id}`, { role_id: wide }, { token: superToken });

  // The old session is gone rather than carrying stale permissions
  assert.equal((await h.get('/api/admin/members', { token: before })).status, 401);

  const after = await h.loginAdmin(colleague.email, colleague.password);
  assert.equal((await h.post('/api/admin/surveys', { title: 'x', questions: [] }, { token: after })).status, 201);
});

test('deactivating an administrator ends their access immediately', async () => {
  const role = h.makeRole('Helper', ['members.read']);
  const colleague = h.makeAdmin({ email: 'ada@creditdirect.ng', roleId: role });
  const token = await h.loginAdmin(colleague.email, colleague.password);

  await h.put(`/api/admin/admins/${colleague.id}`, { status: 'inactive' }, { token: superToken });

  assert.equal((await h.get('/api/admin/members', { token })).status, 401);
  const login = await h.post('/api/auth/login', { identifier: colleague.email, password: colleague.password });
  assert.equal(login.status, 403);
});

test('a staff password can be reset, which signs them out everywhere', async () => {
  const role = h.makeRole('Helper', ['members.read']);
  const colleague = h.makeAdmin({ email: 'ada@creditdirect.ng', roleId: role });
  const token = await h.loginAdmin(colleague.email, colleague.password);

  const res = await h.post(`/api/admin/admins/${colleague.id}/reset-password`,
    { new_password: 'a-brand-new-password' }, { token: superToken });
  assert.equal(res.status, 200);

  assert.equal((await h.get('/api/admin/members', { token })).status, 401, 'the old session must not survive');

  const withOld = await h.post('/api/auth/login', { identifier: colleague.email, password: colleague.password });
  assert.equal(withOld.status, 401);

  const withNew = await h.post('/api/auth/login', { identifier: colleague.email, password: 'a-brand-new-password' });
  assert.equal(withNew.status, 200);
});

test('a read-only role can see who has access but not change it', async () => {
  const role = h.makeRole('Helper', ['members.read']);
  const colleague = h.makeAdmin({ email: 'ada@creditdirect.ng', roleId: role });

  // Read-only here holds members.read/cohorts.read/surveys.read — no roles.read
  const list = await h.get('/api/admin/admins', { token: readOnlyToken });
  assert.equal(list.status, 403);

  const assign = await h.put(`/api/admin/admins/${colleague.id}`, { role_id: role }, { token: readOnlyToken });
  assert.equal(assign.status, 403);

  const reset = await h.post(`/api/admin/admins/${colleague.id}/reset-password`,
    { new_password: 'a-long-enough-password' }, { token: readOnlyToken });
  assert.equal(reset.status, 403);
});
