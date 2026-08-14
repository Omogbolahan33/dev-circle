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

module.exports = { parseXLSX, XlsxError };
