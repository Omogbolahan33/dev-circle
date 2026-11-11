const { toCSV } = require('../utils/helpers');
const { buildXLSX } = require('../utils/xlsx');
const { segmentForProducts } = require('../utils/participantSegment');

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
      'Participant segment is calculated from distinct products: none = General / App, 1 = Single Product, 2 = Multi-Product, 3+ = Power Tester. Any segment column in an older file is ignored.',
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
        notes: 'Industry or sector, separate from employment type.',
        suggested: ['Fintech', 'Banking', 'Lending', 'Payments', 'Insurance', 'Other'],
        examples: ['Fintech', 'Banking']
      },
      {
        key: 'employment',
        label: 'Employment',
        notes: 'Employment type, for example Salary Earner or Entrepreneur.',
        suggested: ['Salary Earner', 'Entrepreneur', 'Student'],
        examples: ['Salary Earner', 'Entrepreneur']
      },
      {
        key: 'age_group',
        aliases: ['age', 'age band'],
        label: 'Age group',
        notes: 'Age band rather than date of birth. Leave blank if unknown.',
        suggested: ['18 - 24', '25 - 34', '35 - 44', '45 - 54', '55 - 64'],
        examples: ['25 - 34', '35 - 44']
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
        key: 'products',
        label: 'Products',
        notes: 'Products the participant uses. Separate several with a semicolon; checkbox columns such as Mobile App and Yield are also recognised.',
        suggested: ['Mobile App', 'Yield', 'BNPL', 'Salaried Loans', 'CD Business'],
        examples: ['Mobile App; Yield', 'BNPL'],
        parse: value => [...new Set((Array.isArray(value) ? value : String(value).split(/[;|]/))
          .map(item => String(item).trim()).filter(Boolean))],
        empty: () => []
      },
      {
        key: 'status',
        label: 'Status',
        notes: 'Member status: active, inactive, or suspended.',
        suggested: ['active', 'inactive', 'suspended'],
        examples: ['active']
      },
      {
        key: 'preferred_research',
        label: 'Preferred research',
        notes: 'Research topics or formats the participant prefers.',
        examples: ['Product testing; interviews']
      },
      {
        key: 'last_contacted',
        label: 'Last contacted',
        notes: 'Date the participant was last contacted. ISO date recommended.',
        examples: ['2026-10-13']
      },
      {
        key: 'sessions',
        label: 'Sessions',
        notes: 'Number of research sessions completed.',
        examples: ['2'],
        parse: value => /^\d+$/.test(value) ? Number(value) : value
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
  const keyOf = value => String(value).trim().toLowerCase().replace(/[ _-]+/g, ' ');
  const values = Object.fromEntries(Object.entries(row).map(([k, v]) => [keyOf(k), v]));
  const lookup = name => values[keyOf(name)];

  for (const column of columns) {
    const names = [column.key, ...(column.aliases || [])];
    const found = names.map(lookup).find(v => v !== undefined && v !== null && String(v).trim() !== '');

    if (found === undefined) {
      out[column.key] = column.empty ? column.empty() : null;
      continue;
    }

    const value = String(found).trim();
    out[column.key] = column.parse ? column.parse(value) : value;
  }

  // Accept the participant panel's split-name and checkbox-product layout.
  if (!out.name) {
    const first = lookup('First Name');
    const last = lookup('Last Name');
    out.name = [first, last].filter(Boolean).map(String).join(' ').trim() || null;
  }
  if (!out.email) out.email = lookup('Email Address') || null;
  if (key === 'members') {
    if (!out.phone) out.phone = lookup('Phone') || null;
    if (!out.location_state) out.location_state = lookup('State') || null;
    const products = ['Mobile App', 'Yield', 'BNPL', 'Salaried Loans', 'CD Business']
      .filter(name => ['✓', 'yes', 'true', '1', 'x'].includes(String(lookup(name) || '').trim().toLowerCase()));
    if (products.length) out.products = [...new Set([...(out.products || []), ...products])];
    out.segment = segmentForProducts(out.products);
  }

  if (out.email) out.email = String(out.email).toLowerCase();
  if (out.status) out.status = String(out.status).trim().toLowerCase();
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
