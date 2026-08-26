const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ─── Do the pages call anything that does not exist? ────────
// This exists because an entire screen died on one word. The applications queue
// called timeAgo(), which had never been a function anywhere — the pages use
// formatDate() — and the failure arrived as "Could not load applications" with
// the real reason only in the browser console.
//
// There is no build step here and no framework: a page is HTML with an inline
// script and a few <script src> includes, so nothing but a browser ever looks
// at the two together. This looks at them together.
//
// It is deliberately a *reference* check and not a linter. What it answers is
// the one question that keeps costing a screen: is every bare function call in
// this page reachable from what the page actually loads?

const PUBLIC = path.join(__dirname, '..', '..', 'public');

function pagesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return pagesUnder(full);
    return entry.name.endsWith('.html') ? [full] : [];
  });
}

// Names a script file introduces to the global scope.
function globalsFrom(source) {
  const names = new Set();
  const add = re => { for (const m of source.matchAll(re)) names.add(m[1]); };

  add(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm);
  add(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm);
  add(/^\s*class\s+([A-Za-z_$][\w$]*)/gm);
  // window.Thing = … is how a couple of the embeds publish themselves
  add(/^\s*window\.([A-Za-z_$][\w$]*)\s*=/gm);

  return names;
}

// Comments and string literals, removed. Without this the scan reads prose as
// code: a comment saying "furniture (a section heading)" looks like a call to
// furniture(), and `var(--sp-4)` inside a CSS template string looks like a call
// to var(). Both were reported on the first run, and a check that cries wolf
// twenty times is a check nobody reads.
//
// Template literals are the interesting case: the text between the backticks is
// data, but the ${…} holes in it are code and hold most of the calls a page
// makes. So the text goes and the holes stay.
function stripLiterals(source) {
  let out = '';
  let i = 0;

  // A stack, because these pages nest templates inside their own holes several
  // deep — `${list.map(x => `<td>${fmt(x)}</td>`).join('')}` is the ordinary
  // shape of a table row here. A single-pass scanner reads the inner backtick
  // as ordinary code and lets the markup inside it through, which is how CSS
  // like var(--sp-4) came back looking like a call to var().
  //
  // 'code' frames keep what they see. 'tpl' frames drop it, except for the
  // holes, which push a 'code' frame of their own.
  const stack = [{ mode: 'code', braces: 0 }];
  const top = () => stack[stack.length - 1];

  while (i < source.length) {
    const frame = top();
    const char = source[i];
    const next = source[i + 1];

    if (frame.mode === 'tpl') {
      if (char === '\\') { i += 2; continue; }
      if (char === '`') { stack.pop(); i++; continue; }
      if (char === '$' && next === '{') {
        stack.push({ mode: 'code', braces: 0, inHole: true });
        i += 2;
        out += ' ';
        continue;
      }
      i++;                       // template text: dropped
      continue;
    }

    // ── code ──
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      i++;
      while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
      i++;
      out += ' ';
      continue;
    }
    if (char === '`') {
      stack.push({ mode: 'tpl' });
      i++;
      out += ' ';
      continue;
    }
    if (char === '{') { frame.braces++; out += char; i++; continue; }
    if (char === '}') {
      // The brace that closes the hole this frame was opened by, rather than
      // one belonging to an object literal inside it.
      if (frame.inHole && frame.braces === 0) { stack.pop(); i++; out += ' '; continue; }
      frame.braces--;
      out += char;
      i++;
      continue;
    }

    out += char;
    i++;
  }

  return out;
}

// Every bare `name(` in a script — not `obj.name(`, which is a method and
// somebody else's problem.
function callsIn(source) {
  const names = new Set();
  for (const m of stripLiterals(source).matchAll(/(?<![.\w$?])([A-Za-z_$][\w$]*)\s*\(/g)) {
    names.add(m[1]);
  }
  return names;
}

// Keywords that look like calls, and the browser and language builtins a page
// may reach for. Anything genuinely missing from this list shows up as a
// failure naming it, which is the right way to find out.
const NOT_A_CALL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function',
  'else', 'do', 'new', 'delete', 'void', 'in', 'of', 'yield', 'case', 'with', 'try',
  'async', 'instanceof'
]);

