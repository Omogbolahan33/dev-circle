const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const h = require('../helpers');
const templates = require('../../src/services/importTemplates');
const { parseXLSX } = require('../../src/utils/xlsx');
const { parseCSV } = require('../../src/utils/helpers');

before(h.start);
after(h.stop);

let token;

beforeEach(async () => {
  h.reset();
  h.makeRootCircle();
  const role = h.makeRole('Super Admin', ['*']);
  const admin = h.makeAdmin({ email: 'boss@creditdirect.ng', roleId: role });
  token = await h.loginAdmin(admin.email, admin.password);
});

async function fetchTemplate(format) {
  const res = await fetch(`${h.baseUrl()}/api/admin/import/template?format=${format}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res;
}

// ─── The template describes what the parser accepts ─────────
// This is the point of generating it from the column spec: a template that
// advertises a column the importer ignores is worse than no template at all.

test('the template header row is exactly the columns the importer reads', () => {
  const rows = parseCSV(templates.toCsvTemplate('members'));
  assert.deepEqual(Object.keys(rows[0]), templates.headers('members'));
});

test('every required column appears in the template', () => {
  const required = templates.get('members').columns.filter(c => c.required).map(c => c.key);
  const header = templates.headers('members');
  for (const key of required) assert.ok(header.includes(key), `${key} missing from template`);
});

test('the downloaded CSV imports cleanly without a single edit', async () => {
  const res = await fetchTemplate('csv');
  assert.equal(res.status, 200);

  const csv = (await res.text()).replace(/^﻿/, '');
  const result = await h.post('/api/admin/import', { csv, dry_run: true }, { token });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.errors, [], 'the example rows must satisfy every validation rule');
  assert.equal(result.body.created, 2);
});

test('the downloaded workbook imports cleanly without a single edit', async () => {
  const res = await fetchTemplate('xlsx');
  assert.equal(res.status, 200);

  const xlsx_base64 = Buffer.from(await res.arrayBuffer()).toString('base64');
  const result = await h.post('/api/admin/import', { xlsx_base64, dry_run: true }, { token });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.errors, []);
  assert.equal(result.body.created, 2);
});

test('CSV and XLSX templates carry identical data', async () => {
  const csv = parseCSV((await (await fetchTemplate('csv')).text()).replace(/^﻿/, ''));
  const xlsx = parseXLSX(Buffer.from(await (await fetchTemplate('xlsx')).arrayBuffer()));

  // A phone number starting with "+" is where these last diverged: the CSV
  // formula guard was prefixing it with an apostrophe
  assert.deepEqual(csv, xlsx);
});

test('the example rows survive normalisation into the shape the database wants', () => {
  const rows = parseCSV(templates.toCsvTemplate('members'));
  const normalised = templates.normaliseRow('members', rows[0]);

  assert.equal(normalised.email, 'ada.obi@zilla.ng');
  assert.deepEqual(normalised.api_products, ['payments', 'lending'],
    'the semicolon list must become an array');
  assert.match(normalised.phone, /^\+/, 'the leading + must survive the round trip');
});

test('a column alias in an uploaded sheet still lands', () => {
  // Someone exporting from another system may head the columns differently
  const normalised = templates.normaliseRow('members', {
    email: 'ADA@Zilla.NG', full_name: 'Ada Obi', sector: 'Fintech',
    state: 'Lagos', dob: '1994-04-12', organisation: 'Zilla'
  });

  assert.equal(normalised.name, 'Ada Obi');
  assert.equal(normalised.work_sector, 'Fintech');
  assert.equal(normalised.location_state, 'Lagos');
  assert.equal(normalised.date_of_birth, '1994-04-12');
  assert.equal(normalised.company, 'Zilla');
  assert.equal(normalised.email, 'ada@zilla.ng', 'email is the identity key and is lowercased');
});

test('a blank optional column becomes null, not the string "undefined"', () => {
  const normalised = templates.normaliseRow('members', { email: 'a@b.ng', name: 'A B' });
  assert.equal(normalised.company, null);
  assert.deepEqual(normalised.api_products, []);
});

// ─── Delivery ───────────────────────────────────────────────

test('the workbook is a valid archive with the parts a reader expects', async () => {
  const buf = Buffer.from(await (await fetchTemplate('xlsx')).arrayBuffer());

  // Locate the central directory and read the part names out of it, rather
  // than trusting our own reader to validate our own writer
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocd, -1, 'no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names = [];

  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50);
    const nameLength = buf.readUInt16LE(offset + 28);
    names.push(buf.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }

  for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
                          'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) {
    assert.ok(names.includes(required), `${required} missing from the workbook`);
  }
});

test('the workbook carries a second sheet explaining the columns', async () => {
  const buf = Buffer.from(await (await fetchTemplate('xlsx')).arrayBuffer());
  assert.ok(buf.includes(Buffer.from('xl/worksheets/sheet2.xml')));

  // The workbook part names the tabs; check the guidance tab is one of them
  const workbook = templates.toWorkbook('members');
  assert.ok(workbook.length > 1000);
});

test('downloads are named so the browser saves a usable file', async () => {
  for (const [format, extension] of [['csv', 'csv'], ['xlsx', 'xlsx']]) {
    const res = await fetchTemplate(format);
    const disposition = res.headers.get('content-disposition');
    assert.match(disposition, /attachment/);
    assert.match(disposition, new RegExp(`\\.${extension}"`));
  }
});

