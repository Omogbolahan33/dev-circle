const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');

before(h.start);
after(h.stop);

beforeEach(() => {
  h.reset();
  h.makeRootCircle();
});

test('unauthenticated request to /api/users/readiness is refused', async () => {
  const res = await h.get('/api/users/readiness');
  assert.equal(res.status, 401);
});

test('a member with unconfigured available time has Ring 2 incomplete on their dashboard metric', async () => {
  // Create member with profile details and consent, but default empty preferred_days
  const user = h.makeUser({
    name: 'Bimpe Ade',
    company: 'Moniepoint',
    work_sector: 'Fintech',
    preferred_days: [],
    preferred_time_start: '10:00',
    preferred_time_end: '14:00',
    preferred_channels: ['email']
  });
  h.grantConsent(user.id, 'email');

  const token = await h.loginUser(user.email);

  // 1. GET /api/users/readiness
  const readinessRes = await h.get('/api/users/readiness', { token });
  assert.equal(readinessRes.status, 200);

  const readiness = readinessRes.body;
  assert.equal(readiness.total_rings, 3);
  assert.equal(readiness.completed_rings, 2, '2 of 3 rings complete');
  assert.equal(readiness.is_complete, false);

  const ring1 = readiness.rings.find(r => r.id === 'profile');
  const ring2 = readiness.rings.find(r => r.id === 'availability');
  const ring3 = readiness.rings.find(r => r.id === 'channels');

  assert.equal(ring1.is_complete, true);
  assert.equal(ring1.percentage, 100);

  // Ring 2 is incomplete because available days are not selected
  assert.equal(ring2.is_complete, false);
  assert.equal(ring2.name, 'Available Time');
  assert.equal(ring2.action_url, '/member/profile.html#availability');

  assert.equal(ring3.is_complete, true);
  assert.equal(ring3.percentage, 100);

  // Unfinished tasks checklist
  const availTask = readiness.unfinished_tasks.find(t => t.ring_id === 'availability');
  assert.ok(availTask, 'Unfinished available time task surfaced');
  assert.equal(availTask.task_key, 'preferred_days');

  // Next action directs user to available time
  assert.equal(readiness.next_action.ring_id, 'availability');
  assert.match(readiness.next_action.headline, /available time/i);

  // 2. Also verified in GET /api/users/profile
  const profileRes = await h.get('/api/users/profile', { token });
  assert.equal(profileRes.status, 200);
  assert.ok(profileRes.body.readiness);
  assert.equal(profileRes.body.readiness.completed_rings, 2);
  assert.equal(profileRes.body.readiness.is_complete, false);
});

test('updating available time completes Ring 2 and closes all 3 rings', async () => {
  const user = h.makeUser({
    name: 'Bimpe Ade',
    company: 'Moniepoint',
    work_sector: 'Fintech',
    preferred_days: [],
    preferred_channels: ['email']
  });
  h.grantConsent(user.id, 'email');

  const token = await h.loginUser(user.email);

  // Initially incomplete
  const beforeRes = await h.get('/api/users/readiness', { token });
  assert.equal(beforeRes.body.completed_rings, 2);

  // Member updates their available time on profile
  const updateRes = await h.put('/api/users/profile', {
    preferred_days: ['Mon', 'Wed', 'Fri'],
    preferred_time_start: '10:00',
    preferred_time_end: '16:00'
  }, { token });
  assert.equal(updateRes.status, 200);

  // After update: Ring 2 is completed, closing all 3 rings
  const afterRes = await h.get('/api/users/readiness', { token });
  assert.equal(afterRes.status, 200);
  assert.equal(afterRes.body.completed_rings, 3);
  assert.equal(afterRes.body.is_complete, true);
  assert.equal(afterRes.body.overall_percentage, 100);

  const ring2 = afterRes.body.rings.find(r => r.id === 'availability');
  assert.equal(ring2.is_complete, true);
  assert.equal(ring2.percentage, 100);
  assert.equal(afterRes.body.unfinished_tasks.length, 0);
  assert.match(afterRes.body.summary, /All 3 rings closed/);
});
