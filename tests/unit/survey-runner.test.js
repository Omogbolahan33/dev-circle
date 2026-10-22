const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ─── The footer button, in every layout ─────────────────────
// This exists because of a survey that took seven clicks on Submit to send.
// Seven questions, all on one page, and the footer button was wired to the
// one-question-at-a-time walk: each click moved an invisible cursor on by one
// question, and only the click that reached the last one actually submitted.
// On a survey with a question still unanswered, the next click landed on a
// question the member could not see, reported an error against it, and never
// submitted at all — a Submit button that does nothing.
//
// The two runners (survey, onboarding) both carry the walk, so both are read
// out of their page and exercised here. There is no DOM in this suite and no
// browser dependency to add: the two functions this is about are pure routing
// — which screen a click goes to — and everything they touch is a stub below.

const PAGES = {
  'member survey': path.join(__dirname, '..', '..', 'public', 'member', 'survey.html'),
  'onboarding form': path.join(__dirname, '..', '..', 'public', 'onboarding', 'form.html')
};

// The source of one function declaration, braces balanced. A page has one
// inline script and no build step, so this is the only handle on it.
function functionSource(html, name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() is no longer on the page`);

  let i = html.indexOf('{', start);
  const bodyStart = i;
  let depth = 0;
  let quote = null;
  let template = false;

  for (; i < html.length; i++) {
    const char = html[i];

    if (quote) {
      if (char === '\\') { i++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (template) {
      if (char === '\\') { i++; continue; }
      if (char === '`') template = false;
      continue;
    }
    if (char === '/' && html[i + 1] === '/') { while (i < html.length && html[i] !== '\n') i++; continue; }
    if (char === '/' && html[i + 1] === '*') { i += 2; while (i < html.length && !(html[i] === '*' && html[i + 1] === '/')) i++; i++; continue; }
    if (char === '\'' || char === '"') { quote = char; continue; }
    if (char === '`') { template = true; continue; }

    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }

  // Unbalanced braces in the file would have shipped a page that cannot parse,
  // so this is about the reader, not the page.
  assert.fail(`could not find the end of ${name}() at ${bodyStart}`);
}

// The page's function, with its free names answered by `scope` — which is also
// where its side effects land, so a test can see what a click did.
function load(html, name, scope) {
  const source = functionSource(html, name);
  const build = new Function('scope', `with (scope) { ${source}\nreturn ${name}; }`);
  return build(scope);
}

const QUESTIONS = Array.from({ length: 7 }, (_, i) => ({
  id: `q${i + 1}_ab12cd${i}`,
  type: 'choice',
  required: true
}));

// Everything goNext()/goBack() can reach, as counters and stubs. `answerable`
// is the one behaviour worth varying: a required question with no answer is
// what turns a click into a refusal.
function scopeFor(layout, { answerable = true } = {}) {
  const questions = QUESTIONS;

  const scope = {
    theme: { layout },
    cursor: 0,
    pageCursor: 0,
    answers: {},
    errors: {},
    embedded: false,

    submitted: 0,
    rendered: 0,
    paged: 0,
    scrolled: 0,
    shown: [],

    asked: () => questions,
    paging: () => layout === 'n_per_page' || layout === 'by_section',
    pagesNow: () => [questions],
    isLast: () => scope.cursor >= questions.length - 1,
    isLastPage: () => scope.pageCursor >= 0,

    SurveySchema: {
      isAnswerable: () => true,
      validateAnswer: () => (answerable ? { ok: true, value: 'Yes' } : { ok: false, error: 'This one is required' })
    },

    submit: () => { scope.submitted++; },
    render: () => { scope.rendered++; },
    renderPages: () => { scope.paged++; },
    reportHeight: () => {},
    showError: question => { scope.shown.push(question.id); },
    window: { scrollTo: () => { scope.scrolled++; } }
  };

  return scope;
}

for (const [label, file] of Object.entries(PAGES)) {
  const html = fs.readFileSync(file, 'utf8');

  test(`${label}: a survey on one page submits on the first click`, () => {
    const scope = scopeFor('all_at_once');
    const goNext = load(html, 'goNext', scope);

    goNext();

    assert.equal(scope.submitted, 1, 'one click on the footer button is one submission');
    assert.equal(scope.rendered, 0, 'there is no next screen to draw');
    assert.equal(scope.cursor, 0, 'nothing was walked, because there is nowhere to walk');
  });

  test(`${label}: one question at a time still walks instead of submitting`, () => {
    const scope = scopeFor('one_per_page');
    const goNext = load(html, 'goNext', scope);

    goNext();

    assert.equal(scope.submitted, 0, 'the first of seven questions is not the end of the survey');
    assert.equal(scope.cursor, 1, 'the walk moved to the next question');
    assert.equal(scope.rendered, 1);
  });

  test(`${label}: one question at a time stops on a required question`, () => {
    const scope = scopeFor('one_per_page', { answerable: false });
    const goNext = load(html, 'goNext', scope);

    goNext();

    assert.equal(scope.submitted, 0);
    assert.equal(scope.cursor, 0, 'an unanswered required question holds the walk where it is');
    assert.deepEqual(scope.shown, [QUESTIONS[0].id], 'and says so against that question');
    assert.equal(scope.errors[QUESTIONS[0].id], 'This one is required');
  });

  test(`${label}: back on a one-page survey moves nothing`, () => {
    const scope = scopeFor('all_at_once');
    const goBack = load(html, 'goBack', scope);
    scope.cursor = 3;

    goBack();

    assert.equal(scope.cursor, 3, 'the whole form is one screen; there is no earlier question');
    assert.equal(scope.rendered, 0);
  });

  test(`${label}: back on a one-question-per-screen survey steps back`, () => {
    const scope = scopeFor('one_per_page');
    const goBack = load(html, 'goBack', scope);
    scope.cursor = 3;

    goBack();

    assert.equal(scope.cursor, 2);
    assert.equal(scope.rendered, 1);
  });
}
