// ─── The Dev Circle API specification ───────────────────────
// One OpenAPI 3.0 document describing every endpoint the platform serves. It
// is assembled at runtime from the same permission catalogue the routes are
// gated on, so what the reference says a role needs is what the server checks.
//
// Served by GET /api/admin/docs/openapi.json and rendered by
// /admin/api-docs.html. The document is self-contained: hand the JSON to any
// developer and they have the whole API, examples included.

const config = require('../config');
const pkg = require('../../package.json');
const { PERMISSIONS } = require('../middleware/auth');
const { securitySchemes, schemas, responses, parameters } = require('./components');

const publicPaths = require('./paths.public');
const adminPaths = require('./paths.admin');
// Both halves of onboarding together: the public form and the admin queue are
// only comprehensible read against each other.
const onboardingPaths = require('./paths.onboarding');

// ─── The guide ──────────────────────────────────────────────
// Rendered above the endpoint list. It answers the things a developer asks
// before their first call — how do I authenticate, what do errors look like,
// what will rate-limit me — so nobody has to infer them from the operations.

const permissionTable = () => {
  const rows = PERMISSIONS.map(p => `| \`${p.key}\` | ${p.group} | ${p.label} |`).join('\n');
  return `| Permission | Group | What it allows |\n| --- | --- | --- |\n${rows}`;
};

const description = () => `
${config.brand.product} is the engagement platform for the Credit Direct developer ecosystem — surveys,
cohorts, consent-aware messaging and engagement history for the developers integrating our APIs.

This reference covers every endpoint the platform serves. Each operation carries a worked
request and response, and **Try it out** runs against this deployment using your own session.

---

## Authentication

There are three ways to hold a credential, and which one you use depends on who you are.

### Members — email and phone digits

Developers hold no password at all, so there is none to leak, reset or reuse from another site.
They sign in with their email address and the last six digits of the phone number on their
record — one call:

\`\`\`bash
curl -X POST https://your-deployment/api/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"identifier":"chidi@paystack.africa","digits":"550142"}'
\`\`\`

A phone number is not accepted as the identifier: the secret is six digits of that very
number. Six digits is a weak secret and is treated as one — eight failed attempts per
address and IP are throttled for fifteen minutes.

### Credit Direct staff — a password

Staff are recognised by their email domain and sign in with \`POST /auth/login\`. The response
carries the role's permission list, so a console can hide the actions that role cannot perform.

### Integrations — a scoped API key

Machine-to-machine callers use a key issued from \`POST /admin/api-keys\` and sent as
\`x-api-key\`. Keys are scoped: one scoped to \`feex\` cannot post landing-page registrations.

Send whichever credential you hold on every request:

\`\`\`http
Authorization: Bearer <session token>
x-api-key: dc_a1b2c3d4_…
\`\`\`

---

## The sandbox

Every endpoint below can be sent against a **sandbox**: a second database, identical in shape
to the live one and filled with invented people. Add one header:

\`\`\`http
X-Devcircle-Sandbox: 1
\`\`\`

Everything else is the same request. The same validation runs, the same permissions are
checked, the same 409 comes back when you claim a gift twice — because it is the same code,
talking to a different database. Two things differ, both on purpose:

- **Nothing is dispatched.** Email, WhatsApp and SMS are recorded as \`simulated\`. You can
  send a broadcast to every member in the sandbox and nobody receives anything.
- **It is disposable.** \`POST /admin/sandbox/reset\` throws it away and rebuilds it.

Your existing session works — the sandbox mirrors it across, so you are the same person with
the same role, looking at different data. It needs the \`sandbox.use\` permission, and staff
only. Responses served from it carry \`X-Devcircle-Sandbox: active\`, so a client never has to
guess which data it is holding.

In the API reference page this is a toggle, and it is **on by default**. Turn it off
deliberately, when you mean to touch real members.

---

## Permissions

Every \`/admin\` endpoint is gated on a capability its role must hold, shown on each operation
as **Requires the \`…\` permission** and as the \`x-permission\` extension. A 403 names the
permissions that would have allowed the call, so a client can say precisely what is missing.

A role holding \`*\` has every permission, including ones added in later releases.

${permissionTable()}

---

## Conventions

**Timestamps** are UTC strings formatted \`YYYY-MM-DD HH:MM:SS\`, not ISO-8601 with a zone.
The one exception is \`scheduled_for\` on a session, which is accepted and returned as ISO.

**Ids** are UUIDs, generated by the server. Never construct one.

**Partial updates.** A \`PUT\` touches only the fields present in the body. Sending an empty
body is an error rather than a silent no-op, so a broken client fails loudly.

**Pagination.** Endpoints that paginate take \`page\` and \`limit\` and answer with a
\`pagination\` object. \`limit\` is capped at 100; a larger value is clamped, not rejected.

**Arrays** are returned as real JSON arrays even though they are stored encoded, so a client
never has to parse a string that contains JSON.

---

## Errors

Every non-2xx response is JSON with an \`error\` field written in language safe to show a
person.

| Status | Meaning |
| --- | --- |
| \`400\` | The request was rejected before anything changed |
| \`401\` | No credential, or one that has expired or been revoked |
| \`403\` | Authenticated, but the role or key scope does not permit this |
| \`404\` | No such record — or none this caller may see |
| \`409\` | The request contradicts the current state of the record |
| \`410\` | The thing existed but has closed |
| \`429\` | Rate limited — see below |
| \`500\` | Our fault. Quote the \`error_id\` in a report |

A 404 and a 403 are deliberately indistinguishable where telling them apart would reveal
whether a record exists.

---

## Rate limits

Fixed windows of one minute, applied per credential where there is one and per IP otherwise:

| Surface | Limit |
| --- | --- |
| \`/api/auth/*\` | 20 requests / minute |
| \`/api/integrations/*\` | 300 requests / minute |
| Everything else under \`/api\` | 300 requests / minute |

Sign-in has its own throttle on top: eight failed attempts for one address and IP pair
locks that pair out for 15 minutes, whichever credential was being offered. That throttle
is most of what makes a six-digit secret defensible — see the note beside it in the
Authentication section.

Every response carries \`RateLimit-Limit\`, \`RateLimit-Remaining\` and \`RateLimit-Reset\`.
A 429 adds \`Retry-After\`. Back off on the header rather than on a fixed sleep.

---

## Webhooks and replay

Inbound events from Customer.io, Feex and the Developer Hub are written to the integration
log **before** they are acted on. An event for a member ${config.brand.product} does not know yet is kept
unprocessed rather than dropped — \`GET /integrations/events/pending\` lists what is waiting,
and the sender can replay it once the member exists.

\`POST /integrations/feex/webhook\` is idempotent on \`ticket_id\`: send new tickets and status
changes to the same endpoint and the ticket is updated rather than duplicated.
`.trim();

