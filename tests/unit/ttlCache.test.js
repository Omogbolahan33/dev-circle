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
    assert.equal(cache.pages.get('l|/api/admin/members|||*'), undefined);
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

  it('touching last_used_at does not drop a list', () => {
    cache.clearAll();
    cache.putPage('/members', { body: { members: [1] } });
    cache.noteWrite("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?");
    assert.deepEqual(cache.pages.get('l|/api/admin/members|||*'), { members: [1] });
  });

  it('a survey write drops surveys and the overview, not roles', () => {
    cache.clearAll();
    cache.putPage('/surveys', { body: { surveys: [] } });
    cache.putPage('/dashboard', { body: { stats: {} } });
    cache.putPage('/roles', { body: { roles: [1] } });
    cache.noteWrite('INSERT INTO surveys (id, title) VALUES (?, ?)');
    assert.equal(cache.pages.get('l|/api/admin/surveys|||*'), undefined);
    assert.equal(cache.pages.get('l|/api/admin/dashboard|||*'), undefined);
    assert.deepEqual(cache.pages.get('l|/api/admin/roles|||*'), { roles: [1] });
  });

  it('names the table a statement writes', () => {
    assert.deepEqual(cache.tablesTouched('INSERT INTO surveys (id) VALUES (?)'), ['surveys']);
    assert.deepEqual(cache.tablesTouched('UPDATE users SET status = ? WHERE id = ?'), ['users']);
    assert.deepEqual(cache.tablesTouched('DELETE FROM sessions WHERE token_hash = ?'), ['sessions']);
  });

  it('a warmed page uses the same key the request will look up', () => {
    cache.clearAll();
    cache.putPage('/dashboard', { circleId: 'circ-1', body: { stats: { total_members: 0 } } });
    // Warming has no requester, so what it loads is stored against `*` and read
    // by admins who hold everything. Anyone narrower fills their own.
    const req = permissions => ({
      method: 'GET',
      path: '/dashboard',
      baseUrl: '/api/admin',
      query: {},
      headers: { 'x-circle-id': 'circ-1' },
      circleId: 'circ-1',
      permissions
    });

    assert.deepEqual(cache.peekPage(req(['*'])), { stats: { total_members: 0 } });
  });

  it('a warmed page is not handed to an admin who holds less than everything', () => {
    cache.clearAll();
    cache.putPage('/dashboard', { circleId: 'circ-1', body: { stats: { total_members: 0 } } });

    const narrow = {
      method: 'GET', path: '/dashboard', baseUrl: '/api/admin', query: {},
      headers: { 'x-circle-id': 'circ-1' }, circleId: 'circ-1',
      permissions: ['cohorts.read']
    };

    assert.equal(cache.peekPage(narrow), undefined,
      'nobody checked whether this admin may see the overview, so it is not theirs to be handed');
  });
});
