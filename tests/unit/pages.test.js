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
// Words a regex literal may follow — after these a slash opens a pattern, where
// after an identifier or a closing bracket it divides.
const REGEX_MAY_FOLLOW = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await'
]);

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
    // A regex literal, which is neither code to keep nor a string to skip past
    // — and which bites hardest when it contains a quote. /[",\n|]/ in the CSV
    // escaper read as the start of a string, and the scanner then swallowed
    // every remaining line of question-import.js as string content: no error,
    // no finding, just half a module nothing looked at any more.
    //
    // Telling a regex from a division is the usual guess: after a value — an
    // identifier, a number, a closing bracket — a slash divides; after an
    // operator, a comma, or a keyword like `return`, it opens a regex.
    if (char === '/' && next !== '/' && next !== '*') {
      const before = out.replace(/\s+$/, '');
      const previous = before[before.length - 1] || '';
      const word = (before.match(/[A-Za-z_$][\w$]*$/) || [''])[0];

      if (!/[\w$)\]]/.test(previous) || REGEX_MAY_FOLLOW.has(word)) {
        i++;
        let inClass = false;
        while (i < source.length) {
          const c = source[i];
          if (c === '\\') { i += 2; continue; }
          if (c === '\n') break;              // an unterminated one: not a regex
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) { i++; break; }
          i++;
        }
        while (i < source.length && /[a-z]/.test(source[i])) i++;   // flags
        out += ' ';
        continue;
      }
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

test('no page declares the same function twice', () => {
  // Two `function decide(…)` in one script is not an error anywhere — the later
  // one silently wins, and every button wired to the earlier one starts doing
  // something else. It happened on the applications queue the moment a bulk
  // decide() was added beside the one the drawer already had, and nothing
  // anywhere would have said so.
  const clashes = [];

  for (const file of pagesUnder(PUBLIC)) {
    const html = fs.readFileSync(file, 'utf8');
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
      .map(m => m[1]).join('\n');

    const seen = new Map();
    for (const m of stripLiterals(inline).matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
      seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    }

    const twice = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
    if (twice.length) clashes.push(`${path.relative(PUBLIC, file)}: ${twice.join(', ')}`);
  }

  assert.deepEqual(clashes, [],
    '\nThese pages declare a function more than once — the later one wins:\n' + clashes.join('\n') + '\n');
});

test('no page loads the same script twice', () => {
  // A repeated <script src> is not the harmless duplicate it looks like. These
  // assets publish themselves with `const SurveyTheme = …` at the top level,
  // and a second evaluation of that line is "Identifier 'SurveyTheme' has
  // already been declared" — a SyntaxError, so the whole file is thrown away
  // and the module the page wanted is the one thing it does not get. Both
  // survey builders loaded survey-theme.js twice, three lines apart, and the
  // page looked fine until the theme panel was opened.
  const repeats = [];

  for (const file of pagesUnder(PUBLIC)) {
    const html = fs.readFileSync(file, 'utf8');

    const seen = new Map();
    for (const m of html.matchAll(/<script\s+src="([^"]+)"/g)) {
      seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    }

    const twice = [...seen].filter(([, count]) => count > 1).map(([src]) => src);
    if (twice.length) repeats.push(`${path.relative(PUBLIC, file)}: ${twice.join(', ')}`);
  }

  assert.deepEqual(repeats, [],
    '\nThese pages load the same script more than once — the second one throws:\n' + repeats.join('\n') + '\n');
});

// ─── Does a module actually expose what a handler calls? ────
// The first check in this file reads bare `name(` calls and leaves `obj.name(`
// to somebody else. This is somebody else. A module written as an IIFE has
// exactly the methods its `return {…}` names, and nothing warns you when a
// function inside it never makes that list — not the browser, which says only
// "is not a function", and not at a moment you would notice.

// The body of the {…} that opens at `open`.
function braceBody(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && !--depth) return source.slice(open + 1, i);
  }
  return '';
}

// Splits an object-literal body on the commas that belong to it, not the ones
// inside nested objects, arrays or argument lists.
function topLevelParts(body) {
  const parts = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts;
}

