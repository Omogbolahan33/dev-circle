const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ─── Reading a timestamp in the browser ─────────────────────
// The two databases hand the browser three shapes for the same column:
//
//   SQLite     "2026-08-26 22:14:19"            — datetime('now'), UTC, unmarked
//   Postgres   "2026-08-26T22:14:19.041Z"       — TIMESTAMPTZ, a Date through JSON
//   Postgres   "2026-08-26 22:14:19.041123+00"  — where the SQL cast it to text
//
// The third appears wherever a query renders the timestamp itself rather than
// letting the driver hand back a Date — the admin dashboard's UNION does,
// because every arm of it has to agree on a column type.
//
// Three pages normalised that themselves with `.replace(' ','T') + 'Z'`, which
// appends a second Z to the Postgres form. `…041ZZ` is not a date any browser
// will parse, so every session time and every dashboard time rendered the words
// "Invalid Date" after the move to Postgres.
//
// The second bug was quieter: formatDate did the replace *without* the Z, so it
// read the SQLite form as local time — an hour out in WAT, and "Just now"
// swallowed the negative difference so nothing looked wrong.

const API_JS = fs.readFileSync(path.join(__dirname, '../../public/assets/js/api.js'), 'utf8');

// The helper is a plain function in a browser script; lift it out to exercise it.
const parseStamp = (() => {
  const start = API_JS.indexOf('function parseStamp');
  const end = API_JS.indexOf('function formatDate');
  // eslint-disable-next-line no-eval
  return eval(`${API_JS.slice(start, end)}; parseStamp`);
})();

const iso = value => (parseStamp(value) ? parseStamp(value).toISOString() : null);

test('both databases produce the same instant', () => {
  // The same moment, written the way each backend writes it.
  assert.equal(iso('2026-08-26 22:14:19'), '2026-08-26T22:14:19.000Z');
  assert.equal(iso('2026-08-26T22:14:19.000Z'), '2026-08-26T22:14:19.000Z');
});

test('a Postgres timestamp is not given a second zone', () => {
  // The bug, stated directly: this is the value that rendered "Invalid Date".
  const postgres = '2026-08-26T22:14:19.041Z';
  assert.ok(parseStamp(postgres), 'a TIMESTAMPTZ through JSON must parse');
  assert.equal(iso(postgres), '2026-08-26T22:14:19.041Z');

  // And what the pages used to do with it
  assert.ok(Number.isNaN(new Date(postgres.replace(' ', 'T') + 'Z').getTime()),
    'the old normalisation really did produce an unparseable date');
});

test('a Postgres timestamp the SQL cast to text itself still parses', () => {
  // The third shape, and the one that put the word "Undated" over every row of
  // the admin dashboard's activity card. That card is read through a single
  // UNION — every arm has to agree on a column type — so the timestamp is cast
  // to text in SQL rather than coming back as a Date. Postgres renders it with
  // microseconds and the shortest legal offset, and "+00" is two digits where
  // the guard wanted four, so a Z was appended to a string that already had a
  // zone and nothing parsed it.
  assert.equal(iso('2026-08-26 22:14:19.041123+00'), '2026-08-26T22:14:19.041Z');
  assert.equal(iso('2026-08-26 22:14:19+00'), '2026-08-26T22:14:19.000Z');

  // And the old guard really did reject it, so this test fails if it returns.
  assert.ok(!/[Zz]$|[+-]\d{2}:?\d{2}$/.test('2026-08-26T22:14:19+00'),
    'a two-digit offset is exactly what the four-digit guard missed');
});

test('an offset is honoured however Postgres chose to write it', () => {
  // Postgres prints the minimum that is unambiguous: hours alone when the
  // minutes are zero, hours and minutes when they are not.
  assert.equal(iso('2026-08-26 22:14:19+01'), '2026-08-26T21:14:19.000Z');
  assert.equal(iso('2026-08-26 22:14:19-05'), '2026-08-27T03:14:19.000Z');
  assert.equal(iso('2026-08-26 22:14:19+0530'), '2026-08-26T16:44:19.000Z');
});

test('microseconds are rounded off rather than refused', () => {
  // Six fractional digits are not in the Date Time String Format. V8 forgives
  // them and Safari does not, which is the kind of difference that ships.
  assert.equal(iso('2026-08-26T22:14:19.041123Z'), '2026-08-26T22:14:19.041Z');
  assert.equal(iso('2026-08-26 22:14:19.5+01'), '2026-08-26T21:14:19.500Z');
});

test('a SQLite timestamp is read as UTC, not as local time', () => {
  // It is what datetime('now') returns, and it does not say so. Read as local
  // it is out by the machine's offset — an hour in WAT.
  assert.equal(iso('2026-08-26 22:14:19'), '2026-08-26T22:14:19.000Z');
});

test('an explicit offset is honoured rather than overwritten', () => {
  assert.equal(iso('2026-08-26T22:14:19+01:00'), '2026-08-26T21:14:19.000Z');
  assert.equal(iso('2026-08-26T22:14:19-05:00'), '2026-08-27T03:14:19.000Z');
});

test('a date with no time is midnight UTC, not an invalid date', () => {
  // date_of_birth is a bare date. Appending a zone to it produces nothing a
  // browser will parse, which is why it is handled before the zone is added.
  assert.equal(iso('1994-03-02'), '1994-03-02T00:00:00.000Z');
});

test('a Date object passes through', () => {
  const when = new Date('2026-01-01T00:00:00Z');
  assert.equal(parseStamp(when), when);
});

test('nothing readable comes back as null, never as an Invalid Date', () => {
  // A caller can render a dash for null. There is nothing sensible to render
  // for NaN, which is how the words "Invalid Date" reached a screen.
  for (const value of [null, undefined, '', '   ', 'not a date', 'Invalid Date', {}, new Date('nonsense')]) {
    assert.equal(parseStamp(value), null, `${JSON.stringify(value)} should be null`);
  }
});

test('no page normalises a timestamp on its own any more', () => {
  // The bug was one line, copied onto three pages. What stops it coming back is
  // that there is one parser and the pages call it.
  const offenders = [];

  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(html|js)$/.test(entry.name)) continue;
      if (full.endsWith(`assets${path.sep}js${path.sep}api.js`)) continue;

      const source = fs.readFileSync(full, 'utf8');
      if (/replace\(\s*['"] ['"]\s*,\s*['"]T['"]\s*\)/.test(source)) {
        offenders.push(path.relative(path.join(__dirname, '../../public'), full));
      }
    }
  };
  walk(path.join(__dirname, '../../public'));

  assert.deepEqual(offenders, [],
    '\nThese normalise a timestamp themselves instead of calling parseStamp:\n' + offenders.join('\n') + '\n');
});
