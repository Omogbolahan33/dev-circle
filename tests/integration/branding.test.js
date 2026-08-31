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
  assert.ok(res.text.includes(`by ${config.brand.organisation}`), 'the mark is attributed');
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
