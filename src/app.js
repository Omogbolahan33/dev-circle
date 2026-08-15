const express = require('express');
const cors = require('cors');
const path = require('path');

const config = require('./config');
const { requestLogger } = require('./utils/logger');
const { rateLimit } = require('./middleware/rateLimit');
const { securityHeaders } = require('./middleware/security');
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

// Swagger UI ships as static assets in a package rather than in public/, and
// the API reference page loads them from here. Only the two files that page
// names are reachable: publishing a package directory wholesale would also
// serve the vendor's own demo page, which points at an external petstore, and
// its source maps. Serving them from our origin is what keeps the reference
// inside the Content-Security-Policy — both files are self-contained.
const SWAGGER_ASSETS = new Set(['/swagger-ui.css', '/swagger-ui-bundle.js']);

app.use('/vendor/swagger-ui',
  (req, res, next) => {
    if (!SWAGGER_ASSETS.has(req.path)) return res.status(404).type('text/plain').send('Not found');
    next();
  },
  express.static(require('swagger-ui-dist').getAbsoluteFSPath(), {
    index: false,
    maxAge: config.isProduction ? '7d' : 0
  })
);

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
