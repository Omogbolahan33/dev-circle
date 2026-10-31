const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

before(h.start);
after(h.stop);

let userToken;
let member;

beforeEach(async () => {
  h.reset();
  h.makeRootCircle();
  member = h.makeUser();
  userToken = await h.loginUser(member.email);
});

test('Developer Circle participation consent can be granted and withdrawal permanently deletes the account', async () => {
  const granted = await h.post('/api/users/participation-consent', {}, { token: userToken });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.ok(granted.body.participation_consent.granted_at);

  const first = await h.del('/api/users/participation-consent', { token: userToken });
  assert.equal(first.status, 409);
  assert.equal(first.body.confirm_required, true);
  assert.match(first.body.error, /permanently deletes your account/);

  const sessionsBefore = Number(h.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE subject_id = ?').get(member.id).c);
  assert.ok(sessionsBefore > 0);

  const removed = await h.del('/api/users/participation-consent?confirm=true', { token: userToken });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(h.db.prepare('SELECT id FROM users WHERE id = ?').get(member.id), undefined);
  assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE subject_id = ?').get(member.id).c), 0);
  assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS c FROM developer_circle_consent WHERE user_id = ?').get(member.id).c), 0);
});
