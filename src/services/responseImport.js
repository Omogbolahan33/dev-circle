const surveyForm = require('./surveyForm');
const { toCSV } = require('../utils/helpers');
const { buildXLSX } = require('../utils/xlsx');

// ─── Importing responses collected elsewhere ────────────────
// A survey does not always run here. It goes out on paper at a meetup, through
// Google Forms, inside a partner's own tool — and comes back as a spreadsheet.
// Those answers are the same evidence as the ones typed into this platform,
// and until they can be landed against a survey definition they are a file on
// somebody's laptop.
//
// This is the survey-shaped twin of importTemplates.js, and it is built on the
// same rule: the columns are declared once and both the downloadable template
// and the parser are generated from that declaration, so a template can never
// advertise a column the parser ignores. The difference is that there is no
// fixed column list to declare — the columns *are* the survey's questions, so
// the spec is computed per survey instead of written out.
//
// Onboarding forms land the same way, through onboardingImport.js, which is a
// thin wrapper: it passes its own leading columns and its own guidance and
// takes everything else — the header matching, the cell coercion, the grid
// bracket form, the example row — unchanged. That is the whole reason those
// take an options bag rather than reading a constant.
//
// Values are only reshaped here, never judged. A cell becomes the kind of
// thing an answer is — a number, a list, a grid — and then goes through
// surveyForm.checkResponse, the same check a member's submission gets. An
// imported answer is not held to a lower standard than a typed one.

// ─── Header matching ────────────────────────────────────────
// Headers arrive from three directions with three conventions: our own CSV
// export writes "q1. How clear are the docs?", a Google Forms export writes
// the wording alone, and parseCSV/parseXLSX have already lowercased everything
// and turned spaces into underscores. Normalising all of them the same way is
// what lets one sheet be read whichever of those it came from.

function norm(value) {
  return String(value ?? '')
    .replace(/[_\s]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[?.!,;:]+$/, '')
    .trim();
}

// The same heading with our export's position prefix taken off, so an export
// of one survey imports into another — which is the point of duplicating a
// survey and then bringing the old answers across. Kept as a second key rather
// than folded into the first, because "q1. Any comments?" and "q2. Any
// comments?" are two different columns and stripping the prefix would make
// them one.
const unnumbered = value => norm(value).replace(/^q\d+\s*[.)]\s*/, '').trim();

// Columns a sheet may carry that this import has no place to put. Named so
// that an export of one survey re-imports without its leading columns being
// reported as unmatched — silence about them would be right, but so would not
// crying wolf.
const CARRIED = ['triggered by'];

const RESPONDENT_COLUMNS = [
  {
    key: 'email',
    field: 'email',
    label: 'Respondent email',
    aliases: ['respondent_email', 'email_address', 'username'],
    notes: 'Matches the response to a member. An address nobody here holds yet creates the ' +
           'member, so a round run outside this platform brings its respondents with it. ' +
           'Leave it blank for someone answering anonymously: the answers are still kept, ' +
           'just with nobody attached to them.',
    example: 'ada.obi@zilla.ng'
  },
  {
    key: 'name',
    field: 'name',
    label: 'Respondent name',
    aliases: ['respondent_name', 'full_name'],
    // Only read when the email names somebody new. Overwriting the name an
    // existing member gave us with whatever a spreadsheet says would let a
    // transcription error rewrite a profile, which is not what importing a
    // survey is for.
    notes: 'Used only when the email is one we have not seen — it names the member being ' +
           'created. An existing member keeps the name they gave us.',
    example: 'Ada Obi'
  },
  {
    key: 'company',
    field: 'company',
    label: 'Company',
    aliases: ['organisation', 'organization'],
    notes: 'Same again: recorded on a member being created, ignored for one who already exists.',
    example: 'Zilla'
  },
  {
    key: 'submitted_at',
    field: 'submittedAt',
    label: 'Submitted at',
    // "Timestamp" is what a Google Forms export heads its submission time
    // with, and it is the single most common column on a sheet reaching this.
    // Ignoring it would date every imported response to the day it was typed
    // in, quietly flattening the one reading nobody would think to check.
    aliases: ['completed_at', 'timestamp', 'date', 'submitted'],
    notes: 'When they answered, as YYYY-MM-DD or YYYY-MM-DD HH:MM. Blank means now — worth ' +
           'filling in, since it is what every reading of responses over time depends on.',
    example: '2026-03-14 09:20'
  },
  {
    key: 'response_id',
    field: 'externalId',
    label: 'Their reference',
    aliases: ['external_response_id', 'submission_id'],
    notes: 'The other system\'s own id for this submission, if it has one. Its only job is to ' +
           'make importing the same file twice land nothing the second time.',
    example: 'gf-00417'
  }
];

