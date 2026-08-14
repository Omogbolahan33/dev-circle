const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('../helpers');

const { PERMISSIONS } = require('../../src/middleware/auth');

before(h.start);
after(h.stop);

const SPEC_PATH = '/api/admin/docs/openapi.json';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

let superToken;
let repToken;

beforeEach(async () => {
  h.reset();
  h.makeRootCircle();

  const superRole = h.makeRole('Super Admin', ['*']);
  // Everything an engagement rep does, and nothing that would let them read
  // the map of the admin surface.
  const repRole = h.makeRole('CDL Rep', ['members.read', 'surveys.read', 'roles.read']);

  const boss = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: superRole });
  const rep = h.makeAdmin({ email: 'rep@creditdirect.ng', roleId: repRole });

  superToken = await h.loginAdmin(boss.email, boss.password);
  repToken = await h.loginAdmin(rep.email, rep.password);
});

// ─── Who may read it ────────────────────────────────────────

test('the specification needs a credential', async () => {
  const res = await h.get(SPEC_PATH);
  assert.equal(res.status, 401);
});

test('a member cannot reach it at all', async () => {
  const user = h.makeUser();
  const token = await h.loginUser(user.email);

  const res = await h.get(SPEC_PATH, { token });
  assert.equal(res.status, 403);
});

test('an admin without docs.read is refused, and told what is missing', async () => {
  const res = await h.get(SPEC_PATH, { token: repToken });

  assert.equal(res.status, 403);
  assert.deepEqual(res.body.required, ['docs.read']);
});

test('a super admin reads it', async () => {
  const res = await h.get(SPEC_PATH, { token: superToken });
  assert.equal(res.status, 200);
});

test('a role granted docs.read explicitly reads it too', async () => {
  const role = h.makeRole('Docs reader', ['docs.read']);
  const reader = h.makeAdmin({ email: 'reader@creditdirect.ng', roleId: role });
  const token = await h.loginAdmin(reader.email, reader.password);

  const res = await h.get(SPEC_PATH, { token });
  assert.equal(res.status, 200);
});

// The permission is new, so an existing deployment has nobody holding it.
// Migration 18 is what hands it to the role that is meant to have it.

function migration18() {
  return require('../../src/db/migrations').define(h.db).find(m => m.id === 18);
}

function permissionsOf(name) {
  return JSON.parse(h.db.prepare('SELECT permissions FROM roles WHERE name = ?').get(name).permissions);
}

test('the migration grants docs.read to a Super Admin whose permissions are spelled out', () => {
  h.db.prepare("UPDATE roles SET permissions = ? WHERE name = 'Super Admin'")
    .run(JSON.stringify(['members.read', 'roles.write']));

  migration18().up();

  const after = permissionsOf('Super Admin');
  assert.ok(after.includes('docs.read'), 'Super Admin must end up with the new permission');
  assert.ok(after.includes('members.read'), 'what the role already had must survive');
});

test('the migration leaves a wildcard Super Admin untouched, and re-running changes nothing', () => {
  // '*' already includes every permission, present and future
  assert.deepEqual(permissionsOf('Super Admin'), ['*']);

  migration18().up();
  assert.deepEqual(permissionsOf('Super Admin'), ['*']);

  migration18().up();
  assert.deepEqual(permissionsOf('Super Admin'), ['*']);
});

test('docs.read is a real permission a role can be built from', async () => {
  assert.ok(PERMISSIONS.some(p => p.key === 'docs.read'), 'docs.read must be in the catalogue');

  const res = await h.post('/api/admin/roles',
    { name: 'Reference reader', permissions: ['docs.read'] },
    { token: superToken });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body.role.permissions, ['docs.read']);
});

// ─── What it says ───────────────────────────────────────────

test('it is a valid OpenAPI document with servers, tags and security', async () => {
  const { body: spec } = await h.get(SPEC_PATH, { token: superToken });

  assert.match(spec.openapi, /^3\./);
  assert.ok(spec.info.title && spec.info.version, 'info must name the API and its version');
  assert.ok(spec.servers.length, 'a server is needed for "Try it out" to work');
  assert.ok(spec.tags.length, 'operations are grouped by tag');
  assert.ok(spec.components.securitySchemes.bearerAuth, 'session auth must be described');
  assert.ok(spec.components.securitySchemes.apiKeyAuth, 'integration key auth must be described');
});

