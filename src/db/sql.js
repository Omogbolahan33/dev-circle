// Split SQL scripts into statements for the Postgres adapter, which sends one
// statement per query. Semicolons inside quoted strings, comments or
// dollar-quoted function bodies are data, not statement boundaries.
function statementsIn(sql) {
  const source = String(sql || '');
  const statements = [];
  let statement = '';
  let state = 'normal';
  let dollarTag = '';
  let blockDepth = 0;
  let escapeString = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (state === 'line-comment') {
      if (char === '\n') {
        statement += '\n';
        state = 'normal';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (char === '/' && next === '*') {
        blockDepth++;
        i++;
      } else if (char === '*' && next === '/') {
        blockDepth--;
        i++;
        if (!blockDepth) state = 'normal';
      }
      continue;
    }

    if (state === 'single-quote') {
      statement += char;
      if (escapeString && char === '\\' && next !== undefined) {
        statement += next;
        i++;
      } else if (char === "'" && next === "'") {
        statement += next;
        i++;
      } else if (char === "'") {
        state = 'normal';
      }
      continue;
    }

    if (state === 'double-quote') {
      statement += char;
      if (char === '"' && next === '"') {
        statement += next;
        i++;
      } else if (char === '"') {
        state = 'normal';
      }
      continue;
    }

    if (state === 'dollar-quote') {
      if (source.startsWith(dollarTag, i)) {
        statement += dollarTag;
        i += dollarTag.length - 1;
        state = 'normal';
      } else {
        statement += char;
      }
      continue;
    }

    if (char === '-' && next === '-') {
      state = 'line-comment';
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block-comment';
      blockDepth = 1;
      statement += ' ';
      i++;
      continue;
    }
    if (char === "'") {
      const before = source[i - 1] || '';
      const beforeBefore = source[i - 2] || '';
      escapeString = /[eE]/.test(before) && !/[\w$]/.test(beforeBefore);
      statement += char;
      state = 'single-quote';
      continue;
    }
    if (char === '"') {
      statement += char;
      state = 'double-quote';
      continue;
    }
    if (char === '$') {
      const tag = source.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) {
        dollarTag = tag;
        statement += tag;
        i += tag.length - 1;
        state = 'dollar-quote';
        continue;
      }
    }
    if (char === ';') {
      const normalized = statement.trim();
      if (normalized) statements.push(normalized);
      statement = '';
      continue;
    }
    statement += char;
  }

  const finalStatement = statement.trim();
  if (finalStatement) statements.push(finalStatement);
  return statements;
}

module.exports = { statementsIn };
