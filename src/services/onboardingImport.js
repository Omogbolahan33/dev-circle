const responseImport = require('./responseImport');
const onboarding = require('./onboarding');
const surveyForm = require('./surveyForm');

// ─── Onboarding by spreadsheet ──────────────────────────────
// A form is not always filled in by the person it is about. A partner hands
// over a list of the developers they want enrolled, a stand collects a page of
// names, a programme arrives as somebody's export — and until those can be
// landed against a form's own questions they are a file on somebody's laptop.
//
// What an imported row becomes is exactly what a filled-in form becomes: an
// application, resolved into a profile by the same mapping and waiting on the
// same decision. It is emphatically *not* a shortcut into the members table —
// see the note on approve-on-import below for the one case where it can be
// both steps at once, and why that is gated on a separate permission.
//
// Almost none of the reading is here. The header matching, the cell coercion,
// the bracket form of a grid, the example row that makes the template
// self-explanatory — all of that is responseImport's, unchanged, because a
// spreadsheet full of answers is a spreadsheet full of answers whichever kind
// of form drew it up. What this file supplies is the two columns that are
// onboarding's rather than a survey's, and the prose that goes with them.

// The leading columns. Deliberately short: on an onboarding form the person's
// name, address and number are *questions*, tagged with the field they fill,
// so they already have columns of their own. Adding a second "Email" column
// here would give a sheet two places to put one thing.
const APPLICANT_COLUMNS = [
  {
    key: 'submitted_at',
    field: 'submittedAt',
    label: 'Collected at',
    // "Timestamp" is what a Google Forms export heads its submission time with,
    // and it is the single most common column on a sheet reaching this.
    aliases: ['collected_at', 'completed_at', 'timestamp', 'date', 'submitted'],
    notes: 'When they gave you these details, as YYYY-MM-DD or YYYY-MM-DD HH:MM. Blank means ' +
           'now — worth filling in, since it is what tells a reviewer how stale the row is.',
    example: '2026-03-14 09:20'
  },
  {
    key: 'reference',
    field: 'externalId',
    label: 'Your reference',
    aliases: ['external_ref', 'ref', 'record_id', 'submission_id'],
    notes: 'Your own id for this person, if you have one. Its only job is to make importing ' +
           'the same file twice land nothing the second time — which is what lets somebody ' +
           'who is not sure whether the first upload went through simply run it again.',
    example: 'partner-00417'
  }
];

const options = () => ({ meta: APPLICANT_COLUMNS, sheetName: 'Applicants', guidance: guidance() });

function guidance(form) {
  const name = form ? `"${form.name}"` : 'this form';
  return [
    `One row per person you are onboarding through ${name}. Delete the example row before importing.`,
    'A column is only required where the form itself requires an answer — which always includes ' +
      'the email address and the phone number, since those are what the member signs in with.',
    'A row missing one is refused rather than stored half-filled. Check the import first and it ' +
      'will name every row and column at once, so a sheet is fixed in one pass.',
    'Nothing here creates a member. Every row becomes an application in the same queue a filled-in ' +
      'form lands in, and somebody still has to approve it — unless you tick "approve as they ' +
      'land", which needs the permission to approve.',
    'A row whose email already has an application to this form is skipped, never duplicated.',
    'Do not rename the column headings. They are how each column finds the question it belongs to.',
    'Branching still applies. A question that would have been hidden by the answers in a row is ' +
      'not asked of that row, and anything filled in under it is dropped.'
  ];
}

// The blank sheet, generated from the form itself — so the separator in a
// multi-choice cell and the notation of a ranking are demonstrated rather than
// described in a paragraph nobody reads.
const columns = form => responseImport.columns(form, options());
const toCsvTemplate = form => responseImport.toCsvTemplate(form, { ...options(), guidance: guidance(form) });
const toWorkbook = form => responseImport.toWorkbook(form, { ...options(), guidance: guidance(form) });

const slug = name => String(name || 'form')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'form';

const filename = (form, format) => `${slug(form.name)}-applicants-template.${format}`;

// ─── Reading a sheet ────────────────────────────────────────

// One row into one application, or into the reason it is not one.
//
// Every row goes through surveyForm.checkResponse — the same check a filled-in
// form gets, from the same definition. That is deliberate and it is
// occasionally inconvenient: a partner's list that omits the phone number will
// have every row refused. The alternative is a queue holding applications that
// do not satisfy the rules the form states about itself, and then "approved"
// means something different depending on which door the row came in by.
function readRow(form, headings, raw) {
  const questions = onboarding.hydrate(form).questions;
  const { meta, answers, unmatched } = responseImport.readRow(headings, raw);

  const checked = surveyForm.checkResponse(questions, answers);
  if (!checked.ok) {
    const missing = checked.missing
      .map(id => questions.find(q => q.id === id))
      .filter(Boolean)
      .map(q => q.text);

    const wrong = Object.entries(checked.errors)
      .map(([id, message]) => {
        const question = questions.find(q => q.id === id);
        return question ? `${question.text}: ${message}` : message;
      });

    return {
      ok: false,
      unmatched,
      error: missing.length
        ? `Not answered: ${missing.join('; ')}`
        : wrong.join('; ') || 'Some answers could not be accepted'
    };
  }

  const { profile, consent } = onboarding.resolveProfile(questions, checked.answers);

  return {
    ok: true,
    unmatched,
    answers: checked.answers,
    profile,
    consent,
    submittedAt: meta.submittedAt,
    externalRef: meta.externalId
  };
}

module.exports = {
  APPLICANT_COLUMNS,
  columns, guidance, toCsvTemplate, toWorkbook, filename,
  readRow,
  accepts: responseImport.accepts,
  index: responseImport.index
};
