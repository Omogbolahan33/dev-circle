const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// pg.js requires the `pg` driver, but only *creates* the pool lazily — so
// requiring it here never opens a connection.
const pg = require('../../src/db/pg');

describe('PG_DNS_RESULT_ORDER parsing', () => {
  test('defaults to ipv4first when unset or vague', () => {
    assert.equal(pg.parseDnsResultOrder(undefined), 'ipv4first');
    assert.equal(pg.parseDnsResultOrder(''), 'ipv4first');
    assert.equal(pg.parseDnsResultOrder('   '), 'ipv4first');
    assert.equal(pg.parseDnsResultOrder('default'), 'ipv4first');
    assert.equal(pg.parseDnsResultOrder('auto'), 'ipv4first');
  });

  test('passes through valid orders case-insensitively', () => {
    assert.equal(pg.parseDnsResultOrder('ipv4first'), 'ipv4first');
    assert.equal(pg.parseDnsResultOrder('IPV6FIRST'), 'ipv6first');
    assert.equal(pg.parseDnsResultOrder(' Verbatim '), 'verbatim');
  });

  test('none/off keeps Node’s default (no override)', () => {
    assert.equal(pg.parseDnsResultOrder('none'), null);
    assert.equal(pg.parseDnsResultOrder('off'), null);
  });

  test('falls back to ipv4first on garbage values', () => {
    assert.equal(pg.parseDnsResultOrder('ip-first'), 'ipv4first');
    assert.equal(pg.parseDnsResultOrder('ipv4 first'), 'ipv4first');
  });

  test('applyDnsResultOrder returns the applied order', () => {
    assert.equal(pg.applyDnsResultOrder('ipv4first'), 'ipv4first');
    assert.equal(pg.applyDnsResultOrder('none'), null);
  });
});

describe('Postgres connection diagnosis', () => {
  // The exact failure seen in production: Render resolved the DB hostname to
  // an IPv6 address it had no route for.
  const productionError = new Error(
    'connect ENETUNREACH 2a05:d018:1b65:3002:3b53:4bd9:3cbb:8274:5432 - Local (:::0)'
  );

  test('recognises IPv6-unreachable failures and says what to do', () => {
    const d = pg.diagnoseConnectionError(productionError);
    assert.ok(d, 'expected a diagnosis');
    assert.match(d.reason, /IPv6/);
    assert.match(d.reason, /2a05:d018:1b65:3002/);
    assert.match(d.fix, /pooler|PG_DNS_RESULT_ORDER/);
  });

  test('does not confuse the "::" local-address wildcard with IPv6', () => {
    const d = pg.diagnoseConnectionError(new Error('connect ENETUNREACH 1.2.3.4:5432 - Local (:::0)'));
    // IPv4 unreachable is a routing/firewall problem, not the IPv6 trap —
    // falls through to no diagnosis rather than claiming IPv6.
    assert.equal(d, null);
  });

  test('flags DNS failures', () => {
    const d = pg.diagnoseConnectionError(new Error('getaddrinfo ENOTFOUND db.xxxxx.supabase.co'));
    assert.ok(d);
    assert.match(d.reason, /resolve/);
  });

  test('flags refused/timeout with the paused-or-expired hint', () => {
    const d = pg.diagnoseConnectionError(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })
    );
    assert.ok(d);
    assert.match(d.fix, /pause|expire/);
  });

  test('flags bad credentials by pg error code', () => {
    const d = pg.diagnoseConnectionError(
      Object.assign(new Error('password authentication failed for user "postgres"'), { code: '28P01' })
    );
    assert.ok(d);
    assert.match(d.reason, /credentials/);
  });

  test('returns null for unrelated errors', () => {
    assert.equal(pg.diagnoseConnectionError(new Error('syntax error at or near "FROM"')), null);
    assert.equal(pg.diagnoseConnectionError(null), null);
  });
});
