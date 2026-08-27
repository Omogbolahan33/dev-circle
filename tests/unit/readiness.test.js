const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeReadiness } = require('../../src/services/readiness');

test('null user returns null', () => {
  assert.equal(computeReadiness(null), null);
  assert.equal(computeReadiness(undefined), null);
});

test('a newly registered user without available time leaves Ring 2 incomplete', () => {
  const user = {
    id: 'u1',
    name: 'Tunde Bakare',
    phone: '+2348012345678',
    company: 'Sterling',
    work_sector: 'Banking',
    preferred_days: '[]',
    preferred_time_start: '10:00',
    preferred_time_end: '14:00',
    preferred_channels: '["email"]'
  };
  const consent = [{ channel: 'email', status: 'granted' }];

  const readiness = computeReadiness(user, consent);

  assert.equal(readiness.total_rings, 3);
  assert.equal(readiness.completed_rings, 2, 'Two rings closed, leaving availability incomplete');
  assert.equal(readiness.is_complete, false);

  const ring1 = readiness.rings.find(r => r.id === 'profile');
  const ring2 = readiness.rings.find(r => r.id === 'availability');
  const ring3 = readiness.rings.find(r => r.id === 'channels');

  assert.equal(ring1.is_complete, true);
  assert.equal(ring1.percentage, 100);

  // Ring 2: Available time is incomplete because days are not set
  assert.equal(ring2.is_complete, false);
  assert.equal(ring2.percentage, 50);
  assert.equal(ring2.name, 'Available Time');

  const daysTask = ring2.tasks.find(t => t.key === 'preferred_days');
  assert.equal(daysTask.done, false);

  assert.equal(ring3.is_complete, true);
  assert.equal(ring3.percentage, 100);

  // Unfinished progress keeping them back
  assert.ok(readiness.unfinished_tasks.length > 0);
  const availUnfinished = readiness.unfinished_tasks.find(t => t.ring_id === 'availability');
  assert.ok(availUnfinished);
  assert.equal(availUnfinished.task_key, 'preferred_days');
  assert.equal(availUnfinished.action_url, '/member/profile.html#availability');

  assert.match(readiness.summary, /2 of 3 rings complete/);
  assert.match(readiness.summary, /Available Time/);
  assert.match(readiness.next_action.headline, /available time/i);
});

test('updating available time completes Ring 2 and closes all 3 rings', () => {
  const user = {
    id: 'u1',
    name: 'Tunde Bakare',
    phone: '+2348012345678',
    company: 'Sterling',
    work_sector: 'Banking',
    preferred_days: ['Mon', 'Wed', 'Fri'],
    preferred_time_start: '09:00',
    preferred_time_end: '17:00',
    preferred_channels: ['email', 'whatsapp']
  };
  const consent = [
    { channel: 'email', status: 'granted' },
    { channel: 'whatsapp', status: 'granted' }
  ];

  const readiness = computeReadiness(user, consent);

  assert.equal(readiness.completed_rings, 3);
  assert.equal(readiness.is_complete, true);
  assert.equal(readiness.overall_percentage, 100);

  const ring2 = readiness.rings.find(r => r.id === 'availability');
  assert.equal(ring2.is_complete, true);
  assert.equal(ring2.percentage, 100);
  assert.equal(readiness.unfinished_tasks.length, 0);
  assert.match(readiness.summary, /All 3 rings closed/);
  assert.equal(readiness.next_action, null);
});

test('missing work sector or company leaves Ring 1 incomplete', () => {
  const user = {
    id: 'u2',
    name: 'Kemi Adebayo',
    phone: '+2348098765432',
    company: '', // missing
    work_sector: null, // missing
    preferred_days: ['Tue', 'Thu'],
    preferred_time_start: '10:00',
    preferred_time_end: '14:00',
    preferred_channels: ['email']
  };
  const consent = [{ channel: 'email', status: 'granted' }];

  const readiness = computeReadiness(user, consent);
  const ring1 = readiness.rings.find(r => r.id === 'profile');

  assert.equal(ring1.is_complete, false);
  assert.equal(ring1.percentage, 50); // 2 of 4 tasks done
  assert.equal(readiness.completed_rings, 2);
  assert.equal(readiness.is_complete, false);

  const missingKeys = readiness.unfinished_tasks.filter(t => t.ring_id === 'profile').map(t => t.task_key);
  assert.deepEqual(missingKeys.sort(), ['company', 'work_sector'].sort());
});

test('missing channel consent leaves Ring 3 incomplete', () => {
  const user = {
    id: 'u3',
    name: 'Ifeanyi Okoli',
    phone: '+2348011223344',
    company: 'Flutterwave',
    work_sector: 'Fintech',
    preferred_days: ['Mon', 'Tue', 'Wed'],
    preferred_time_start: '10:00',
    preferred_time_end: '16:00',
    preferred_channels: ['email']
  };
  const consent = [{ channel: 'email', status: 'withdrawn' }]; // withdrawn, not granted

  const readiness = computeReadiness(user, consent);
  const ring3 = readiness.rings.find(r => r.id === 'channels');

  assert.equal(ring3.is_complete, false);
  assert.equal(ring3.percentage, 50); // channels selected, but consent not granted
  assert.equal(readiness.completed_rings, 2);

  const consentTask = readiness.unfinished_tasks.find(t => t.task_key === 'consent');
  assert.ok(consentTask);
});