// ─── The columns of one survey ──────────────────────────────
// One column per answerable question, plus one per row of a grid. The bracket
// form — "Rate these [Documentation]" — is the convention Google Forms and
// Microsoft Forms both export grids in, so a grid arrives already split the
// way this reads it.
//
// A section holds no answer, so it holds no column, exactly as in the CSV
// export.
function columns(survey, { meta = RESPONDENT_COLUMNS } = {}) {
  const questions = surveyForm.hydrate(survey).questions || [];
  const spec = meta.map(c => ({
    ...c,
    kind: 'respondent',
    match: [c.key, ...c.aliases]
  }));

  let number = 0;

  for (const question of questions) {
    if (!surveyForm.isAnswerable(question)) continue;
    number++;

    const wording = question.text || question.type;

    const entry = (suffix = '') => ({
      kind: 'question',
      question,
      number,
      key: `q${number}. ${wording}${suffix}`,
      // The position, the slot id and the wording all address the same column.
      // The slot id is the one that survives a question being reworded between
      // the export and the import; the wording is the one a form built
      // somewhere else will have written.
      match: [`q${number}${suffix}`, `${question.id}${suffix}`, `${wording}${suffix}`]
    });

    if (question.type === 'matrix' && (question.rows || []).length) {
      for (const row of question.rows) {
        spec.push({ ...entry(` [${row}]`), row });
      }
      // The same grid packed into one cell — "Docs: Clear; Errors: Confusing"
      // — which is how the CSV export writes it, and therefore how last
      // round's export arrives. Read, but not offered: a column per row is
      // easier to fill in by hand and easier to read back.
      spec.push({ ...entry(), row: null, template: false });
      continue;
    }

    spec.push({ ...entry(), row: null });
  }

  return spec;
}

// Every heading that addresses a column, resolved to the column it addresses.
// A heading claimed by two columns is dropped rather than given to the first:
// two questions worded identically are told apart by their position, and
// guessing between them would put one respondent's answer under the other
// question with nothing on screen ever saying so.
function index(spec) {
  const found = new Map();
  const clashed = new Set();

  const claim = (heading, column) => {
    if (!heading) return;
    if (clashed.has(heading)) return;
    if (found.has(heading) && found.get(heading) !== column) {
      found.delete(heading);
      clashed.add(heading);
      return;
    }
    found.set(heading, column);
  };

  for (const column of spec) {
    claim(norm(column.key), column);
    claim(unnumbered(column.key), column);
    for (const alias of column.match) claim(norm(alias), column);
  }

  return found;
}

// ─── Reading a cell ─────────────────────────────────────────

const blank = value => value === undefined || value === null || String(value).trim() === '';

// Excel hands a date over as a count of days since 1899-12-30 — the epoch that
// bakes in the 1900 leap-year bug every spreadsheet has agreed to keep. A cell
// formatted as a date in the workbook arrives here as that number, so a date
// column that looks like "45731" is a real date rather than a typo.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const EXCEL_MAX = 2958465;              // 9999-12-31

function fromExcelSerial(value, { withTime = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > EXCEL_MAX) return null;
  const iso = new Date(EXCEL_EPOCH + Math.round(n * 86400000)).toISOString();
  return withTime ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 10);
}

// A date in whatever the sheet wrote it as, returned as YYYY-MM-DD or null.
// Day-first is assumed for a slashed date, because that is what a Nigerian
// spreadsheet means by 03/04/2026 — and guessing the other way round would
// silently move a third of every date set by up to eleven months.
function toISODate(value) {
  const text = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);

  const slashed = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (slashed) {
    const [, day, month, year] = slashed;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  if (/^\d+(\.\d+)?$/.test(text)) return fromExcelSerial(text);

  return null;
}

