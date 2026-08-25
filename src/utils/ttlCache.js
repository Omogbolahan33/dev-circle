// Small in-process TTL map. Used to skip a Postgres round-trip on the hot
// path (session, circle access) when the answer cannot have changed.

function ttlCache({ ttlMs = 30_000, max = 500 } = {}) {
  const map = new Map();

  function get(key) {
    const hit = map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.exp) {
      map.delete(key);
      return undefined;
    }
    map.delete(key);
    map.set(key, hit);
    return hit.val;
  }

  function set(key, val) {
    if (map.has(key)) map.delete(key);
    else if (map.size >= max) map.delete(map.keys().next().value);
    map.set(key, { val, exp: Date.now() + ttlMs });
  }

  function del(key) { map.delete(key); }
  function clear() { map.clear(); }

  return { get, set, delete: del, clear };
}

// Collapse a stampede of identical lookups (dashboard + feedback fire
// together) into one query.
function singleflight() {
  const inflight = new Map();
  return function run(key, fn) {
    const existing = inflight.get(key);
    if (existing) return existing;
    const pending = Promise.resolve().then(fn).finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  };
}

module.exports = { ttlCache, singleflight };
