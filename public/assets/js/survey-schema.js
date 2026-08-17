// ─── Survey schema ──────────────────────────────────────────
// What a question is, what it may carry, and what counts as an answer to it.
//
// This file is the law in two places at once. The builder reads it to know
// which controls to draw and to refuse a survey that cannot be answered; the
// server reads the same file to refuse the same survey, and to check a
// submission it must never trust. Written twice, the two drift within a
// release: the browser starts allowing a rating of 8 on a 1–5 scale, or the
// server starts requiring an answer to a question the member was never shown.
// So it is written once and loaded by both — plain script in the page,
// require() on the server.
//
// It lives under public/ because that is the half that can only be reached one
// way: the server can require a file from anywhere, a browser can only fetch
// what is served.
//
//   SurveySchema.normalizeQuestions(draft)   → { questions, issues }  (authoring)
//   SurveySchema.visible(questions, answers) → the questions actually asked
//   SurveySchema.checkResponse(qs, answers)  → { ok, errors, answers }  (submitting)

const SurveySchema = (() => {

  // ─── Question types ───────────────────────────────────────
  // `answerable: false` is for furniture — a section heading is part of the
  // survey but nobody answers it, and treating it as a question is what makes
  // "3 of 8" wrong and a required check impossible to satisfy.
  //
  // `verbatim: true` marks types whose answer is a sentence a person wrote.
  // Those get filed as feedback, so they can be read alongside everything else
  // that member has said, rather than only inside this one response.

  const TYPES = [
    {
      type: 'text',
      label: 'Text',
      hint: 'A sentence in their own words',
      answerable: true,
      verbatim: true
    },
    {
      type: 'choice',
      label: 'Single choice',
      hint: 'Pick one of several',
      answerable: true,
      options: true
    },
    {
      type: 'multi_choice',
      label: 'Multiple choice',
      hint: 'Pick any number',
      answerable: true,
      options: true
    },
    {
      type: 'dropdown',
      label: 'Dropdown',
      hint: 'Pick one from a long list',
      answerable: true,
      options: true
    },
    {
      type: 'rating',
      label: 'Rating',
      hint: 'A scale with labelled ends',
      answerable: true
    },
    {
      type: 'nps',
      label: 'NPS',
      hint: '0–10 recommendation, scored as promoters and detractors',
      answerable: true
    },
    {
      type: 'matrix',
      label: 'Grid',
      hint: 'Several things rated on one shared scale',
      answerable: true
    },
    {
      type: 'ranking',
      label: 'Ranking',
      hint: 'Put options in order of preference',
      answerable: true,
      options: true
    },
    {
      type: 'number',
      label: 'Number',
      hint: 'A quantity, within a range you set',
      answerable: true
    },
    {
      type: 'date',
      label: 'Date',
      hint: 'A calendar date',
      answerable: true
    },
    {
      type: 'boolean',
      label: 'Yes / No',
      hint: 'A single either-or',
      answerable: true
    },
    {
      type: 'section',
      label: 'Section',
      hint: 'A heading or note between questions — nothing to answer',
      answerable: false
    }
  ];

  const BY_TYPE = new Map(TYPES.map(t => [t.type, t]));

  const spec = type => BY_TYPE.get(type) || null;
  const isAnswerable = question => !!(question && spec(question.type)?.answerable);
  const isVerbatim = question => !!(question && spec(question.type)?.verbatim);

  // Formats a text answer can be held to. Chosen over separate question types
  // because the member sees the same control either way — what changes is only
  // what we accept, and a type per format would multiply the builder for
  // nothing.
  const TEXT_FORMATS = {
    none: { label: 'Any text', test: () => true },
    email: {
      label: 'Email address',
      test: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
      message: 'Enter a valid email address'
    },
    url: {
      label: 'Web address',
      test: v => /^https?:\/\/[^\s.]+\.[^\s]{2,}$/i.test(v),
      message: 'Enter a full web address, starting http:// or https://'
    },
    phone: {
      label: 'Phone number',
      // Deliberately loose: this is a survey, not a billing form, and a member
      // who writes their number with spaces or a country code has answered.
      test: v => /^[+\d][\d\s()\-]{6,19}$/.test(v),
      message: 'Enter a valid phone number'
    }
  };

  const RATING_STYLES = ['numbers', 'stars', 'faces'];

  // Free text attached to an "Other" option. Short by design: it is a label
  // the member is writing, not an essay — the essay belongs in a text question.
  const OTHER_MAX = 200;

  const DEFAULT_TEXT_MAX = 2000;

  // ─── Small helpers ────────────────────────────────────────

  const str = v => (v === null || v === undefined ? '' : String(v));
  const trimmed = v => str(v).trim();
  const isBlank = v => trimmed(v) === '';

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const s = trimmed(value);
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  // Case and surrounding space do not make two options different. Used to
  // catch duplicates while authoring and to match an answer back to the
  // option it came from.
  const foldOption = v => trimmed(v).toLowerCase();

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  function isRealDate(value) {
    if (!ISO_DATE.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }

  // ─── Authoring: normalizing a written survey ──────────────
  // Takes what the builder posted and returns the survey as it will be stored,
  // plus every reason it cannot be. Nothing here guesses at intent: a rating
  // scale of "seven" becomes an issue, not a 7, because a survey that quietly
  // means something other than what was written is worse than one that refuses
  // to save.

  function normalizeOptions(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const options = [];
    for (const option of raw) {
      const text = trimmed(option && typeof option === 'object' ? option.text : option);
      if (!text) continue;                       // blank rows are the builder's, not the author's
      const fold = foldOption(text);
      if (seen.has(fold)) continue;              // a list with the same option twice cannot be tallied
      seen.add(fold);
      options.push(text);
    }
    return options;
  }

  function normalizeQuestion(raw, index, earlier) {
    const issues = [];
    const at = (field, message) => issues.push({ index, field, message, number: index + 1 });

    const type = trimmed(raw && raw.type) || 'text';
    if (!BY_TYPE.has(type)) {
      at('type', `"${type}" is not a question type`);
      return { question: null, issues };
    }

    const question = {
      id: trimmed(raw.id) || null,       // the caller assigns this; kept if already stable
      type,
      text: trimmed(raw.text)
    };

    if (!question.text) {
      at('text', 'Every question needs its wording');
    }

    if (raw.question_id) question.question_id = trimmed(raw.question_id);
    if (!isBlank(raw.description)) question.description = trimmed(raw.description).slice(0, 500);

    // Whether an answer is compulsory. Only meaningful for something you can
    // answer — a required section heading is a contradiction that would block
    // every submission.
    const answerable = BY_TYPE.get(type).answerable;
    if (answerable) question.required = raw.required === true || raw.required === 'true';

    switch (type) {
      case 'text': {
        question.multiline = raw.multiline !== false && raw.multiline !== 'false';
        const format = trimmed(raw.format) || 'none';
        if (!TEXT_FORMATS[format]) at('format', `Unknown text format "${format}"`);
        else if (format !== 'none') question.format = format;

        // A format is a shape, not an essay: an email address in a box sized
        // for a paragraph reads as a mistake.
        if (question.format) question.multiline = false;

        const min = raw.min_length === '' || raw.min_length === null || raw.min_length === undefined
          ? null : clampInt(raw.min_length, 0, 10000, null);
        const max = raw.max_length === '' || raw.max_length === null || raw.max_length === undefined
          ? DEFAULT_TEXT_MAX : clampInt(raw.max_length, 1, 10000, DEFAULT_TEXT_MAX);

        if (min !== null && min > max) {
          at('min_length', `Shortest answer (${min}) is longer than the longest allowed (${max})`);
        } else if (min) {
          question.min_length = min;
        }
        question.max_length = max;
        if (!isBlank(raw.placeholder)) question.placeholder = trimmed(raw.placeholder).slice(0, 120);
        break;
      }

      case 'choice':
      case 'dropdown':
      case 'multi_choice':
      case 'ranking': {
        question.options = normalizeOptions(raw.options);
        if (question.options.length < 2) {
          at('options', 'Needs at least two options to choose between');
        }
        if (Array.isArray(raw.options) && raw.options.filter(o => !isBlank(o)).length > question.options.length) {
          at('options', 'Two options are the same');
        }

        if (type !== 'ranking') {
          question.allow_other = raw.allow_other === true || raw.allow_other === 'true';
          if (question.allow_other && !isBlank(raw.other_label)) {
            question.other_label = trimmed(raw.other_label).slice(0, 60);
          }
        }

        // Order effects are real: the first option is picked more often for no
        // reason connected to what it says.
        if (raw.randomize === true || raw.randomize === 'true') question.randomize = true;

        if (type === 'multi_choice') {
          const count = question.options.length + (question.allow_other ? 1 : 0);
          const min = clampInt(raw.min_select, 0, 100, 0);
          const max = raw.max_select === '' || raw.max_select === null || raw.max_select === undefined
            ? null : clampInt(raw.max_select, 1, 100, null);

          if (min > count) {
            at('min_select', `Asks for at least ${min} answers but offers ${count} options`);
          } else if (max !== null && min > max) {
            at('min_select', `Asks for at least ${min} but allows at most ${max}`);
          } else {
            if (min) question.min_select = min;
            if (max !== null && max < count) question.max_select = max;
          }

          // Options that cannot be held together with any other — "None of
          // the above" ticked alongside three things is not an answer.
          const exclusive = normalizeOptions(raw.exclusive_options)
            .filter(o => question.options.some(opt => foldOption(opt) === foldOption(o)));
          if (exclusive.length) question.exclusive_options = exclusive;
        }
        break;
      }

      case 'rating': {
        question.scale = clampInt(raw.scale, 2, 10, 5);
        if (raw.scale !== undefined && raw.scale !== null && raw.scale !== '' &&
            !Number.isFinite(parseInt(raw.scale, 10))) {
          at('scale', 'Scale must be a number');
        }

        const style = trimmed(raw.style) || 'numbers';
        if (!RATING_STYLES.includes(style)) at('style', `Unknown rating style "${style}"`);
        else if (style !== 'numbers') question.style = style;

        // Ends are what make a scale mean anything. Stored as a sparse array
        // the length of the scale so the member's view and the results screen
        // read the same positions.
        const labels = Array.isArray(raw.labels) ? raw.labels : [];
        const low = trimmed(raw.label_low || labels[0]);
        const high = trimmed(raw.label_high || labels[labels.length - 1]);
        if (low || high) {
          question.labels = Array.from({ length: question.scale }, (_, i) => {
            if (i === 0) return low;
            if (i === question.scale - 1) return high;
            return trimmed(labels[i]);
          });
        }
        break;
      }

      case 'nps':
        // Fixed by definition. A "0–10, how likely are you to recommend"
        // question with a different scale is not NPS, and scoring it as if it
        // were would put a number in front of people that means nothing.
        question.scale = 10;
        if (!isBlank(raw.label_low)) question.label_low = trimmed(raw.label_low).slice(0, 40);
        if (!isBlank(raw.label_high)) question.label_high = trimmed(raw.label_high).slice(0, 40);
        break;

      case 'matrix': {
        question.rows = normalizeOptions(raw.rows);
        question.columns = normalizeOptions(raw.columns);
        if (question.rows.length < 1) at('rows', 'A grid needs at least one row');
        if (question.columns.length < 2) at('columns', 'A grid needs at least two columns to choose between');
        if (question.rows.length > 20) at('rows', 'A grid over 20 rows will not be finished — split it up');
        question.multi = raw.multi === true || raw.multi === 'true';
        break;
      }

      case 'number': {
        const min = raw.min === '' || raw.min === null || raw.min === undefined ? null : toNumber(raw.min);
        const max = raw.max === '' || raw.max === null || raw.max === undefined ? null : toNumber(raw.max);
        if (raw.min !== undefined && raw.min !== null && raw.min !== '' && min === null) {
          at('min', 'Smallest value must be a number');
        }
        if (raw.max !== undefined && raw.max !== null && raw.max !== '' && max === null) {
          at('max', 'Largest value must be a number');
        }
        if (min !== null && max !== null && min > max) {
          at('min', `Smallest value (${min}) is above the largest (${max})`);
        } else {
          if (min !== null) question.min = min;
          if (max !== null) question.max = max;
        }
        question.integer = raw.integer === true || raw.integer === 'true';
        if (!isBlank(raw.unit)) question.unit = trimmed(raw.unit).slice(0, 20);
        break;
      }

      case 'date': {
        const min = trimmed(raw.min);
        const max = trimmed(raw.max);
        if (min && !isRealDate(min)) at('min', 'Earliest date is not a real date');
        else if (min) question.min = min;
        if (max && !isRealDate(max)) at('max', 'Latest date is not a real date');
        else if (max) question.max = max;
        if (question.min && question.max && question.min > question.max) {
          at('min', 'Earliest date is after the latest');
        }
        break;
      }

      case 'boolean':
        question.true_label = trimmed(raw.true_label).slice(0, 40) || 'Yes';
        question.false_label = trimmed(raw.false_label).slice(0, 40) || 'No';
        if (foldOption(question.true_label) === foldOption(question.false_label)) {
          at('true_label', 'Both answers read the same');
        }
        break;

      case 'section':
        // The wording is the heading; there is nothing else to hold.
        break;
    }

    const logic = normalizeLogic(raw.visible_if, earlier, at);
    if (logic) question.visible_if = logic;

    return { question, issues };
  }

  // ─── Branching ────────────────────────────────────────────
  // A question can depend on what came before it:
  //
  //   visible_if: { match: 'all', rules: [{ question: 'q2_ab12', op: 'is', value: 'No' }] }
  //
  // Two rules make this safe rather than clever. A rule may only look
  // backwards — a question whose visibility depends on an answer not yet given
  // has no defined state, and letting authors write one produces a survey that
  // behaves differently depending on which way the member walked through it.
  // And a value compared against a fixed list must be on that list, because
  // "Nigeria " with a trailing space is a condition that can never be true and
  // nothing on screen would ever say so.

  const OPERATORS = [
    { op: 'is', label: 'is', needsValue: true },
    { op: 'is_not', label: 'is not', needsValue: true },
    { op: 'includes', label: 'includes', needsValue: true },
    { op: 'not_includes', label: 'does not include', needsValue: true },
    { op: 'gt', label: 'is more than', needsValue: true, numeric: true },
    { op: 'gte', label: 'is at least', needsValue: true, numeric: true },
    { op: 'lt', label: 'is less than', needsValue: true, numeric: true },
    { op: 'lte', label: 'is at most', needsValue: true, numeric: true },
    { op: 'answered', label: 'was answered', needsValue: false },
    { op: 'not_answered', label: 'was skipped', needsValue: false }
  ];

  const OPERATORS_BY_OP = new Map(OPERATORS.map(o => [o.op, o]));

  // Which comparisons make sense against which type. Offering "is more than"
  // for a free-text question invites a rule that can never fire.
  function operatorsFor(type) {
    switch (type) {
      case 'multi_choice':
        return ['includes', 'not_includes', 'answered', 'not_answered'];
      case 'choice':
      case 'dropdown':
      case 'boolean':
        return ['is', 'is_not', 'answered', 'not_answered'];
      case 'rating':
      case 'nps':
      case 'number':
        return ['is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'answered', 'not_answered'];
      case 'date':
        return ['is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'answered', 'not_answered'];
      case 'text':
        return ['is', 'is_not', 'includes', 'not_includes', 'answered', 'not_answered'];
      default:
        return ['answered', 'not_answered'];
    }
  }

  // Which earlier questions a rule can point at. Sections hold no answer, and
  // grids and rankings hold a shape no single comparison reads sensibly.
  const CONDITIONABLE = new Set([
    'text', 'choice', 'dropdown', 'multi_choice', 'rating', 'nps', 'number', 'date', 'boolean'
  ]);

  function normalizeLogic(raw, earlier, at) {
    if (!raw || typeof raw !== 'object') return null;

    const rules = Array.isArray(raw.rules) ? raw.rules : [];
    if (!rules.length) return null;

    const match = raw.match === 'any' ? 'any' : 'all';
    const kept = [];

    for (const rule of rules) {
      const questionId = trimmed(rule && rule.question);
      if (!questionId) continue;

      const source = earlier.find(q => q.id === questionId);
      if (!source) {
        // Either it points forward or it points at nothing. Both mean the
        // condition can never be evaluated at the moment it is needed.
        at('visible_if', 'A rule can only depend on a question asked earlier');
        continue;
      }
      if (!CONDITIONABLE.has(source.type)) {
        at('visible_if', `"${source.text}" holds no answer a rule can read`);
        continue;
      }

      const op = trimmed(rule.op) || 'is';
      if (!OPERATORS_BY_OP.has(op)) {
        at('visible_if', `Unknown condition "${op}"`);
        continue;
      }
      if (!operatorsFor(source.type).includes(op)) {
        at('visible_if', `"${OPERATORS_BY_OP.get(op).label}" cannot be asked of a ${source.type} question`);
        continue;
      }

      const needsValue = OPERATORS_BY_OP.get(op).needsValue;
      if (!needsValue) { kept.push({ question: questionId, op }); continue; }

      let value = rule.value;

      if (source.options && ['is', 'is_not', 'includes', 'not_includes'].includes(op)) {
        const matchOption = source.options.find(o => foldOption(o) === foldOption(value));
        const other = source.allow_other && foldOption(value) === '__other__';
        if (!matchOption && !other) {
          at('visible_if', `"${trimmed(value)}" is not one of the options for "${source.text}"`);
          continue;
        }
        value = other ? '__other__' : matchOption;
      } else if (source.type === 'boolean') {
        value = value === true || value === 'true' || foldOption(value) === foldOption(source.true_label);
      } else if (OPERATORS_BY_OP.get(op).numeric && source.type !== 'date') {
        const n = toNumber(value);
        if (n === null) {
          at('visible_if', 'A "more than" or "at least" rule needs a number to compare with');
          continue;
        }
        value = n;
      } else if (source.type === 'date') {
        const d = trimmed(value);
        if (!isRealDate(d)) { at('visible_if', 'A date rule needs a real date'); continue; }
        value = d;
      } else {
        value = trimmed(value);
        if (!value) { at('visible_if', 'A rule needs something to compare with'); continue; }
      }

      kept.push({ question: questionId, op, value });
    }

    return kept.length ? { match, rules: kept } : null;
  }

  // Does one rule hold, given the answers so far? `answers` here holds only
  // answers to questions that were actually shown — see visible().
  function ruleHolds(rule, question, answers) {
    const has = Object.prototype.hasOwnProperty.call(answers, rule.question);
    const value = has ? answers[rule.question] : undefined;
    const answered = has && isAnswered(question, value);

    if (rule.op === 'answered') return answered;
    if (rule.op === 'not_answered') return !answered;
    if (!answered) return false;   // nothing to compare against

    switch (rule.op) {
      case 'is':
        if (Array.isArray(value)) return value.length === 1 && sameValue(value[0], rule.value);
        return sameValue(value, rule.value);
      case 'is_not':
        if (Array.isArray(value)) return !value.some(v => sameValue(v, rule.value));
        return !sameValue(value, rule.value);
      case 'includes':
        if (Array.isArray(value)) return value.some(v => sameValue(v, rule.value));
        return str(value).toLowerCase().includes(str(rule.value).toLowerCase());
      case 'not_includes':
        if (Array.isArray(value)) return !value.some(v => sameValue(v, rule.value));
        return !str(value).toLowerCase().includes(str(rule.value).toLowerCase());
      case 'gt': case 'gte': case 'lt': case 'lte': {
        // Dates compare as ISO strings, which sort correctly; everything else
        // compares as a number.
        const isDate = question && question.type === 'date';
        const left = isDate ? str(value) : toNumber(value);
        const right = isDate ? str(rule.value) : toNumber(rule.value);
        if (left === null || right === null || left === '' || right === '') return false;
        if (rule.op === 'gt') return left > right;
        if (rule.op === 'gte') return left >= right;
        if (rule.op === 'lt') return left < right;
        return left <= right;
      }
      default:
        return false;
    }
  }

  function sameValue(a, b) {
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      return Boolean(a) === Boolean(b);
    }
    if (typeof a === 'number' || typeof b === 'number') {
      const na = toNumber(a); const nb = toNumber(b);
      if (na !== null && nb !== null) return na === nb;
    }
    return foldOption(a) === foldOption(b);
  }

  // The questions this member is actually being asked, given what they have
  // answered. Walked in order, carrying only the answers to questions that
  // were themselves shown: an answer given on a path the member later backed
  // out of must not keep a downstream question alive.
  function visible(questions, answers = {}) {
    const shown = [];
    const live = {};
    const byId = new Map();

    for (const question of questions || []) {
      byId.set(question.id, question);

      const logic = question.visible_if;
      let show = true;

      if (logic && Array.isArray(logic.rules) && logic.rules.length) {
        const results = logic.rules.map(rule => ruleHolds(rule, byId.get(rule.question), live));
        show = logic.match === 'any' ? results.some(Boolean) : results.every(Boolean);
      }

      if (!show) continue;

      shown.push(question);
      if (Object.prototype.hasOwnProperty.call(answers, question.id)) {
        live[question.id] = answers[question.id];
      }
    }

    return shown;
  }

  const visibleIds = (questions, answers) => new Set(visible(questions, answers).map(q => q.id));

  // ─── Answers ──────────────────────────────────────────────

  // Nothing there at all. Kept apart from "not a valid answer" because the two
  // deserve opposite treatment: an empty answer to an optional question is
  // fine and is stored as nothing, while a value that cannot be read as an
  // answer is refused. Folding them together would mean a rating of "banana"
  // was quietly discarded and the member told their survey went through.
  function isEmpty(value) {
    if (value === undefined || value === null) return true;
    if (typeof value === 'boolean' || typeof value === 'number') return false;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') {
      return !Object.values(value).some(v => (Array.isArray(v) ? v.length > 0 : !isBlank(v)));
    }
    return isBlank(value);
  }

  // Has this been answered at all? Distinct from whether the answer is valid:
  // an empty answer to an optional question is fine, an invalid one never is.
  function isAnswered(question, value) {
    if (!question || !isAnswerable(question)) return false;
    if (value === undefined || value === null) return false;

    switch (question.type) {
      case 'multi_choice':
      case 'ranking':
        return Array.isArray(value) && value.length > 0;
      case 'matrix':
        return !!value && typeof value === 'object' && Object.values(value)
          .some(v => Array.isArray(v) ? v.length > 0 : !isBlank(v));
      case 'boolean':
        return value === true || value === false || value === 'true' || value === 'false';
      case 'rating':
      case 'nps':
      case 'number':
        return toNumber(value) !== null;
      default:
        return !isBlank(value);
    }
  }

  // Check one answer and return it in the shape it will be stored in. The
  // returned value is what gets written — never the raw submission — so a
  // number arriving as "7" from a form field is stored as 7 and analysed as
  // one.
  function validateAnswer(question, value) {
    const fail = error => ({ ok: false, error });
    const pass = v => ({ ok: true, value: v });

    if (!isAnswerable(question)) return fail('This is not a question');

    if (isEmpty(value)) {
      if (question.required) return fail('This one is required');
      return { ok: true, value: undefined, empty: true };
    }

    switch (question.type) {
      case 'text': {
        const text = trimmed(value);
        const max = question.max_length || DEFAULT_TEXT_MAX;
        if (text.length > max) return fail(`Keep it under ${max} characters`);
        if (question.min_length && text.length < question.min_length) {
          return fail(`Please write at least ${question.min_length} characters`);
        }
        const format = TEXT_FORMATS[question.format || 'none'];
        if (format && !format.test(text)) return fail(format.message);
        return pass(text);
      }

      case 'choice':
      case 'dropdown': {
        const text = trimmed(value);
        const known = (question.options || []).find(o => foldOption(o) === foldOption(text));
        if (known) return pass(known);
        // An unlisted value is the "Other" box when the author allowed one,
        // and a rejected answer when they did not — otherwise a choice
        // question tallies values nobody was ever offered.
        if (!question.allow_other) return fail('Pick one of the options');
        if (text.length > OTHER_MAX) return fail(`Keep it under ${OTHER_MAX} characters`);
        return pass(text);
      }

      case 'multi_choice': {
        if (!Array.isArray(value)) return fail('Pick from the options');

        const picked = [];
        for (const entry of value) {
          const text = trimmed(entry);
          if (!text) continue;
          const known = (question.options || []).find(o => foldOption(o) === foldOption(text));
          if (known) {
            if (!picked.some(p => foldOption(p) === foldOption(known))) picked.push(known);
            continue;
          }
          if (!question.allow_other) return fail('Pick from the options');
          if (text.length > OTHER_MAX) return fail(`Keep it under ${OTHER_MAX} characters`);
          if (!picked.some(p => foldOption(p) === foldOption(text))) picked.push(text);
        }

        if (!picked.length) {
          return question.required ? fail('This one is required') : { ok: true, value: undefined, empty: true };
        }

        const exclusive = (question.exclusive_options || [])
          .find(o => picked.some(p => foldOption(p) === foldOption(o)));
        if (exclusive && picked.length > 1) {
          return fail(`"${exclusive}" cannot be picked alongside anything else`);
        }

        if (question.min_select && picked.length < question.min_select) {
          return fail(`Pick at least ${question.min_select}`);
        }
        if (question.max_select && picked.length > question.max_select) {
          return fail(`Pick at most ${question.max_select}`);
        }
        return pass(picked);
      }

      case 'ranking': {
        if (!Array.isArray(value)) return fail('Put the options in order');
        const ordered = [];
        for (const entry of value) {
          const known = (question.options || []).find(o => foldOption(o) === foldOption(entry));
          if (!known) return fail('That is not one of the options');
          if (ordered.some(o => foldOption(o) === foldOption(known))) {
            return fail('Each option can only take one position');
          }
          ordered.push(known);
        }
        // A partial ranking is not comparable with a complete one, so the
        // whole list is the answer or none of it is.
        if (ordered.length !== (question.options || []).length) {
          return fail('Give every option a position');
        }
        return pass(ordered);
      }

      case 'rating': {
        const n = toNumber(value);
        const scale = question.scale || 5;
        if (!Number.isInteger(n) || n < 1 || n > scale) return fail(`Choose a rating from 1 to ${scale}`);
        return pass(n);
      }

      case 'nps': {
        const n = toNumber(value);
        if (!Number.isInteger(n) || n < 0 || n > 10) return fail('Choose a score from 0 to 10');
        return pass(n);
      }

      case 'number': {
        const n = toNumber(value);
        if (n === null) return fail('Enter a number');
        if (question.integer && !Number.isInteger(n)) return fail('Enter a whole number');
        if (question.min !== undefined && n < question.min) return fail(`Must be at least ${question.min}`);
        if (question.max !== undefined && n > question.max) return fail(`Must be at most ${question.max}`);
        return pass(n);
      }

      case 'date': {
        const date = trimmed(value);
        if (!isRealDate(date)) return fail('Enter a date as YYYY-MM-DD');
        if (question.min && date < question.min) return fail(`Must be on or after ${question.min}`);
        if (question.max && date > question.max) return fail(`Must be on or before ${question.max}`);
        return pass(date);
      }

      case 'boolean':
        if (value === true || value === 'true') return pass(true);
        if (value === false || value === 'false') return pass(false);
        return fail('Choose one');

      case 'matrix': {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Answer the grid');

        const rows = question.rows || [];
        const columns = question.columns || [];
        const answer = {};

        for (const [row, picked] of Object.entries(value)) {
          const knownRow = rows.find(r => foldOption(r) === foldOption(row));
          if (!knownRow) return fail('That row is not part of this grid');

          if (question.multi) {
            const list = (Array.isArray(picked) ? picked : [picked])
              .map(p => columns.find(c => foldOption(c) === foldOption(p)))
              .filter(Boolean);
            if (list.length) answer[knownRow] = [...new Set(list)];
          } else {
            const knownColumn = columns.find(c => foldOption(c) === foldOption(picked));
            if (!knownColumn && !isBlank(picked)) return fail('That is not one of the columns');
            if (knownColumn) answer[knownRow] = knownColumn;
          }
        }

        // Required means the whole grid, not one row of it — a half-answered
        // grid cannot be read across its rows, which is the only reason to
        // ask one as a grid.
        if (question.required && Object.keys(answer).length < rows.length) {
          return fail('Answer every row');
        }
        if (!Object.keys(answer).length) {
          return question.required ? fail('This one is required') : { ok: true, value: undefined, empty: true };
        }
        return pass(answer);
      }

      default:
        return fail('Unknown question type');
    }
  }

  // ─── Submitting ───────────────────────────────────────────
  // The whole response at once: which questions were actually asked, whether
  // each answer holds up, and what gets stored.
  //
  // Answers to questions the member never saw are dropped rather than refused.
  // Backing out of a branch is ordinary behaviour — answer "Yes", answer the
  // follow-up, go back, change to "No" — and the follow-up's answer is then a
  // thing the member has retracted. Storing it would put words in their mouth;
  // rejecting the submission would punish them for changing their mind.

  function checkResponse(questions, answers = {}) {
    const list = Array.isArray(questions) ? questions : [];
    const asked = visible(list, answers);
    const askedIds = new Set(asked.map(q => q.id));

    const errors = {};
    const clean = {};
    const missing = [];

    for (const question of asked) {
      if (!isAnswerable(question)) continue;

      const raw = Object.prototype.hasOwnProperty.call(answers, question.id)
        ? answers[question.id] : undefined;

      const result = validateAnswer(question, raw);
      if (!result.ok) {
        errors[question.id] = result.error;
        // Separated so a client can say "three questions still need an answer"
        // rather than lumping a missing answer in with a rejected one
        if (isEmpty(raw)) missing.push(question.id);
        continue;
      }
      if (result.value !== undefined) clean[question.id] = result.value;
    }

    const dropped = Object.keys(answers).filter(id => !askedIds.has(id));

    return {
      ok: Object.keys(errors).length === 0,
      errors,
      missing,
      dropped,
      answers: clean,
      asked: asked.map(q => q.id)
    };
  }

  // ─── Authoring, whole survey ──────────────────────────────

  // `allowEmpty` is for a draft. Writing a survey is not done in one sitting,
  // and refusing to save a title and an audience until the questions exist is
  // how a draft gets written in a text file instead. What must never be empty
  // is a survey that goes out, which is checked where it is published.
  function normalizeQuestions(draft, { makeId, allowEmpty = false } = {}) {
    const list = Array.isArray(draft) ? draft : [];
    const issues = [];
    const questions = [];
    const seenIds = new Set();

    list.forEach((raw, index) => {
      const { question, issues: found } = normalizeQuestion(raw, index, questions);
      issues.push(...found);
      if (!question) return;

      // A stable id per slot: answers are keyed by it, branching points at it,
      // and an export lines its columns up against it. Two questions sharing
      // one would overwrite each other's answers.
      if (!question.id || seenIds.has(question.id)) {
        question.id = makeId ? makeId(index) : `q${index + 1}`;
      }
      seenIds.add(question.id);
      questions.push(question);
    });

    if (!questions.length) {
      if (!allowEmpty) {
        issues.push({ index: -1, field: 'questions', message: 'A survey needs at least one question' });
      }
    } else if (!questions.some(isAnswerable)) {
      issues.push({ index: -1, field: 'questions', message: 'A survey of only section headings asks nothing' });
    }

    // A question nobody can reach is almost always a mistake in the logic
    // rather than an intention, and it is invisible on the page that made it.
    questions.forEach((question, index) => {
      if (!question.visible_if) return;
      const contradiction = question.visible_if.match === 'all' &&
        question.visible_if.rules.some(a =>
          question.visible_if.rules.some(b =>
            a !== b && a.question === b.question &&
            ((a.op === 'is' && b.op === 'is' && !sameValue(a.value, b.value)) ||
             (a.op === 'answered' && b.op === 'not_answered'))));
      if (contradiction) {
        issues.push({
          index, number: index + 1, field: 'visible_if',
          message: 'These conditions contradict each other, so this question can never be shown'
        });
      }
    });

    return { questions, issues };
  }

  // ─── Reading results ──────────────────────────────────────
  // How to summarise an answer in one line — used by the results table, the
  // CSV export and anywhere a response is shown next to a member's name. Kept
  // here so a grid does not become "[object Object]" in one of the three.

  function answerToText(question, value) {
    if (value === undefined || value === null || value === '') return '';

    switch (question.type) {
      case 'multi_choice':
        return Array.isArray(value) ? value.join('; ') : str(value);
      case 'ranking':
        return Array.isArray(value) ? value.map((o, i) => `${i + 1}. ${o}`).join('; ') : str(value);
      case 'matrix':
        return Object.entries(value)
          .map(([row, picked]) => `${row}: ${Array.isArray(picked) ? picked.join(' / ') : picked}`)
          .join('; ');
      case 'boolean':
        return value ? (question.true_label || 'Yes') : (question.false_label || 'No');
      case 'rating':
        return `${value}/${question.scale || 5}`;
      case 'nps':
        return `${value}/10`;
      case 'number':
        return question.unit ? `${value} ${question.unit}` : str(value);
      default:
        return str(value);
    }
  }

  // NPS is not an average. A 10 and a 0 do not make two 5s, and reporting the
  // mean of a recommendation score is the single most common way of hiding
  // that half your members are actively unhappy.
  function npsScore(values) {
    const scores = values.map(toNumber).filter(n => n !== null);
    if (!scores.length) return null;

    const promoters = scores.filter(n => n >= 9).length;
    const passives = scores.filter(n => n >= 7 && n <= 8).length;
    const detractors = scores.filter(n => n <= 6).length;

    return {
      score: Math.round(((promoters - detractors) / scores.length) * 100),
      promoters, passives, detractors, responses: scores.length
    };
  }

  return {
    TYPES, BY_TYPE, spec, isAnswerable, isVerbatim,
    TEXT_FORMATS, RATING_STYLES, OTHER_MAX, DEFAULT_TEXT_MAX,
    OPERATORS, operatorsFor, CONDITIONABLE,
    normalizeQuestion, normalizeQuestions,
    visible, visibleIds, isAnswered, isEmpty, validateAnswer, checkResponse,
    answerToText, npsScore,
    // exported for callers that need the same folding rules
    foldOption, toNumber, isRealDate
  };
})();

// Loaded as a plain script in the browser and required on the server. The
// guard is what lets one file be the single definition rather than two that
// agree until they do not.
if (typeof module !== 'undefined' && module.exports) module.exports = SurveySchema;