// When a submission happened, in the form SQLite stores. Anything unreadable
// comes back null and the caller falls back to now rather than refusing the
// row: an import whose timestamps are messy is still an import worth having.
function toTimestamp(value) {
  if (blank(value)) return null;
  const text = String(value).trim();

  const stamped = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?/.exec(text);
  if (stamped) return `${stamped[1]} ${stamped[2]}${stamped[3] || ':00'}`;

  if (/^\d+(\.\d+)?$/.test(text)) return fromExcelSerial(text, { withTime: true });

  // A date in some other notation with a clock time after it — "14/03/2026
  // 09:20:15", which is how a form export stamps a submission. The date half
  // goes through the same reading as a bare one, so there is one place that
  // decides what 03/04 means.
  const withClock = /^(\S+)[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  const date = toISODate(withClock ? withClock[1] : text);
  if (!date) return null;

  const clock = withClock
    ? `${String(withClock[2]).padStart(2, '0')}:${withClock[3]}:${withClock[4] || '00'}`
    : '00:00:00';

  return `${date} ${clock}`;
}

// Several answers in one cell. Semicolons and pipes only — a comma sits inside
// far too many option labels to be a separator, and the CSV parser has already
// dealt with the commas that were structural.
const splitList = value =>
  String(value).split(/[;|\n]/).map(v => v.trim()).filter(Boolean);

// Strip what answerToText adds on the way out, so the export's own formatting
// survives the round trip back in: "1. Docs" is the option "Docs" in first
// place, and "4/5" is a rating of 4.
const unrank = value => String(value).replace(/^\d+\s*[.)]\s*/, '').trim();
const unscale = value => String(value).split('/')[0].trim();

const escapeRe = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One cell, reshaped into the kind of thing this question's answer is.
// Anything that cannot be reshaped is passed through untouched for
// checkResponse to refuse in its own words — there is no second vocabulary of
// error messages here.
function readCell(question, raw) {
  const value = String(raw).trim();

  switch (question.type) {
    case 'multi_choice':
      return splitList(value);

    case 'ranking':
      return splitList(value).map(unrank);

    case 'rating':
    case 'nps':
      return unscale(value);

    case 'number':
      // "12 calls" is what the export writes when the question carries a unit
      return question.unit
        ? value.replace(new RegExp(`\\s*${escapeRe(question.unit)}\\s*$`, 'i'), '').trim()
        : value;

    case 'date':
      return toISODate(value) || value;

    case 'boolean': {
      const folded = value.toLowerCase();
      const yes = [String(question.true_label || 'Yes').toLowerCase(), 'yes', 'true', 'y', '1'];
      const no = [String(question.false_label || 'No').toLowerCase(), 'no', 'false', 'n', '0'];
      if (yes.includes(folded)) return true;
      if (no.includes(folded)) return false;
      return value;
    }

    default:
      return value;
  }
}

// A grid arriving as one cell rather than a column per row: "Docs: Clear;
// Errors: Confusing", which is how the CSV export writes it.
function readGrid(question, raw) {
  const answer = {};
  for (const entry of splitList(raw)) {
    const at = entry.indexOf(':');
    if (at < 0) continue;
    const row = entry.slice(0, at).trim();
    const picked = entry.slice(at + 1).trim();
    if (!row || !picked) continue;
    answer[row] = question.multi ? picked.split('/').map(v => v.trim()).filter(Boolean) : picked;
  }
  return answer;
}

// ─── Reading a row ──────────────────────────────────────────

// One sheet row into one response. Returns the answers keyed by slot id — the
// same keys a submitted response uses — plus what the row said about the
// respondent. Nothing is validated here; checkResponse does that, once, for
// every way an answer can arrive.
function readRow(headings, row) {
  const meta = { email: null, name: null, company: null, submittedAt: null, externalId: null };
  const answers = {};
  const unmatched = [];

  for (const [heading, raw] of Object.entries(row || {})) {
    if (blank(raw)) continue;

    const cleaned = norm(heading);
    const column = headings.get(cleaned) || headings.get(unnumbered(heading));

    if (!column) {
      // A heading that matched nothing produces a blank answer, and a blank
      // answer looks exactly like a question somebody chose not to answer.
      // Nothing else in the import would ever say otherwise, so it is said
      // here.
      if (!CARRIED.includes(cleaned)) unmatched.push(heading);
      continue;
    }

    if (column.kind === 'respondent') {
      meta[column.field] = String(raw).trim();
      continue;
    }

    const { question, row: gridRow } = column;

    if (gridRow) {
      const held = answers[question.id];
      const existing = held && typeof held === 'object' && !Array.isArray(held) ? held : {};
      answers[question.id] = {
        ...existing,
        [gridRow]: question.multi
          ? String(raw).split(/[;|/]/).map(v => v.trim()).filter(Boolean)
          : String(raw).trim()
      };
      continue;
    }

    answers[question.id] = question.type === 'matrix'
      ? readGrid(question, raw)
      : readCell(question, raw);
  }

  meta.email = meta.email ? meta.email.toLowerCase() : null;
  meta.submittedAt = toTimestamp(meta.submittedAt);

  return { meta, answers, unmatched };
}

