// ─── Bulk question import ──────────────────────────────────
// Writing a survey or onboarding form one question at a time is the right way
// to *refine* one, but a programme often starts with a list someone already
// holds — a spreadsheet of feedback questions, a bank of KYB fields, a
// stakeholder's column of wording. This turns that list into questions
// without pretending a spreadsheet can say everything the builder can:
// options, grids and scales come through; branching logic and the per-form
// extras (field mapping, consent) stay in the builder, where they belong.
//
// Shared by the survey builder and the onboarding builder, exactly as the
// question editor is. It validates every row through SurveySchema — the same
// definition the server checks — so an import cannot create a question the
// survey could never save. A row with a problem is reported, never guessed at.

const QuestionImport = (() => {

  // ─── CSV reading ────────────────────────────────────────
  // Handles quoted fields, embedded commas/newlines and doubled quotes. The
  // same shape as the server's parser (helpers.parseCSV), done client-side so
  // a preview appears before anything is posted.
  function parseCSVText(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    const src = String(text).replace(/^﻿/, ''); // strip BOM from Excel

    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === ',') { row.push(field); field = ''; continue; }
      if (ch === '\r') continue;
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }

    const nonEmpty = rows.filter(r => r.some(c => c.trim() !== ''));
    if (nonEmpty.length < 2) return [];
    // Normalise a heading to a bare key: lowercase, spaces to underscores,
    // punctuation dropped — done in that order so "Question Type" and
    // "question_type" land on the same key.
    const normKey = h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const headers = nonEmpty[0].map(normKey);
    return nonEmpty.slice(1).map(cells => {
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = (cells[idx] ?? '').trim(); });
      return obj;
    });
  }

  // Accept a few sensible aliases so a sheet headed "question" or "prompt"
  // lines up without a manual rename.
  const HEADER_ALIASES = {
    wording: 'text', question: 'text', prompt: 'text', q: 'text', question_text: 'text', title: 'text',
    type: 'type', kind: 'type', question_type: 'type',
    required: 'required', mandatory: 'required', required_: 'required',
    options: 'options', choices: 'options', answers: 'options', option: 'options',
    description: 'description', help: 'description', note: 'description', helper_text: 'description',
    rows: 'rows', statements: 'rows',
    columns: 'columns', scale_labels: 'columns',
    low: 'label_low', low_label: 'label_low', label_low: 'label_low', start: 'label_low', min_label: 'label_low',
    high: 'label_high', high_label: 'label_high', label_high: 'label_high', end: 'label_high', max_label: 'label_high',
    scale: 'scale', points: 'scale',
    placeholder: 'placeholder', placeholder_text: 'placeholder',
    unit: 'unit',
    min: 'min', minimum: 'min', min_value: 'min',
    max: 'max', maximum: 'max', max_value: 'max',
    format: 'format', input_format: 'format',
    true_label: 'true_label', yes_label: 'true_label',
    false_label: 'false_label', no_label: 'false_label',
    allow_other: 'allow_other', other: 'allow_other', allow_other_: 'allow_other',
    maps_to: 'maps_to', field: 'maps_to', maps: 'maps_to', member_field: 'maps_to'
  };

  // A human might write "multiple choice" or "mcq"; the schema only knows its
  // own type codes, so translate the words a spreadsheet is likely to use.
  const TYPE_ALIASES = {
    text: 'text', short_text: 'text', long_text: 'text', paragraph: 'text', open_text: 'text', 'free_text': 'text',
    choice: 'choice', single: 'choice', single_choice: 'choice', radio: 'choice', 'yes_no_choice': 'choice',
    multi_choice: 'multi_choice', multi: 'multi_choice', multiple: 'multi_choice', multiple_choice: 'multi_choice',
    multiselect: 'multi_choice', multi_select: 'multi_choice', checkboxes: 'multi_choice', checkbox: 'multi_choice', mcq: 'multi_choice',
    dropdown: 'dropdown', select: 'dropdown', menu: 'dropdown',
    rating: 'rating', scale: 'rating', likert: 'rating', stars: 'rating',
    nps: 'nps', net_promoter: 'nps',
    matrix: 'matrix', grid: 'matrix', rating_grid: 'matrix',
    ranking: 'ranking', rank: 'ranking', order: 'ranking',
    number: 'number', numeric: 'number', integer: 'number', amount: 'number',
    date: 'date', calendar: 'date',
    boolean: 'boolean', yes_no: 'boolean', yesno: 'boolean', yn: 'boolean',
    section: 'section', heading: 'section', note: 'section', intro: 'section'
  };

  function normalizeTypeName(raw) {
    const key = String(raw || '').trim().toLowerCase().replace(/[\s/\-]+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!key) return null;
    if (TYPE_ALIASES[key]) return TYPE_ALIASES[key];
    return SurveySchema.TYPES.some(t => t.type === key) ? key : null;
  }

  // Options and grid rows are lists inside one cell. A newline, a pipe, or a
  // semicolon separates them — commas are kept for option wording like
  // "Yes, definitely" by using them only as a last resort inside quotes.
  function splitList(value) {
    if (value == null) return [];
    let parts;
    if (String(value).includes('\n')) parts = String(value).split(/\r?\n/);
    else if (String(value).includes('|')) parts = String(value).split('|');
    else if (String(value).includes(';')) parts = String(value).split(';');
    else parts = String(value).split(',');
    return parts.map(p => p.trim()).filter(Boolean);
  }

  const YES = /^(yes|y|true|1|required|mandatory|✓|✔)$/i;
  const asBool = v => YES.test(String(v || '').trim());

  // Turn one sheet row into a raw question draft shaped for the schema.
  function rowToDraft(row) {
    const draft = {};
    for (const [rawKey, value] of Object.entries(row)) {
      const key = HEADER_ALIASES[rawKey] || rawKey;
      if (value === '' || value == null) continue;
      switch (key) {
        case 'text': draft.text = value; break;
        case 'type': draft.type = value; break;
        case 'description': draft.description = value; break;
        case 'required': draft.required = asBool(value); break;
        case 'options': draft.options = splitList(value); break;
        case 'rows': draft.rows = splitList(value); break;
        case 'columns': draft.columns = splitList(value); break;
        case 'label_low': draft.label_low = value; break;
        case 'label_high': draft.label_high = value; break;
        case 'scale': draft.scale = value; break;
        case 'placeholder': draft.placeholder = value; break;
        case 'unit': draft.unit = value; break;
        case 'min': draft.min = value; break;
        case 'max': draft.max = value; break;
        case 'format': draft.format = value; break;
        case 'true_label': draft.true_label = value; break;
        case 'false_label': draft.false_label = value; break;
        case 'allow_other': draft.allow_other = asBool(value); break;
        case 'maps_to': draft.maps_to = value; break;   // onboarding: which profile field
        default: break;   // unknown columns are ignored rather than rejected
      }
    }

    // Rating/grid columns: a "scale" of 5 with no labels is a plain number
    // scale; if columns were given they are the grid scale.
    if (Array.isArray(draft.columns) && draft.columns.length) {
      draft.type = draft.type === 'rating' ? 'matrix' : (draft.type || 'matrix');
    }

    return draft;
  }

  // Validate a whole sheet through the schema. Returns questions ready to
  // add (ids assigned by the caller) plus per-row issues, without throwing —
  // the drawer lists the problems so they can be fixed in the sheet.
  function build(rows) {
    const valid = [];
    const issues = [];
    const seenText = new Map();

    rows.forEach((row, index) => {
      const number = index + 1;

      // A row with nothing at all is just a trailing blank line; skip silently.
      if (!row || !Object.values(row).some(v => String(v || '').trim() !== '')) return;

      // Resolve the columns we read directly here through the same aliasing
      // rowToDraft uses, so a sheet headed "Question"/"Prompt" still lines up.
      const get = key => {
        for (const [rawKey, mapped] of Object.entries(HEADER_ALIASES)) {
          if (mapped === key && row[rawKey] != null && row[rawKey] !== '') return row[rawKey];
        }
        return row[key];
      };

      const hasOptions = get('options') != null && String(get('options')).trim() !== '';
      const type = normalizeTypeName(get('type') || (hasOptions ? 'choice' : 'text'));
      const wording = String(get('text') || '').trim();

      if (!wording) {
        issues.push({ number, message: 'Every question needs its wording (the “Question” column).' });
        return;
      }
      if (type === null) {
        issues.push({ number, message: `“${row.type || '?'}” is not a question type.` });
        return;
      }

      // The same wording twice in one import is almost always a paste error.
      const fold = wording.toLowerCase();
      if (seenText.has(fold)) {
        issues.push({ number, message: `Duplicate of row ${seenText.get(fold)} — “${wording.slice(0, 40)}”.` });
        return;
      }

      const draft = rowToDraft(row);
      draft.type = type;
      draft.text = wording;

      // The schema numbers issues from an array index; give it one.
      const { question, issues: qIssues } = SurveySchema.normalizeQuestion(draft, 0, []);
      if (qIssues && qIssues.length) {
        for (const issue of qIssues) {
          issues.push({ number, field: issue.field, message: issue.message });
        }
        return;
      }

      seenText.set(fold, number);
      valid.push(question);
    });

    return { valid, issues };
  }

  // ─── Template ───────────────────────────────────────────
  // A headings row plus one example of each common type, so a first-time
  // author can see how a scale or a grid is written without a second doc.
  function templateCSV() {
    const header = ['question', 'type', 'required', 'options', 'rows', 'columns', 'label_low', 'label_high', 'scale', 'description'];
    const examples = [
      ['How would you rate your experience with the API today?', 'rating', 'yes', '', '', '', 'Very poor', 'Excellent', '5', 'A scale with labelled ends'],
      ['Which products have you integrated?', 'multi_choice', 'yes', 'Loans | Savings | Transfers | Cards', '', '', '', '', '', 'Separate options with | or new lines'],
      ['What is your favourite deployment channel?', 'choice', 'no', 'Play Store | App Store | Web | Partner', '', '', '', '', '', 'Pick one'],
      ['Reliability', 'matrix', 'no', '', 'Weekly uptime | Support speed', 'Poor | Fine | Great', '', '', '', 'A grid: rows down, columns across'],
      ['How many transactions do you process a month?', 'number', 'no', '', '', '', '', '', '', 'min and max are set in the builder'],
      ['What one thing should we improve?', 'text', 'no', '', '', '', '', '', '', 'Any sentence in their own words'],
      ['Contact details', 'section', '', '', '', '', '', '', '', 'A heading — nothing to answer']
    ];
    const esc = v => {
      const s = String(v ?? '');
      return /[",\n|]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    for (const ex of examples) lines.push(ex.map(esc).join(','));
    // BOM so Excel reads the UTF-8 headings correctly; \r\n for Windows.
    return '﻿' + lines.join('\r\n');
  }

  function downloadTemplate() {
    const blob = new Blob([templateCSV()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'question-import-template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ─── Drawer UI ──────────────────────────────────────────
  // Self-contained: the module injects its own drawer the first time it is
  // asked, so a builder page only has to add a button that calls
  // QuestionImport.open({ builder }). No per-page markup to keep in step.

  let mount = null;
  let last = null;      // { valid, issues, rows }
  let ctx = null;       // { builder, noun }

  function shell() {
    if (!mount) {
      const div = document.createElement('div');
      div.innerHTML = `
<aside class="drawer drawer-lg" id="qiDrawer">
  <div class="drawer-head">
    <div>
      <div class="drawer-title">Import questions in bulk
        <span class="tip" data-tip="Import brings in wording, type, whether it is required, options and grid/scale columns. Branching (“show this if…”) and per-field mapping are set in the builder afterwards — a sheet cannot describe those clearly.">?</span>
      </div>
      <div class="drawer-sub">Paste or upload a CSV — one question per row. Valid rows are added; rows with a problem are listed, not added.</div>
    </div>
    <button class="icon-btn" onclick="QuestionImport.close()">×</button>
  </div>
  <div class="drawer-body">
    <div class="field">
      <label class="label">Start from the template</label>
      <div class="field-row">
        <button class="btn btn-sm btn-secondary" onclick="QuestionImport.downloadTemplate()">Download template (CSV)
          <span class="tip" data-tip="Shows the columns and an example of each question type.">?</span></button>
      </div>
    </div>

    <div class="field mt-6">
      <label class="label" for="qiFile">Upload a CSV file</label>
      <input type="file" class="input" id="qiFile" accept=".csv,text/csv">
    </div>

    <div class="field mt-6">
      <label class="label" for="qiData">…or paste the rows
        <span class="tip" data-tip="Nothing is added until you confirm.">?</span></label>
      <textarea class="input mono text-xs" id="qiData" style="min-height:160px"
        placeholder="question,type,required,options,description&#10;How was onboarding?,rating,yes,,,Rate 1-5&#10;Which channel?,choice,no,Email | WhatsApp | SMS"></textarea>
    </div>

    <div class="field-row">
      <button class="btn btn-sm btn-secondary" onclick="QuestionImport.parse()">Check rows</button>
    </div>

    <div id="qiResult" class="mt-6"></div>
  </div>
  <div class="drawer-foot">
    <button class="btn btn-secondary" onclick="QuestionImport.close()">Cancel</button>
    <span style="flex:1"></span>
    <button class="btn btn-primary" id="qiAdd" onclick="QuestionImport.add()" disabled>Add questions</button>
  </div>
</aside>`;
      document.body.appendChild(div.firstElementChild);
      mount = document.getElementById('qiDrawer');

      document.getElementById('qiFile').addEventListener('change', async e => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          document.getElementById('qiData').value = text;
          parse();
        } catch (err) {
          renderResult(null, [], `Could not read that file: ${err.message}`);
        }
      });
    }
    return mount;
  }

  function parse() {
    const text = document.getElementById('qiData').value;
    const rows = parseCSVText(text);
    if (!rows.length) {
      last = null;
      document.getElementById('qiAdd').disabled = true;
      renderResult(0, [], null, true);
      return;
    }
    const { valid, issues } = build(rows);
    last = { valid, issues, rows };
    document.getElementById('qiAdd').disabled = valid.length === 0;
    renderResult(valid.length, issues, null);
  }

  function renderResult(validCount, issues, fatalError, empty = false) {
    const out = document.getElementById('qiResult');
    if (fatalError) {
      out.innerHTML = `<div class="hint" style="color:var(--danger,#dc2626)">${escapeHtml(fatalError)}</div>`;
      return;
    }
    if (empty) {
      out.innerHTML = '<p class="hint">Add some rows (or a header line plus rows) and check again.</p>';
      return;
    }
    const added = validCount;
    const parts = [];
    if (added) {
      parts.push(`<div class="hint" style="color:var(--success,#16a34a)">
        ${added} question${added === 1 ? '' : 's'} ready to add.</div>`);
    }
    if (issues.length) {
      parts.push(`<div class="hint mt-2" style="color:var(--danger,#dc2626)">
        ${issues.length} row${issues.length === 1 ? '' : 's'} with a problem — these are skipped:</div>
        <ul class="text-xs mt-2" style="margin:0;padding-left:18px">
          ${issues.slice(0, 25).map(i =>
            `<li>Row ${i.number}${i.field ? ` (${escapeHtml(i.field)})` : ''}: ${escapeHtml(i.message)}</li>`).join('')}
          ${issues.length > 25 ? `<li>…and ${issues.length - 25} more</li>` : ''}
        </ul>`);
    }
    if (last && last.valid.length) {
      parts.push(`<div class="mt-4">
        ${last.valid.map(q => `<div class="text-xs" style="padding:2px 0">
          <span class="badge badge-info">${escapeHtml(q.type)}</span>
          ${escapeHtml(q.text)}
          ${q.options?.length ? `<span class="muted">— ${escapeHtml(q.options.join(' · '))}</span>` : ''}
        </div>`).join('')}
      </div>`);
    }
    out.innerHTML = parts.join('');
  }

  function add() {
    if (!last || !last.valid.length || !ctx) return;
    const ready = last.valid.map(q => {
      // The builder assigns ids; strip the schema's null placeholder and let
      // the editor own identity, the same way a question added by hand gets one.
      const { id, ...rest } = q;
      return { ...rest, id: ctx.builder.newId() };
    });
    ctx.builder.importQuestions(ready);
    showToast(`${ready.length} question${ready.length === 1 ? '' : 's'} imported`);
    close();
    // A per-page finish hook.
    const finish = ctx.afterAdd;
    if (typeof finish === 'function') finish(ready);
  }

  function open(options) {
    ctx = options || null;
    shell();
    last = null;
    document.getElementById('qiData').value = '';
    document.getElementById('qiFile').value = '';
    document.getElementById('qiResult').innerHTML = '';
    document.getElementById('qiAdd').disabled = true;
    Shell.openDrawer('qiDrawer');
  }

  function close() {
    Shell.closeDrawer('qiDrawer');
  }

  return { parseCSVText, build, templateCSV, downloadTemplate, normalizeTypeName, open, close };
})();

if (typeof window !== 'undefined') window.QuestionImport = QuestionImport;
