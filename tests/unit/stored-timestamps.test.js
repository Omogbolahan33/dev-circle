const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseStamp, sqlTime, hasExpired } = require('../../src/utils/helpers');

// ─── Reading a stored timestamp on the server ───────────────
// The browser's half of this is in timestamps.test.js. This is the other half,
// and it was the more expensive one, because on the server a timestamp is not
// read to be displayed — it is read to decide whether something has expired.
//
// Four shapes reach this process:
//
//   SQLite     "2026-08-26 22:14:19"            datetime('now') — UTC, unmarked
//   Postgres   Date                             a TIMESTAMPTZ, parsed by pg
//   Postgres   "2026-08-26 22:14:19.041123+00"  where the SQL cast it to text
//   either     "2026-08-26"                     a bare date column
//
// Seven call sites normalised this for themselves with a variation on
// `String(value).replace(' ', 'T')`, which handles the first and mangles the
// second into an Invalid Date. `Invalid Date < new Date()` is false, so the
// answer to "has this expired?" was no — for a closed survey, for a revoked
// key's expiry, for the previous engagement a streak counts from.

const iso = value => (parseStamp(value) ? parseStamp(value).toISOString() : null);

const INSTANT = '2026-08-26T22:14:19.041Z';

test('every shape the two databases produce is the same instant', () => {
  assert.equal(iso(new Date(INSTANT)), INSTANT);                       // pg, a Date
  assert.equal(iso('2026-08-26 22:14:19.041123+00'), INSTANT);         // pg, cast to text
  assert.equal(iso('2026-08-26T22:14:19.041Z'), INSTANT);              // pg, through JSON
  assert.equal(iso('2026-08-26 22:14:19'), '2026-08-26T22:14:19.000Z'); // sqlite
});

test('a Date is not stringified and re-parsed into nonsense', () => {
  // The bug, stated directly. pg registers no type parser for timestamps, so
  // this is what every expiry check was actually handed.
  const fromPg = new Date(INSTANT);

  assert.equal(iso(fromPg), INSTANT);
  assert.ok(Number.isNaN(new Date(String(fromPg).replace(' ', 'T')).getTime()),
    'the old normalisation really did make an Invalid Date of it');
});

test('an expiry in the past is expired, whichever shape it arrives in', () => {
  const at = new Date('2026-10-01T00:00:00Z');

  for (const past of [
    new Date(INSTANT),
    '2026-08-26 22:14:19.041123+00',
    '2026-08-26T22:14:19.041Z',
    '2026-08-26 22:14:19'
  ]) {
    assert.equal(hasExpired(past, at), true,
      `${past} is in the past and must read as expired`);
  }
});

test('an expiry in the future is not expired, whichever shape it arrives in', () => {
  const at = new Date('2026-01-01T00:00:00Z');

  for (const future of [
    new Date(INSTANT),
    '2026-08-26 22:14:19.041123+00',
    '2026-08-26T22:14:19.041Z',
    '2026-08-26 22:14:19'
  ]) {
    assert.equal(hasExpired(future, at), false);
  }
});

test('no expiry, and an unreadable one, are not expired', () => {
  // Most rows have no expiry at all, and "not set" has always meant "does not
  // expire". An unreadable one answers the same way rather than locking
  // somebody out of a key over a value nobody can parse.
  for (const value of [null, undefined, '', '   ', 'not a date', new Date('nonsense')]) {
    assert.equal(hasExpired(value), false, `${JSON.stringify(value)} must not read as expired`);
  }
});

test('an offset is honoured however Postgres chose to write it', () => {
  assert.equal(iso('2026-08-26 22:14:19+01'), '2026-08-26T21:14:19.000Z');
  assert.equal(iso('2026-08-26 22:14:19-05'), '2026-08-27T03:14:19.000Z');
  assert.equal(iso('2026-08-26 22:14:19+0530'), '2026-08-26T16:44:19.000Z');
  assert.equal(iso('2026-08-26 22:14:19+05:30'), '2026-08-26T16:44:19.000Z');
});

test('an unzoned timestamp is UTC, not the hour the server happens to keep', () => {
  // datetime('now') writes UTC and does not say so. Read as local it is out by
  // the host's offset — an hour in WAT, which is what put the wrong time in a
  // session invitation.
  assert.equal(iso('2026-08-26 22:14:19'), '2026-08-26T22:14:19.000Z');
});

test('a value that is already a Date string is left to the engine', () => {
  // Nothing should hand this a stringified Date any more, but if something
  // does, the normalisation below must not be applied to it: "West Africa
  // Time" contains a T, and the old rules would have read the hour off by one
  // rather than failing outright.
  const when = new Date(INSTANT);
  assert.equal(parseStamp(String(when)).getTime(), Math.floor(when.getTime() / 1000) * 1000);
});

test('a bare date is midnight UTC', () => {
  assert.equal(iso('1994-03-02'), '1994-03-02T00:00:00.000Z');
});

test('sqlTime is the inverse, in the form both databases compare as text', () => {
  assert.equal(sqlTime(new Date(INSTANT)), '2026-08-26 22:14:19');
  assert.equal(sqlTime('2026-08-26 22:14:19.041123+00'), '2026-08-26 22:14:19');
  assert.equal(sqlTime(null), null);
});

test('nothing on the server normalises a stored timestamp on its own', () => {
  // Seven call sites did, each slightly differently, and the one that was
  // right was right by accident. What stops it coming back is that there is
  // one parser and everything calls it.
  const offenders = [];
  const root = path.join(__dirname, '../../src');

  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (full === path.join(root, 'utils', 'helpers.js')) continue;

      // The parsing direction only. `.replace('T', ' ')` is the inverse — a
      // Date being written out — and that is fine wherever it appears.
      const source = fs.readFileSync(full, 'utf8');
      if (/replace\(\s*['"] ['"]\s*,\s*['"]T['"]\s*\)/.test(source)) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  walk(root);

  assert.deepEqual(offenders, [],
    '\nThese normalise a stored timestamp themselves instead of calling parseStamp:\n' +
    offenders.join('\n') + '\n');
});
