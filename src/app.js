const express = require('express');
const cors = require('cors');
const path = require('path');

const config = require('./config');
const { requestLogger } = require('./utils/logger');
const { rateLimit } = require('./middleware/rateLimit');
const { securityHeaders, allowFraming } = require('./middleware/security');
const {
  jsonSyntaxHandler, normalizeBody, errorHandler
} = require('./middleware/errorHandler');

// Initialise the database (creates the schema and applies migrations)
require('./db');

// ─── Application ────────────────────────────────────────────
// Builds and exports the Express app without listening, so the test suite can
// mount it on an ephemeral port. Starting the process is server.js's job.

const app = express();

// Rate limiting and login throttling need the real client address when
// running behind a proxy or load balancer.
app.set('trust proxy', config.isProduction ? 1 : false);
app.disable('x-powered-by');

app.use(cors({
  origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(jsonSyntaxHandler);
app.use(normalizeBody);
app.use(securityHeaders);

// Only public/ is reachable over HTTP. Serving the project root used to
// publish the entire codebase — /src/config/index.js and any .env with it.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Brand assets someone uploaded — a wordmark, a background, a brand font.
// Served by a route rather than by the static handler above, because the
// content type has to come from the bytes rather than from the extension: a
// file called logo.png full of HTML must not be served as HTML from our own
// origin. Unauthenticated on purpose — a survey answered over a public link
// has to be able to load its own logo — and the name is unguessable, which is
// the only thing standing in front of it.
// When Supabase Storage is configured, tries Supabase first (async), then
// falls back to local disk.
app.get('/uploads/{*name}', async (req, res) => {
  const uploads = require('./services/uploads');
  const name = Array.isArray(req.params.name) ? req.params.name.join('/') : req.params.name;
  let asset = null;

  // Try Supabase async read when configured
  if (config.uploads.backend === 'supabase' && config.supabase.hasServiceRole) {
    try { asset = await uploads.readAsync(name); } catch {}
  }
  // Fallback to sync disk read
  if (!asset) asset = uploads.read(name);

  if (!asset) return res.status(404).type('text/plain').send('Not found');

  res.setHeader('Content-Type', asset.mime);
  // Nothing is inline that a browser could be talked into interpreting
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  // The name is a content hash of sorts — a new upload gets a new name — so
  // this can be cached hard and never revalidated.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(asset.buffer);
});

// A survey addressed to whoever holds its link. The token stays in the path
// rather than a query string so the address survives being pasted into a chat
// window, printed on a slide or turned into a QR code — and the page it serves
// is the same runner members answer on, so the two cannot drift apart. The
// token is read by the page and never used here, because everything it opens
// is decided by the API.
app.get('/s/:token', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'member', 'survey.html'));
});

// An onboarding form, at its own address and inside somebody else's page.
//
// This is the one route that serves a page willing to be framed, and the only
// place the decision can be made: which origins may frame it is a property of
// the individual form, so it has to be read from the form the token opens
// before the response goes out. Everything else about what the page shows is
// still decided by the API — see routes/onboarding.routes.js.
//
// A token that never existed and one whose form has been closed both fall
// through to the page with framing refused. The page then asks the API, is
// told the same "not open" a closed form gives, and says so. Deciding it here
// instead would make this route an oracle for which tokens are real.
app.get('/o/:token', async (req, res) => {
  const onboarding = require('./services/onboarding');
  const form = await onboarding.byToken(req.params.token);
  if (form) allowFraming(res, onboarding.frameAncestors(form));

  res.sendFile(path.join(PUBLIC_DIR, 'onboarding', 'form.html'));
});

// Swagger UI's CSS and bundle are vendored into public/vendor/swagger-ui/ so
// the API reference page loads them like every other asset — from the static
// handler registered above — rather than through a route that depends on the
// swagger-ui-dist package being installed at run time. A static or CDN-backed
// deployment of public/ therefore renders the reference styled instead of as
// bare HTML text, and the two files stay on our origin, inside the
// Content-Security-Policy.
//
// Only the two files the page names are vendored, so anything else that would
// have lived alongside them in the package — its own demo page (index.html),
// source maps — must not be reachable. Any request under /vendor/swagger-ui
// that reaches this point was not one of those vendored files (the static
// handler served those already), so it is refused outright.
app.use('/vendor/swagger-ui', (req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

app.use(requestLogger());

// ─── Rate limits ────────────────────────────────────────────
// Tightest on the surfaces an attacker probes first, looser on ordinary
// authenticated traffic so real use is never the thing that trips it.
app.use('/api/auth', rateLimit({ name: 'auth', windowMs: 60_000, max: 20 }));
app.use('/api/integrations', rateLimit({ name: 'integrations', windowMs: 60_000, max: 300 }));
app.use('/api', rateLimit({ name: 'api', windowMs: 60_000, max: 300 }));

// Ahead of the routes and behind the rate limits: a request that asks for the
// sandbox is served against a throwaway database from here down.
app.use('/api', require('./middleware/sandbox').sandboxContext);

app.use('/api', require('./routes'));

// Anything else is a frontend route: hand back the sign-in page and let the
// client decide where the visitor belongs. A request that looks like an asset
// gets a 404 instead, so a broken stylesheet or script link fails loudly
// rather than quietly receiving a page of HTML.
const ASSET_LIKE = /\.(js|css|map|json|png|jpe?g|svg|ico|woff2?|txt|xml)$/i;

app.get('/{*path}', (req, res) => {
  if (ASSET_LIKE.test(req.path)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use(errorHandler);

module.exports = app;
