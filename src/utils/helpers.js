const crypto = require('crypto');

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function parseJSON(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// `max` is the page-size ceiling and defaults to the 100 the admin tables use.
// A few feeds raise it — the dashboard reads twelve weeks of engagement in one
// request to draw the heat grid — and they say so at the call site rather than
// clamping by hand and getting the offset wrong, which is the bug below.
function paginate(page = 1, limit = 20, { max = 100 } = {}) {
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.min(max, Math.max(1, parseInt(limit) || 20));
  // Offset must use the clamped limit — using the raw argument skipped or
  // repeated rows whenever the caller asked for more than the cap.
  return { offset: (p - 1) * l, limit: l, page: p };
}

// The envelope every paged list answers with, so one "Load more" on the client
// works against all of them. `pages` is 0 for an empty set rather than 1 —
// there is no page to be on — and `has_more` saves every caller doing the
// same arithmetic to decide whether to offer the button.
function pageMeta({ page, limit, total }) {
  return { page, limit, total, pages: Math.ceil(total / limit) || 0, has_more: page * limit < total };
}

function buildWhere(filters) {
  const clauses = [];
  const params = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      clauses.push(`${key} = ?`);
      params.push(value);
    }
  }
  return {
    where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '',
    params
  };
}

function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  safe.preferred_channels = parseJSON(safe.preferred_channels, []);
  safe.preferred_days = parseJSON(safe.preferred_days, []);
  safe.api_products = parseJSON(safe.api_products, []);
  safe.notification_prefs = parseJSON(safe.notification_prefs, {});
  return safe;
}

// ─── CSV ────────────────────────────────────────────────────
// Exports go straight into Excel, so values need escaping on two fronts:
// embedded quotes/newlines must be quoted properly, and a leading =, +, -, or
// @ must be neutralised or Excel evaluates the cell as a formula.

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

// neutralizeFormulas guards against a member putting a formula in a field and
// having it execute in whoever opens the export. It is on for anything derived
// from user data, and off only for content we authored ourselves — an import
// template, where a phone number legitimately starts with "+" and must survive
// the round trip back through the parser.
function csvCell(value, { neutralizeFormulas = true } = {}) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) value = value.join('; ');

  let str = String(value);
  if (neutralizeFormulas && FORMULA_PREFIX.test(str)) str = `'${str}`;

  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(values, options) {
  return values.map(v => csvCell(v, options)).join(',');
}

function toCSV(headers, rows, pick = (row, header) => row[header], options) {
  const lines = [csvRow(headers, options)];
  for (const row of rows) {
    lines.push(csvRow(headers.map(h => pick(row, h)), options));
  }
  return lines.join('\r\n');
}

// ─── CSV parsing (bulk import) ──────────────────────────────
// Handles quoted fields, embedded commas, and escaped quotes, which a naive
// split(',') does not. Returns an array of objects keyed by header.

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = String(text).replace(/^﻿/, ''); // strip BOM from Excel exports

  for (let i = 0; i < src.length; i++) {
    const char = src[i];

    if (inQuotes) {
      if (char === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }

  if (field.length || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter(r => r.some(cell => cell.trim() !== ''));
  if (nonEmpty.length < 2) return [];

  const headers = nonEmpty[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));

  return nonEmpty.slice(1).map(cells => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] ?? '').trim(); });
    return obj;
  });
}

module.exports = {
  uuid, now, parseJSON, paginate, pageMeta, buildWhere, sanitizeUser,
  csvCell, csvRow, toCSV, parseCSV
};
