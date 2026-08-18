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

test('blank option rows are dropped rather than refused', () => {
  // They are the builder's empty inputs, not something the author wrote
  const result = normalize([{ type: 'choice', text: 'Which?', options: ['A', '', 'B', '  '] }]);
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.questions[0].options, ['A', 'B']);
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