// ─── The template ───────────────────────────────────────────
// The blank sheet, generated from the survey itself. This is why a template
// earns its place here: the separator in a multi-choice cell, the order
// notation of a ranking and the bracket form of a grid are conventions nobody
// would guess, and every one of them is demonstrated by the example row rather
// than described in a paragraph nobody reads.

function filler(length) {
  const unit = 'A sentence in their own words. ';
  return unit.repeat(Math.ceil(length / unit.length) + 1).slice(0, length);
}

// A plausible answer, chosen so the downloaded template imports without a
// single edit. That is asserted by a test, and it is the only honest way to
// promise an operator that the format shown is the format accepted.
function exampleAnswer(question, row = null) {
  switch (question.type) {
    case 'text': {
      const example = question.format === 'email' ? 'ada.obi@zilla.ng'
        : question.format === 'url' ? 'https://docs.creditdirect.ng'
        : question.format === 'phone' ? '+2348031234567'
        : 'The sandbox keys worked first time.';
      const long = example.length < (question.min_length || 0) ? filler(question.min_length) : example;
      return long.slice(0, question.max_length || long.length);
    }

    case 'choice':
    case 'dropdown':
      return (question.options || [])[0] || '';

    case 'multi_choice': {
      const options = question.options || [];
      const exclusive = new Set((question.exclusive_options || []).map(surveyForm.foldOption));
      // An exclusive option cannot be shown alongside anything else, so the
      // ones that can be held together come first
      const pool = [
        ...options.filter(o => !exclusive.has(surveyForm.foldOption(o))),
        ...options.filter(o => exclusive.has(surveyForm.foldOption(o)))
      ];
      const least = Math.max(question.min_select || 1, 1);
      const most = Math.min(question.max_select || pool.length, pool.length);
      return pool.slice(0, Math.max(least, Math.min(2, most))).join('; ');
    }

    case 'ranking':
      return (question.options || []).map((o, i) => `${i + 1}. ${o}`).join('; ');

    case 'rating': {
      const scale = question.scale || 5;
      return String(Math.min(Math.ceil(scale / 2) + 1, scale));
    }

    case 'nps':
      return '9';

    case 'number': {
      const min = question.min ?? 1;
      const max = question.max ?? Math.max(min, 12);
      const value = Math.min(Math.max(min, 12), max);
      return String(question.integer ? Math.round(value) : value);
    }

    case 'date':
      return question.min || question.max || '2026-03-14';

    case 'boolean':
      return question.true_label || 'Yes';

    case 'matrix':
      return row ? (question.columns || [])[0] || '' : '';

    default:
      return '';
  }
}

// What the sheet itself carries. A column the parser reads but the template
// does not offer — a grid packed into one cell — is left out of both the
// heading row and the example, so the two can never disagree about what a
// filled-in sheet looks like.
const offered = spec => spec.filter(c => c.template !== false);

const headers = spec => offered(spec).map(c => c.key);

const exampleRow = spec => offered(spec).map(column => column.kind === 'respondent'
  ? column.example
  : exampleAnswer(column.question, column.row));