test('every operation is documented enough to use', async () => {
  const { body: spec } = await h.get(SPEC_PATH, { token: superToken });
  const problems = [];

  for (const [route, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;

      const where = `${method.toUpperCase()} ${route}`;
      if (!operation.summary) problems.push(`${where}: no summary`);
      if (!operation.tags || !operation.tags.length) problems.push(`${where}: no tag`);

      const success = Object.keys(operation.responses || {}).find(code => code.startsWith('2'));
      if (!success) problems.push(`${where}: documents no success response`);

      // A response a developer cannot picture is a response they will guess at
      const content = operation.responses[success] && operation.responses[success].content;
      if (content) {
        const sample = Object.values(content)[0];
        if (!sample.example && !sample.examples) problems.push(`${where}: success response has no example`);
      }

      if (operation.requestBody) {
        const media = Object.values(operation.requestBody.content || {})[0];
        if (!media || (!media.example && !media.examples)) {
          problems.push(`${where}: request body has no example`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('every path parameter is declared', async () => {
  const { body: spec } = await h.get(SPEC_PATH, { token: superToken });
  const problems = [];

  for (const [route, item] of Object.entries(spec.paths)) {
    const wanted = [...route.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    if (!wanted.length) continue;

    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;

      const declared = (operation.parameters || [])
        .filter(p => p.in === 'path').map(p => p.name);

      for (const name of wanted) {
        if (!declared.includes(name)) {
          problems.push(`${method.toUpperCase()} ${route}: {${name}} is not declared`);
        }
      }
    }
  }

  assert.deepEqual(problems, []);
});

test('every $ref resolves', async () => {
  const { body: spec } = await h.get(SPEC_PATH, { token: superToken });
  const broken = [];

  const check = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(check);

    if (typeof node.$ref === 'string') {
      const target = node.$ref.replace(/^#\//, '').split('/')
        .reduce((at, key) => (at ? at[key] : undefined), spec);
      if (target === undefined) broken.push(node.$ref);
    }
    Object.values(node).forEach(check);
  };

  check(spec.paths);
  assert.deepEqual(broken, []);
});

test('every admin operation names the permission that gates it', async () => {
  const { body: spec } = await h.get(SPEC_PATH, { token: superToken });
  const known = new Set(PERMISSIONS.map(p => p.key));
  const problems = [];

  for (const [route, item] of Object.entries(spec.paths)) {
    if (!route.startsWith('/admin/')) continue;

    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;

      const required = operation['x-permission'];
      const where = `${method.toUpperCase()} ${route}`;

      if (!Array.isArray(required) || !required.length) {
        problems.push(`${where}: no x-permission`);
        continue;
      }
      // A documented permission that gates nothing is worse than none at all:
      // it sends somebody building a role after a key the server will reject.
      for (const key of required) {
        if (!known.has(key)) problems.push(`${where}: unknown permission "${key}"`);
      }
    }
  }

  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

// ─── That it stays true ─────────────────────────────────────
// The reference is only worth sharing while it matches the server. These read
// the routers from source and compare both directions, so an endpoint added
// without documentation — or documented without being served — fails here
// rather than being discovered by whoever is trying to integrate.

function registeredRoutes() {
  const ROUTES = path.join(__dirname, '..', '..', 'src', 'routes');

  const join = (prefix, segment) => {
    const joined = `${prefix}${segment}`.replace(/\/{2,}/g, '/');
    return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
  };

  const walk = (file, prefix, found) => {
    const source = fs.readFileSync(file, 'utf8');

    for (const m of source.matchAll(/router\.use\(\s*'([^']*)'\s*,\s*require\('([^']+)'\)\s*\)/g)) {
      walk(require.resolve(path.resolve(path.dirname(file), m[2])), join(prefix, m[1]), found);
    }
    for (const m of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
      // Express names a path parameter :id; OpenAPI names it {id}
      found.add(`${m[1].toUpperCase()} ${join(prefix, m[2]).replace(/:(\w+)/g, '{$1}')}`);
    }
    return found;
  };

  return walk(path.join(ROUTES, 'index.js'), '', new Set());
}

function documentedRoutes(spec) {
  const found = new Set();
  for (const [route, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      if (item[method]) found.add(`${method.toUpperCase()} ${route}`);
    }
  }
  return found;
}

test('every endpoint the server serves is in the reference', async () => {
  const { body: spec } = await h.get(SPEC_PATH, { token: superToken });
  const documented = documentedRoutes(spec);

  const missing = [...registeredRoutes()].filter(route => !documented.has(route)).sort();

  assert.deepEqual(missing, [], `\nUndocumented endpoints:\n${missing.join('\n')}`);
});

test('every endpoint in the reference is one the server serves', async () => {
  const { body: spec } = await h.get(SPEC_PATH, { token: superToken });
  const registered = registeredRoutes();

  const phantom = [...documentedRoutes(spec)].filter(route => !registered.has(route)).sort();

  assert.deepEqual(phantom, [], `\nDocumented but not routed:\n${phantom.join('\n')}`);
});

test('the reference covers the whole API, not a handful of endpoints', async () => {
  const { body: spec } = await h.get(SPEC_PATH, { token: superToken });
  assert.ok(documentedRoutes(spec).size >= 100, 'the API has more endpoints than this');
});

// ─── The page that renders it ───────────────────────────────

test('the reference page and its Swagger assets are served', async () => {
  const page = await h.call('GET', '/admin/api-docs.html', { raw: true });
  assert.equal(page.status, 200);
  assert.match(page.text, /swagger/i);

  for (const asset of ['/vendor/swagger-ui/swagger-ui.css', '/vendor/swagger-ui/swagger-ui-bundle.js']) {
    const res = await h.call('GET', asset, { raw: true });
    assert.equal(res.status, 200, `${asset} must be served from this origin`);
  }
});

test('the Swagger package cannot serve its own demo page', async () => {
  // index: false — the vendor's index.html points at an external petstore, and
  // publishing a package directory wholesale is how unintended files escape.
  const res = await h.call('GET', '/vendor/swagger-ui/index.html', { raw: true });
  assert.equal(res.status, 404);
});
