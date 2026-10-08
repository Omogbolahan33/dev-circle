const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ─── Naming somebody who gave no name ───────────────────────
// Migration 28 made users.name nullable: an onboarding form decides what it
// asks, and a circle collecting only an address produces members without one.
// The member dashboard still did `user.name.split(' ')`, so the first nameless
// member to sign in got "Failed to load: null is not an object (evaluating
// 'user.name.split')" in place of their dashboard. The admin side did not crash
// but called them "System" in the activity feed and "Anonymous" under their
// own survey answers.
//
// Every page now names a person through personName / firstName in shell.js.

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const SHELL_JS = fs.readFileSync(path.join(PUBLIC, 'assets/js/shell.js'), 'utf8');

// Plain functions in a browser script; lift them out to exercise them.
function lift(name) {
  const start = SHELL_JS.indexOf(`function ${name}(`);
  const end = SHELL_JS.indexOf('\n}\n', start) + 2;
  // eslint-disable-next-line no-eval
  return eval(`(${SHELL_JS.slice(start, end)})`);
}
const personName = lift('personName');
const firstName = lift('firstName');

test('a named member is called by their name', () => {
  assert.equal(personName('Joy Bassey', 'j.bassey@ogabassey.com'), 'Joy Bassey');
  assert.equal(firstName('Joy Bassey'), 'Joy');
  assert.equal(firstName('  Joy   Bassey '), 'Joy');
});

test('a nameless member is called by their address', () => {
  for (const missing of [null, undefined, '', '   ']) {
    assert.equal(personName(missing, 'j.bassey@ogabassey.com'), 'j.bassey@ogabassey.com');
    assert.equal(firstName(missing), null);
  }
});

test('nobody at all is an empty string, never "null"', () => {
  assert.equal(personName(null, null), '');
  assert.equal(personName(undefined, undefined), '');
});

// The crash was a string method called straight on a person's name. Forms,
// cohorts, circles and roles always have one; people may not.
test('no page calls a string method on a person\'s name', () => {
  const PERSON = /\b(?:user|u|m|member|a|r|f|i|open|existing_member)\.(?:name|user_name|developer)\.(?:split|trim|slice|substring|charAt|toLowerCase|toUpperCase|replace|includes|startsWith|localeCompare|length)\b/;
  const pages = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : pages(full);
    return /\.(html|js)$/.test(entry.name) ? [full] : [];
  });

  const offenders = pages(PUBLIC).flatMap(file =>
    fs.readFileSync(file, 'utf8').split('\n')
      .map((line, i) => PERSON.test(line) ? `${path.relative(PUBLIC, file)}:${i + 1}: ${line.trim()}` : null)
      .filter(Boolean));

  assert.deepEqual(offenders, [], 'use personName / firstName from shell.js');
});
