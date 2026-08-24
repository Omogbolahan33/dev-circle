const circles = require('../services/circles');
const { permissionsFor } = require('./auth');

// ─── Working inside a circle ────────────────────────────────
// Every admin request happens in one workspace. Which one comes from the
// X-Circle-Id header (or ?circle_id), and falls back to the first circle this
// staff member can reach — so a single-workspace install needs no ceremony.
//
// This also decides what they may do there. A role is now granted *within* a
// circle, so permissions are resolved per request rather than once at sign-in:
// a CDL rep for one workspace has none in another.

async function circleContext(req, res, next) {
  // Only staff work inside a circle; members reach their own data by identity
  if (!req.isAdmin) return next();

  const requested = req.headers['x-circle-id'] || req.query.circle_id || null;
  const available = await circles.forAdmin(req.admin);

  if (!available.length) {
    return res.status(403).json({
      error: 'You have not been given access to any circle yet.',
      circles: []
    });
  }

  const circle = requested
    ? available.find(c => c.id === requested || c.slug === requested)
    : available[0];

  if (!circle) {
    // Naming a circle they cannot reach is refused rather than quietly
    // answered with a different one's data
    return res.status(403).json({
      error: 'You do not have access to that circle.',
      circles: available.map(c => ({ id: c.id, name: c.name, slug: c.slug }))
    });
  }

  req.circle = circle;
  req.circleId = circle.id;
  req.availableCircles = available;

  // Permissions belong to the role held in *this* circle
  const roleId = await circles.roleFor(req.admin, circle.id);
  req.permissions = await permissionsFor({ ...req.admin, role_id: roleId });

  // So a client can tell which workspace answered
  res.setHeader('X-Circle-Id', circle.id);

  next();
}

// Creating circles, and reaching across them, is the tier above
function requireGlobalAdmin(req, res, next) {
  if (!req.admin?.is_global) {
    return res.status(403).json({
      error: 'Only Credit Direct staff with access across circles can do this.'
    });
  }
  next();
}

module.exports = { circleContext, requireGlobalAdmin };
