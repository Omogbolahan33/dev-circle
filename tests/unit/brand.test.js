const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ─── The wordmark in the chrome ──────────────────────────────
// Signed in, the corner of the shell should say whose circle you are in. It
// used to say whose software it is — and for any workspace without an uploaded
// logo it said nothing at all, because the hook was emptied outright.
//
// There is no DOM library in this project and adding one to assert on three
// branches would be a poor trade, so the page is stood in for here the way
// theme-panel.test.js stands in for a builder: the globals brand.js reaches
// for, and no more of a browser than it actually touches.

const SHARED = path.join(__dirname, '..', '..', 'public', 'assets', 'js');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class El {
  constructor(html = '') {
    this._html = html;
    this._classes = new Set();
    this.classList = {
      add: c => this._classes.add(c),
      remove: c => this._classes.delete(c),
      contains: c => this._classes.has(c)
    };
    this.style = { setProperty() {}, removeProperty() {} };
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; }
  get textContent() { return this._text ?? this._html; }
  set textContent(v) { this._text = v; this._html = escapeHtml(v); }
  setAttribute() {}
  removeAttribute() {}
  hasAttribute() { return false; }
  remove() {}
  appendChild() {}
  replaceChildren(node) {
    this._text = undefined;
    this._html = `<img src="${escapeHtml(node.src)}" alt="${escapeHtml(node.alt)}" class="${node.className}">`;
  }
}

// The product mark exactly as shell.js writes it into the hook.
const PRODUCT = 'dev<span>.</span>circle';

let hooks;

function setUpDom() {
  hooks = [new El(PRODUCT), new El(PRODUCT)];
  for (const el of hooks) el.hasAttribute = () => false;

  global.document = {
    documentElement: new El(),
    head: new El(),
    createElement: () => ({ src: '', alt: '', className: '' }),
    getElementById: () => null,
    querySelectorAll: selector => (selector === '[data-brand-logo]' ? hooks : [])
  };
  // In a browser survey-theme.js is a bare global as well as a property of
  // window, and brand.js reads it both ways.
  global.SurveyTheme = require(path.join(SHARED, 'survey-theme.js'));
  global.window = { SurveyTheme: global.SurveyTheme };
}

setUpDom();
require(path.join(SHARED, 'brand.js'));
const Brand = global.window.Brand;

test.beforeEach(() => {
  // Fresh hooks each time, but the module keeps its captured fallback per
  // element — so re-seeding the product mark is what a fresh page load is.
  for (const el of hooks) {
    el.innerHTML = PRODUCT;
    el._text = undefined;
    el._classes.clear();
  }
});

test('a circle with a logo shows the logo, labelled with its name', () => {
  Brand.apply({ logo_url: '/uploads/kuda.png' }, 'Kuda Engineering');

  for (const el of hooks) {
    assert.match(el.innerHTML, /<img src="\/uploads\/kuda\.png"/);
    assert.match(el.innerHTML, /alt="Kuda Engineering"/);
    assert.ok(el.classList.contains('has-logo'));
  }
});

test('a circle with no logo is named rather than left blank', () => {
  Brand.apply({ accent_color: '#107EBC' }, 'Kuda Engineering');

  for (const el of hooks) {
    assert.equal(el.textContent, 'Kuda Engineering');
    assert.ok(!el.classList.contains('has-logo'));
  }
});

test('a name carrying markup is written as text, not as HTML', () => {
  Brand.apply({ accent_color: '#107EBC' }, '<img src=x onerror=alert(1)>');

  for (const el of hooks) {
    assert.ok(!el.innerHTML.includes('<img'), el.innerHTML);
    assert.match(el.innerHTML, /&lt;img/);
  }
});

test('clearing a brand still names the circle', () => {
  Brand.clear('Kuda Engineering');
  for (const el of hooks) assert.equal(el.textContent, 'Kuda Engineering');
});

test('with no circle to name, the product mark comes back intact', () => {
  Brand.apply({ logo_url: '/uploads/kuda.png' }, 'Kuda Engineering');
  Brand.clear(null);
  for (const el of hooks) assert.equal(el.innerHTML, PRODUCT);
});

test('the active circle is the stored one, falling back to the first', () => {
  const list = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];

  assert.equal(Brand.activeIn(list, 'b').name, 'Beta');
  assert.equal(Brand.activeIn(list, 'gone').name, 'Alpha', 'a circle taken away falls back');
  assert.equal(Brand.activeIn([], 'a'), null);
  assert.equal(Brand.activeIn(null, 'a'), null);
});
