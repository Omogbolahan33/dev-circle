const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ─── The question editor ────────────────────────────────────
// The editor moved out of survey-new.html so that the onboarding builder could
// use it rather than carry a second copy. Two copies of a branching editor
// drift within a release — and the copy that got there first had no test at
// all, which is what made moving it feel risky.
//
// So this is the coverage that did not exist before: not the DOM wiring, which
// needs a browser, but the part that decides what a card contains. A rating
// question that stops offering a scale, a branching row that stops listing the
// questions it can depend on, or an extension field that stops being drawn are
// all silent failures on a page nobody has open.

const SHARED = path.join(__dirname, '..', '..', 'public', 'assets', 'js');

// The globals a builder page provides. Only what the module actually reaches
// for — a fuller fake would be a fake of the browser rather than of the page.
global.SurveySchema = require(path.join(SHARED, 'survey-schema.js'));
global.SurveyTheme = require(path.join(SHARED, 'survey-theme.js'));
global.SurveyRender = { mount() {}, heading: q => `<h2>${q.text}</h2>` };
global.escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
global.CSS = { escape: v => v };
global.Shell = { confirm: async () => true };

// The preview declares a brand typeface into <head>, so the module reaches for
// a document even when only its markup is under test.
global.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild() {} }
};

const QuestionBuilder = require(path.join(SHARED, 'question-builder.js'));

