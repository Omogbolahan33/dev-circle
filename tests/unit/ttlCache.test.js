const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTtlCache } = require('../../src/utils/ttlCache');
const cache = require('../../src/middleware/cache');

describe('ttl cache', () => {
  it('returns what was stored until it expires', () => {
    const map = createTtlCache({ ttlMs: 60_000, max: 4 });
    map.set('a', { n: 1 });
    assert.deepEqual(map.get('a'), { n: 1 });
  });

  it('drops the oldest entry when it is full', () => {
    const map = createTtlCache({ ttlMs: 60_000, max: 2 });
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    assert.equal(map.get('a'), undefined);
    assert.equal(map.get('b'), 2);
    assert.equal(map.get('c'), 3);
  });

  it('a write to members drops page bodies but not a live session', () => {
    cache.clearAll();
    cache.principals.set(cache.authKey('abc'), { ok: true });
    cache.pages.set('l|/api/admin/members||', { members: [] });
    cache.noteWrite('INSERT INTO users (id) VALUES (?)');
    assert.equal(cache.pages.get('l|/api/admin/members||'), undefined);
    assert.deepEqual(cache.principals.get(cache.authKey('abc')), { ok: true });
  });

  it('deleting a session drops the principal', () => {
    cache.clearAll();
    cache.principals.set(cache.authKey('abc'), { ok: true });
    cache.noteWrite('DELETE FROM sessions WHERE subject_id = ?');
    assert.equal(cache.principals.get(cache.authKey('abc')), undefined);
  });

  it('inserting a session keeps other principals', () => {
    cache.clearAll();
    cache.principals.set(cache.authKey('abc'), { ok: true });
    cache.noteWrite('INSERT INTO sessions (token_hash, subject_id) VALUES (?, ?)');
    assert.deepEqual(cache.principals.get(cache.authKey('abc')), { ok: true });
  });
});
