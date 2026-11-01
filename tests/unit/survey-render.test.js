const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const shared = path.join(__dirname, '..', '..', 'public', 'assets', 'js');
global.SurveySchema = require(path.join(shared, 'survey-schema.js'));
const SurveyRender = require(path.join(shared, 'survey-render.js'));

test('single-choice dropdowns use the existing select answer shape', () => {
  const html = SurveyRender.markup({
    id: 'q1', type: 'choice', dropdown: true, text: 'Region?',
    options: [{ label: 'Lagos' }, { label: 'Abuja' }]
  }, 'Abuja', {});

  assert.match(html, /class="input sv-select"/);
  assert.match(html, /<option value="1" selected>Abuja<\/option>/);
});

test('multiple-choice dropdowns render a checkbox list in a compact dropdown', () => {
  const html = SurveyRender.markup({
    id: 'q1', type: 'multi_choice', dropdown: true, text: 'Which tools?',
    options: [{ label: 'CLI' }, { label: 'SDK' }]
  }, ['SDK'], {});

  assert.match(html, /class="sv-dropdown-multi"/);
  assert.match(html, /data-dropdown-menu hidden/);
  assert.match(html, /data-dropdown-value>SDK<\/span>/);
  assert.match(html, /role="checkbox"/);
  assert.match(html, /class="sv-option picked"/);
});