// ─── Tags ───────────────────────────────────────────────────
// The order here is the order Swagger UI renders, so it reads as a tour: sign
// in, then what a developer can do, then what an operator can do.

const tags = [
  { name: 'Health', description: 'Liveness, safe to poll.' },
  { name: 'Authentication', description: 'One sign-in form, three ways to hold a credential: for developers their email address and the last six digits of their phone number, for Credit Direct staff a password, and Developer Hub SSO.' },
  { name: 'Member profile', description: 'The signed-in developer\'s own profile, memberships, consent and engagement history.' },
  { name: 'Member surveys', description: 'Surveys open to the signed-in developer, and how they answer them.' },
  { name: 'Open surveys', description: 'Answering a survey over its link, with no account and no sign-in. The token in the path is the whole of the authorisation and opens exactly one survey; nothing here identifies the person answering.' },
  { name: 'Onboarding forms', description: 'Filling in an onboarding form, with no account and no sign-in, on a page this platform does not own. The token in the path is the whole of the authorisation. Nothing here creates an account: what a submission produces is an application somebody reviews.' },
  { name: 'Member rewards', description: 'The reward catalogue and claiming from it.' },
  { name: 'Member notifications', description: 'The portal inbox, notification categories and quiet hours.' },
  { name: 'Feedback', description: 'Feedback raised by the signed-in developer.' },
  { name: 'Integrations', description: 'Machine-to-machine endpoints for the landing page, Customer.io, Feex and the Developer Hub. Authenticate with a scoped API key.' },
  { name: 'Admin · Dashboard', description: 'Headline numbers and the demography of the member base.' },
  { name: 'Admin · Members', description: 'Finding, updating, importing and exporting developers.' },
  { name: 'Admin · Cohorts', description: 'Saved segments — hand-picked lists, or rule sets that keep themselves current.' },
  { name: 'Admin · Circles', description: 'Nested engagement spaces, each with its own members, cohorts, surveys and messaging.' },
  { name: 'Admin · Surveys', description: 'Authoring surveys, resolving their audience, inviting and reminding, and reading the results.' },
  { name: 'Admin · Onboarding', description: 'Publishing a form that collects people who are not members yet, and deciding on what it brings back. Approving is what creates the account — the form itself never does.' },
  { name: 'Admin · Sessions', description: 'Dated engagements with automated lead-up reminders and availability checking.' },
  { name: 'Admin · Broadcasts', description: 'Consent-aware messaging to a cohort, a circle or everyone, with a full delivery audit trail.' },
  { name: 'Admin · Rewards', description: 'The reward catalogue, its eligibility rules and fulfilment.' },
  { name: 'Admin · Feedback', description: 'Reading and triaging feedback, including complaints mirrored from Feex.' },
  { name: 'Admin · Access control', description: 'Roles, permissions and staff accounts.' },
  { name: 'Admin · Credentials', description: `The keys ${config.brand.product} issues to integrations, end to end — issue, inspect, re-scope, rotate and revoke — plus the state of the outbound provider credentials.` },
  { name: 'Admin · Integrations', description: 'The inbound event log: everything the connected systems have sent.' },
  { name: 'Admin · Sandbox', description: 'The throwaway database this reference can be pointed at.' },
  { name: 'Admin · API reference', description: 'This document.' }
];

// ─── Assembly ───────────────────────────────────────────────

function build() {
  return {
    openapi: '3.0.3',
    info: {
      title: `${config.brand.product} API`,
      version: pkg.version,
      description: description(),
      contact: {
        name: 'Credit Direct developer engagement',
        email: 'developers@creditdirect.ng'
      },
      license: { name: 'Proprietary — Credit Direct Limited' }
    },
    servers: [
      // Relative first, so "Try it out" runs against whatever host the reference
      // is being read from — a staging reader never posts to production.
      { url: '/api', description: 'This deployment' },
      { url: `${config.appUrl}/api`, description: `Configured base URL (${config.env})` }
    ],
    tags,
    security: [{ bearerAuth: [] }],
    paths: { ...publicPaths, ...onboardingPaths, ...adminPaths },
    components: { securitySchemes, schemas, responses, parameters }
  };
}

// The document is deterministic for the life of the process, so it is built
// once. Only the permission catalogue and the configured URL feed it, and
// neither changes without a restart.
let cached = null;

function spec() {
  if (!cached) cached = build();
  return cached;
}

// A count worth having: it is what the drift test asserts against the router.
function operationCount() {
  const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
  return Object.values(spec().paths)
    .reduce((total, item) => total + METHODS.filter(m => item[m]).length, 0);
}

module.exports = { spec, build, operationCount, tags };
