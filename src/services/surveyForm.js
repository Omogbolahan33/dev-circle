const path = require('path');
const crypto = require('crypto');
const { uuid, parseJSON } = require('../utils/helpers');
const questions = require('./questions');

// ─── Survey definitions ─────────────────────────────────────
// The server's door onto the two files that define what a survey is. They sit
// under public/ so the builder and the member's page load the very same
// definition over HTTP — see the header of survey-schema.js for why that
// matters more than tidiness of layout.
//
// What this adds is the half only the server can do: giving each question a
// durable identity, and turning a posted body into either something storable
// or a list of reasons it is not.

const SHARED = path.join(__dirname, '..', '..', 'public', 'assets', 'js');

const schema = require(path.join(SHARED, 'survey-schema.js'));
const themes = require(path.join(SHARED, 'survey-theme.js'));

// Slot ids carry a random tail so that inserting a question into a live draft
// cannot hand an existing slot's id — and therefore its collected answers — to
// a different question.
const slotId = index => `q${index + 1}_${uuid().slice(0, 8)}`;

// ─── The public link ────────────────────────────────────────
// A survey addressed to whoever holds its link is reachable by anyone who
// holds it, so the token is the whole of its security. 32 bytes from the
// system generator: long enough that guessing is not a strategy, and URL-safe
// so it survives being pasted into a chat, a slide or a QR code.
const publicToken = () => crypto.randomBytes(24).toString('base64url');

// The key an anonymous respondent carries to come back to their own
// half-finished response. Hashed at rest, like every other bearer secret here
// — a leaked database should not hand over the ability to edit submissions.
const responseKey = () => crypto.randomBytes(24).toString('base64url');
const hashKey = key => crypto.createHash('sha256').update(String(key)).digest('hex');

const ANONYMOUS = 'anonymous';

// Take what was posted and return the survey as it will be stored. Questions
// come back normalized, themed and identified; issues come back as the reasons
// it cannot be saved, phrased for the person who wrote it.
// `identify` decides whether each answerable question also becomes a canonical
// question — a row in `questions`, so that answers to it can be read together
// whichever survey carried it. That is right for a survey and wrong for an
// onboarding form: onboarding answers are profile facts and are never filed as
// evidence, so the canonical row would carry nothing and would still be offered
// to the next author as a question already asked. A promise the data does not
// keep is worse than no row.
async function normalizeDefinition(body, { createdBy = null, allowEmpty = false, identify = true } = {}) {
  const { questions: normalized, issues } = schema.normalizeQuestions(body.questions, {
    makeId: slotId, allowEmpty
  });

  const { theme, issues: themeIssues, warnings } = themes.normalize(body.theme);
  for (const issue of themeIssues) {
    issues.push({ index: -1, field: `theme.${issue.field}`, message: issue.message });
  }

  if (issues.length) return { questions: normalized, theme, issues, warnings };

  // Slot ids are already assigned by normalizeQuestions, so a definition that
  // is not being identified is complete as it stands.
  if (!identify) return { questions: normalized, theme, issues: [], warnings };

  // Only what someone answers becomes a question in its own right — a section
  // heading is furniture. attachToSurvey may adopt the wording of a question
  // being continued, so what it returns is what gets stored.
  const identified = await questions.attachToSurvey(normalized, {
    createdBy,
    identifies: schema.isAnswerable
  });

  return { questions: identified, theme, issues: [], warnings };
}

// ─── Copying a survey ───────────────────────────────────────
// The questions of an existing survey, ready to be saved as a new one.
//
// Every slot gets a fresh id, and that is the whole point rather than a
// detail. Answers are keyed by slot id, so a copy that kept them would have
// two surveys whose responses are indexed by the same keys — and the first
// time somebody exported one against the other's definition, the columns
// would line up and mean nothing. Branching rules point at slot ids too, so
// they are rewritten in the same pass; a rule left pointing at the original's
// id would silently never fire, which is the worst way for logic to break
// because the survey still saves and still runs.
//
// What is deliberately carried over is question_id — the canonical question
// each slot is an instance of. A copy asks the same question, so its answers
// belong in the same body of evidence; that is what the canonical identity is
// for.
function copyQuestions(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const renamed = new Map(list.map((question, index) => [question.id, slotId(index)]));

  return list.map((question, index) => {
    const copy = { ...question, id: renamed.get(question.id) || slotId(index) };

    if (copy.visible_if && Array.isArray(copy.visible_if.rules)) {
      copy.visible_if = {
        ...copy.visible_if,
        rules: copy.visible_if.rules.map(rule => ({
          ...rule,
          question: renamed.get(rule.question) || rule.question
        }))
      };
    }

    return copy;
  });
}

// A stored survey with its JSON columns opened up, ready to be answered or
// rendered. Everything that reads a survey goes through here so a missing
// theme or a malformed questions column degrades the same way everywhere.
function hydrate(survey) {
  if (!survey) return null;
  return {
    ...survey,
    questions: typeof survey.questions === 'string' ? parseJSON(survey.questions, []) : (survey.questions || []),
    target_ids: typeof survey.target_ids === 'string' ? parseJSON(survey.target_ids, []) : (survey.target_ids || []),
    theme: typeof survey.theme === 'string' ? parseJSON(survey.theme, null) : (survey.theme || null),
    // The address to hand out. Built here so one definition of the link exists
    // rather than three screens each assembling their own.
    public_path: survey.public_token ? `/s/${survey.public_token}` : null
  };
}

// What an anonymous respondent may see of a survey. Everything an authored
// survey carries that is about *running* it — who it targets, which circle
// owns it, who wrote it, how many have answered — is nobody's business on the
// open internet, so this is a list of what to include rather than a list of
// what to strip. A field added to surveys later is private by default.
function forPublic(survey) {
  const full = hydrate(survey);
  return {
    id: full.id,
    title: full.title,
    description: full.description,
    questions: full.questions,
    theme: full.theme,
    time_estimate_min: full.time_estimate_min,
    expires_at: full.expires_at
  };
}

// The first line of an error response about a badly written survey. The
// builder shows issues against the questions they belong to; anything else
// reaching this endpoint gets a sentence it can print.
function issueSummary(issues) {
  const first = issues[0];
  if (!first) return 'Survey could not be saved';
  return first.number ? `Question ${first.number}: ${first.message}` : first.message;
}

// A draft may be empty; a survey that goes out may not. Checked wherever a
// survey becomes active, so it cannot be published empty through an edit
// either — the member would be sent an invitation to answer nothing.
function canGoOut(questions) {
  return Array.isArray(questions) && questions.some(schema.isAnswerable);
}

module.exports = {
  ...schema,
  themes,
  slotId,
  copyQuestions,
  normalizeDefinition,
  hydrate,
  forPublic,
  issueSummary,
  canGoOut,
  publicToken,
  responseKey,
  hashKey,
  ANONYMOUS
};