const BUILTINS = new Set([
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON',
  'Date', 'RegExp', 'Error', 'TypeError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Proxy', 'Reflect', 'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'queueMicrotask', 'structuredClone', 'fetch', 'alert', 'confirm',
  'prompt', 'console', 'window', 'document', 'navigator', 'location', 'history',
  'localStorage', 'sessionStorage', 'URL', 'URLSearchParams', 'FormData', 'Blob', 'File',
  'FileReader', 'Image', 'Audio', 'CustomEvent', 'Event', 'MutationObserver',
  'ResizeObserver', 'IntersectionObserver', 'AbortController', 'Headers', 'Request',
  'Response', 'TextEncoder', 'TextDecoder', 'CSS', 'getComputedStyle', 'matchMedia',
  'atob', 'btoa', 'crypto', 'performance', 'require', 'module', 'globalThis',
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView',

  // Loaded from /vendor/swagger-ui, which is a package directory rather than
  // anything under public/ — so it cannot be read the way the other includes
  // are. Named here because the API reference genuinely depends on it.
  'SwaggerUIBundle'
]);

function auditPage(file) {
  const html = fs.readFileSync(file, 'utf8');

  // What the page loads, in order
  const provided = new Set();
  for (const m of html.matchAll(/<script\s+src="([^"]+)"/g)) {
    const src = m[1];
    if (!src.startsWith('/')) continue;
    const asset = path.join(PUBLIC, src.replace(/^\//, ''));
    if (fs.existsSync(asset)) for (const name of globalsFrom(fs.readFileSync(asset, 'utf8'))) provided.add(name);
  }

  // What the page itself defines and calls, including inline handlers — an
  // onclick is a call site like any other, and the one most easily missed.
  const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const handlers = [...html.matchAll(/\son(?:click|change|input|submit|keyup|keydown)="([^"]*)"/g)]
    .map(m => m[1]).join(';\n');

  const script = `${inline}\n${handlers}`;
  for (const name of globalsFrom(inline)) provided.add(name);

  // Locally scoped declarations too — an inner `const load = …` is not global
  // but it is certainly defined.
  for (const m of script.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) provided.add(m[1]);
  for (const m of script.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) provided.add(m[1]);
  // Destructured bindings — a few pages pull a helper out of an object.
  for (const m of script.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) provided.add(name);
    }
  }

  // …and parameters, because a callback is called by the name it was given.
  // bars(id, data, colour) calls colour(label); busy(btn, label, work) calls
  // work(). Both read as undefined without this, and both are fine.
  //
  // This deliberately over-collects: a name wrongly counted as provided only
  // softens the check, while one wrongly missing is a false failure, and a test
  // that cries wolf is a test that gets deleted.
  const parameterNames = new Set();
  const clean = stripLiterals(script);

  for (const m of clean.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.replace(/=.*$/, '').replace(/[{}[\]]/g, '').split(':').pop().trim();
      if (/^\.{0,3}[A-Za-z_$][\w$]*$/.test(name)) parameterNames.add(name.replace(/^\.{3}/, ''));
    }
  }
  // Single-parameter arrows, which take no brackets
  for (const m of clean.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) parameterNames.add(m[1]);

  for (const name of parameterNames) provided.add(name);

  return [...callsIn(script)]
    .filter(name => !NOT_A_CALL.has(name) && !BUILTINS.has(name) && !provided.has(name))
    .sort();
}

test('every function a page calls is one the page can reach', () => {
  const broken = [];

  for (const file of pagesUnder(PUBLIC)) {
    const missing = auditPage(file);
    if (missing.length) broken.push(`${path.relative(PUBLIC, file)}: ${missing.join(', ')}`);
  }

  assert.deepEqual(broken, [],
    '\nThese pages call something that is not defined and not loaded:\n' + broken.join('\n') + '\n');
});
