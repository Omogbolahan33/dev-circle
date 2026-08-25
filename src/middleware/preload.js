// Start a page query on a second pool connection while requireAuth is still
// waiting on the session JOIN. Remote Postgres is one RTT per statement;
// overlapping the two is what turns a 260ms list GET into a 130ms one.
//
// The console already sends X-Circle-Id. Without it we cannot know the
// workspace yet (circleContext picks the first reachable one after auth),
// so the handler falls through to its own query.

function circleHint(req) {
  return req.headers['x-circle-id'] || req.query.circle_id || null;
}

function preload(fn) {
  return (req, res, next) => {
    req._preload = Promise.resolve().then(() => fn(req));
    next();
  };
}

async function takePreload(req, fallback) {
  if (Object.prototype.hasOwnProperty.call(req, '_preload')) {
    const value = await req._preload;
    if (value != null) return value;
  }
  return fallback();
}

module.exports = { preload, takePreload, circleHint };
