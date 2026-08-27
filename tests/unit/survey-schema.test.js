const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// The definition the builder, the member's page and the server all read. Tested
// here rather than through the API because it is the thing being relied on in
// three places, and a rule that holds in one and not another is the failure
// this whole arrangement exists to prevent.
const schema = require(path.join(__dirname, '..', '..', 'public', 'assets', 'js', 'survey-schema.js'));
const themes = require(path.join(__dirname, '..', '..', 'public', 'assets', 'js', 'survey-theme.js'));

const normalize = questions => schema.normalizeQuestions(questions);
const messages = result => result.issues.map(i => i.message);

// ─── Writing a survey ───────────────────────────────────────

test('a question with no wording is refused', () => {
  const result = normalize([{ type: 'rating', text: '   ' }]);
  assert.ok(messages(result).some(m => /needs its wording/i.test(m)));
});

test('a choice question needs something to choose between', () => {
  const result = normalize([{ type: 'choice', text: 'Which one?', options: ['Only this'] }]);
  assert.ok(messages(result).some(m => /at least two options/i.test(m)));
});

test('the same option twice is refused, because it cannot be tallied', () => {
  const result = normalize([
    { type: 'choice', text: 'Which environment?', options: ['Sandbox', 'sandbox ', 'Production'] }
  ]);
  assert.ok(messages(result).some(m => /same/i.test(m)));
});

// ─── Option subtext ─────────────────────────────────────────
// A choice is read as a card: the word, and under it a line of subtext —
// text, a link, an image or a bare address, the same rich wording as the
// question itself, checked the same way. The answer stays the word.

test('a choice option is a word with room for a line under it', () => {
  const result = normalize([{
    type: 'choice', text: 'Which?',
    options: [
      { label: 'Sandbox' },
      { label: 'Production', subtext: 'Live traffic — see [the runbooks](https://example.com/runbooks)' }
    ]
  }]);
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.questions[0].options, [
    { label: 'Sandbox' },
    { label: 'Production', subtext: 'Live traffic — see [the runbooks](https://example.com/runbooks)' }
  ]);
});

test('an image under an option is checked like any image and written as an image', () => {
  const subtext = 'As in ![the flow](https://example.com/flow.png)';
  const question = only({
    type: 'choice', text: 'Which?',
    options: [{ label: 'A' }, { label: 'B', subtext }]
  });
  assert.equal(question.options[1].subtext, subtext);
  const html = schema.linkify(subtext);
  assert.ok(html.includes('<img class="sv-wording-img" src="https://example.com/flow.png" alt="the flow"'), html);
});

