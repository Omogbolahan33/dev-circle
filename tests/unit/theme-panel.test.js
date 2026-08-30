const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ─── The theme panel ─────────────────────────────────────────
// The panel is shared by the two builders, which is exactly where a "this
// section must not exist for one kind of form" mistake would be drawn on
// both. So the opt-out is pinned here: a form whose own fields hold the
// words on the opening and closing screens (onboarding) gets a panel
// without those sections and without the image that sat on one of them, and
// a survey gets them all.

const SHARED = path.join(__dirname, '..', '..', 'public', 'assets', 'js');

global.SurveyTheme = require(path.join(SHARED, 'survey-theme.js'));
global.escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
global.api = { post: async () => ({ asset: { path: '/uploads/x.png' } }), put: async () => ({}) };
global.Auth = { getCircle: () => null };
global.showToast = () => {};
// A page global the hex field's blur handler reaches for; named here because
// the page is what defines it, and this test stands in for the page.
global.renderThemePanel = () => {};

const ThemePanel = require(path.join(SHARED, 'theme-panel.js'));

const SCHEMA = {
  theme: {
    fonts: [{ value: 'sans', label: 'Sans', stack: 'sans-serif', category: 'sans' }],
    scales: { small: 1, regular: 1.1, large: 1.2, larger: 1.3 },
    corners: ['sharp', 'soft', 'round'],
    modes: ['auto', 'light', 'dark'],
    progress: ['bar', 'steps', 'count', 'none'],
    backgrounds: ['plain', 'tinted', 'gradient'],
    fits: ['cover', 'contain', 'tile'],
    layouts: ['one_per_page', 'all_at_once', 'n_per_page', 'by_section'],
    page_size: { min: 2, max: 10 }
  }
};

// The panel writes its whole body into the mount and then binds into it. The
// body is what is asserted on, so the mount records it; the binding is the
// browser's business, so every lookup answers "nothing here".
function mount() {
  return {
    _html: '',
    set innerHTML(value) { this._html = value; },
    get innerHTML() { return this._html; },
    querySelector: () => null,
    querySelectorAll: () => []
  };
}

function render(extra = {}) {
  const m = mount();
  const panel = ThemePanel.create({
    schema: SCHEMA,
    state: { theme: {}, circleTheme: null },
    mount: m,
    noun: 'form',
    ...extra
  });
  panel.render();
  return m.innerHTML;
}

test('a panel that keeps its screens offers the words on both', () => {
  const html = render();
  assert.ok(html.includes('id="theme-opening"'), 'the opening section is there');
  assert.ok(html.includes('id="theme-closing"'), 'the closing section is there');
  assert.ok(html.includes('data-upload="header_image"'), 'the image that sits on the opening screen is there');
});

test('screens: false drops the screen words, and the image that sat on them', () => {
  const html = render({ screens: false });
  assert.ok(!html.includes('id="theme-opening"'), 'no opening section');
  assert.ok(!html.includes('id="theme-closing"'), 'no closing section');
  assert.ok(!html.includes('data-upload="header_image"'), 'no opening image row');
  assert.ok(html.includes('Wordmark and background'), 'the images sub says what is left');
  assert.ok(!html.includes('data-theme-copy="intro.headline"'), 'no intro copy control');
  assert.ok(!html.includes('data-theme-copy="thank_you.headline"'), 'no thank-you copy control');

  // What is dropped is the two screens and nothing of the look
  for (const id of ['id="theme-colours"', 'id="theme-type"', 'id="theme-layout"', 'id="theme-images"']) {
    assert.ok(html.includes(id), `${id} is still drawn`);
  }
  assert.ok(html.includes('data-upload="logo_url"'), 'the wordmark stays — the bar still shows it');
});