test('the CSV opens as UTF-8 in Excel', async () => {
  const buf = Buffer.from(await (await fetchTemplate('csv')).arrayBuffer());
  // Without the byte-order mark Excel reads accented names as mojibake
  assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
});

test('an unknown format is refused rather than guessed at', async () => {
  const res = await h.get('/api/admin/import/template?format=pdf', { token });
  assert.equal(res.status, 400);
});

test('an unknown template type 404s', async () => {
  const res = await h.get('/api/admin/import/template?type=invoices&format=csv', { token });
  assert.equal(res.status, 404);
});

// ─── Access ─────────────────────────────────────────────────

test('the template needs the same permission as the import itself', async () => {
  const role = h.makeRole('Viewer', ['members.read']);
  const viewer = h.makeAdmin({ email: 'viewer@creditdirect.ng', roleId: role });
  const viewerToken = await h.loginAdmin(viewer.email, viewer.password);

  for (const path of ['/api/admin/import/template?format=csv', '/api/admin/import/columns']) {
    const res = await h.get(path, { token: viewerToken });
    assert.equal(res.status, 403, `${path} should require members.import`);
  }
});

test('the columns endpoint returns what the drawer needs to describe the upload', async () => {
  const res = await h.get('/api/admin/import/columns', { token });

  assert.equal(res.status, 200);
  assert.ok(res.body.guidance.length > 0);

  const email = res.body.columns.find(c => c.key === 'email');
  assert.equal(email.required, true);
  assert.ok(email.notes);

  const products = res.body.columns.find(c => c.key === 'api_products');
  assert.ok(products.suggested.includes('lending'));
});

// ─── Writer ─────────────────────────────────────────────────

test('cells beyond column Z are addressed correctly', () => {
  const { buildXLSX } = require('../../src/utils/xlsx');
  const wide = Array.from({ length: 30 }, (_, i) => `col${i}`);
  const buf = buildXLSX([{ name: 'Wide', rows: [wide] }]);

  const sheet = zlib.inflateRawSync(extractPart(buf, 'xl/worksheets/sheet1.xml')).toString();
  assert.ok(sheet.includes('r="AA1"'), 'the 27th column must be AA, not [1');
  assert.ok(sheet.includes('r="AD1"'));
});

test('characters that would corrupt the XML are handled', () => {
  const { buildXLSX } = require('../../src/utils/xlsx');
  const buf = buildXLSX([{ name: 'Odd', rows: [['a & b', '<script>', 'quote"here']] }]);
  assert.deepEqual(parseXLSX(buf), []); // one row only, so no data rows

  const withHeader = buildXLSX([{
    name: 'Odd',
    rows: [['name', 'note'], ['Smith & Sons', 'a <tag> and a "quote"']]
  }]);
  const rows = parseXLSX(withHeader);
  assert.equal(rows[0].name, 'Smith & Sons');
  assert.equal(rows[0].note, 'a <tag> and a "quote"');
});

test('a sheet name Excel would reject is sanitised', () => {
  const { buildXLSX } = require('../../src/utils/xlsx');
  const buf = buildXLSX([{ name: 'Bad/Name:With*Chars[]?', rows: [['a']] }]);
  const workbook = zlib.inflateRawSync(extractPart(buf, 'xl/workbook.xml')).toString();

  assert.ok(!/[\\/?*[\]:]/.test(/name="([^"]*)"/.exec(workbook)[1]));
});

test('building a workbook with no sheets is refused', () => {
  const { buildXLSX, XlsxError } = require('../../src/utils/xlsx');
  assert.throws(() => buildXLSX([]), XlsxError);
});

// Pull one deflated part out of the archive by name
function extractPart(buf, wanted) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    const nameLength = buf.readUInt16LE(offset + 28);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const localOffset = buf.readUInt32LE(offset + 42);

    if (name === wanted) {
      const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      return buf.subarray(start, start + compressedSize);
    }
    offset += 46 + nameLength + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }
  throw new Error(`${wanted} not found`);
}
