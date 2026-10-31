const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

before(h.start);
after(h.stop);

let token;
beforeEach(async () => {
  h.reset();
  h.makeRootCircle();
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: role });
  token = await h.loginAdmin(admin.email, admin.password);
});

test('member deletion requires confirmation and removes the account and linked data', async () => {
  const user = h.makeUser();
  await h.loginUser(user.email); // create an auth session that deletion must revoke

  const first = await h.del(`/api/admin/members/${user.id}`, { token });
  assert.equal(first.status, 409);
  assert.equal(first.body.confirm_required, true);

  const removed = await h.del(`/api/admin/members/${user.id}?confirm=true`, { token });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(h.db.prepare('SELECT id FROM users WHERE id = ?').get(user.id), undefined);
  assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE subject_id = ?').get(user.id).c), 0);
});
