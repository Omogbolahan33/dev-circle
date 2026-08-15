const zlib = require('zlib');

// ─── Minimal XLSX reader ────────────────────────────────────
// The blueprint asks for bulk import "from existing excel worksheet". An
// .xlsx file is a ZIP archive of XML parts, and Node ships inflate, so the
// first worksheet can be read without pulling in a spreadsheet library —
// which for this use (read a flat table of members) would be a lot of
// surface area for very little gain.
//
// Scope: the first worksheet, cell values as strings. Formulas resolve to
// their cached value. Styling, dates-as-serial-numbers, and multi-sheet
// workbooks beyond sheet one are deliberately out of scope.

class XlsxError extends Error {}

// ─── ZIP ────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

function findEndOfCentralDirectory(buf) {
  // The EOCD record sits at the end, after a comment of up to 64KB
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new XlsxError('Not a valid .xlsx file (no ZIP end-of-directory record)');
}

function readEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CEN_SIG) {
      throw new XlsxError('Corrupt ZIP central directory');
    }

    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function extract(buf, entry) {
  // The local header repeats the name and extra fields with its own lengths
  const nameLength = buf.readUInt16LE(entry.localOffset + 26);
  const extraLength = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return raw;                 // stored
  if (entry.method === 8) return zlib.inflateRawSync(raw); // deflate
  throw new XlsxError(`Unsupported ZIP compression method ${entry.method}`);
}

// ─── XML ────────────────────────────────────────────────────

const XML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'"
};

function decodeXml(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, m => XML_ENTITIES[m]);
}

// Shared strings are stored once and referenced by index from the sheet.
// A string can be split across several <t> runs when it carries formatting.
function parseSharedStrings(xml) {
  if (!xml) return [];

  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, inner]) => {
    const runs = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1]));
    return runs.join('');
  });
}

function columnIndex(ref) {
  // "BC12" → column 54 (zero-based)
  const letters = /^([A-Z]+)/.exec(ref);
  if (!letters) return 0;
  let n = 0;
  for (const char of letters[1]) {
    n = n * 26 + (char.charCodeAt(0) - 64);
  }
  return n - 1;
}

function parseSheet(xml, sharedStrings) {
  const rows = [];

  for (const [, rowXml] of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];

    for (const match of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = match[1] ?? match[3] ?? '';
      const body = match[2] ?? '';

      const refMatch = /r="([A-Z]+\d+)"/.exec(attrs);
      const index = refMatch ? columnIndex(refMatch[1]) : cells.length;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];

      let value = '';
      if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1])).join('');
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          value = type === 's' ? (sharedStrings[Number(v)] ?? '') : decodeXml(v);
        }
      }

      // Fill gaps so column positions stay aligned with the header row
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }

    rows.push(cells);
  }

  return rows;
}

// ─── Public ─────────────────────────────────────────────────

// Read the first worksheet into an array of objects keyed by header row,
// matching what parseCSV returns so the import path is shared.
function parseXLSX(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'base64');

  if (buf.length < 22 || buf.readUInt16LE(0) !== 0x4b50) {
    throw new XlsxError('Not a valid .xlsx file');
  }

  const entries = readEntries(buf);

  // Sheet order in the archive is not guaranteed, so take the lowest-numbered
  // sheet part, which is the first worksheet in practice.
  const sheetNames = [...entries.keys()]
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));

  if (!sheetNames.length) throw new XlsxError('No worksheet found in the workbook');

  const shared = entries.has('xl/sharedStrings.xml')
    ? parseSharedStrings(extract(buf, entries.get('xl/sharedStrings.xml')).toString('utf8'))
    : [];

  const rows = parseSheet(extract(buf, entries.get(sheetNames[0])).toString('utf8'), shared);

  const nonEmpty = rows.filter(r => r.some(cell => String(cell).trim() !== ''));
  if (nonEmpty.length < 2) return [];

  const headers = nonEmpty[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, '_'));

  return nonEmpty.slice(1).map(cells => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = String(cells[i] ?? '').trim(); });
    return obj;
  });
}

// ─── Writing ────────────────────────────────────────────────
// The mirror of the reader: assemble the same handful of XML parts back into
// a ZIP. Used for import templates, so an operator can download a workbook
// with the right columns instead of guessing at them.
//
// Values are written as inline strings. That skips the shared-strings table
// entirely — worth it for a template of a few dozen cells, and it keeps every
// value exactly as typed rather than letting Excel reinterpret it.

function crc32(buf) {
  let crc = -1;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are not legal in XML and will make Excel declare the
    // file corrupt rather than skip the cell
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function columnName(index) {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function sheetXml(rows) {
  const body = rows.map((cells, r) => {
    const rendered = cells.map((value, c) => {
      if (value === null || value === undefined || value === '') return '';
      return `<c r="${columnName(c)}${r + 1}" t="inlineStr">` +
             `<is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${rendered}</row>`;
  }).join('');

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData></worksheet>`;
}

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const sum = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(8, 8);               // deflate
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, deflated);

    const entry = Buffer.alloc(46 + nameBuf.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);              // version made by
    entry.writeUInt16LE(20, 6);              // version needed
    entry.writeUInt16LE(8, 10);              // deflate
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    nameBuf.copy(entry, 46);
    central.push(entry);

    offset += local.length + deflated.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

// sheets: [{ name, rows: [[cell, cell], …] }]
function buildXLSX(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) {
    throw new XlsxError('At least one sheet is required');
  }

  // Excel rejects these characters in a tab name and caps it at 31 chars
  const names = sheets.map((s, i) =>
    String(s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));

  const files = [
    ['[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map((_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ` +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
      '</Types>'],

    ['_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'],

    ['xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((name, i) =>
        `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>'],

    ['xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) =>
        `<Relationship Id="rId${i + 1}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        `Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      '</Relationships>'],

    ...sheets.map((sheet, i) =>
      [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet.rows || [])])
  ];

  return zip(files);
}

module.exports = { parseXLSX, buildXLSX, XlsxError };
