// Tiny in-process TTL map. Not shared across Render instances — each
// dyno keeps what it has already paid to load. Writes go through
// noteWrite and drop the entries, so a stale list cannot outlive a change.

function createTtlCache({ ttlMs = 30_000, max = 400 } = {}) {
  const map = new Map();

  function get(key) {
    const hit = map.get(key);
    if (!hit) return undefined;
    if (hit.exp <= Date.now()) {
      map.delete(key);
      return undefined;
    }
    map.delete(key);
    map.set(key, hit);
    return hit.value;
  }

  function has(key) {
    return get(key) !== undefined;
  }

  function set(key, value, ttl = ttlMs) {
    if (map.has(key)) map.delete(key);
    map.set(key, { value, exp: Date.now() + ttl });
    if (map.size > max) {
      const first = map.keys().next().value;
      map.delete(first);
    }
    return value;
  }

  function del(key) {
    map.delete(key);
  }

  function clear() {
    map.clear();
  }

  function invalidate(prefix) {
    for (const key of map.keys()) {
      if (key.startsWith(prefix)) map.delete(key);
    }
  }

  return { get, has, set, del, clear, invalidate, get size() { return map.size; } };
}

module.exports = { createTtlCache };