test('an image under an option without words for the blind is refused, and so is an image that is not from the web', () => {
  const noWords = normalize([{
    type: 'choice', text: 'Which?',
    options: [{ label: 'A' }, { label: 'B', subtext: '![](https://example.com/x.png)' }]
  }]);
  assert.ok(messages(noWords).some(m => /cannot see it/i.test(m)));

  const notWeb = normalize([{
    type: 'choice', text: 'Which?',
    options: [{ label: 'A' }, { label: 'B', subtext: '![pic](ftp://example.com/x.png)' }]
  }]);
  assert.ok(messages(notWeb).some(m => /Option "B"/.test(m) && /http:\/\/? or https:\/\//.test(m)));
});

test('a link under an option that is not a web address is refused, with the option named', () => {
  const result = normalize([{
    type: 'choice', text: 'Which?',
    options: [{ label: 'A' }, { label: 'B', subtext: '[t](javascript:alert(1))' }]
  }]);
  assert.ok(messages(result).some(m => /Option "B"/.test(m) && /http:\/\/? or https:\/\//.test(m)));
});

test('a picture uploaded from the device may sit under an option, and nowhere else may', () => {
  const stored = normalize([{
    type: 'choice', text: 'Which?',
    options: [
      { label: 'A', subtext: 'See ![the flow](/uploads/flow-diagram-ab12cd34ef56.png)' },
      { label: 'B', subtext: 'Or ![a hash named one](/uploads/3f2b8a1c9d4e4f5a8b6c7d8e9f0a1b2c.png)' }
    ]
  }]);
  assert.equal(messages(stored).length, 0, 'an uploaded picture is a picture: ' + JSON.stringify(messages(stored)));
  assert.equal(stored.questions[0].options[0].subtext, 'See ![the flow](/uploads/flow-diagram-ab12cd34ef56.png)');
  const html = schema.linkify('See ![the flow](/uploads/flow-diagram-ab12cd34ef56.png)');
  assert.ok(html.includes('<img class="sv-wording-img" src="/uploads/flow-diagram-ab12cd34ef56.png" alt="the flow"'),
    'it is drawn as the image it is');

  // Anything that is not a web address and not one of our uploads stays refused
  const notOurs = normalize([{
    type: 'choice', text: 'Which?',
    options: [{ label: 'A' }, { label: 'B', subtext: '![x](/etc/passwd)' }]
  }]);
  assert.ok(messages(notOurs).some(m => /Option "B"/.test(m) && /only come from/.test(m)));

  const escaped = normalize([{
    type: 'choice', text: 'Which?',
    options: [{ label: 'A' }, { label: 'B', subtext: '![x](/uploads/../../.env)' }]
  }]);
  assert.ok(messages(escaped).some(m => /Option "B"/.test(m)), 'an upload path that climbs out of the folder is not an upload');

  // A link still goes only to the web — an uploaded file is a picture, not a destination
  const asLink = normalize([{
    type: 'choice', text: 'Which?',
    options: [{ label: 'A' }, { label: 'B', subtext: '[open](/uploads/flow-diagram-ab12cd34ef56.png)' }]
  }]);
  assert.ok(messages(asLink).some(m => /Option "B"/.test(m) && /a link may only go to an http:\/\/ or https:\/\//.test(m)));
});

test('a dropdown keeps its options as words — no room under them for subtext', () => {
  const result = normalize([{
    type: 'dropdown', text: 'Which?',
    options: [{ label: 'A', subtext: 'a note' }, 'B']
  }]);
  assert.deepEqual(result.questions[0].options, ['A', 'B']);
});

test('an answer to a choice is stored as the word, whatever the option looks like', () => {
  const { questions } = normalize([{
    type: 'choice', text: 'Which?',
    options: [{ label: 'Sandbox' }, { label: 'Production', subtext: 'x' }]
  }]);
  const checked = schema.checkResponse(questions, { q1: 'production' });
  assert.ok(checked.ok);
  assert.equal(checked.answers.q1, 'Production', 'the answer is the word as offered');
});

test('a branch rule on a choice holds the word, not the card around it', () => {
  const { questions } = normalize([
    {
      id: 'q1', type: 'choice', text: 'Which?',
      options: [{ label: 'Sandbox' }, { label: 'Production', subtext: 'x' }],
      branch_to: { rules: [{ op: 'is', value: 'Production', end: true, message: 'Bye' }] }
    },
    { id: 'q2', type: 'text', text: 'More?' }
  ]);
  assert.equal(questions[0].branch_to.rules[0].value, 'Production');
  const ending = schema.ending(questions, { q1: 'Production' });
  assert.ok(ending);
  assert.equal(ending.message, 'Bye');
});

test('an option that is nothing but an address is a link whose label is itself', () => {
  assert.equal(
    schema.linkify('https://example.com/docs'),
    '<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">https://example.com/docs</a>'
  );
});

test('blank option rows are dropped rather than refused', () => {
  // They are the builder's empty inputs, not something the author wrote
  const result = normalize([{ type: 'choice', text: 'Which?', options: ['A', '', 'B', '  '] }]);
  assert.equal(result.issues.length, 0);
  // Choice options are cards: a word, and the subtext under it
  assert.deepEqual(result.questions[0].options, [{ label: 'A' }, { label: 'B' }]);
});

test('asking for more answers than there are options is refused', () => {
  const result = normalize([
    { type: 'multi_choice', text: 'Pick some', options: ['A', 'B'], min_select: 3 }
  ]);
  assert.ok(messages(result).some(m => /offers 2 options/i.test(m)));
});

test('a minimum above the maximum is refused', () => {
  const result = normalize([
    { type: 'multi_choice', text: 'Pick some', options: ['A', 'B', 'C'], min_select: 3, max_select: 2 }
  ]);
  assert.ok(messages(result).some(m => /at least 3 but allows at most 2/i.test(m)));
});

test('a number range that cannot contain anything is refused', () => {
  const result = normalize([{ type: 'number', text: 'How many?', min: 100, max: 10 }]);
  assert.ok(messages(result).some(m => /above the largest/i.test(m)));
});

test('a date range that runs backwards is refused', () => {
  const result = normalize([{ type: 'date', text: 'When?', min: '2026-06-01', max: '2026-01-01' }]);
  assert.ok(messages(result).some(m => /after the latest/i.test(m)));
});

test('a rating scale is held between 2 and 10', () => {
  assert.equal(normalize([{ type: 'rating', text: 'How clear?', scale: 99 }]).questions[0].scale, 10);
  assert.equal(normalize([{ type: 'rating', text: 'How clear?', scale: 1 }]).questions[0].scale, 2);
});

test('NPS is always 0–10, whatever scale is sent', () => {
  // A "how likely are you to recommend" question on another scale is not NPS,
  // and scoring it as one would put a meaningless number in front of people
  const question = normalize([{ type: 'nps', text: 'Would you recommend us?', scale: 5 }]).questions[0];
  assert.equal(question.scale, 10);
});

test('an unknown question type is refused rather than guessed at', () => {
  const result = normalize([{ type: 'telepathy', text: 'What are you thinking?' }]);
  assert.ok(messages(result).some(m => /not a question type/i.test(m)));
});

test('a survey of only section headings asks nothing', () => {
  const result = normalize([{ type: 'section', text: 'Part one' }]);
  assert.ok(messages(result).some(m => /asks nothing/i.test(m)));
});

test('an empty survey is refused, unless it is a draft still being written', () => {
  assert.ok(normalize([]).issues.length);
  assert.equal(schema.normalizeQuestions([], { allowEmpty: true }).issues.length, 0);
});

test('every question is given an id, and two questions never share one', () => {
  const result = normalize([
    { id: 'same', type: 'text', text: 'One' },
    { id: 'same', type: 'text', text: 'Two' }
  ]);
  assert.notEqual(result.questions[0].id, result.questions[1].id);
});

// ─── Branching ──────────────────────────────────────────────

test('a rule may only depend on a question asked earlier', () => {
  const result = normalize([
    {
      id: 'q1', type: 'text', text: 'First',
      visible_if: { match: 'all', rules: [{ question: 'q2', op: 'is', value: 'x' }] }
    },
    { id: 'q2', type: 'choice', text: 'Second', options: ['x', 'y'] }
  ]);
  assert.ok(messages(result).some(m => /asked earlier/i.test(m)));
});

test('a rule compared against an option nobody was offered is refused', () => {
  // Otherwise it is a branch that can never fire, and nothing on screen says so
  const result = normalize([
    { id: 'q1', type: 'choice', text: 'Environment?', options: ['Sandbox', 'Production'] },
    {
      id: 'q2', type: 'text', text: 'Why?',
      visible_if: { match: 'all', rules: [{ question: 'q1', op: 'is', value: 'Staging' }] }
    }
  ]);
  assert.ok(messages(result).some(m => /not one of the options/i.test(m)));
});

test('a comparison that makes no sense for the question is refused', () => {
  const result = normalize([
    { id: 'q1', type: 'text', text: 'Tell us more' },
    {
      id: 'q2', type: 'text', text: 'And?',
      visible_if: { match: 'all', rules: [{ question: 'q1', op: 'gte', value: 3 }] }
    }
  ]);
  assert.ok(messages(result).some(m => /cannot be asked of a text question/i.test(m)));
});

test('conditions that contradict each other are caught, not shipped', () => {
  const result = normalize([
    { id: 'q1', type: 'choice', text: 'Environment?', options: ['Sandbox', 'Production'] },
    {
      id: 'q2', type: 'text', text: 'Why?',
      visible_if: {
        match: 'all',
        rules: [
          { question: 'q1', op: 'is', value: 'Sandbox' },
          { question: 'q1', op: 'is', value: 'Production' }
        ]
      }
    }
  ]);
  assert.ok(messages(result).some(m => /never be shown/i.test(m)));
});

const BRANCHED = normalize([
  { id: 'q1', type: 'nps', text: 'Would you recommend us?', required: true },
  {
    id: 'q2', type: 'multi_choice', text: 'What went wrong?',
    options: ['Docs', 'Errors', 'Latency'], required: true, min_select: 1,
    visible_if: { match: 'all', rules: [{ question: 'q1', op: 'lte', value: 6 }] }
  },
  { id: 'q3', type: 'text', text: 'Anything else?' }
]).questions;

test('a question is only asked when its condition holds', () => {
  assert.deepEqual(schema.visible(BRANCHED, { q1: 9 }).map(q => q.id), ['q1', 'q3']);
  assert.deepEqual(schema.visible(BRANCHED, { q1: 3 }).map(q => q.id), ['q1', 'q2', 'q3']);
});

test('a required question inside a branch nobody took does not block submission', () => {
  // This is the whole point of checking requirement against what was shown
  const result = schema.checkResponse(BRANCHED, { q1: 10 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('a required question inside a branch they did take does block it', () => {
  const result = schema.checkResponse(BRANCHED, { q1: 2 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['q2']);
});

test('an answer to a branch they backed out of is dropped, not refused', () => {
  // Answer 3, answer the follow-up, go back and answer 10: the follow-up has
  // been retracted. Storing it would put words in their mouth.
  const result = schema.checkResponse(BRANCHED, { q1: 10, q2: ['Docs'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.dropped, ['q2']);
  assert.equal(result.answers.q2, undefined);
});

test('a condition reading a question that is itself hidden counts as unanswered', () => {
  const questions = normalize([
    { id: 'q1', type: 'boolean', text: 'Are you live?' },
    {
      id: 'q2', type: 'choice', text: 'Which product?', options: ['Lending', 'Payments'],
      visible_if: { match: 'all', rules: [{ question: 'q1', op: 'is', value: true }] }
    },
    {
      id: 'q3', type: 'text', text: 'How is it going?',
      visible_if: { match: 'all', rules: [{ question: 'q2', op: 'is', value: 'Lending' }] }
    }
  ]).questions;

  // q2 was never shown, so the stale answer to it cannot keep q3 alive
  const shown = schema.visible(questions, { q1: false, q2: 'Lending' }).map(q => q.id);
  assert.deepEqual(shown, ['q1']);
});

test('any-of shows the question when a single rule holds', () => {
  const questions = normalize([
    { id: 'q1', type: 'rating', text: 'Docs?', scale: 5 },
    { id: 'q2', type: 'rating', text: 'Sandbox?', scale: 5 },
    {
      id: 'q3', type: 'text', text: 'What would fix it?',
      visible_if: {
        match: 'any',
        rules: [
          { question: 'q1', op: 'lte', value: 2 },
          { question: 'q2', op: 'lte', value: 2 }
        ]
      }
    }
  ]).questions;

  assert.equal(schema.visible(questions, { q1: 5, q2: 1 }).length, 3);
  assert.equal(schema.visible(questions, { q1: 5, q2: 5 }).length, 2);
});

// ─── Wording that points outside the survey ─────────────────

test('a link in the wording is kept as written', () => {
  const question = only({
    type: 'boolean',
    text: 'I have read and agree to the [Terms & Conditions](https://example.com/terms)'
  });
  assert.equal(
    question.text,
    'I have read and agree to the [Terms & Conditions](https://example.com/terms)'
  );
});

test('a link that is not a web address is refused, because a click must go somewhere real', () => {
  const result = normalize([
    { type: 'boolean', text: 'Agree to the [Terms](javascript:alert(1))?' }
  ]);
  assert.ok(messages(result).some(m => /http/i.test(m)));
});

test('a link with no words to click on is refused', () => {
  const result = normalize([
    { type: 'boolean', text: 'Agree to the [ ](https://example.com/terms)?' }
  ]);
  assert.ok(messages(result).some(m => /nothing to click/i.test(m)));
});

test('a note under the question may carry links too', () => {
  const question = only({
    type: 'boolean',
    text: 'Do you agree?',
    description: 'By answering yes you accept the [Terms](https://example.com/terms) and [Privacy Policy](https://example.com/privacy).'
  });
  assert.match(question.description, /Privacy Policy/);
});

test('a bracket that is not a link stays the words it is', () => {
  const question = only({ type: 'text', text: 'Press [Enter] to continue — what do you see?' });
  assert.equal(question.text, 'Press [Enter] to continue — what do you see?');
});

test('linkify escapes the wording and writes only an anchor', () => {
  const html = schema.linkify('Read the <script>[terms](https://example.com/t)</script> first');
  assert.ok(!html.includes('<script>'), 'the wording is escaped, not trusted');
  assert.ok(html.includes('<a href="https://example.com/t" target="_blank" rel="noopener noreferrer">terms</a>'));
});

test('linkify never makes a link of what it cannot parse', () => {
  assert.equal(schema.linkify('a [broken (link) b'), 'a [broken (link) b');
  assert.equal(schema.linkify('a [link](ftp://example.com/x) b'), 'a [link](ftp://example.com/x) b');
});

test('an image in the wording is written as an image, nothing else', () => {
  const html = schema.linkify('See ![the map](https://example.com/m.png) and [the docs](https://example.com/d)');
  assert.ok(!html.includes('<script>') && !html.includes('<iframe>'));
  assert.ok(html.includes('<img class="sv-wording-img" src="https://example.com/m.png" alt="the map" loading="lazy">'));
  assert.ok(html.includes('<a href="https://example.com/d" target="_blank" rel="noopener noreferrer">the docs</a>'));
});

test('an image that is not a web address stays the literal words', () => {
  assert.equal(schema.linkify('see ![x](data:image/png;base64,AAA)'), 'see ![x](data:image/png;base64,AAA)');
});

// ─── What happens next ─────────────────────────────────────
// The "then" of a branch, written where the "when" is: on the question
// whose answer decides it. The standing case is a consent question that
// ends the survey when the answer is no, with its own words for that
// ending; the other place a rule may send the survey is a later question.
const CONSENT = [
  {
    id: 'q1', type: 'boolean', text: 'Do you agree to the [Terms](https://example.com/terms)?',
    required: true, true_label: 'Yes', false_label: 'No',
    branch_to: {
      rules: [{ op: 'is', value: false, end: true, message: 'We can\'t continue without your agreement.' }]
    }
  },
  { id: 'q2', type: 'text', text: 'Tell us about your integration.', required: true },
  { id: 'q3', type: 'nps', text: 'How likely are you to recommend us?' }
];

test('a branch rule is held to the question it sits on', () => {
  const result = normalize([
    { id: 'q1', type: 'text', text: 'Anything?', branch_to: { rules: [{ op: 'gt', value: 5, end: true }] } }
  ]);
  assert.ok(messages(result).some(m => /cannot be asked of a text/i.test(m)));
});

test('a rule that neither ends the survey nor goes anywhere is refused', () => {
  const result = normalize([
    { id: 'q1', type: 'boolean', text: 'Agree?', branch_to: { rules: [{ op: 'is', value: true }] } }
  ]);
  assert.equal(result.questions[0].branch_to, undefined);
  assert.ok(messages(result).some(m => /where the survey goes/i.test(m)));
});

test('a rule that does both has no single place to go', () => {
  const result = normalize([
    {
      id: 'q1', type: 'boolean', text: 'Agree?',
      branch_to: { rules: [{ op: 'is', value: true, end: true, goto: 'q2' }] }
    },
    { id: 'q2', type: 'text', text: 'More?' }
  ]);
  assert.equal(result.questions[0].branch_to, undefined);
  assert.ok(messages(result).some(m => /where the survey goes/i.test(m)));
});

test('a branch holds its value to the same shapes a visibility rule does', () => {
  const question = normalize([{
    id: 'q1', type: 'choice', text: 'Which product?', options: ['Lending', 'Payments'],
    branch_to: { rules: [{ op: 'is', value: 'lending', end: true }] }
  }]).questions[0];
  assert.deepEqual(question.branch_to.rules, [{ op: 'is', value: 'Lending', end: true }]);
});

test('a jump may only land on a question later in the survey', () => {
  // A jump to a question already answered would re-ask it, and two questions
  // jumping at each other is a loop a member cannot leave — so it is refused.
  // Question order, not question ids, is what "later" means.
  const result = normalize([
    { id: 'q0', type: 'text', text: 'Earlier?' },
    { id: 'q1', type: 'boolean', text: 'Later?', branch_to: { rules: [{ op: 'is', value: true, goto: 'q0' }] } }
  ]);
  assert.equal(result.questions[1].branch_to, undefined);
  assert.ok(messages(result).some(m => /later in the survey/i.test(m)));
});

test('a no to the consent question ends the survey there', () => {
  const questions = normalize(CONSENT).questions;
  assert.deepEqual(schema.visible(questions, { q1: false }).map(q => q.id), ['q1']);
  assert.deepEqual(schema.visible(questions, { q1: true }).map(q => q.id), ['q1', 'q2', 'q3']);
});

test('the ending is reported by the same walk that sees it', () => {
  const questions = normalize(CONSENT).questions;

  const ending = schema.ending(questions, { q1: false });
  assert.equal(ending.question.id, 'q1');
  assert.equal(ending.message, 'We can\'t continue without your agreement.');

  assert.equal(schema.ending(questions, { q1: true, q2: 'Fine' }), null);
});

test('a jump lands on the question it names, skipping what is in between', () => {
  const questions = normalize([
    {
      id: 'q1', type: 'choice', text: 'What are you building?', options: ['Public API', 'Internal tool'],
      branch_to: { rules: [{ op: 'is', value: 'Internal tool', goto: 'q4' }] }
    },
    { id: 'q2', type: 'text', text: 'Which endpoint first?' },
    { id: 'q3', type: 'text', text: 'Sandbox or production?' },
    { id: 'q4', type: 'text', text: 'What breaks in your setup first?' },
    { id: 'q5', type: 'nps', text: 'How likely are you to recommend us?' }
  ]).questions;

  assert.deepEqual(schema.visible(questions, { q1: 'Internal tool' }).map(q => q.id), ['q1', 'q4', 'q5']);
  assert.deepEqual(schema.visible(questions, { q1: 'Public API' }).map(q => q.id), ['q1', 'q2', 'q3', 'q4', 'q5']);
});

test('a jump onto a hidden question lands on whatever is asked next after it', () => {
  const questions = normalize([
    {
      id: 'q1', type: 'boolean', text: 'Quick path?',
      branch_to: { rules: [{ op: 'is', value: true, goto: 'q2' }] }
    },
    {
      id: 'q2', type: 'text', text: 'Only for the slow path?',
      visible_if: { match: 'all', rules: [{ question: 'q1', op: 'is', value: false }] }
    },
    { id: 'q3', type: 'text', text: 'For everybody?' }
  ]).questions;

  // q2 is hidden for exactly the answer that jumps to it, so the walk lands
  // on q3
  assert.deepEqual(schema.visible(questions, { q1: true }).map(q => q.id), ['q1', 'q3']);
});

test('a branch cannot fire on an answer the member retracted', () => {
  const questions = normalize([
    { id: 'q0', type: 'choice', text: 'What is your role?', options: ['Developer', 'Buyer'] },
    {
      id: 'q1', type: 'boolean', text: 'Agree?',
      visible_if: { match: 'all', rules: [{ question: 'q0', op: 'is', value: 'Developer' }] },
      branch_to: { rules: [{ op: 'is', value: false, end: true }] }
    },
    { id: 'q2', type: 'text', text: 'More?' }
  ]).questions;

  // q1 was only ever asked of developers, so the buyer's answer to it is a
  // retraction — and the survey does not end at a question they never saw
  const shown = schema.visible(questions, { q0: 'Buyer', q1: false, q2: 'x' }).map(q => q.id);
  assert.deepEqual(shown, ['q0', 'q2']);
  assert.equal(schema.ending(questions, { q0: 'Buyer', q1: false, q2: 'x' }), null);
});

test('the first rule that holds decides, in the order written', () => {
  const questions = normalize([
    {
      id: 'q1', type: 'choice', text: 'Status?', options: ['Sandbox', 'Production'],
      branch_to: {
        rules: [
          { op: 'is', value: 'Production', goto: 'q4' },
          { op: 'is', value: 'Production', end: true },
          { op: 'is', value: 'Sandbox', end: true, message: 'Sandbox members are done here.' }
        ]
      }
    },
    { id: 'q2', type: 'text', text: 'Middle one' },
    { id: 'q3', type: 'text', text: 'Middle two' },
    { id: 'q4', type: 'text', text: 'Production fast lane' }
  ]).questions;

  // Production takes the first rule that holds — the jump — and the end
  // written for the same answer never reads
  assert.deepEqual(schema.visible(questions, { q1: 'Production' }).map(q => q.id), ['q1', 'q4']);
  assert.equal(schema.ending(questions, { q1: 'Production' }), null);

  const sandbox = schema.ending(questions, { q1: 'Sandbox' });
  assert.equal(sandbox.question.id, 'q1');
  assert.equal(sandbox.message, 'Sandbox members are done here.');
});

test('a required question the survey ended before is neither asked nor blocked', () => {
  const questions = normalize(CONSENT).questions;

  const done = schema.checkResponse(questions, { q1: false });
  assert.ok(done.ok);
  assert.deepEqual(done.asked, ['q1']);
  assert.deepEqual(done.answers, { q1: false });

  const open = schema.checkResponse(questions, { q1: true });
  assert.ok(!open.ok);
  assert.deepEqual(open.missing, ['q2']);
});

test('an answer given before the branch is kept; one the branch skipped is dropped', () => {
  const questions = normalize(CONSENT).questions;
  const checked = schema.checkResponse(questions, { q1: false, q2: 'Should not be stored' });
  assert.ok(checked.ok);
  assert.deepEqual(checked.answers, { q1: false });
  assert.deepEqual(checked.dropped, ['q2']);
});

test('answers to the questions a jump skipped are dropped the same way', () => {
  const questions = normalize([
    {
      id: 'q1', type: 'choice', text: 'What are you building?', options: ['Public API', 'Internal tool'],
      branch_to: { rules: [{ op: 'is', value: 'Internal tool', goto: 'q4' }] }
    },
    { id: 'q2', type: 'text', text: 'Which endpoint first?', required: true },
    { id: 'q3', type: 'text', text: 'Sandbox or production?', required: true },
    { id: 'q4', type: 'text', text: 'What breaks in your setup first?' }
  ]).questions;

  const checked = schema.checkResponse(questions, { q1: 'Internal tool', q2: 'x', q3: 'y' });
  assert.ok(checked.ok);
  assert.deepEqual(checked.answers, { q1: 'Internal tool' });
  assert.deepEqual(checked.dropped, ['q2', 'q3']);
});

// ─── Answers ────────────────────────────────────────────────

const only = question => normalize([question]).questions[0];
const check = (question, value) => schema.validateAnswer(question, value);

test('a rating outside its scale is refused', () => {
  const question = only({ type: 'rating', text: 'How clear?', scale: 5 });
  assert.equal(check(question, 8).ok, false);
  assert.equal(check(question, 0).ok, false);
  assert.equal(check(question, 'banana').ok, false);
  assert.equal(check(question, 4).value, 4);
});

test('a rating arriving as a string is stored as a number', () => {
  // Otherwise the average of a survey is computed over strings
  const question = only({ type: 'rating', text: 'How clear?', scale: 5 });
  assert.strictEqual(check(question, '4').value, 4);
});

test('an option nobody was offered is refused', () => {
  const question = only({ type: 'choice', text: 'Which?', options: ['Sandbox', 'Production'] });
  assert.equal(check(question, 'Staging').ok, false);
  assert.equal(check(question, 'sandbox').value, 'Sandbox', 'case is not a different answer');
});

test('an unlisted answer is accepted only where the author offered "something else"', () => {
  const closed = only({ type: 'choice', text: 'Which?', options: ['A', 'B'] });
  const open = only({ type: 'choice', text: 'Which?', options: ['A', 'B'], allow_other: true });
  assert.equal(check(closed, 'Something we did not think of').ok, false);
  assert.equal(check(open, 'Something we did not think of').ok, true);
});

test('multi-choice limits are enforced', () => {
  const question = only({
    type: 'multi_choice', text: 'Which?', options: ['A', 'B', 'C', 'D'],
    min_select: 2, max_select: 3
  });
  assert.equal(check(question, ['A']).ok, false);
  assert.equal(check(question, ['A', 'B', 'C', 'D']).ok, false);
  assert.equal(check(question, ['A', 'B']).ok, true);
});

test('an exclusive option cannot be held alongside another', () => {
  const question = only({
    type: 'multi_choice', text: 'What blocked you?',
    options: ['Docs', 'Errors', 'None of these'],
    exclusive_options: ['None of these']
  });
  assert.equal(check(question, ['None of these', 'Docs']).ok, false);
  assert.equal(check(question, ['None of these']).ok, true);
});

test('the same option picked twice counts once', () => {
  const question = only({ type: 'multi_choice', text: 'Which?', options: ['A', 'B'] });
  assert.deepEqual(check(question, ['A', 'a', 'A']).value, ['A']);
});

test('a ranking must place every option exactly once', () => {
  const question = only({ type: 'ranking', text: 'In order', options: ['A', 'B', 'C'] });
  assert.equal(check(question, ['A', 'B']).ok, false, 'a partial ranking is not comparable');
  assert.equal(check(question, ['A', 'B', 'A']).ok, false);
  assert.deepEqual(check(question, ['C', 'A', 'B']).value, ['C', 'A', 'B']);
});

test('a required grid must be answered on every row', () => {
  const question = only({
    type: 'matrix', text: 'Rate these', rows: ['Docs', 'Sandbox'],
    columns: ['Poor', 'Fine'], required: true
  });
  assert.equal(check(question, { Docs: 'Fine' }).ok, false);
  assert.equal(check(question, { Docs: 'Fine', Sandbox: 'Poor' }).ok, true);
});

test('a grid cell outside its columns is refused', () => {
  const question = only({
    type: 'matrix', text: 'Rate these', rows: ['Docs'], columns: ['Poor', 'Fine']
  });
  assert.equal(check(question, { Docs: 'Excellent' }).ok, false);
  assert.equal(check(question, { Nonsense: 'Fine' }).ok, false);
});

test('a text format is enforced, and a plain text question is not', () => {
  const email = only({ type: 'text', text: 'Best address?', format: 'email' });
  assert.equal(check(email, 'not an address').ok, false);
  assert.equal(check(email, 'ada@example.ng').ok, true);
  assert.equal(check(only({ type: 'text', text: 'Thoughts?' }), 'not an address').ok, true);
});

test('a number is held to its range and its wholeness', () => {
  const question = only({ type: 'number', text: 'How many?', min: 1, max: 100, integer: true });
  assert.equal(check(question, 0).ok, false);
  assert.equal(check(question, 101).ok, false);
  assert.equal(check(question, 1.5).ok, false);
  assert.equal(check(question, 50).ok, true);
});

test('a date must be a real one', () => {
  const question = only({ type: 'date', text: 'When?' });
  assert.equal(check(question, '2026-02-30').ok, false);
  assert.equal(check(question, 'last tuesday').ok, false);
  assert.equal(check(question, '2026-02-28').ok, true);
});

test('an answer that cannot be read is refused, not quietly dropped', () => {
  // The question is optional, so the tempting shortcut is to treat anything
  // unreadable as no answer at all — which tells the member their survey went
  // through while discarding what they said
  const optional = only({ type: 'rating', text: 'How clear?', scale: 5 });
  assert.equal(check(optional, 'banana').ok, false);
  assert.equal(check(only({ type: 'boolean', text: 'Live?' }), 'maybe').ok, false);
  assert.equal(check(only({ type: 'number', text: 'How many?' }), 'lots').ok, false);
});

test('an empty answer is fine unless the question is required', () => {
  assert.equal(check(only({ type: 'text', text: 'Anything else?' }), '').ok, true);
  assert.equal(check(only({ type: 'text', text: 'Anything else?', required: true }), '').ok, false);
  assert.equal(check(only({ type: 'text', text: 'Anything else?', required: true }), '   ').ok, false);
});

test('a section holds no answer at all', () => {
  const section = only({ type: 'section', text: 'Part two' });
  assert.equal(schema.isAnswerable(section), false);
  assert.equal(check(section, 'anything').ok, false);
});

// ─── Reading results ────────────────────────────────────────

test('NPS is scored as promoters minus detractors, not averaged', () => {
  // A 10 and a 0 do not make two 5s, and the mean is the standard way of
  // hiding that half your members are actively unhappy
  const score = schema.npsScore([10, 9, 8, 7, 6, 0]);
  assert.equal(score.promoters, 2);
  assert.equal(score.passives, 2);
  assert.equal(score.detractors, 2);
  assert.equal(score.score, 0);
});

test('every answer shape has a readable one-line form', () => {
  const grid = only({ type: 'matrix', text: 'Rate', rows: ['Docs'], columns: ['Poor', 'Fine'] });
  assert.equal(schema.answerToText(grid, { Docs: 'Fine' }), 'Docs: Fine');

  const ranking = only({ type: 'ranking', text: 'Order', options: ['A', 'B'] });
  assert.equal(schema.answerToText(ranking, ['B', 'A']), '1. B; 2. A');

  const yesno = only({ type: 'boolean', text: 'Live?', true_label: 'In production' });
  assert.equal(schema.answerToText(yesno, true), 'In production');
});

// ─── Themes ─────────────────────────────────────────────────

test('text on an accent is chosen by contrast, not by preference', () => {
  assert.equal(themes.onAccent('#1a1a2e'), '#ffffff');
  assert.equal(themes.onAccent('#e6b473'), '#111111');
});

test('a colour that is not a colour is refused', () => {
  const { issues } = themes.normalize({ accent: 'brand blue' });
  assert.ok(issues.some(i => i.field === 'accent'));
});

test('images are uploaded, not linked to', () => {
  // Three reasons pointing the same way: the content policy only allows
  // same-origin images, a remote address puts every member in front of
  // whoever hosts it, and a link can change to something else after approval
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>', '//evil.example/logo.png',
                     'https://cdn.example.ng/logo.png']) {
    const { theme, issues } = themes.normalize({ logo_url: url });
    assert.equal(theme?.logo_url, undefined, `${url} must not be stored`);
    assert.ok(issues.some(i => i.field === 'logo_url'));
  }

  const stored = '/uploads/0123456789abcdef0123456789abcdef.png';
  assert.equal(themes.normalize({ logo_url: stored }).theme.logo_url, stored);
  assert.equal(themes.normalize({ logo_url: '/assets/logo.png' }).theme.logo_url, '/assets/logo.png',
    'the product\'s own assets are still usable');
});

test('a path cannot climb out of where uploads live', () => {
  for (const bad of ['/uploads/../../../etc/passwd', '/assets/../../.env', '/uploads/..%2f..%2fx']) {
    const { theme } = themes.normalize({ background_image: bad });
    assert.equal(theme?.background_image, undefined, `${bad} must not be stored`);
  }
});

test('only what differs from the default is stored, so a survey follows its circle', () => {
  assert.equal(themes.normalize({ accent: themes.DEFAULTS.accent, progress: 'bar' }).theme, null);
  assert.deepEqual(themes.normalize({ progress: 'steps' }).theme, { progress: 'steps' });
});

test('"N per page" without an N is refused — the number is the author\'s to set, not the app\'s to pick', () => {
  const { issues } = themes.normalize({ layout: 'n_per_page' });
  assert.ok(issues.some(i => i.field === 'page_size'), JSON.stringify(issues));

  const { theme } = themes.normalize({ layout: 'n_per_page', page_size: 4 });
  assert.equal(theme.page_size, 4);
});

test('an N outside the range is brought inside it rather than refused', () => {
  assert.equal(themes.normalize({ layout: 'n_per_page', page_size: 99 }).theme.page_size, 10);
  assert.equal(themes.normalize({ layout: 'n_per_page', page_size: 1 }).theme.page_size, 2);
});

test('a survey theme sits on top of its circle, field by field', () => {
  const resolved = themes.resolve({ accent: '#e6b473' }, { accent: '#0d9488', logo_url: '/circle.png' });
  assert.equal(resolved.accent, '#e6b473', 'the survey wins where it has an opinion');
  assert.equal(resolved.logo_url, '/circle.png', 'and inherits where it has none');
});

// ─── Brand colours ──────────────────────────────────────────

test('a brand names a background and a text colour, and gets the ladder between them', () => {
  // Without this, a custom canvas would sit behind cards and borders still
  // drawn from the product's own greys — a page that looks like it failed
  const { theme } = themes.normalize({ background_color: '#0B3D2E', text_color: '#F5EFE0' });
  const css = themes.toCSS(theme);

  assert.equal(css['--surface-0'], '#0b3d2e', 'the canvas is the background');
  assert.equal(css['--white'], '#f5efe0', 'body text is the text colour');
  assert.notEqual(css['--surface-2'], css['--surface-0'], 'cards lift off the canvas');
  assert.ok(css['--ash'] && css['--ash'] !== css['--white'], 'secondary text is derived, not left behind');
  assert.ok(css['--line'].startsWith('rgba(245, 239, 224'), 'borders are drawn from the text colour');
});

test('an unreadable combination is refused outright', () => {
  const { issues } = themes.normalize({ background_color: '#ffffff', text_color: '#e8e8e8' });
  assert.ok(issues.some(i => i.field === 'text_color' && /not readable/i.test(i.message)));
});

test('a legible but tight combination is allowed, and said out loud', () => {
  // Below AA but above the floor: a judgement about a brand, not a broken page
  const { theme, issues, warnings } = themes.normalize({ background_color: '#ffffff', text_color: '#8a8a8a' });
  assert.equal(issues.length, 0);
  assert.equal(theme.text_color, '#8a8a8a', 'it is honoured');
  assert.ok(warnings.some(w => /4\.5:1/.test(w.message)), 'and flagged');
});

test('contrast is judged on the whole theme, not one colour at a time', () => {
  // A survey naming only text is read against the canvas it inherits
  const circle = themes.normalize({ background_color: '#101014', text_color: '#ffffff' }).theme;
  const merged = themes.normalize({ ...circle, text_color: '#1a1a20' });
  assert.ok(merged.issues.length, 'near-black text on a near-black canvas is refused');
});

test('an accent that vanishes into the background is flagged', () => {
  const { warnings } = themes.normalize({
    background_color: '#107ebc', text_color: '#ffffff', accent: '#1180be'
  });
  assert.ok(warnings.some(w => w.field === 'accent'));
});

test('a background image is dimmed by default, because text has to survive it', () => {
  const { theme } = themes.normalize({ background_image: '/uploads/aaaabbbbccccddddeeeeffff00001111.jpg' });
  assert.equal(theme.background_overlay, 0.55);

  const canvas = themes.toCSS(theme)['--survey-canvas'];
  assert.ok(canvas.includes('url(/uploads/aaaabbbbccccddddeeeeffff00001111.jpg)'));
  assert.ok(canvas.indexOf('linear-gradient') < canvas.indexOf('url('), 'the scrim sits over the image');
});

test('an author can lift the scrim, but not past the point of no return', () => {
  assert.equal(themes.normalize({ background_image: '/uploads/aaaabbbbccccddddeeeeffff00001111.jpg', background_overlay: 0 }).theme.background_overlay, 0);
  assert.equal(themes.normalize({ background_image: '/uploads/aaaabbbbccccddddeeeeffff00001111.jpg', background_overlay: 5 }).theme.background_overlay, 0.95);
});

test('an image address that could break out of the CSS it lands in is refused', () => {
  // A background image is written into a url(), so a bracket or a quote in it
  // could close that url() and start declaring something else
  for (const bad of [
    'a.jpg); background: url(evil',
    'a.jpg"); color: red; ("',
    "a.jpg'); }",
    '/logo one.png'
  ]) {
    const { theme, issues } = themes.normalize({ background_image: bad });
    assert.equal(theme?.background_image, undefined, `${bad} must not be stored`);
    assert.ok(issues.some(i => i.field === 'background_image'));
  }
  const stored = '/uploads/aaaabbbbccccddddeeeeffff00001111.jpg';
  assert.equal(themes.normalize({ background_image: stored }).theme.background_image, stored,
    'a stored upload is fine');
});

// ─── A brand's own typeface ─────────────────────────────────

test('type is a library of real families, picked by name', () => {
  // Not "pairings" with mood names mapped onto whatever the reader's device
  // happens to have: an author told to use Montserrat has to be able to
  // choose Montserrat, and two people picking the same option must get the
  // same typeface.
  const fonts = Object.entries(themes.FONTS);
  assert.ok(fonts.length >= 12, 'a font picker is a library, not a handful of moods');

  for (const [key, font] of fonts) {
    assert.ok(font.label, `${key} needs a name`);
    assert.ok(font.stack, `${key} needs a stack`);
    assert.ok(['sans', 'serif', 'mono', 'device', 'custom'].includes(font.category), `${key} needs a category`);
    assert.ok(/system-ui|serif|sans-serif|monospace/.test(font.stack),
      `${key} must fall back to something every device has`);
  }

  for (const named of ['Inter', 'Roboto', 'Montserrat', 'Playfair Display', 'Lora', 'IBM Plex Mono']) {
    assert.ok(fonts.some(([, f]) => f.label === named), `${named} should be offered by name`);
  }
});

test('every family the picker offers is actually served from here', () => {
  // A list that names Montserrat and renders Helvetica is worse than not
  // offering it: the author cannot tell, and the member never sees it
  const fs = require('fs');
  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'assets', 'css', 'fonts.css'), 'utf8'
  );

  for (const [key, font] of Object.entries(themes.FONTS)) {
    // The app's own, an upload, or one that comes from the reader's device.
    // Excluded by what they are rather than by name, so a family added later
    // has to declare itself rather than quietly slipping past this.
    if (key === 'default' || font.device || font.needsUpload) continue;

    const family = font.stack.match(/^'([^']+)'/)[1];
    assert.ok(css.includes(`font-family: '${family}'`), `${family} is offered but never declared`);

    const file = (css.split(`font-family: '${family}'`)[1].match(/url\('([^']+)'\)/) || [])[1];
    assert.ok(file, `${family} has no file`);
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', '..', 'public', file.replace(/^\//, ''))),
      `${family} points at ${file}, which is not there`
    );
  }
});

test('a family that comes from the reader\'s device says so, and falls back', () => {
  // Corbel ships with Windows and Office and with nothing else. Offering it is
  // fine; offering it as though every reader will see it is not.
  const corbel = themes.FONTS.corbel;
  assert.ok(corbel.device, 'it is not ours to serve');
  assert.ok(corbel.note, 'and the author has to be told what that means');
  assert.match(corbel.stack, /^Corbel,/);
  assert.match(corbel.stack, /sans-serif$/, 'with somewhere to land for everyone else');

  const css = themes.toCSS(themes.normalize({ font: 'corbel' }).theme);
  assert.match(css['--font-body'], /^Corbel,/);
});

test('a survey is set in one family throughout', () => {
  // A form is not a magazine: setting the question in one face and the options
  // in another makes it harder to read, not more designed
  const css = themes.toCSS(themes.normalize({ font: 'lora' }).theme);
  assert.equal(css['--font-display'], css['--font-body']);
  assert.match(css['--font-display'], /^'Lora'/);
});

test('text size is a setting, because a survey is read on a phone in the field', () => {
  assert.equal(themes.toCSS(themes.normalize({ scale: 'larger' }).theme)['--survey-scale'], '1.25');
  assert.equal(themes.toCSS(themes.normalize({}).theme)['--survey-scale'], '1');
  assert.ok(themes.normalize({ scale: 'enormous' }).issues.some(i => i.field === 'scale'));
});

test('choosing your own font without uploading one is refused', () => {
  // Otherwise it silently falls back to a system stack and reads as a failed upload
  const { issues } = themes.normalize({ font: 'brand' });
  assert.ok(issues.some(i => i.field === 'font'));
});

test('an uploaded font leads the stack, with the fallbacks still behind it', () => {
  const { theme } = themes.normalize({
    font: 'brand',
    brand_font: '/uploads/11112222333344445555666677778888.woff2',
    brand_font_name: 'Acme Grotesk'
  });
  const css = themes.toCSS(theme);
  assert.ok(css['--font-display'].startsWith("'Acme Grotesk', "));
  assert.ok(/system-ui/.test(css['--font-display']), 'readable before it loads, and if it never does');

  const face = themes.fontFace(theme);
  assert.ok(face.includes("font-family: 'Acme Grotesk'"));
  assert.ok(face.includes("format('woff2')"));
  assert.ok(face.includes('font-display: swap'), 'a slow connection must not mean a blank question');
});

test('a font name cannot break out of the declaration it is written into', () => {
  const { theme } = themes.normalize({
    font: 'brand',
    brand_font: '/uploads/11112222333344445555666677778888.woff2',
    brand_font_name: "Evil'; } body { display: none } @font-face { font-family: 'x"
  });
  const face = themes.fontFace(theme);
  assert.ok(!face.includes('display: none'));
  assert.ok(!/\}/.test(themes.familyName(theme.brand_font_name)));
  assert.equal(themes.familyName("Acme'; }"), 'Acme');
});

test('a font is only served from here, never fetched from a foundry', () => {
  const { theme, issues } = themes.normalize({ brand_font: 'https://fonts.example/acme.woff2' });
  assert.equal(theme?.brand_font, undefined);
  assert.ok(issues.some(i => i.field === 'brand_font'));
});

test('a dark brand canvas makes the survey dark, whatever the member set', () => {
  const dark = themes.toCSS(themes.normalize({ background_color: '#0b0b12', text_color: '#ffffff' }).theme);
  const light = themes.toCSS(themes.normalize({ background_color: '#fffdf7', text_color: '#101014' }).theme);
  assert.equal(dark['--surface-0'], '#0b0b12');
  assert.equal(light['--surface-0'], '#fffdf7');
  assert.equal(dark['--white'], '#ffffff');
  assert.equal(light['--white'], '#101014');
});

test('naming only a background still produces readable text', () => {
  // The author gave half the pair; the other half cannot be left to the
  // product's default or it may be white on white
  const onLight = themes.toCSS(themes.normalize({ background_color: '#ffffff' }).theme);
  const onDark = themes.toCSS(themes.normalize({ background_color: '#101014' }).theme);
  assert.ok(themes.contrast(onLight['--white'], '#ffffff') > 4.5);
  assert.ok(themes.contrast(onDark['--white'], '#101014') > 4.5);
});
