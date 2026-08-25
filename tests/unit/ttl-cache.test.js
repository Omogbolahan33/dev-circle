const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ttlCache, singleflight } = require('../../src/utils/ttlCache');

test('ttlCache expires entries', () => {
  const cache = ttlCache({ ttlMs: 20, max: 10 });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
});

test('ttlCache evicts the oldest when full', () => {
  const cache = ttlCache({ ttlMs: 60_000, max: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
});

test('singleflight coalesces concurrent callers', async () => {
  const run = singleflight();
  let calls = 0;
  const work = () => new Promise(resolve => {
    calls++;
    setTimeout(() => resolve(calls), 15);
  });
  const [a, b] = await Promise.all([run('k', work), run('k', work)]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(calls, 1);
});
