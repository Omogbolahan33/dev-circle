const { toCSV } = require('../utils/helpers');
const { buildXLSX } = require('../utils/xlsx');

// ─── Import templates ───────────────────────────────────────
// Every bulk import declares its columns once, here. The importer reads rows
// through this spec and the downloadable template is generated from it, so a
// template can never advertise a column the parser ignores, or omit one it
// requires. Adding an import means adding an entry — the download endpoint,
// the reference sheet, and the validation notes all follow from it.

class TemplateError extends Error {}

const NIGERIAN_STATES = 'Lagos, Abuja, Rivers, Kano, Oyo, Kaduna, Enugu, …';

const TEMPLATES = {
  members: {
    label: 'Members',
    filename: 'devcircle-members-template',
    sheetName: 'Members',
    // Shown above the reference table in the workbook
    guidance: [
      'Fill in one row per person. Delete the example rows before importing.',
      'Only email and name are required; leave anything else blank if you do not have it.',
      'Members sign in with a one-time code sent to their email or phone, so there is no password column.',
      'Credit Direct staff are not imported here — add them under Roles, where they get a password.',
      'Re-importing someone who already exists skips them rather than creating a duplicate.'
    ],
    columns: [
      {
        key: 'email',
        required: true,
        label: 'Email',
        notes: 'Their sign-in identity, and where a one-time code goes. Must not be a Credit Direct address.',
        examples: ['ada.obi@zilla.ng', 'kunle@wemabank.dev']
      },
      {
        key: 'name',
        required: true,
        aliases: ['full_name'],
        label: 'Full name',
        notes: 'As they would write it themselves.',
        examples: ['Ada Obi', 'Kunle Adeyemi']
      },
      {
        key: 'phone',
        aliases: ['phone_number'],
        label: 'Phone',
        notes: 'Include the country code. Used for one-time codes, WhatsApp and SMS.',
        examples: ['+2348031234567', '+2349087654321']
      },
      {
        key: 'company',
        aliases: ['organisation', 'organization'],
        label: 'Company',
        notes: 'The business they integrate on behalf of.',
        examples: ['Zilla', 'Wema Bank']
      },
      {
        key: 'work_sector',
        aliases: ['sector'],
        label: 'Work sector',
        notes: 'Free text, but stick to one spelling so cohorts group cleanly.',
        suggested: ['Fintech', 'Banking', 'Lending', 'Payments', 'Insurance', 'Other'],
        examples: ['Fintech', 'Banking']
      },
      {
        key: 'date_of_birth',
        aliases: ['dob'],
        label: 'Date of birth',
        notes: 'YYYY-MM-DD. Feeds the age bands on the analytics page. Leave blank if unknown.',
        examples: ['1994-04-12', '1988-11-30']
      },
      {
        key: 'gender',
        label: 'Gender',
        notes: 'Free text; blank is fine.',
        suggested: ['female', 'male', 'other'],
        examples: ['female', 'male']
      },
      {
        key: 'location_state',
        aliases: ['state'],
        label: 'State',
        notes: `Where they are based. ${NIGERIAN_STATES}`,
        examples: ['Lagos', 'Ogun']
      },
      {
        key: 'api_products',
        label: 'API products',
        notes: 'Which product families they integrate. Separate several with a semicolon.',
        suggested: ['payments', 'lending', 'identity', 'credit_scoring'],
        examples: ['payments;lending', 'lending'],
        // Stored as a JSON array, so the string has to be split on the way in
        parse: value => String(value).split(/[;|]/).map(s => s.trim()).filter(Boolean),
        empty: () => []
      }
    ]
  }
};

function get(key) {
  const template = TEMPLATES[key];
  if (!template) throw new TemplateError(`No import template named "${key}"`);
  return template;
}

function list() {
  return Object.entries(TEMPLATES).map(([key, t]) => ({
    key,
    label: t.label,
    required: t.columns.filter(c => c.required).map(c => c.key),
    optional: t.columns.filter(c => !c.required).map(c => c.key)
  }));
}

// Read one uploaded row through the spec. Header aliases are resolved here, so
// a spreadsheet that says "full_name" or "sector" still lands correctly.
function normaliseRow(key, row) {
  const { columns } = get(key);
  const out = {};

  for (const column of columns) {
    const names = [column.key, ...(column.aliases || [])];
    const found = names.map(n => row[n]).find(v => v !== undefined && v !== null && String(v).trim() !== '');

    if (found === undefined) {
      out[column.key] = column.empty ? column.empty() : null;
      continue;
    }

    const value = String(found).trim();
    out[column.key] = column.parse ? column.parse(value) : value;
  }

  // Email is the identity key and is matched case-insensitively everywhere else
  if (out.email) out.email = out.email.toLowerCase();

  return out;
}

function headers(key) {
  return get(key).columns.map(c => c.key);
}

// The rows shown under the header, which an operator overwrites with real data
function exampleRows(key) {
  const { columns } = get(key);
  const depth = Math.max(...columns.map(c => (c.examples || []).length));
  return Array.from({ length: depth }, (_, i) =>
    columns.map(c => (c.examples || [])[i] ?? ''));
}

// ─── Renderers ──────────────────────────────────────────────

function toCsvTemplate(key) {
  const cols = headers(key);
  // Template content is authored here, not supplied by a member, so the
  // formula guard is off — it would otherwise prefix "+234…" phone numbers
  // with an apostrophe that then imports as part of the number.
  return toCSV(cols, exampleRows(key), (row, header) => row[cols.indexOf(header)],
    { neutralizeFormulas: false });
}

function toWorkbook(key) {
  const template = get(key);
  const cols = headers(key);

  const dataSheet = {
    name: template.sheetName || 'Data',
    rows: [cols, ...exampleRows(key)]
  };

  // A second sheet carrying the rules, so the person filling this in does not
  // have to go back to the app to find out what a column expects
  const reference = {
    name: 'How to fill this in',
    rows: [
      ['Column', 'Required', 'What it is'],
      ...template.columns.map(c => [
        c.label || c.key,
        c.required ? 'Required' : 'Optional',
        [
          c.notes,
          c.suggested ? `Suggested values: ${c.suggested.join(', ')}.` : null,
          c.aliases?.length ? `Also accepted as: ${c.aliases.join(', ')}.` : null
        ].filter(Boolean).join(' ')
      ]),
      [],
      ['Notes'],
      ...template.guidance.map(line => [line])
    ]
  };

  return buildXLSX([dataSheet, reference]);
}

function filename(key, format) {
  return `${get(key).filename}.${format}`;
}

module.exports = {
  TEMPLATES, get, list, normaliseRow, headers, exampleRows,
  toCsvTemplate, toWorkbook, filename, TemplateError
};
