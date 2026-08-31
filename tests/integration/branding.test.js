const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('../helpers');

before(h.start);
after(h.stop);

// ─── Whose software this is ──────────────────────────────────
// The product's name and Credit Direct's mark are written into the pages as
// what they are. There was briefly a {{brand.*}} placeholder layer with a
// middleware behind it; it is gone, and these guard the things that actually
// matter about the result — that the mark is there, that it reads on both
// themes, and that no half-written placeholder ever ships in its place.

const PRODUCT = 'Dev Circle';
const ORG = 'Credit Direct';
const FULL = 'Credit Direct Dev Circle';

test('the sign-in page is signed by the organisation, in full, including the tab', async () => {
  const res = await h.call('GET', '/', { raw: true });
  assert.equal(res.status, 200);

  assert.match(res.text, new RegExp(`<title>${FULL} — Sign in</title>`));
  assert.ok(res.text.includes('Credit Direct Limited · CBN Licensed'), 'the licence line is present');
  assert.ok(res.text.includes('https://creditdirect.ng'), 'the organisation is linked');
  // The lockup carries the organisation, so the line under it names the
  // product rather than repeating the company.
  assert.ok(res.text.includes(`>${PRODUCT}</p>`), 'the product is named under the mark');
});

test('the sign-in page shows the Credit Direct lockup, in both inks', async () => {
  const res = await h.call('GET', '/', { raw: true });

  assert.ok(res.text.includes('/assets/brand/creditdirect.svg'), 'the light ink is there');
  assert.ok(res.text.includes('/assets/brand/creditdirect-white.svg'), 'the dark ink is there');
  assert.ok(res.text.includes(`alt="${FULL}"`), 'the mark is labelled');
  assert.ok(res.text.includes('aria-hidden="true"'), 'the duplicate is hidden from assistive tech');
});

test('the shell carries the mark too, on both surfaces it renders', async () => {
  const shell = await h.call('GET', '/assets/js/shell.js', { raw: true });
  const marks = shell.text.match(/creditdirect\.svg/g) || [];
  assert.ok(marks.length >= 2, 'the admin console and the member portal both get it');
  assert.ok(shell.text.includes('creditdirect-white.svg'), 'and the dark ink with it');
});

test('both inks and the favicon are actually served', async () => {
  for (const asset of ['/assets/brand/creditdirect.svg',
                       '/assets/brand/creditdirect-white.svg',
                       '/assets/brand/favicon.svg']) {
    const res = await h.call('GET', asset, { raw: true });
    assert.equal(res.status, 200, asset);
    assert.match(res.headers.get('content-type'), /svg/, asset);
    assert.match(res.text, /^<svg/, `${asset} is not an svg`);
  }
});

test('the two inks are the same artwork, differing only in colour', async () => {
  const light = await h.call('GET', '/assets/brand/creditdirect.svg', { raw: true });
  const dark = await h.call('GET', '/assets/brand/creditdirect-white.svg', { raw: true });

  assert.equal(light.text.replace(/#107EBC/g, '#FFFFFF'), dark.text,
    'the white variant must be the blue one with the ink swapped');
  assert.ok(!dark.text.includes('#107EBC'), 'no blue ink survives in the dark variant');
});

test('every page points at the favicon', async () => {
  for (const page of ['/', '/admin/dashboard.html', '/member/dashboard.html', '/onboarding/form.html']) {
    const res = await h.call('GET', page, { raw: true });
    assert.ok(res.text.includes('/assets/brand/favicon.svg'), `${page} has no favicon`);
  }
});

test('the public survey and onboarding links carry the mark, not a placeholder', async () => {
  // These are served by their own routes rather than the static handler, which
  // is exactly how a page gets forgotten.
  for (const route of ['/s/anytoken', '/o/anytoken']) {
    const res = await h.call('GET', route, { raw: true });
    assert.equal(res.status, 200, route);
    assert.ok(res.text.includes('/assets/brand/creditdirect.svg'), `${route} has no mark`);
  }
});

// ─── Nothing half-written reaches a person ───────────────────

test('no page ships a template placeholder of any kind', () => {
  // {{...}} is not a syntax this project resolves any more. If one appears in a
  // page it will be served to somebody exactly as typed.
  const root = path.join(__dirname, '..', '..', 'public');
  const offenders = [];

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Third-party, and its own braces are its own business.
        if (entry.name !== 'vendor') walk(full);
        continue;
      }
      if (!/\.(html|js|css)$/.test(entry.name)) continue;

      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/\{\{\s*[\w.]+\s*\}\}/g)) {
        offenders.push(`${path.relative(root, full)}: ${m[0]}`);
      }
    }
  })(root);

  assert.deepEqual(offenders, [], 'these would be served exactly as written');
});

test('the font catalogue an admin sees names the product', async () => {
  // survey-theme.js is required on the server as well as served to the browser.
  // Its default face is named for the product, and that name has to survive the
  // trip through the API as a real name.
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'fonts@creditdirect.ng', roleId: role });
  const token = await h.loginAdmin(admin.email, admin.password);

  const res = await h.get('/api/admin/surveys/schema', { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const labels = (res.body.theme?.fonts || []).map(f => f.label);
  assert.ok(labels.length, 'the schema carries a font list');
  for (const label of labels) {
    assert.ok(!String(label).includes('{{'), `font label leaked a placeholder: ${label}`);
  }
  assert.ok(labels.includes(PRODUCT), 'the default face is named for the product');
});

test('the vendored swagger bundle is served whole', async () => {
  const res = await h.call('GET', '/vendor/swagger-ui/swagger-ui-bundle.js', { raw: true });
  assert.equal(res.status, 200);
  assert.ok(res.text.length > 1_000_000, 'the whole bundle is served');
});

test('nothing outside public/ is reachable', async () => {
  for (const attempt of ['/../package.json', '/..%2f..%2fpackage.json',
                         '/../../etc/passwd', '/..%2fsrc%2fconfig%2findex.js']) {
    const res = await h.call('GET', attempt, { raw: true });
    assert.ok(!res.text.includes('"dependencies"'), `${attempt} reached package.json`);
    assert.ok(!res.text.includes('root:'), `${attempt} reached /etc/passwd`);
    assert.ok(!res.text.includes('DATABASE_URL'), `${attempt} reached the config`);
  }
});
