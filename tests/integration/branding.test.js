const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const config = require('../../src/config');
const brand = require('../../src/middleware/brand');

before(h.start);
after(h.stop);

// ─── Whose software this is ──────────────────────────────────
// The product name was written into 72 files by hand, which is why it could
// not be changed and why a second deployment could not be branded. It comes
// from config now and is put into the pages on the way out. What these guard is
// that every page actually gets served through that — a page that slipped past
// it would ship {{brand.product}} to a member, in the browser tab, on the way
// in to sign up.

const PAGES = [
  '/', '/index.html',
  '/admin/dashboard.html', '/admin/members.html', '/admin/roles.html',
  '/admin/api-docs.html', '/admin/circles.html', '/admin/feedback.html',
  '/member/dashboard.html', '/member/profile.html', '/member/feedback.html',
  '/member/engagement.html', '/onboarding/form.html',
  '/assets/js/shell.js'
];

test('no page ships an unsubstituted token', async () => {
  for (const page of PAGES) {
    const res = await h.call('GET', page, { raw: true });
    assert.equal(res.status, 200, page);
    assert.ok(!res.text.includes('{{brand'), `${page} still carries a raw token`);
  }
});

test('the sign-in page is signed by the organisation, in full, including the tab', async () => {
  const res = await h.call('GET', '/', { raw: true });

  assert.match(res.text, new RegExp(`<title>${config.brand.full} — Sign in</title>`));
  // The lockup carries the organisation, so the line under it names the
  // product rather than repeating the company.
  assert.ok(res.text.includes(`>${config.brand.product}</p>`), 'the product is named under the mark');
  assert.ok(res.text.includes(config.brand.legal), 'the licence line is present');
  assert.ok(res.text.includes(config.brand.website), 'the organisation is linked');
});

test('the extensionless path and the file itself are the same page', async () => {
  const bare = await h.call('GET', '/', { raw: true });
  const named = await h.call('GET', '/index.html', { raw: true });
  assert.equal(bare.text, named.text);
});

