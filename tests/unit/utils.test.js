const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { parseCSV, toCSV, csvCell, paginate } = require('../../src/utils/helpers');
const { parseXLSX, XlsxError } = require('../../src/utils/xlsx');

// ─── CSV writing ────────────────────────────────────────────

test('a value containing a comma is quoted', () => {
  assert.equal(csvCell('Obi, Ada'), '"Obi, Ada"');
});

test('embedded quotes are doubled, not left to break the row', () => {
  assert.equal(csvCell('Say "hi"'), '"Say ""hi"""');
});

test('a formula-looking value is neutralised before it reaches Excel', () => {
  // Otherwise a member could put a formula in their company name and have it
  // execute in whoever opens the export
  for (const dangerous of ['=cmd|calc', '+1+1', '-1+1', '@SUM(A1)']) {
    assert.ok(csvCell(dangerous).startsWith("'"), `${dangerous} should be prefixed`);
  }
});

test('ordinary values are left alone', () => {
  assert.equal(csvCell('Paystack'), 'Paystack');
  assert.equal(csvCell(42), '42');
  assert.equal(csvCell(null), '');
});

test('arrays are flattened into one cell', () => {
  assert.equal(csvCell(['payments', 'lending']), 'payments; lending');
});

test('toCSV emits a header row plus one row per record', () => {
  const csv = toCSV(['name', 'email'], [
    { name: 'Ada', email: 'ada@x.ng' },
    { name: 'Obi, B', email: 'obi@x.ng' }
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'name,email');
  assert.equal(lines[1], 'Ada,ada@x.ng');
  assert.equal(lines[2], '"Obi, B",obi@x.ng');
});

// ─── CSV reading ────────────────────────────────────────────

test('quoted fields containing commas survive the round trip', () => {
  const rows = parseCSV('email,name\nada@x.ng,"Obi, Ada"');
  assert.deepEqual(rows, [{ email: 'ada@x.ng', name: 'Obi, Ada' }]);
});

test('escaped quotes inside a field are decoded', () => {
  const rows = parseCSV('name,company\nAda,"Zilla ""Labs"""');
  assert.equal(rows[0].company, 'Zilla "Labs"');
});

test('headers are normalised so spreadsheet capitalisation does not matter', () => {
  const rows = parseCSV('Email,Full Name,Work Sector\nada@x.ng,Ada Obi,Fintech');
  assert.deepEqual(Object.keys(rows[0]), ['email', 'full_name', 'work_sector']);
});

test('a byte-order mark from Excel is stripped', () => {
  const rows = parseCSV('﻿email,name\nada@x.ng,Ada');
  assert.equal(rows[0].email, 'ada@x.ng');
});

test('a header row on its own yields nothing', () => {
  assert.deepEqual(parseCSV('email,name'), []);
});

test('blank lines are ignored', () => {
  const rows = parseCSV('email,name\n\nada@x.ng,Ada\n\n');
  assert.equal(rows.length, 1);
});

// ─── XLSX ───────────────────────────────────────────────────

// Build a minimal but genuine .xlsx: a ZIP of the XML parts Excel writes
function buildXlsx({ shared, rows }) {
  const files = new Map();

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  files.set('xl/sharedStrings.xml',
    `<?xml version="1.0"?><sst count="${shared.length}">` +
    shared.map(s => `<si><t>${esc(s)}</t></si>`).join('') + '</sst>');

  const cols = 'ABCDEFGH';
  const sheetRows = rows.map((indices, r) =>
    `<row r="${r + 1}">` +
    indices.map((idx, c) => `<c r="${cols[c]}${r + 1}" t="s"><v>${idx}</v></c>`).join('') +
    '</row>').join('');
  files.set('xl/worksheets/sheet1.xml',
    `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`);

  files.set('[Content_Types].xml', '<?xml version="1.0"?><Types/>');

  // Assemble the ZIP by hand so the test does not depend on a zip library
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);              // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    locals.push(local, deflated);

    const cen = Buffer.alloc(46 + nameBuf.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(deflated.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    nameBuf.copy(cen, 46);
    central.push(cen);

    offset += local.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.size, 8);
  eocd.writeUInt16LE(files.size, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function crc32(buf) {
  let crc = -1;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

test('a worksheet is read into records keyed by its header row', () => {
  const workbook = buildXlsx({
    shared: ['email', 'name', 'company', 'ada@zilla.ng', 'Obi, Ada', 'Zilla Labs'],
    rows: [[0, 1, 2], [3, 4, 5]]
  });

  assert.deepEqual(parseXLSX(workbook), [
    { email: 'ada@zilla.ng', name: 'Obi, Ada', company: 'Zilla Labs' }
  ]);
});

test('base64 input is accepted, as the upload endpoint sends it', () => {
  const workbook = buildXlsx({
    shared: ['email', 'name', 'a@b.ng', 'Ada'],
    rows: [[0, 1], [2, 3]]
  });

  const rows = parseXLSX(workbook.toString('base64'));
  assert.equal(rows[0].email, 'a@b.ng');
});

test('XML entities in cell values are decoded', () => {
  const workbook = buildXlsx({
    shared: ['company', 'Smith & Sons <Ltd>'],
    rows: [[0], [1]]
  });

  assert.equal(parseXLSX(workbook)[0].company, 'Smith & Sons <Ltd>');
});

test('a file that is not a workbook is rejected clearly', () => {
  assert.throws(() => parseXLSX(Buffer.from('this is a text file')), XlsxError);
});

// ─── Pagination ─────────────────────────────────────────────

test('the page offset uses the clamped limit, not the requested one', () => {
  // Asking for 500 clamps to 100; the offset must follow the clamp or page 2
  // skips 400 records that were never shown
  const { offset, limit } = paginate(2, 500);
  assert.equal(limit, 100);
  assert.equal(offset, 100);
});

test('nonsense pagination input falls back to defaults', () => {
  const { offset, limit, page } = paginate('abc', 'xyz');
  assert.equal(page, 1);
  assert.equal(limit, 20);
  assert.equal(offset, 0);
});
