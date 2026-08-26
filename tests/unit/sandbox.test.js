const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toSqlite } = require('../../src/db/sandbox');

test('undefined and null become null', () => {
  assert.equal(toSqlite(undefined), null);
  assert.equal(toSqlite(null), null);
});

test('strings, numbers, bigints and buffers pass through', () => {
  assert.equal(toSqlite('full'), 'full');
  assert.equal(toSqlite(1), 1);
  assert.equal(toSqlite(0), 0);
  assert.equal(toSqlite(7n), 7n);
  const buf = Buffer.from('x');
  assert.equal(toSqlite(buf), buf);
});

test('booleans become 0 or 1', () => {
  assert.equal(toSqlite(true), 1);
  assert.equal(toSqlite(false), 0);
});

test('a Date becomes an ISO string, an invalid Date becomes null', () => {
  const when = new Date('2026-08-24T12:00:00.000Z');
  assert.equal(toSqlite(when), '2026-08-24T12:00:00.000Z');
  assert.equal(toSqlite(new Date('not-a-date')), null);
});

test('objects and arrays are JSON, not bound as objects', () => {
  assert.equal(toSqlite({ a: 1 }), '{"a":1}');
  assert.equal(toSqlite(['*']), '["*"]');
});