// Both shapes this codebase uses: `openDrawer(id) {…}` in an object literal,
// and the shorthand `{ open, close }` of an IIFE's return.
function keysOf(body) {
  const names = new Set();
  for (const part of topLevelParts(body)) {
    const m = part.match(/^\s*(?:async\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*(?:[:(]|$)/);
    if (m) names.add(m[1]);
  }
  return names;
}

// Module.method() written into an inline handler — in a page, or in the markup
// a module renders for its own drawer, which is where this one hid.
function moduleCalls(source) {
  return [...source.matchAll(
    /\son(?:click|change|input|submit|keyup|keydown)="\s*([A-Z][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g
  )].map(m => [m[1], m[2]]);
}

test('every module method called anywhere is one that module exposes', () => {
  // QuestionImport defined add() and parse() and returned neither, so both of
  // the import drawer's buttons threw "QuestionImport.add is not a function".
  // The markup naming them is written by the module itself, so no check that
  // reads only pages would ever have seen the call.
  const assetDir = path.join(PUBLIC, 'assets', 'js');
  const assets = fs.readdirSync(assetDir).filter(f => f.endsWith('.js')).map(f => path.join(assetDir, f));

  // Indentation is what tells the module's own `return {…}` from the ones
  // inside its functions, so the search for it reads the file as written.
  // stripLiterals runs on the tail from there: it drops the text of a template
  // (and with it the newlines), which is exactly what a line anchor cannot
  // survive, but it leaves the braces balanced, which is what braceBody needs.
  const bodyAt = (source, from) => {
    const tail = stripLiterals(source.slice(from));
    return braceBody(tail, tail.indexOf('{'));
  };

  const exposes = new Map();
  for (const file of assets) {
    const source = fs.readFileSync(file, 'utf8');
    const clean = stripLiterals(source);

    for (const m of source.matchAll(/^const ([A-Z][\w$]*)\s*=\s*([{(])/gm)) {
      const [, name, opener] = m;
      let names;

      if (opener === '{') {
        names = keysOf(bodyAt(source, m.index));
      } else {
        // An IIFE exposes what it returns and only that. The module's own
        // return is the one at the outermost indent; the deeper ones belong to
        // the functions inside it.
        const returns = [...source.matchAll(/^ {0,2}return\s*\{/gm)];
        const last = returns[returns.length - 1];
        names = last ? keysOf(bodyAt(source, last.index)) : new Set();
      }

      // …plus anything bolted on after the fact.
      for (const a of clean.matchAll(new RegExp(`[^\\w$.]${name}\\.([A-Za-z_$][\\w$]*)\\s*=[^=]`, 'g'))) names.add(a[1]);
      exposes.set(name, names);
    }
  }

  const wrong = new Set();
  for (const file of [...pagesUnder(PUBLIC), ...assets]) {
    const source = fs.readFileSync(file, 'utf8');

    // Two passes, because neither sees the other's call sites. stripLiterals
    // reads a file as code — right for a script, but in an HTML file it takes
    // every attribute's quotes for a string and erases the handlers with them.
    // So handlers are read from the raw text and ordinary calls from the code.
    const calls = [
      ...moduleCalls(source),
      ...[...stripLiterals(source).matchAll(/\b([A-Z][A-Za-z0-9_$]*)\.([a-zA-Z_$][\w$]*)\s*\(/g)]
        .map(m => [m[1], m[2]])
    ];

    for (const [module, method] of calls) {
      // A module this check cannot find is not a failure — a call may land on
      // something a page defines for itself, or on a browser object that
      // happens to be capitalised, and a check that cries wolf is a check
      // nobody reads.
      const names = exposes.get(module);
      if (names && !names.has(method)) wrong.add(`${path.relative(PUBLIC, file)}: ${module}.${method}()`);
    }
  }

  assert.deepEqual([...wrong].sort(), [],
    '\nThese handlers call a method the module never exposes:\n' + [...wrong].sort().join('\n') + '\n');
});

test('every method called on a builder is one QuestionBuilder.create returns', () => {
  // The seam the check above cannot see. QuestionImport calls straight into the
  // builder it was handed — ctx.builder.importQuestions(ready) — and that is an
  // ordinary method call in a script, not an inline handler, so nothing that
  // reads onclick attributes goes near it. importQuestions() was written,
  // wired up and never added to what create() returns, and the import drawer
  // got all the way to "Add questions" before saying so.
  //
  // The returned surface is deliberately small (see the comment on it), which
  // is exactly why the two halves drift: the feature is added in one file and
  // the doorway it needs is in another.
  const builderJs = path.join(PUBLIC, 'assets', 'js', 'question-builder.js');
  const source = fs.readFileSync(builderJs, 'utf8');

  // Every object this module hands out — create()'s instance and the module's
  // own { create }. A union, because a caller reaching for a name in either is
  // reaching for something that exists.
  const surface = new Set();
  for (const m of source.matchAll(/^ {0,6}return\s*\{/gm)) {
    const tail = stripLiterals(source.slice(m.index));
    for (const key of keysOf(braceBody(tail, tail.indexOf('{')))) surface.add(key);
  }

  const assetDir = path.join(PUBLIC, 'assets', 'js');
  const files = [
    ...pagesUnder(PUBLIC),
    ...fs.readdirSync(assetDir).filter(f => f.endsWith('.js')).map(f => path.join(assetDir, f))
  ];

  const missing = new Set();
  for (const file of files) {
    // `builder.x()`, `builder?.x()` and `ctx.builder.x()` alike. Lower-case, so
    // QuestionBuilder.create() is not mistaken for one of these.
    for (const m of stripLiterals(fs.readFileSync(file, 'utf8')).matchAll(/\bbuilder\??\.([a-zA-Z_$][\w$]*)\s*\(/g)) {
      if (!surface.has(m[1])) missing.add(`${path.relative(PUBLIC, file)}: builder.${m[1]}()`);
    }
  }

  assert.deepEqual([...missing].sort(), [],
    '\nThese call a builder method that create() does not return:\n' + [...missing].sort().join('\n') + '\n');
});
