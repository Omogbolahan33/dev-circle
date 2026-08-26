const config = require('../config');

// ─── Security headers ───────────────────────────────────────
// The frontend is served from this same origin and uses inline scripts and
// styles, so those are allowed; everything else is locked to self. Fonts come
// from Google, which is the one third-party origin the pages need.

const DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'"
];

const CSP = DIRECTIVES.join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);

  if (config.isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

// ─── Pages that are meant to be framed ──────────────────────
// One page in this platform exists to be put on somebody else's site: an
// onboarding form. Every other page refuses to be framed, and that default is
// worth keeping strict rather than loosening globally — clickjacking a form
// that creates members is exactly the attack the header is there to stop.
//
// So a route opts in, per response, naming the origins that particular form
// allows. Two headers say this, and they disagree about how:
//
//   · X-Frame-Options has no list form. ALLOW-FROM was only ever implemented
//     by one browser and is dead everywhere. Left in place it would mean DENY,
//     so it is removed rather than rewritten.
//   · frame-ancestors is the one that carries a list, and in every browser
//     that understands it, it wins. It is rewritten from the same directive
//     array the default CSP is built from, so the two cannot drift as the
//     policy changes.
//
// A form with no origins named resolves to 'none', which is a page reachable
// at its own link and embeddable nowhere.
function allowFraming(res, frameAncestors) {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', DIRECTIVES
    .map(d => (d.startsWith('frame-ancestors') ? `frame-ancestors ${frameAncestors}` : d))
    .join('; '));
}

module.exports = { securityHeaders, allowFraming, CSP, DIRECTIVES };
