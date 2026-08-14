const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(h.start);
after(h.stop);

let readOnlyToken;
let superToken;

beforeEach(async () => {
  h.reset();
  h.makeRootCircle();

  const readOnlyRole = h.makeRole('Read Only', ['members.read', 'cohorts.read', 'surveys.read']);
  const superRole = h.makeRole('Super Admin', ['*']);

  const readOnly = h.makeAdmin({ email: 'viewer@cd.ng', roleId: readOnlyRole });
  const superAdmin = h.makeAdmin({ email: 'boss@cd.ng', roleId: superRole });

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
  ['POST', '/api/admin/circles', { name: 'x' }],
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

test('a read-only role cannot reset a member password', async () => {
  const user = h.makeUser();
  const res = await h.post(`/api/admin/members/${user.id}/reset-password`,
    { new_password: 'newpassword123' }, { token: readOnlyToken });
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
  const user = h.makeUser({ password: 'dev-password' });
  const token = await h.loginUser(user.email, 'dev-password');

  const res = await h.get('/api/admin/members', { token });
  assert.equal(res.status, 403);
});

test('changing an admin role takes effect immediately, not at token expiry', async () => {
  const role = h.makeRole('Editor', ['members.read', 'surveys.read', 'surveys.write']);
  const editor = h.makeAdmin({ email: 'editor@cd.ng', roleId: role });
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
  const me = h.db.prepare("SELECT id FROM admin_users WHERE email = 'boss@cd.ng'").get();
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
  h.makeAdmin({ email: 'temp@cd.ng', roleId: role });

  const res = await h.del(`/api/admin/roles/${role}`, { token: superToken });
  assert.equal(res.status, 409);
});