// What a column will accept, spelled out for the sheet that explains itself.
// Read off the question rather than written per type, so a scale changed in
// the builder changes what this says.
function accepts(question) {
  switch (question.type) {
    case 'choice':
    case 'dropdown':
      return `One of: ${(question.options || []).join(', ')}.` +
        (question.allow_other ? ' Anything else is kept as an "Other" answer.' : '');
    case 'multi_choice':
      return `Any of: ${(question.options || []).join(', ')}. Separate several with a semicolon.` +
        (question.min_select ? ` At least ${question.min_select}.` : '') +
        (question.max_select ? ` At most ${question.max_select}.` : '');
    case 'ranking':
      return `Every one of ${(question.options || []).join(', ')}, in order, separated by ` +
        'semicolons. A partial order is refused — it cannot be compared with a complete one.';
    case 'rating':
      return `A whole number from 1 to ${question.scale || 5}. "4/5" is read as 4.`;
    case 'nps':
      return 'A whole number from 0 to 10.';
    case 'number':
      return 'A number.' +
        (question.min !== undefined ? ` At least ${question.min}.` : '') +
        (question.max !== undefined ? ` At most ${question.max}.` : '') +
        (question.integer ? ' Whole numbers only.' : '') +
        (question.unit ? ` Measured in ${question.unit}.` : '');
    case 'date':
      return 'A date as YYYY-MM-DD. A date-formatted cell from Excel is read correctly too.' +
        (question.min ? ` On or after ${question.min}.` : '') +
        (question.max ? ` On or before ${question.max}.` : '');
    case 'boolean':
      return `"${question.true_label || 'Yes'}" or "${question.false_label || 'No'}". ` +
        'Yes/no and true/false are accepted as well.';
    case 'matrix':
      return `One of: ${(question.columns || []).join(', ')}.` +
        (question.multi ? ' Separate several with a slash.' : '');
    case 'text':
      return question.format === 'email' ? 'An email address.'
        : question.format === 'url' ? 'A full web address, starting http:// or https://.'
        : question.format === 'phone' ? 'A phone number.'
        : `Whatever they wrote, up to ${question.max_length || 2000} characters.`;
    default:
      return '';
  }
}

function guidance(survey) {
  return [
    `One row per respondent who answered "${survey.title}". Delete the example row before importing.`,
    'A column is only required where the survey itself requires an answer. A row missing one ' +
      'is refused rather than stored half-answered — check the import first and it will name ' +
      'every row and question at once.',
    'An email nobody here holds yet creates the member, using the name and company beside ' +
      'it. An email that already belongs to somebody attaches the response to them and ' +
      'changes nothing about their profile.',
    'Leave the email blank only for someone answering anonymously. Their answers are still ' +
      'kept, but on a survey that was put to named people a blank email is flagged — it is ' +
      'far more often a column that did not line up than a genuine anonymous reply.',
    'A row whose email matches a member who has already completed this survey is skipped, ' +
      'never duplicated.',
    'Do not rename the column headings. They are how each column finds the question it belongs to.',
    'Free-text answers are filed as feedback as well, so they can be read alongside everything ' +
      'else that developer has told us.'
  ];
}

function toCsvTemplate(survey, opts = {}) {
  const spec = columns(survey, opts);
  const cols = headers(spec);
  const row = exampleRow(spec);
  // Authored here rather than supplied by a member, so the formula guard is
  // off: it would otherwise prefix "+234…" with an apostrophe that then
  // imports as part of the number.
  return toCSV(cols, [row], (r, header) => r[cols.indexOf(header)], { neutralizeFormulas: false });
}

function toWorkbook(survey, opts = {}) {
  const spec = columns(survey, opts);

  const data = { name: opts.sheetName || 'Responses', rows: [headers(spec), exampleRow(spec)] };

  // A second sheet carrying the rules, so whoever is transcribing a stack of
  // paper forms does not have to go back to the app to find out what a column
  // will accept.
  const reference = {
    name: 'How to fill this in',
    rows: [
      ['Column', 'Required', 'What it accepts'],
      ...offered(spec).map(column => column.kind === 'respondent'
        ? [column.label, 'Optional', column.notes]
        : [
          column.key,
          column.question.required ? 'Required' : 'Optional',
          [column.row ? `The "${column.row}" row of the grid.` : null, accepts(column.question)]
            .filter(Boolean).join(' ')
        ]),
      [],
      ['Notes'],
      ...(opts.guidance ? opts.guidance : guidance(survey)).map(line => [line])
    ]
  };

  return buildXLSX([data, reference]);
}

// A survey title is written by a person, and a filename will not take
// everything a person might write
const slug = title => String(title || 'survey')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'survey';

const filename = (survey, format) => `${slug(survey.title)}-responses-template.${format}`;

module.exports = {
  columns, index, offered, headers, readRow, exampleRow, exampleAnswer, accepts, guidance,
  toCsvTemplate, toWorkbook, filename,
  norm, unnumbered, toISODate, toTimestamp,
  RESPONDENT_COLUMNS, CARRIED
};
