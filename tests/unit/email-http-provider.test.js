const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const HttpEmailProvider = require('../../src/services/email/providers/http');

// ─── The vendor-neutral email provider ──────────────────────
// One provider for whichever REST email API a deployment has a key for,
// configured from the environment rather than from code. These run it against a
// real HTTP server standing in for a vendor, because what has to be right is
// the bytes on the wire — the header the key goes in and the names the fields
// take — and nothing short of an actual request proves those.

let server;
let baseUrl;
let seen = null;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen = { method: req.method, headers: req.headers, body: JSON.parse(body || '{}') };

      if (seen.body.subject === 'reject me') {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'sender domain not verified' }));
      }
      if (seen.body.subject === 'reject silently') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('nope');
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_12345', data: { id: 'nested_67890' } }));
    });
  });

  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/emails`;
});

after(() => server && server.close());

const base = () => ({
  url: baseUrl,
  apiKey: 'k_live_abc',
  fromEmail: 'devcircle@creditdirect.ng',
  fromName: 'Dev Circle'
});

const send = (config, overrides = {}) => new HttpEmailProvider({ ...base(), ...config })
  .send({ to: 'ada@zilla.ng', subject: 'Welcome', html: '<p>hi</p>', text: 'hi', ...overrides });

test('the default shape is a bearer token and flat json', () => {
  // What Resend, MailerSend and most smaller services take without any mapping.
  return send({}).then(out => {
    assert.equal(out.status, 'sent');
    assert.equal(out.ref, 'msg_12345');
    assert.equal(seen.headers.authorization, 'Bearer k_live_abc');
    assert.deepEqual(seen.body, {
      to: 'ada@zilla.ng',
      from: 'Dev Circle <devcircle@creditdirect.ng>',
      subject: 'Welcome',
      html: '<p>hi</p>',
      text: 'hi'
    });
  });
});

test('a bare key in a vendor header is the other convention, and it is expressible', async () => {
  await send({
    authHeader: 'X-Postmark-Server-Token',
    authScheme: '',
    fieldTo: 'To', fieldFrom: 'From', fieldSubject: 'Subject',
    fieldHtml: 'HtmlBody', fieldText: 'TextBody'
  });

  assert.equal(seen.headers['x-postmark-server-token'], 'k_live_abc');
  assert.equal(seen.headers.authorization, undefined, 'the key goes in one place, not two');
  assert.equal(seen.body.HtmlBody, '<p>hi</p>');
  assert.equal(seen.body.Subject, 'Welcome');
});

test('a recipient can be a list where the vendor insists on one', async () => {
  await send({ toAsArray: true });
  assert.deepEqual(seen.body.to, ['ada@zilla.ng']);
});

test('the sender can be a bare address where the vendor will not take a display name', async () => {
  await send({ fromWithName: false });
  assert.equal(seen.body.from, 'devcircle@creditdirect.ng');
});

test('what the vendor requires on every send rides along', async () => {
  // A message stream, a template id, a sending domain — the things a flat field
  // mapping cannot express.
  await send({ extra: { MessageStream: 'outbound', track_opens: false } });
  assert.equal(seen.body.MessageStream, 'outbound');
  assert.equal(seen.body.track_opens, false);
});

test('the message id is read from wherever the vendor puts it', async () => {
  assert.equal((await send({ refPath: 'data.id' })).ref, 'nested_67890');
  assert.equal((await send({ refPath: 'id' })).ref, 'msg_12345');
  // A path that is not there is not an error — the send worked, there is just
  // nothing to look up on their side.
  assert.equal((await send({ refPath: 'nowhere.at.all' })).ref, null);
});

test('the vendor\'s own words survive a refusal', async () => {
  // "HTTP 422" is not something an operator can act on.
  const out = await send({}, { subject: 'reject me' });
  assert.equal(out.status, 'failed');
  assert.match(out.error, /sender domain not verified/);
  assert.equal(out.ref, null);
});

test('a refusal with nothing to say still reports the status', async () => {
  const out = await send({}, { subject: 'reject silently' });
  assert.equal(out.status, 'failed');
  assert.match(out.error, /HTTP 500/);
});

test('an unreachable vendor is a failure, not a crash', async () => {
  const out = await new HttpEmailProvider({
    ...base(),
    url: 'http://127.0.0.1:1/emails'
  }).send({ to: 'ada@zilla.ng', subject: 'x' });

  assert.equal(out.status, 'failed');
  assert.ok(out.error);
});

test('without a url and a key it refuses rather than pretending', async () => {
  const provider = new HttpEmailProvider({});
  assert.equal(provider.isConfigured(), false);

  const out = await provider.send({ to: 'ada@zilla.ng', subject: 'x' });
  assert.equal(out.status, 'failed');
  assert.match(out.error, /EMAIL_HTTP_URL and EMAIL_HTTP_API_KEY/);
});

test('a send with no recipient is refused before it leaves', async () => {
  const out = await new HttpEmailProvider(base()).send({ to: null, subject: 'x' });
  assert.equal(out.status, 'failed');
  assert.match(out.error, /Recipient email address/);
});

test('it does not claim vendor features it cannot speak to', () => {
  // Templates and batching differ per vendor. A generic provider that claimed
  // them would be lying to whatever asked.
  const caps = new HttpEmailProvider(base()).getCapabilities();
  assert.equal(caps.html, true);
  assert.equal(caps.templates, false);
  assert.equal(caps.batch, false);
});