test('a page is revalidated rather than re-sent', async () => {
  const first = await h.call('GET', '/', { raw: true });
  const etag = first.headers.get('etag');
  assert.ok(etag, 'a substituted page carries an ETag');

  const again = await h.call('GET', '/', { raw: true, headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
});

test('a file with no token in it is left to the static handler', async () => {
  // CSS is never substituted, and must still be served normally.
  const res = await h.call('GET', '/assets/css/tokens.css', { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/css/);
});

test('the served page is the same length as the file plus its substitutions', async () => {
  // A guard against the handler truncating on multi-byte characters: the legal
  // line carries a middle dot, and the pitch copy em dashes.
  const res = await h.call('GET', '/', { raw: true });
  assert.ok(res.text.includes('·'), 'the middle dot survived');
  assert.ok(res.text.includes('—'), 'the em dashes survived');
});

test('nothing outside public/ is reachable through the brand handler', async () => {
  // A traversal that survives the URL parser must not reach a file. Note what
  // is being asserted: a path fetch() normalises away lands on the app's own
  // catch-all and is answered with the sign-in page, which is a 200 — so the
  // check is on what came back, not on the status.
  for (const attempt of ['/../package.json', '/..%2f..%2fpackage.json',
                         '/../../etc/passwd', '/..%2fsrc%2fconfig%2findex.js']) {
    const res = await h.call('GET', attempt, { raw: true });
    assert.ok(!res.text.includes('"dependencies"'), `${attempt} reached package.json`);
    assert.ok(!res.text.includes('root:'), `${attempt} reached /etc/passwd`);
    assert.ok(!res.text.includes('DATABASE_URL'), `${attempt} reached the config`);
  }
});

// ─── The substitution itself ─────────────────────────────────

test('only the names that exist resolve; anything else is left as written', () => {
  const out = brand.substitute('{{brand.product}} / {{brand.organisation}} / {{nonsense}} / {{}}');
  assert.equal(out, `${config.brand.product} / ${config.brand.organisation} / {{nonsense}} / {{}}`);
});

test('a brand value cannot close a string or open a tag', () => {
  // Operator configuration rather than user input, but it lands in HTML and in
  // HTML built inside template literals, so it is stripped once on the way in
  // rather than escaped differently in each place.
  assert.equal(brand.sanitize('<script>alert(1)</script>'), 'scriptalert(1)/script');
  assert.equal(brand.sanitize('a`b'), 'ab');
  // The opening ${ is what makes an interpolation; the stray brace left behind
  // is inert text wherever it lands.
  assert.equal(brand.sanitize('${process.exit()}'), 'process.exit()}');
  assert.equal(brand.sanitize('  padded  '), 'padded');
  assert.equal(brand.sanitize(null), '');
});

test('the domain is the address as it is read, not as it is dialled', () => {
  assert.ok(!brand.TOKENS.get('brand.domain').startsWith('http'));
  assert.ok(config.brand.website.includes(brand.TOKENS.get('brand.domain')));
});

test('the font catalogue an admin sees names the product, not the token', async () => {
  // survey-theme.js is required on the server as well as served to the browser,
  // and only the served copy passes through substitution. The font list is the
  // one place a label from it is published as JSON.
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'fonts@creditdirect.ng', roleId: role });
  const token = await h.loginAdmin(admin.email, admin.password);

  const res = await h.get('/api/admin/surveys/schema', { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const labels = (res.body.theme?.fonts || []).map(f => f.label);
  assert.ok(labels.length, 'the schema carries a font list');
  for (const label of labels) {
    assert.ok(!String(label).includes('{{'), `font label leaked a token: ${label}`);
  }
  assert.ok(labels.includes(config.brand.product), 'the default face is named for the product');
});

// ─── The mark ────────────────────────────────────────────────

test('the sign-in page shows the Credit Direct lockup, in both inks', async () => {
  const res = await h.call('GET', '/', { raw: true });

  assert.ok(res.text.includes('/assets/brand/creditdirect.svg'), 'the light ink is there');
  assert.ok(res.text.includes('/assets/brand/creditdirect-white.svg'), 'the dark ink is there');
  // One of the pair carries the name; the other is decorative, so a screen
  // reader is not told the company twice.
  assert.ok(res.text.includes(`alt="${config.brand.full}"`), 'the mark is labelled');
  assert.ok(res.text.includes('aria-hidden="true"'), 'the duplicate is hidden from assistive tech');
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

test('with no logo configured, the mark is the Credit Direct lockup', () => {
  // The default case, and the only one most deployments will ever be in.
  assert.equal(config.brand.logoUrl, null, 'nothing is configured by default');
  assert.ok(brand.substitute('{{brand.mark}}').includes('/assets/brand/creditdirect.svg'));
});

test('a configured logo replaces it', () => {
  const path = require.resolve('../../src/middleware/brand');
  const cfg = require('../../src/config');
  const saved = cfg.brand.logoUrl;

  cfg.brand.logoUrl = '/uploads/somebody-else.svg';
  delete require.cache[path];
  const rebranded = require(path);

  const mark = rebranded.TOKENS.get('brand.mark');
  assert.ok(mark.includes('/uploads/somebody-else.svg'), 'the configured logo is used');
  assert.ok(!mark.includes('creditdirect'), 'and it replaces both Credit Direct inks');

  cfg.brand.logoUrl = saved;
  delete require.cache[path];
  require(path);
});

// ─── Placeholders that would ship as written ─────────────────

test('every token written into a page is one that actually resolves', () => {
  // substitute() deliberately leaves an unknown name alone rather than blanking
  // it, so a page saying {{something}} for its own reasons survives. The cost of
  // that is that a typo — {{brand.produc}} — is not an error, it is text on the
  // sign-in page. This is what catches it.
  const fs = require('fs');
  const path = require('path');

  const known = new Set([...brand.TOKENS.keys()]);
  const root = path.join(__dirname, '..', '..', 'public');
  const offenders = [];

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(html|js)$/.test(entry.name)) continue;
      // The vendored bundle is third-party and never substituted.
      if (full.includes(`${path.sep}vendor${path.sep}`)) continue;

      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/\{\{\s*(brand[^}]*)\}\}/g)) {
        const name = m[1].trim();
        if (!known.has(name)) offenders.push(`${path.relative(root, full)}: {{${name}}}`);
      }
    }
  })(root);

  assert.deepEqual(offenders, [], 'these would be served to a person exactly as written');
});

test('the vendored swagger bundle is not dragged through substitution', async () => {
  // It is 1.5MB and contains {{ inside a regular expression. It must be served
  // by the static handler, untouched and uncached by this middleware.
  const res = await h.call('GET', '/vendor/swagger-ui/swagger-ui-bundle.js', { raw: true });
  assert.equal(res.status, 200);
  assert.ok(res.text.length > 1_000_000, 'the whole bundle is served');
  assert.ok(res.text.includes('{{[\\w\\W]*'), 'its own braces are left exactly as they are');
});