// ─── A DOM the module can be driven against ─────────────────
// render() writes HTML into a mount and then binds a listener per card. The
// HTML is what is being asserted on, so the mount records it; the binding is
// what needs a browser, so every lookup answers "nothing here" and the wiring
// runs without doing anything.
function element(childCount = 0) {
  return {
    _html: '',
    set innerHTML(value) {
      this._html = value;
      this.children = Array.from({ length: (value.match(/class="q-card/g) || []).length }, () => element());
    },
    get innerHTML() { return this._html; },
    children: Array.from({ length: childCount }, () => element()),
    textContent: '',
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    setAttribute() {}, getAttribute: () => null,
    style: { setProperty() {} }
  };
}

const SCHEMA = {
  types: SurveySchema.TYPES,
  operators: SurveySchema.OPERATORS,
  text_formats: Object.entries(SurveySchema.TEXT_FORMATS).map(([value, f]) => ({ value, label: f.label })),
  rating_styles: SurveySchema.RATING_STYLES
};

function build(questions, extra = {}) {
  const state = { questions, issues: [], locked: false, openQuestion: 0, theme: {}, circleTheme: null };
  const el = { questions: element(), typeMenu: element(), preview: element(), count: element() };
  const builder = QuestionBuilder.create({ schema: SCHEMA, state, el, title: () => 'A form', ...extra });
  return { builder, state, el };
}

test('a card carries the settings its question type needs', () => {
  const cases = [
    ['rating',       ['data-set="scale"', 'data-set="label_low"', 'data-set="style"']],
    ['nps',          ['data-set="label_low"', 'data-set="label_high"']],
    ['text',         ['data-set="format"', 'data-set="max_length"', 'data-set-check="multiline"']],
    ['multi_choice', ['data-add-option="options"', 'data-set="min_select"', 'data-set="max_select"']],
    ['matrix',       ['data-add-option="rows"', 'data-add-option="columns"']],
    ['number',       ['data-set="min"', 'data-set="max"', 'data-set="unit"']],
    ['date',         ['data-set="min"', 'data-set="max"']],
    ['boolean',      ['data-set="true_label"', 'data-set="false_label"']],
    ['ranking',      ['data-add-option="options"']],
    ['section',      ['data-set="description"']]
  ];

  for (const [type, expected] of cases) {
    const { builder, state, el } = build([]);
    builder.add(type);
    builder.render();

    for (const marker of expected) {
      assert.ok(el.questions.innerHTML.includes(marker),
        `a ${type} card is missing ${marker}`);
    }
    assert.equal(state.questions[0].type, type);
  }
});

test('the type settings sit under one “More options” fold, and the fold says what is set', () => {
  // A text question: every settings row goes under the fold, and the fold's
  // label carries what has already been decided — so closed is not hidden
  const { builder, el } = build([{
    id: 'q1', type: 'text', text: 'What is stopping you?', format: 'email', max_length: 120, multiline: false
  }]);
  builder.render();
  let html = el.questions.innerHTML;

  assert.ok(html.includes('data-toggle-more'), 'the settings sit under a fold');
  assert.ok(html.includes('More options'), 'the fold is named as such');
  assert.ok(html.indexOf('data-toggle-more') < html.indexOf('data-set="format"'), 'the format is inside the fold');
  assert.ok(html.indexOf('data-toggle-more') < html.indexOf('data-set="max_length"'), 'the length is inside the fold');
  assert.ok(html.indexOf('data-toggle-more') < html.indexOf('data-set-check="multiline"'), 'the paragraph is inside the fold');
  assert.ok(/data-toggle-more[\s\S]{0,300}?Email address[\s\S]{0,300}?120 characters/.test(html),
    'the closed fold says what is set');

  // A choice question: the options are what the question is made of, so they
  // stay out in the open; only its tuning folds away
  const { builder: b2, el: e2 } = build([{
    id: 'q1', type: 'choice', text: 'Which environment?', options: ['Sandbox', 'Production'], allow_other: true
  }]);
  b2.render();
  html = e2.questions.innerHTML;
  assert.ok(html.indexOf('data-add-option="options"') < html.indexOf('data-toggle-more'), 'the options stay in the open');
  assert.ok(html.indexOf('data-toggle-more') < html.indexOf('data-set-check="allow_other"'), 'the tuning is inside the fold');
  assert.ok(/data-toggle-more[\s\S]{0,300}?an “other” option/.test(html), 'the fold says the “other” is on');

  // A rating's scale is tuning too, so it folds the same way
  const { builder: b3, el: e3 } = build([{ id: 'q1', type: 'rating', text: 'How clear?', scale: 5, style: 'stars' }]);
  b3.render();
  html = e3.questions.innerHTML;
  assert.ok(html.indexOf('data-toggle-more') < html.indexOf('data-set="scale"'), 'the scale is inside the fold');
  assert.ok(/1–5 stars/.test(html), 'the fold says the scale');

  // A ranking question has nothing to tune, so it has no fold — unless this
  // kind of form gives the question something to tune, and that too goes in
  const { builder: b4, el: e4 } = build([{ id: 'q1', type: 'ranking', text: 'Order these', options: ['A', 'B'] }]);
  b4.render();
  assert.ok(!e4.questions.innerHTML.includes('data-toggle-more'), 'nothing to fold means no fold');

  const { builder: b5, el: e5 } = build([{ id: 'q1', type: 'ranking', text: 'Order these', options: ['A', 'B'] }], {
    extraFields: () => '<div class="maps"><select data-maps-to></select></div>'
  });
  b5.render();
  html = e5.questions.innerHTML;
  assert.ok(html.includes('data-toggle-more'), 'the tag gives the fold its reason');
  assert.ok(html.indexOf('data-toggle-more') < html.indexOf('data-maps-to'), 'the tag sits inside the fold');

  // The show-sometimes button is a setting of the question too, so it is
  // inside the fold — and it is what gives a question with no settings of its
  // own a fold at all
  const { builder: b6, state: s6, el: e6 } = build([
    { id: 'q1', type: 'text', text: 'Have you reached production?' },
    { id: 'q2', type: 'ranking', text: 'Order these', options: ['A', 'B'] }
  ]);
  s6.openQuestion = 1;
  b6.render();
  html = e6.questions.innerHTML;
  assert.ok(html.includes('data-toggle-more'), 'the button gives the fold its reason');
  assert.ok(html.indexOf('data-toggle-more') < html.indexOf('data-add-logic'), 'the button is inside the fold');

  // Same for the survey's branching button
  const { builder: b7, el: e7 } = build([
    { id: 'q1', type: 'boolean', text: 'Do you agree?', true_label: 'Yes', false_label: 'No' }
  ], { allowBranching: true });
  b7.render();
  html = e7.questions.innerHTML;
  assert.ok(html.indexOf('data-toggle-more') < html.indexOf('data-add-branch'),
    'the branching button is inside the fold');
});

test('only one card is open at a time, and the closed ones show their wording', () => {
  const { builder, state, el } = build([]);
  builder.add('text');
  builder.add('rating');
  state.questions[0].text = 'What should we call you?';
  builder.render();

  const html = el.questions.innerHTML;
  assert.equal((html.match(/class="q-card open/g) || []).length, 1);
  assert.ok(html.includes('What should we call you?'), 'a closed card should still read as itself');
});

test('a card with something wrong opens regardless of which one was being edited', () => {
  const { builder, state, el } = build([]);
  builder.add('text');
  builder.add('rating');
  state.openQuestion = 1;
  state.issues = [{ index: 0, message: 'A question needs wording' }];
  builder.render();

  const html = el.questions.innerHTML;
  assert.ok(html.includes('class="q-card open invalid"'), 'the invalid card should be open');
  assert.ok(html.includes('A question needs wording'));
});

test('branching can only be written against questions asked earlier', () => {
  const questions = [
    { id: 'q1', type: 'boolean', text: 'Have you reached production?', true_label: 'Yes', false_label: 'No' },
    { id: 'q2', type: 'text', text: 'What is stopping you?', format: 'none' }
  ];
  const { builder, state, el } = build(questions);
  // Only the open card draws its settings, so the one being asserted on is the
  // one that has to be open.
  state.openQuestion = 1;
  builder.render();

  // The second question can branch on the first
  assert.ok(el.questions.innerHTML.includes('data-add-logic'),
    'a later question should be able to branch');

  // The first cannot branch on anything, because nothing came before it
  const { builder: b2, el: el2 } = build([questions[0]]);
  b2.render();
  assert.ok(!el2.questions.innerHTML.includes('data-add-logic'),
    'the first question has nothing to branch on');
});

test('a rule row offers the operators its source question actually accepts', () => {
  const questions = [
    { id: 'q1', type: 'boolean', text: 'Have you reached production?', true_label: 'Yes', false_label: 'No' },
    {
      id: 'q2', type: 'text', text: 'What is stopping you?', format: 'none',
      visible_if: { match: 'all', rules: [{ question: 'q1', op: 'is', value: false }] }
    }
  ];
  const { builder, state, el } = build(questions);
  state.openQuestion = 1;
  builder.render();
  const html = el.questions.innerHTML;

  assert.ok(html.includes('data-rule-question'), 'the rule names the question it depends on');
  assert.ok(html.includes('data-rule-op'), 'the rule names a condition');
  // A boolean is compared by is / is not, never by "more than"
  for (const op of SurveySchema.operatorsFor('boolean')) {
    assert.ok(SurveySchema.OPERATORS.some(o => o.op === op), `${op} is a real operator`);
  }
  assert.ok(!html.includes('>more than<'), 'a yes/no answer cannot be more than anything');
});

test('a form that tags its questions gets its extra field drawn on every card', () => {
  // This is the whole reason the editor is shared rather than copied: onboarding
  // adds one control to a card and changes nothing else about it.
  const drawn = [];
  const { builder, el } = build([], {
    extraFields: (question, index) => {
      drawn.push(index);
      return `<div class="field"><select data-maps-to></select></div>`;
    }
  });

  builder.add('text');
  builder.render();

  assert.ok(el.questions.innerHTML.includes('data-maps-to'), 'the tag control should be on the card');
  assert.ok(drawn.length > 0, 'the extension should have been asked to draw');
});

test('the definition change hook fires when a question is added', () => {
  let changes = 0;
  const { builder } = build([], { onChange: () => { changes++; } });
  builder.add('rating');
  assert.equal(changes, 1, 'the page has to be told its form changed');
});

test('the preview shows the opening-screen image only when the form has an opening screen', () => {
  const { builder, state, el } = build([{ id: 'q1', type: 'text', text: 'What is stopping you?' }]);
  state.theme = { header_image: '/uploads/opening-flow.png' };
  builder.preview();
  assert.ok(el.preview.innerHTML.includes('opening-flow.png'), 'a survey opens on its image');

  const { builder: b2, state: s2, el: e2 } = build(
    [{ id: 'q1', type: 'text', text: 'What is stopping you?' }], { screens: false });
  s2.theme = { header_image: '/uploads/opening-flow.png' };
  b2.preview();
  assert.ok(!e2.preview.innerHTML.includes('opening-flow.png'),
    'a form without an opening screen shows no image the member would never see');
});

test('a choice option offers its line with a pen, and a written one reads as a quiet line', () => {
  const { builder, el } = build([{
    id: 'q1', type: 'choice', text: 'Which environment?',
    options: [{ label: 'Sandbox' }, { label: 'Production', subtext: 'Live traffic' }]
  }], { allowBranching: true });
  builder.render();
  const html = el.questions.innerHTML;

  assert.ok(html.includes('option-desc-toggle'), 'each card option offers its pen');
  assert.ok(html.includes('option-desc-preview'), 'the written subtext reads under the option');
  assert.ok(html.includes('Live traffic'), 'the written subtext stays');
  assert.ok(html.includes('option-subtext'), 'the editor for the line is there, waiting to be opened');
  assert.ok(html.includes('data-attach-subtext'), 'the editor offers a picture from the device');
  assert.ok(!/option-desc-wrap open/.test(html), 'no editor is open until it is asked for');

  // A dropdown option is a word and stays one: no pen, no line
  const { builder: b2, el: plain } = build([{ id: 'q1', type: 'dropdown', text: 'Where?', options: ['NG', 'KE'] }]);
  b2.render();
  assert.ok(!plain.questions.innerHTML.includes('option-desc-toggle'), 'a dropdown keeps its options plain');
});

test('branching on an answer is drawn where it is allowed, and nowhere else', () => {
  // A survey may decide what happens to its own answers: jump to a later
  // question, or end early (a consent question answered "no" ends it there).
  const { builder, el } = build([{ id: 'q1', type: 'boolean', text: 'Do you agree?' }], { allowBranching: true });
  builder.render();
  assert.ok(el.questions.innerHTML.includes('data-add-branch'),
    'a survey question should be able to decide what happens next');

  // A form that collects a profile may not: a form that ends early, or
  // jumps past a credential field, is a half-built member.
  const { builder: b2, el: plain } = build([{ id: 'q1', type: 'boolean', text: 'Do you agree?' }]);
  b2.render();
  assert.ok(!plain.questions.innerHTML.includes('data-add-branch'));
});

test('a branch rule may send them on to the next question, and the button reads as branching', () => {
  const { builder, state, el } = build([
    { id: 'q1', type: 'boolean', text: 'First?' },
    { id: 'q2', type: 'boolean', text: 'Do you agree?', branch_to: { rules: [{ op: 'is', value: true }] } }
  ], { allowBranching: true });
  state.openQuestion = 1;
  builder.render();
  const html = el.questions.innerHTML;

  assert.ok(html.includes('data-add-logic>+ Branching<'), 'the show-sometimes button reads as branching');
  assert.ok(html.includes('goes to the next question'), 'a rule may send them on to the next question');
  assert.ok(/value="next" selected/.test(html), 'a rule that names no place is the next question');
  assert.ok(html.includes('goes to a particular question'), 'a rule may name its landing question');
  assert.ok(html.includes('ends the survey'), 'a rule may end the survey');
});

test('a branch rule asks the condition of its own answer and where the survey goes', () => {
  const { builder, el } = build([
    {
      id: 'q1', type: 'boolean', text: 'Do you agree?', true_label: 'Yes', false_label: 'No',
      branch_to: {
        rules: [
          { op: 'is', value: false, end: true, message: "We can't continue without your agreement." },
          { op: 'is', value: true, goto: 'q2' }
        ]
      }
    },
    { id: 'q2', type: 'text', text: 'More?' }
  ], { allowBranching: true });
  builder.render();
  const html = el.questions.innerHTML;

  assert.ok(html.includes('data-branch-op'), 'the rule is a comparison');
  assert.ok(html.includes('data-branch-value'), 'the comparison holds a value');
  assert.ok(html.includes('data-branch-action'), 'the rule says where the survey goes');
  assert.ok(html.includes('data-branch-target'), 'a jump names its landing question');
  assert.ok(html.includes('data-branch-message'), 'an ending may carry its own words');
  assert.ok(html.includes("We can't continue without your agreement."), 'the written words stay editable');
  assert.ok(!html.includes('data-rule-question'),
    'the condition names nothing: it tests the question it sits on');
  assert.ok(html.includes('q-branches'), 'the card reads as branching on its answer');
});

test('the preview draws the questions, and says so when there are none', () => {
  // The builder's right-hand pane. It renders through SurveyTheme and
  // SurveyRender, so it breaks whenever one of those grows an export the other
  // has not got — and the only symptom is a blank panel.
  const { builder, state, el } = build([]);

  builder.preview();
  assert.match(el.preview.innerHTML, /Write a question/, 'an empty form says why it is empty');

  builder.add('text');
  state.questions[0].text = 'What should we call you?';
  builder.preview();

  assert.match(el.preview.innerHTML, /What should we call you\?/, 'the preview should show the question');
  assert.match(el.preview.innerHTML, /data-preview=/, 'and mount a real control against it');
});

test('the preview survives every question type', () => {
  // One unhandled type throws and the whole panel goes blank, which reads as
  // "no preview" rather than as an error.
  for (const type of SurveySchema.TYPES.map(t => t.type)) {
    const { builder, state, el } = build([]);
    builder.add(type);
    state.questions[0].text = `A ${type} question`;

    assert.doesNotThrow(() => builder.preview(), `${type} broke the preview`);
    assert.ok(el.preview.innerHTML.length, `${type} rendered nothing`);
  }
});

test('the preview handles a tagged onboarding question', () => {
  // maps_to is the one thing an onboarding question carries that a survey
  // question does not.
  const { builder, state, el } = build([]);
  builder.add('text');
  Object.assign(state.questions[0], { text: 'Your email', format: 'email', maps_to: 'email' });

  assert.doesNotThrow(() => builder.preview());
  assert.match(el.preview.innerHTML, /Your email/);
});
