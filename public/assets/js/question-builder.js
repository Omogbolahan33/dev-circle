// ─── The question editor ────────────────────────────────────
// The list of questions in a builder: adding one, writing it, giving it its
// options and its limits, branching it on an earlier answer, moving it,
// removing it, and previewing the whole thing as it will be answered.
//
// It is a module rather than part of a page because there is now more than one
// kind of form built out of these questions — a survey and an onboarding form —
// and the alternative is two copies of the branching editor. The header of
// survey-schema.js makes the argument for why that is unacceptable for the
// definition; it holds just as strongly for the thing that writes it. Two
// editors drift within a release: one starts offering a condition the other
// cannot write, and a form authored in one becomes unopenable in the other.
//
// What differs between the two kinds of form is one thing, and it is the only
// extension point here: onboarding tags a question with the profile field its
// answer fills in. That arrives as `extraFields` and `bindExtra` rather than
// as a flag, so this module needs to know nothing about onboarding at all.
//
//   const builder = QuestionBuilder.create({
//     schema,                    // from GET .../schema
//     state,                     // { questions, issues, locked, openQuestion, theme, circleTheme }
//     el: { questions, typeMenu, preview, count },
//     title: () => 'What the preview calls it',
//     onChange: () => {},        // the definition changed
//     extraFields, bindExtra,    // optional, per kind of form
//     cardFlags                  // optional, a marker on the card's header
//   });
//
// `state` is the caller's object and is mutated in place: the page owns the
// questions, and this draws and edits them. That is deliberate — a builder
// that held its own copy would need the page to ask for it back before every
// save, and the save that forgot would silently post yesterday's questions.

const QuestionBuilder = (() => {

  function create(opts) {
    const { schema, state, el } = opts;

    // Ids are made in the shape the server uses, because a rule written before
    // saving has to point at something that still exists after.
    let made = 0;
    const newId = () => `q${++made}_${Math.random().toString(16).slice(2, 10)}`;

    // What the preview has been answered with. Held here rather than in the
    // page's state because it is not part of the form — it is how the author
    // walks their own branches.
    let previewAnswers = {};

    // Which option description is open for editing. The list redraws as a
    // whole the moment anything in it changes, so the open row has to outlive
    // the redraw — keyed by the question and the option's place in its list.
    const descExpanded = new Set();
    const descKey = (questionId, list, i) => `${questionId}|${list}|${i}`;

    // Which cards have their "More options" fold open. The same redraw
    // problem: the choice is the author's, so it is kept across the redraws
    // their typing causes — keyed by the question's id, so a moved card
    // carries its fold with it.
    const moreExpanded = new Set();

    // Whatever the page calls the thing being built, for the preview's heading.
    if (!opts.title) opts.title = () => '';

    // The definition changed. The preview is redrawn here so no call site can
    // forget it, and the page is told so it can mark itself unsaved.
    const changed = () => { preview(); if (opts.onChange) opts.onChange(); };

    // ─── The question list ────────────────────────────────────

    function renderTypeMenu() {
      el.typeMenu.innerHTML = schema.types.map(type => `
        <button class="type-option" data-type="${type.type}">
          <span class="type-option-name">${escapeHtml(type.label)}</span>
          <span class="type-option-hint">${escapeHtml(type.hint)}</span>
        </button>`).join('');

      el.typeMenu.querySelectorAll('.type-option').forEach(button => {
        button.addEventListener('click', () => {
          addQuestion(button.dataset.type);
          toggleTypeMenu(false);
        });
      });
    }

    function toggleTypeMenu(force) {
      const menu = el.typeMenu;
      menu.classList.toggle('hide', force === false ? true : force === true ? false : !menu.classList.contains('hide'));
    }

    // Sensible starting points, so a question is answerable the moment it is
    // added and the preview has something to show.
    function blank(type) {
      const question = { id: newId(), type, text: '', required: false };
      if (['choice', 'multi_choice'].includes(type)) {
        // Options a member reads as cards — a word, and the subtext under it
        question.options = [{ label: '', subtext: '' }, { label: '', subtext: '' }];
      } else if (['dropdown', 'ranking'].includes(type)) {
        question.options = ['', ''];
      }
      if (type === 'rating') { question.scale = 5; question.style = 'numbers'; }
      if (type === 'matrix') { question.rows = ['', '']; question.columns = ['Poor', 'Fine', 'Great']; }
      if (type === 'text') question.multiline = true;
      if (type === 'boolean') { question.true_label = 'Yes'; question.false_label = 'No'; }
      return question;
    }

    function addQuestion(type) {
      state.questions.push(blank(type));
      // A new question is the one you are working on, so it opens and the last
      // one closes
      state.openQuestion = state.questions.length - 1;
      render();
      changed();
      const cards = el.questions.querySelectorAll('.q-card');
      cards[cards.length - 1]?.querySelector('.q-text')?.focus();
    }

    // Add many questions at once from a bulk import. The caller has already
    // validated them through the schema (see question-import.js), so each
    // arrives with an id and no empty option rows; this only files them.
    function importQuestions(ready) {
      const start = state.questions.length;
      for (const q of ready) state.questions.push(q);
      if (state.questions.length) {
        state.openQuestion = start;   // open the first imported one
      }
      render();
      changed();
    }

    function render() {
      const holder = el.questions;
      holder.innerHTML = state.questions.map((q, i) => card(q, i)).join('');
      state.questions.forEach((q, i) => bindCard(holder.children[i], q, i));

      if (el.count) {
        el.count.textContent = state.questions.filter(q => SurveySchema.isAnswerable(q)).length;
      }
    }

    // One question is open at a time. Ten questions each showing their options,
    // their limits and their branching is six screens of scrolling to reach the
    // one being edited — so a closed card shows only what it asks and what kind
    // of question it is, and opens on a click.
    function card(question, index) {
      const type = schema.types.find(t => t.type === question.type) || { label: question.type };
      const issues = state.issues.filter(i => i.index === index);
      // A question with something wrong is opened regardless: an error nobody
      // can see is worse than a crowded page
      const open = state.openQuestion === index || issues.length > 0;

      const head = `
        <div class="q-head" data-open-toggle>
          <span class="q-num">Q${index + 1}</span>
          <span class="q-kind">${escapeHtml(type.label)}</span>
          ${question.required ? '<span class="q-flag">required</span>' : ''}
          ${question.visible_if ? '<span class="q-branching">conditional</span>' : ''}
          ${question.branch_to ? '<span class="q-branches">branches on its answer</span>' : ''}
          ${opts.cardFlags ? opts.cardFlags(question, index) : ''}
          <span class="spacer"></span>
          <button class="icon-btn" data-move="up" ${index === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="icon-btn" data-move="down" ${index === state.questions.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button class="icon-btn" data-duplicate aria-label="Duplicate">⧉</button>
          <button class="icon-btn" data-remove aria-label="Remove question">×</button>
        </div>`;

      if (!open) {
        return `
          <div class="q-card closed" data-index="${index}">
            ${head}
            <button class="q-summary" data-open-toggle>
              ${question.text
                ? escapeHtml(question.text)
                : '<span class="dim">Untitled — click to write it</span>'}
            </button>
          </div>`;
      }

      return `
        <div class="q-card open${issues.length ? ' invalid' : ''}" data-index="${index}">
          ${head}

          <div class="field">
            <label class="label">${question.type === 'section' ? 'Heading' : 'Question'}
              <span class="tip" data-tip="A word can be a link: [Terms &amp; Conditions](https://example.com/terms)">?</span></label>
            <input type="text" class="input q-text" value="${escapeHtml(question.text || '')}"
                   placeholder="${escapeHtml(placeholderFor(question.type))}">
          </div>

          ${SurveySchema.isAnswerable(question) ? `
            <label class="row-tight text-sm" style="cursor:pointer;gap:var(--sp-2);margin-bottom:var(--sp-4)">
              <span class="check${question.required ? ' on' : ''}" data-required>✓</span> An answer is required
            </label>` : ''}

          ${coreEditor(question)}
          ${moreOptions(question, index)}

          ${issues.length ? `<div class="issue-list">${issues
            .map(i => `<p class="issue">⚠ ${escapeHtml(i.message)}</p>`).join('')}</div>` : ''}
        </div>`;
    }

    function placeholderFor(type) {
      const examples = {
        rating: 'e.g. How clear is the documentation?',
        nps: 'e.g. How likely are you to recommend our APIs to another developer?',
        choice: 'e.g. Which environment do you use most?',
        multi_choice: 'e.g. Which of these have slowed you down?',
        dropdown: 'e.g. Which country do you operate in?',
        matrix: 'e.g. How would you rate each of these?',
        ranking: 'e.g. Put these in the order you would want them built',
        number: 'e.g. How many API calls do you make on a normal day?',
        date: 'e.g. When did you go live?',
        boolean: 'e.g. Have you reached production?',
        section: 'e.g. About your integration',
        text: 'e.g. Anything else we should know?'
      };
      return examples[type] || 'Your question';
    }

    // ─── Per-type settings ────────────────────────────────────
    // A type's editor is two things. The core is what the question is made of
    // — its options, its rows, its columns — and it stays out in the open
    // under the wording, because a choice question whose options are hidden is
    // not a question but a promise. The settings are what tune the question:
    // the form its answer may take, how long it may be, the order its options
    // come in. They do not sit as separate rows, one per setting, making the
    // card a form about a question instead of a question — they sit under one
    // fold, and the fold's label carries what has already been decided.

    function optionsList(question, list) {
      const isCards = question.type === 'choice' || question.type === 'multi_choice';
      const optionTip = isCards
        ? `The pen beside an option adds the line the member reads under it — a sentence, a link, or a picture.`
          + (question.type === 'multi_choice'
            ? ` Mark an option “only” when it cannot be true alongside the others — “None of these”.`
            : '')
        : '';
      return `
        <div class="field" style="margin-bottom:0">
          <label class="label">Options${optionTip ? `
            <span class="tip" data-tip="${escapeHtml(optionTip)}">?</span>` : ''}</label>
          <div class="options">
            ${(question[list] || []).map((option, i) => {
              const word = isCards
                ? (option && typeof option === 'object' ? option.label : option)
                : option;
              const subtext = isCards && option && typeof option === 'object'
                ? (option.subtext || '') : '';
              const descOpen = isCards && descExpanded.has(descKey(question.id, list, i));
              return `
              <div class="option-item" data-list="${list}" data-option="${i}">
                <div class="option-row">
                  <span class="handle">${i + 1}</span>
                  <div class="option-fields">
                    <input type="text" class="input option-word" value="${escapeHtml(word)}" placeholder="Option ${i + 1}">
                    ${isCards && subtext ? `
                    <button type="button" class="option-desc-preview" data-toggle-desc
                            title="The line the member reads under this option — click to edit">
                      ${escapeHtml(subtext)}</button>` : ''}
                  </div>
                  ${isCards ? `
                  <button type="button" class="icon-btn option-desc-toggle${subtext ? ' on' : ''}"
                          data-toggle-desc aria-label="Add or edit the line shown under this option"
                          title="A line under this option as the member reads it — words, a link, a picture">✎</button>` : ''}
                  ${question.type === 'multi_choice' && list === 'options' ? `
                  <button class="exclusive-flag${(question.exclusive_options || []).includes(word) ? ' on' : ''}"
                          data-exclusive="${i}" title="Cannot be picked with anything else">only</button>` : ''}
                  <button class="icon-btn" data-drop-option="${i}" aria-label="Remove option">×</button>
                </div>
                ${isCards ? `
                <div class="option-desc-wrap${descOpen ? ' open' : ''}">
                  <div class="option-desc-edit">
                    <input type="text" class="input option-subtext" maxlength="300" value="${escapeHtml(subtext)}"
                           placeholder="Shown under the option — text, [link](https://…), or a picture with ＋ picture">
                    <button type="button" class="btn btn-sm btn-ghost option-attach" data-attach-subtext
                            title="Upload a picture from your device — it is served from here, and its words come from the file name">＋ picture</button>
                  </div>
                </div>` : ''}
              </div>`;
            }).join('')}
          </div>
          <button class="btn btn-sm btn-ghost mt-2" data-add-option="${list}">+ Add option</button>
        </div>`;
    }

    // What the question is made of: out in the open, under the wording.
    function coreEditor(question) {
      switch (question.type) {
        case 'choice':
        case 'dropdown':
        case 'multi_choice':
        case 'ranking':
          return optionsList(question, 'options');
        case 'matrix':
          return `
            <div class="field-row">
              <div>${optionsList(question, 'rows').replace('>Options<', '>Rows<')}</div>
              <div>${optionsList(question, 'columns').replace('>Options<', '>Columns<')}</div>
            </div>`;
        default:
          return '';
      }
    }

    // What tunes the question: the answer's form and bounds, the options'
    // order, the scale's ends. One per type, all of it under the fold.
    function settingsEditor(question) {
      switch (question.type) {
        case 'text':
          return `
            <div class="field-row">
              <div class="field">
                <label class="label">Answer format</label>
                <select class="input" data-set="format">
                  ${schema.text_formats.map(f => `
                    <option value="${f.value}"${(question.format || 'none') === f.value ? ' selected' : ''}>
                      ${escapeHtml(f.label)}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label class="label">Longest answer</label>
                <input type="number" class="input" data-set="max_length" min="1" max="10000"
                       value="${question.max_length || 2000}">
              </div>
            </div>
            <label class="row-tight text-sm" style="margin-bottom:0;cursor:pointer">
              <span class="check${question.multiline !== false ? ' on' : ''}" data-set-check="multiline">✓</span>
              Room for a paragraph
            </label>`;

        case 'choice':
        case 'dropdown':
          return `
            <div class="row wrap" style="gap:var(--sp-4)">
              <label class="row-tight text-sm" style="cursor:pointer">
                <span class="check${question.allow_other ? ' on' : ''}" data-set-check="allow_other">✓</span>
                Offer "something else"
              </label>
              <label class="row-tight text-sm" style="cursor:pointer">
                <span class="check${question.randomize ? ' on' : ''}" data-set-check="randomize">✓</span>
                Shuffle the order
              </label>
            </div>`;

        case 'multi_choice':
          return `
            <div class="field-row">
              <div class="field" style="margin-bottom:0">
                <label class="label">Pick at least</label>
                <input type="number" class="input" data-set="min_select" min="0" max="20"
                       value="${question.min_select || ''}" placeholder="Any">
              </div>
              <div class="field" style="margin-bottom:0">
                <label class="label">Pick at most</label>
                <input type="number" class="input" data-set="max_select" min="1" max="20"
                       value="${question.max_select || ''}" placeholder="No limit">
              </div>
            </div>
            <div class="row wrap" style="gap:var(--sp-4);margin-top:var(--sp-2)">
              <label class="row-tight text-sm" style="cursor:pointer">
                <span class="check${question.allow_other ? ' on' : ''}" data-set-check="allow_other">✓</span>
                Offer "something else"
              </label>
              <label class="row-tight text-sm" style="cursor:pointer">
                <span class="check${question.randomize ? ' on' : ''}" data-set-check="randomize">✓</span>
                Shuffle the order
              </label>
            </div>`;

        case 'rating':
          return `
            <div class="field-row">
              <div class="field">
                <label class="label">Scale</label>
                <select class="input" data-set="scale">
                  ${[3, 4, 5, 7, 10].map(n => `
                    <option value="${n}"${(question.scale || 5) === n ? ' selected' : ''}>1–${n}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label class="label">Shown as</label>
                <select class="input" data-set="style">
                  ${schema.rating_styles.map(s => `
                    <option value="${s}"${(question.style || 'numbers') === s ? ' selected' : ''}>${s}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="field-row" style="margin-bottom:0">
              <div class="field" style="margin-bottom:0">
                <label class="label">Low end means</label>
                <input type="text" class="input" data-set="label_low" placeholder="Unclear"
                       value="${escapeHtml(question.label_low || (question.labels || [])[0] || '')}">
              </div>
              <div class="field" style="margin-bottom:0">
                <label class="label">High end means</label>
                <input type="text" class="input" data-set="label_high" placeholder="Very clear"
                       value="${escapeHtml(question.label_high || (question.labels || []).slice(-1)[0] || '')}">
              </div>
            </div>`;

        case 'nps':
          return `
            <div class="field-row" style="margin-bottom:0">
              <div class="field" style="margin-bottom:0">
                <label class="label">0 means
                  <span class="tip" data-tip="Fixed at 0–10 and scored as promoters minus detractors, which is the only thing that makes it comparable with anyone else's NPS.">?</span></label>
                <input type="text" class="input" data-set="label_low" placeholder="Not at all likely"
                       value="${escapeHtml(question.label_low || '')}">
              </div>
              <div class="field" style="margin-bottom:0">
                <label class="label">10 means</label>
                <input type="text" class="input" data-set="label_high" placeholder="Extremely likely"
                       value="${escapeHtml(question.label_high || '')}">
              </div>
            </div>`;

        case 'matrix':
          return `
            <label class="row-tight text-sm" style="margin-bottom:0;cursor:pointer">
              <span class="check${question.multi ? ' on' : ''}" data-set-check="multi">✓</span>
              Allow more than one per row
            </label>`;

        case 'number':
          return `
            <div class="field-row">
              <div class="field">
                <label class="label">Smallest</label>
                <input type="number" class="input" data-set="min" value="${question.min ?? ''}" placeholder="Any">
              </div>
              <div class="field">
                <label class="label">Largest</label>
                <input type="number" class="input" data-set="max" value="${question.max ?? ''}" placeholder="Any">
              </div>
              <div class="field">
                <label class="label">Unit</label>
                <input type="text" class="input" data-set="unit" value="${escapeHtml(question.unit || '')}" placeholder="calls/day">
              </div>
            </div>
            <label class="row-tight text-sm" style="margin-bottom:0;cursor:pointer">
              <span class="check${question.integer ? ' on' : ''}" data-set-check="integer">✓</span>
              Whole numbers only
            </label>`;

        case 'date':
          return `
            <div class="field-row" style="margin-bottom:0">
              <div class="field" style="margin-bottom:0">
                <label class="label">No earlier than</label>
                <input type="date" class="input" data-set="min" value="${escapeHtml(question.min || '')}">
              </div>
              <div class="field" style="margin-bottom:0">
                <label class="label">No later than</label>
                <input type="date" class="input" data-set="max" value="${escapeHtml(question.max || '')}">
              </div>
            </div>`;

        case 'boolean':
          return `
            <div class="field-row" style="margin-bottom:0">
              <div class="field" style="margin-bottom:0">
                <label class="label">Yes reads as</label>
                <input type="text" class="input" data-set="true_label" value="${escapeHtml(question.true_label || 'Yes')}">
              </div>
              <div class="field" style="margin-bottom:0">
                <label class="label">No reads as</label>
                <input type="text" class="input" data-set="false_label" value="${escapeHtml(question.false_label || 'No')}">
              </div>
            </div>`;

        case 'section':
          return `
            <div class="field" style="margin-bottom:0">
              <label class="label">Note</label>
              <textarea class="input" data-set="description"
                placeholder="What this part is about, or how far in they are.">${escapeHtml(question.description || '')}</textarea>
            </div>`;

        default:
          return '';
      }
    }

    // The fold everything else on a card sits under: the type's settings,
    // whatever this kind of form adds to a card (onboarding tags its
    // questions, and a tag is a setting of the question), and the question's
    // own show-sometimes and branch-on-answer controls. A card should read as
    // a question — its wording and what it is made of — and one fold named
    // after the rest. It is drawn only when there is something to put in it.
    function moreOptions(question, index) {
      const body = settingsEditor(question)
        + (opts.extraFields ? opts.extraFields(question, index) : '')
        + logicEditor(question, index)
        + (SurveySchema.isAnswerable(question) && opts.allowBranching
          ? branchEditor(question, index) : '');
      if (!body.trim()) return '';

      const summary = moreSummary(question);

      return `
        <div class="q-more${moreExpanded.has(question.id) ? ' open' : ''}">
          <button type="button" class="q-more-toggle" data-toggle-more>
            <span class="q-more-caret">▸</span>
            <span class="q-more-label">More options</span>
            ${summary ? `<span class="q-more-summary">${escapeHtml(summary)}</span>` : ''}
          </button>
          <div class="q-more-body">${body}</div>
        </div>`;
    }

    // What the fold says while it is closed: every setting that is not at its
    // default, in one quiet line. A closed fold must not be a black box — the
    // card should read as what the question is, and this is the rest of it.
    function moreSummary(question) {
      const parts = [];
      switch (question.type) {
        case 'text': {
          const format = (schema.text_formats || []).find(f => f.value === question.format);
          if (question.format && question.format !== 'none') parts.push(format ? format.label : question.format);
          if (question.max_length) parts.push(question.max_length + ' characters');
          if (question.multiline !== false) parts.push('paragraph');
          break;
        }
        case 'choice':
        case 'dropdown':
          if (question.allow_other) parts.push('an “other” option');
          if (question.randomize) parts.push('shuffled');
          break;
        case 'multi_choice':
          if (question.min_select) parts.push('pick at least ' + question.min_select);
          if (question.max_select) parts.push('pick at most ' + question.max_select);
          if (question.allow_other) parts.push('an “other” option');
          if (question.randomize) parts.push('shuffled');
          break;
        case 'rating':
          parts.push('1–' + (question.scale || 5) + ' ' + (question.style || 'numbers'));
          if (question.label_low) parts.push('low: ' + question.label_low);
          if (question.label_high) parts.push('high: ' + question.label_high);
          break;
        case 'nps':
          if (question.label_low) parts.push('0 = ' + question.label_low);
          if (question.label_high) parts.push('10 = ' + question.label_high);
          break;
        case 'matrix':
          if (question.multi) parts.push('more than one per row');
          break;
        case 'number':
          if (question.min != null && question.max != null) parts.push(question.min + '–' + question.max);
          else if (question.min != null) parts.push('from ' + question.min);
          else if (question.max != null) parts.push('to ' + question.max);
          if (question.unit) parts.push(question.unit);
          if (question.integer) parts.push('whole numbers');
          break;
        case 'date':
          if (question.min) parts.push('no earlier than ' + question.min);
          if (question.max) parts.push('no later than ' + question.max);
          break;
        case 'boolean':
          if ((question.true_label && question.true_label !== 'Yes')
            || (question.false_label && question.false_label !== 'No')) {
            parts.push((question.true_label || 'Yes') + ' / ' + (question.false_label || 'No'));
          }
          break;
        case 'section':
          if (question.description) parts.push('a note');
          break;
      }
      return parts.join(' · ');
    }

    // ─── Branching ────────────────────────────────────────────
    // Only earlier questions can be depended on. That is not a limitation of the
    // editor — a question whose visibility depends on an answer not yet given
    // has no defined state, so the survey would behave differently depending on
    // which way the member walked through it.

    function logicEditor(question, index) {
      const earlier = state.questions.slice(0, index)
        .filter(q => SurveySchema.CONDITIONABLE.has(q.type) && q.text);

      if (!earlier.length) {
        return index === 0 ? '' :
          '<p class="hint mt-4">Give an earlier question its wording to be able to branch on it.</p>';
      }

      if (!question.visible_if) {
        return `<div class="logic"><button class="btn btn-sm btn-ghost" data-add-logic>+ Branching</button></div>`;
      }

      const rules = question.visible_if.rules || [];

      return `
        <div class="logic">
          <div class="row" style="gap:var(--sp-2);margin-bottom:var(--sp-3)">
            <span class="logic-lead">Show this question when</span>
            <select class="input" data-logic-match style="width:auto">
              <option value="all"${question.visible_if.match !== 'any' ? ' selected' : ''}>all of these hold</option>
              <option value="any"${question.visible_if.match === 'any' ? ' selected' : ''}>any of these hold</option>
            </select>
            <span class="spacer"></span>
            <button class="icon-btn" data-drop-logic aria-label="Always show this question">×</button>
          </div>
          ${rules.map((rule, r) => ruleRow(rule, r, earlier)).join('')}
          <button class="btn btn-sm btn-ghost mt-2" data-add-rule>+ Add a condition</button>
        </div>`;
    }

    function ruleRow(rule, r, earlier) {
      const source = earlier.find(q => q.id === rule.question) || earlier[0];
      const allowed = SurveySchema.operatorsFor(source ? source.type : 'text');

      return `
        <div class="logic-rule" data-rule="${r}">
          <select class="input" data-rule-question>
            ${earlier.map(q => `
              <option value="${q.id}"${q.id === rule.question ? ' selected' : ''}>
                ${escapeHtml(q.text.slice(0, 48))}${q.text.length > 48 ? '…' : ''}</option>`).join('')}
          </select>
          <select class="input" data-rule-op style="max-width:150px">
            ${schema.operators.filter(o => allowed.includes(o.op)).map(o => `
              <option value="${o.op}"${o.op === rule.op ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
          </select>
          ${ruleValue(rule, source)}
          <button class="icon-btn" data-drop-rule="${r}" aria-label="Remove condition">×</button>
        </div>`;
    }

    // The value control follows the question being tested: options come from a
    // list, because a rule compared against text nobody can type correctly is a
    // branch that never fires and never says why.
    function ruleValue(rule, source) {
      const operator = schema.operators.find(o => o.op === rule.op);
      if (operator && operator.needsValue === false) return '<span class="spacer"></span>';
      if (!source) return '';

      if (source.options) {
        return `
          <select class="input" data-rule-value>
            ${(source.options || []).filter(o => SurveySchema.optionLabel(o)).map(o => {
              const word = SurveySchema.optionLabel(o);
              return `<option value="${escapeHtml(word)}"${word === rule.value ? ' selected' : ''}>${escapeHtml(word)}</option>`;
            }).join('')}
            ${source.allow_other ? `<option value="__other__"${rule.value === '__other__' ? ' selected' : ''}>Something else</option>` : ''}
          </select>`;
      }
      if (source.type === 'boolean') {
        return `
          <select class="input" data-rule-value>
            <option value="true"${rule.value === true ? ' selected' : ''}>${escapeHtml(source.true_label || 'Yes')}</option>
            <option value="false"${rule.value === false ? ' selected' : ''}>${escapeHtml(source.false_label || 'No')}</option>
          </select>`;
      }
      if (source.type === 'date') {
        return `<input type="date" class="input" data-rule-value value="${escapeHtml(rule.value || '')}">`;
      }
      if (['rating', 'nps', 'number'].includes(source.type)) {
        return `<input type="number" class="input" data-rule-value value="${escapeHtml(rule.value ?? '')}">`;
      }
      return `<input type="text" class="input" data-rule-value value="${escapeHtml(rule.value ?? '')}" placeholder="…">`;
    }

    // ─── What happens next ────────────────────────────────────
    // The "then" of a branch, configured where the "when" is: on the question
    // whose answer decides it. Each rule says what the survey does when the
    // answer to this question holds the condition — go to a later question,
    // or end the survey, in the words written for that ending. The rules are
    // read in order and the first that holds decides, so the editor draws
    // them as a list, not a combination.
    //
    // Only the kind of form that may branch offers it at all; a profile form
    // that ends early, or jumps past a credential field, is a half-built
    // member.
    function branchEditor(question, index) {
      if (!question.branch_to) {
        return `<div class="logic"><button class="btn btn-sm btn-ghost" data-add-branch>+ Branch on the answer to this question</button></div>`;
      }

      const later = state.questions.slice(index + 1);

      return `
        <div class="logic">
          <div class="row" style="gap:var(--sp-2);margin-bottom:var(--sp-3)">
            <span class="logic-lead">When the answer to this question holds, the survey
              <span class="tip" data-tip="Checked in the order written — the first rule that holds decides, and a rule that sends them on to the next question keeps the rules after it from deciding. When none holds, the survey simply moves on.">?</span></span>
            <span class="spacer"></span>
            <button class="icon-btn" data-drop-branch aria-label="The survey always moves on from here">×</button>
          </div>
          ${question.branch_to.rules.map((rule, r) => branchRuleRow(rule, r, question, later)).join('')}
          <button class="btn btn-sm btn-ghost mt-2" data-add-branch-rule>+ Add a rule</button>
        </div>`;
    }

    function branchRuleRow(rule, r, question, later) {
      const allowed = SurveySchema.operatorsFor(question.type);
      const operator = schema.operators.find(o => o.op === rule.op);

      return `
        <div class="logic-rule" data-branch-rule="${r}">
          <select class="input" data-branch-op style="max-width:150px">
            ${schema.operators.filter(o => allowed.includes(o.op)).map(o => `
              <option value="${o.op}"${o.op === rule.op ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
          </select>
          ${operator && operator.needsValue !== false ? branchValueInput(rule, question) : '<span class="spacer"></span>'}
          <select class="input" data-branch-action style="width:auto">
            <option value="next"${!rule.goto && !rule.end ? ' selected' : ''}>goes to the next question</option>
            <option value="goto"${rule.goto ? ' selected' : ''}>goes to a particular question</option>
            <option value="end"${rule.end && !rule.goto ? ' selected' : ''}>ends the survey</option>
          </select>
          ${rule.goto ? `
            <select class="input" data-branch-target style="width:auto">
              ${later.map(q => `
                <option value="${q.id}"${q.id === rule.goto ? ' selected' : ''}>
                  ${escapeHtml((q.text || 'Untitled').slice(0, 40))}${(q.text || '').length > 40 ? '…' : ''}</option>`).join('')}
            </select>` : ''}
          ${rule.end && !rule.goto ? `
            <input type="text" class="input" data-branch-message maxlength="200" style="flex:2"
                   placeholder="What to say when it ends, e.g. We can't continue without your agreement."
                   value="${escapeHtml(rule.message || '')}">` : ''}
          <button class="icon-btn" data-drop-branch-rule="${r}" aria-label="Remove rule">×</button>
        </div>`;
    }

    // The value control follows the question being tested, which is the one
    // being edited: options come from its own list, and a rule compared
    // against a value the member cannot produce is a branch that never fires.
    function branchValueInput(rule, question) {
      if ((question.options || []).length) {
        return `
          <select class="input" data-branch-value>
            ${(question.options || []).filter(o => SurveySchema.optionLabel(o)).map(o => {
              const word = SurveySchema.optionLabel(o);
              return `<option value="${escapeHtml(word)}"${word === rule.value ? ' selected' : ''}>${escapeHtml(word)}</option>`;
            }).join('')}
            ${question.allow_other ? `<option value="__other__"${rule.value === '__other__' ? ' selected' : ''}>Something else</option>` : ''}
          </select>`;
      }
      if (question.type === 'boolean') {
        return `
          <select class="input" data-branch-value>
            <option value="true"${rule.value === true ? ' selected' : ''}>${escapeHtml(question.true_label || 'Yes')}</option>
            <option value="false"${rule.value === false ? ' selected' : ''}>${escapeHtml(question.false_label || 'No')}</option>
          </select>`;
      }
      if (question.type === 'date') {
        return `<input type="date" class="input" data-branch-value value="${escapeHtml(rule.value || '')}">`;
      }
      if (['rating', 'nps', 'number'].includes(question.type)) {
        return `<input type="number" class="input" data-branch-value value="${escapeHtml(rule.value ?? '')}">`;
      }
      return `<input type="text" class="input" data-branch-value value="${escapeHtml(rule.value ?? '')}" placeholder="…">`;
    }

    // ─── Wiring one card ──────────────────────────────────────
    // Bound per card rather than re-rendering on every keystroke: a card that
    // redraws itself as you type takes the cursor with it.

    function bindCard(cardEl, question, index) {
      if (!cardEl) return;

      // Once anyone has answered, the questions are what they were asked. The
      // card is left legible rather than hidden — an author needs to read what
      // went out — but nothing in it can be moved, reworded or removed.
      if (state.locked) {
        cardEl.querySelectorAll('input, select, textarea, button').forEach(c => { c.disabled = true; });
        cardEl.querySelectorAll('.check, .exclusive-flag').forEach(c => {
          c.style.pointerEvents = 'none';
          c.style.opacity = '0.6';
        });
        cardEl.classList.add('locked');
        return;
      }

      const redraw = () => { render(); changed(); };
      const touch = () => changed();

      // Clicking the card opens it; clicking a control inside the header does
      // what that control says instead of collapsing the thing being used
      cardEl.querySelectorAll('[data-open-toggle]').forEach(target => {
        target.addEventListener('click', e => {
          if (e.target.closest('.icon-btn')) return;
          state.openQuestion = state.openQuestion === index ? null : index;
          render();
          if (state.openQuestion === index) {
            el.questions.querySelector(`.q-card[data-index="${index}"] .q-text`)?.focus();
          }
        });
      });

      cardEl.querySelector('.q-text')?.addEventListener('input', e => {
        question.text = e.target.value;
        // The closed cards show their wording, so the list stays truthful as it
        // is typed — without redrawing the card being typed into
        const summary = cardEl.querySelector('.q-summary');
        if (summary) summary.textContent = e.target.value;
        touch();
      });

      cardEl.querySelector('[data-required]')?.addEventListener('click', () => {
        question.required = !question.required;
        redraw();
      });

      cardEl.querySelectorAll('[data-move]').forEach(button => {
        button.addEventListener('click', () => move(index, button.dataset.move === 'up' ? -1 : 1));
      });
      cardEl.querySelector('[data-remove]')?.addEventListener('click', () => remove(index));
      cardEl.querySelector('[data-duplicate]')?.addEventListener('click', () => duplicate(index));

      // Plain settings: number inputs come back as numbers so the schema is not
      // asked to guess what "5" means.
      cardEl.querySelectorAll('[data-set]').forEach(input => {
        input.addEventListener('input', () => {
          const key = input.dataset.set;
          const value = input.type === 'number'
            ? (input.value === '' ? undefined : Number(input.value))
            : input.value;
          if (value === undefined || value === '') delete question[key];
          else question[key] = value;
          touch();
        });
        if (input.tagName === 'SELECT') {
          input.addEventListener('change', () => {
            // Scale and format change what the control looks like
            render(); changed();
          });
        }
      });

      cardEl.querySelectorAll('[data-set-check]').forEach(check => {
        check.addEventListener('click', () => {
          const key = check.dataset.setCheck;
          question[key] = !question[key];
          redraw();
        });
      });

      // The fold is the author's choice about what they are looking at, so it
      // survives the redraws their typing causes — but opening it changes the
      // definition nothing, so it redraws without marking the form dirty.
      cardEl.querySelector('[data-toggle-more]')?.addEventListener('click', () => {
        if (moreExpanded.has(question.id)) moreExpanded.delete(question.id);
        else moreExpanded.add(question.id);
        render();
      });

      // Options, rows and columns
      const isCards = question.type === 'choice' || question.type === 'multi_choice';
      cardEl.querySelectorAll('.option-item').forEach(item => {
        const list = item.dataset.list;
        const i = Number(item.dataset.option);
        const row = item.querySelector('.option-row');

        const wordOf = () => isCards
          ? (question[list][i] && typeof question[list][i] === 'object'
            ? question[list][i].label : question[list][i])
          : question[list][i];
        const asCard = () => {
          if (!question[list][i] || typeof question[list][i] !== 'object') {
            question[list][i] = { label: question[list][i] || '', subtext: '' };
          }
          return question[list][i];
        };

        // The line under an option is opened with the pen rather than sitting
        // there in every row: the member meets it only if it was written, and
        // the editor meets it only if it is opened.
        const key = descKey(question.id, list, i);
        const openDesc = () => {
          // One open editor at a time: opening a line closes the one already
          // open, the way the pen is a single thing in the author's hand
          for (const open of [...descExpanded]) if (open !== key) descExpanded.delete(open);
          descExpanded.add(key);
          redraw();
          const now = el.questions.querySelector(`.q-card[data-index="${index}"]`);
          now?.querySelector(`.option-item[data-list="${list}"][data-option="${i}"] .option-subtext`)?.focus();
        };
        const closeDesc = () => { descExpanded.delete(key); redraw(); };

        row.querySelectorAll('[data-toggle-desc]').forEach(toggle => {
          toggle.addEventListener('click', () => {
            if (descExpanded.has(key)) closeDesc(); else openDesc();
          });
        });

        row.querySelector('.option-word').addEventListener('input', e => {
          const before = wordOf();
          if (isCards) asCard().label = e.target.value;
          else question[list][i] = e.target.value;
          // An option marked exclusive keeps that mark when it is renamed
          if (question.exclusive_options) {
            question.exclusive_options = question.exclusive_options
              .map(o => (o === before ? e.target.value : o));
          }
          touch();
        });

        item.querySelector('.option-subtext')?.addEventListener('input', e => {
          asCard().subtext = e.target.value;
          touch();
        });
        item.querySelector('.option-subtext')?.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); closeDesc(); }
        });

        item.querySelector('[data-attach-subtext]')?.addEventListener('click', () => {
          const picker = document.createElement('input');
          picker.type = 'file';
          picker.accept = 'image/png,image/jpeg,image/gif,image/webp';
          picker.style.display = 'none';
          picker.addEventListener('change', () => {
            const file = picker.files && picker.files[0];
            if (picker.parentNode) picker.parentNode.removeChild(picker);
            if (!file) return;
            attachSubtextPicture(file, item.querySelector('.option-subtext'));
          });
          document.body.appendChild(picker);
          picker.click();
        });

        row.querySelector('[data-drop-option]')?.addEventListener('click', () => {
          descExpanded.delete(key);
          question[list].splice(i, 1);
          redraw();
        });

        row.querySelector('[data-exclusive]')?.addEventListener('click', () => {
          const option = wordOf();
          const held = question.exclusive_options || [];
          question.exclusive_options = held.includes(option)
            ? held.filter(o => o !== option)
            : held.concat(option);
          redraw();
        });
      });

      cardEl.querySelectorAll('[data-add-option]').forEach(button => {
        button.addEventListener('click', () => {
          const list = button.dataset.addOption;
          question[list] = (question[list] || []).concat(
            isCards ? { label: '', subtext: '' } : '');
          redraw();
        });
      });

      // Branching
      cardEl.querySelector('[data-add-logic]')?.addEventListener('click', () => {
        const earlier = state.questions.slice(0, index)
          .filter(q => SurveySchema.CONDITIONABLE.has(q.type) && q.text);
        const source = earlier[earlier.length - 1];
        question.visible_if = {
          match: 'all',
          rules: [{ question: source.id, op: SurveySchema.operatorsFor(source.type)[0], value: firstValue(source) }]
        };
        redraw();
      });

      cardEl.querySelector('[data-drop-logic]')?.addEventListener('click', () => {
        delete question.visible_if;
        redraw();
      });

      cardEl.querySelector('[data-logic-match]')?.addEventListener('change', e => {
        question.visible_if.match = e.target.value;
        touch();
      });

      cardEl.querySelector('[data-add-rule]')?.addEventListener('click', () => {
        const earlier = state.questions.slice(0, index)
          .filter(q => SurveySchema.CONDITIONABLE.has(q.type) && q.text);
        const source = earlier[earlier.length - 1];
        question.visible_if.rules.push({
          question: source.id, op: SurveySchema.operatorsFor(source.type)[0], value: firstValue(source)
        });
        redraw();
      });

      cardEl.querySelectorAll('[data-rule]').forEach(row => {
        const r = Number(row.dataset.rule);
        const rule = question.visible_if.rules[r];

        row.querySelector('[data-rule-question]')?.addEventListener('change', e => {
          const source = state.questions.find(q => q.id === e.target.value);
          rule.question = e.target.value;
          // The operator and the value belong to the question being tested, so
          // changing it starts them again rather than carrying over a
          // comparison that no longer applies.
          rule.op = SurveySchema.operatorsFor(source.type)[0];
          rule.value = firstValue(source);
          redraw();
        });

        row.querySelector('[data-rule-op]')?.addEventListener('change', e => {
          rule.op = e.target.value;
          redraw();
        });

        row.querySelector('[data-rule-value]')?.addEventListener('input', e => {
          const source = state.questions.find(q => q.id === rule.question);
          rule.value = source && source.type === 'boolean' ? e.target.value === 'true'
            : e.target.type === 'number' ? Number(e.target.value)
            : e.target.value;
          touch();
        });
        row.querySelector('[data-rule-value]')?.addEventListener('change', e => {
          const source = state.questions.find(q => q.id === rule.question);
          rule.value = source && source.type === 'boolean' ? e.target.value === 'true'
            : e.target.type === 'number' ? Number(e.target.value)
            : e.target.value;
          touch();
        });

        row.querySelector('[data-drop-rule]')?.addEventListener('click', () => {
          question.visible_if.rules.splice(r, 1);
          if (!question.visible_if.rules.length) delete question.visible_if;
          redraw();
        });
      });

      // What happens next
      cardEl.querySelector('[data-add-branch]')?.addEventListener('click', () => {
        question.branch_to = {
          rules: [{
            op: SurveySchema.operatorsFor(question.type)[0],
            value: firstValue(question),
            end: true
          }]
        };
        redraw();
      });

      cardEl.querySelector('[data-drop-branch]')?.addEventListener('click', () => {
        delete question.branch_to;
        redraw();
      });

      cardEl.querySelector('[data-add-branch-rule]')?.addEventListener('click', () => {
        question.branch_to.rules.push({
          op: SurveySchema.operatorsFor(question.type)[0],
          value: firstValue(question),
          end: true
        });
        redraw();
      });

      cardEl.querySelectorAll('[data-branch-rule]').forEach(row => {
        const r = Number(row.dataset.branchRule);
        const rule = question.branch_to.rules[r];
        const later = state.questions.slice(index + 1);

        row.querySelector('[data-branch-op]')?.addEventListener('change', e => {
          rule.op = e.target.value;
          // The value belongs to the comparison: a rule that stops needing
          // one stops carrying a stale one.
          rule.value = firstValue(question);
          redraw();
        });

        row.querySelector('[data-branch-action]')?.addEventListener('change', e => {
          delete rule.end;
          delete rule.goto;
          delete rule.message;
          if (e.target.value === 'end') {
            rule.end = true;
          } else if (e.target.value === 'goto') {
            // A jump needs a landing place; the nearest later question is the
            // least surprising one to offer.
            rule.goto = (later[0] || {}).id;
            if (!rule.goto) rule.end = true;   // nothing later to jump to
          }
          // "next" leaves the rule with no action: it says the survey goes on,
          // and the rules written after it do not decide.
          redraw();
        });

        row.querySelector('[data-branch-target]')?.addEventListener('change', e => {
          rule.goto = e.target.value;
          touch();
        });

        row.querySelector('[data-branch-message]')?.addEventListener('input', e => {
          rule.message = e.target.value;
          touch();
        });

        row.querySelector('[data-branch-value]')?.addEventListener('input', e => {
          rule.value = question.type === 'boolean' ? e.target.value === 'true'
            : e.target.type === 'number' ? Number(e.target.value)
            : e.target.value;
          touch();
        });
        row.querySelector('[data-branch-value]')?.addEventListener('change', e => {
          rule.value = question.type === 'boolean' ? e.target.value === 'true'
            : e.target.type === 'number' ? Number(e.target.value)
            : e.target.value;
          touch();
        });

        row.querySelector('[data-drop-branch-rule]')?.addEventListener('click', () => {
          question.branch_to.rules.splice(r, 1);
          if (!question.branch_to.rules.length) delete question.branch_to;
          redraw();
        });
      });

      // Whatever this kind of form adds to a card, wired with the same redraw
      // and touch the rest of it uses — so an extension cannot get the two
      // confused and leave the preview showing the previous state.
      if (opts.bindExtra) opts.bindExtra(cardEl, question, index, { redraw, touch });
    }

    // A picture under an option, straight from the author's device. It is
    // uploaded the same way a brand asset is — the bytes decide what it is,
    // it is served from here under the name they earned — and lands in the
    // line as the image it is, with the file name as the words for the
    // people who cannot see it.
    function attachSubtextPicture(file, input) {
      if (!input) return;

      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('That picture could not be read'));
        reader.readAsDataURL(file);
      })
        .then(base64 => api.post('/admin/uploads', { file: base64, kind: 'image', filename: file.name }))
        .then(({ asset }) => {
          const words = String(file.name || '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'A picture';
          const current = input.value.replace(/\s+$/, '');
          input.value = (current ? current + ' ' : '') + `![${words}](${asset.path})`;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          showToast('Picture added — it is served from here');
        })
        .catch(err => showToast(err.message || 'The picture could not be uploaded', 'error'));
    }

    function firstValue(source) {
      if (source.options) return (source.options.map(o => SurveySchema.optionLabel(o)).find(Boolean)) || '';
      if (source.type === 'boolean') return true;
      if (['rating', 'nps', 'number'].includes(source.type)) return 0;
      return '';
    }

    // ─── Structural changes ───────────────────────────────────
    // Moving or removing a question can strand a rule that pointed at it, so
    // every rule is checked against what is still in front of it afterwards.

    function move(index, by) {
      const to = index + by;
      if (to < 0 || to >= state.questions.length) return;
      const [question] = state.questions.splice(index, 1);
      state.questions.splice(to, 0, question);
      pruneLogic();
      render();
      changed();
    }

    async function remove(index) {
      const question = state.questions[index];
      // A question is depended on two ways: a later question shown only
      // because of it, or an earlier question whose branch jumps to it.
      const dependents = state.questions.filter(q =>
        (q.visible_if?.rules || []).some(rule => rule.question === question.id) ||
        (q.branch_to?.rules || []).some(rule => rule.goto === question.id));

      if (dependents.length) {
        const ok = await Shell.confirm({
          title: 'Remove this question?',
          text: `${dependents.length} later question${dependents.length === 1 ? '' : 's'} branch on it. ` +
                `Removing it makes ${dependents.length === 1 ? 'that one' : 'those'} unconditional.`,
          ok: 'Remove'
        });
        if (!ok) return;
      }

      state.questions.splice(index, 1);
      pruneLogic();
      render();
      changed();
    }

    function duplicate(index) {
      const copy = JSON.parse(JSON.stringify(state.questions[index]));
      copy.id = newId();
      // A copy sitting directly under the original would be shown by the same
      // condition, which is almost never what duplicating is for — but keeping
      // it is still closer to the author's intent than dropping it silently.
      state.questions.splice(index + 1, 0, copy);
      render();
      changed();
    }

    function pruneLogic() {
      state.questions.forEach((question, index) => {
        if (question.visible_if) {
          const before = new Set(state.questions.slice(0, index).map(q => q.id));
          question.visible_if.rules = question.visible_if.rules.filter(rule => before.has(rule.question));
          if (!question.visible_if.rules.length) delete question.visible_if;
        }
        // A jump whose landing place was removed, or moved ahead of the
        // question it jumps from, can no longer land — the rule goes with it
        // rather than sitting in the definition pointing at nothing.
        if (question.branch_to) {
          const after = new Set(state.questions.slice(index + 1).map(q => q.id));
          question.branch_to.rules = question.branch_to.rules.filter(rule => !rule.goto || after.has(rule.goto));
          if (!question.branch_to.rules.length) delete question.branch_to;
        }
      });
    }

    // ─── Preview ──────────────────────────────────────────────
    // Rendered from the same definition that gets posted, with the same controls
    // the member will use, under the theme it will go out in.

    function preview() {
      const frame = el.preview;

      // Run through the normalizer first, so the preview is what would be
      // stored rather than what has been typed. A half-finished colour or an
      // address that will be refused is shown as its absence, which is what the
      // member would get — and it keeps unvalidated text out of an inline style.
      const { theme: stored } = SurveyTheme.normalize({ ...state.circleTheme, ...state.theme });
      const theme = SurveyTheme.resolve(stored);

      frame.setAttribute('style', SurveyTheme.toCSSText(theme));
      frame.style.background = theme.background_color || 'var(--surface-0)';

      // A brand font has to be declared, not just referenced, or the preview
      // silently shows the fallback and the author thinks the upload failed
      let face = document.getElementById('brandFace');
      if (!face) {
        face = document.createElement('style');
        face.id = 'brandFace';
        document.head.appendChild(face);
      }
      face.textContent = SurveyTheme.fontFace(theme);

      if (theme.background !== 'plain' || theme.background_image) {
        frame.style.backgroundImage = 'var(--survey-canvas)';
        frame.style.backgroundSize = 'cover';
      }

      const questions = state.questions.filter(q => q.text);
      if (!questions.length) {
        frame.innerHTML = '<div class="dim text-sm">Write a question to see it here.</div>';
        return;
      }

      const shown = SurveySchema.visible(questions, previewAnswers);
      const hidden = questions.length - shown.length;

      // A paged layout shows the author where the member's pages break — cut
      // from what is actually asked, the same way the survey cuts them.
      const paged = theme.layout === 'n_per_page' || theme.layout === 'by_section';
      const pages = paged ? SurveyRender.pages(shown, { layout: theme.layout, size: theme.page_size }) : [shown];

      let running = 0;
      const numberFor = new Map();
      for (const q of shown) {
        if (SurveySchema.isAnswerable(q)) { running++; numberFor.set(q.id, running); }
      }

      const questionHtml = q => `
          <div class="pv-q">
            ${SurveySchema.isAnswerable(q)
              ? SurveyRender.heading(q, { number: numberFor.get(q.id) })
              : `<div class="sv-section-mark">Section</div><h2 class="sv-ask">${SurveySchema.linkify(q.text)}</h2>`}
            <div class="sv-control" data-preview="${escapeHtml(q.id)}"></div>
          </div>`;

      // The opening image sits on the opening screen, so a kind of form that
      // has no opening screen of its own shows no header image here either.
      const hasOpeningScreen = opts.screens !== false;
      frame.innerHTML = `
        ${hasOpeningScreen && theme.header_image ? `<img src="${escapeHtml(theme.header_image)}" alt=""
           style="width:100%;max-height:110px;object-fit:cover;border-radius:var(--r-md);margin-bottom:var(--sp-4);display:block">` : ''}
        ${theme.logo_url ? `<img src="${escapeHtml(theme.logo_url)}" alt="" style="max-height:28px;margin-bottom:var(--sp-4)">` : ''}
        <div class="sv-ask" style="font-size:var(--fs-md);margin-bottom:var(--sp-4)">
          ${escapeHtml(opts.title() || 'Untitled')}
        </div>
        ${pages.map((group, gi) => `
          ${gi > 0 ? `<div class="pv-page-break">Page ${gi + 1}</div>` : ''}
          ${group.map(questionHtml).join('')}`).join('')}
        ${hidden ? `<p class="hint mt-4">${hidden} question${hidden === 1 ? '' : 's'} hidden by the answers above.</p>` : ''}`;

      for (const question of shown) {
        const holder = frame.querySelector(`[data-preview="${CSS.escape(question.id)}"]`);
        if (!holder || !SurveySchema.isAnswerable(question)) continue;
        SurveyRender.mount(holder, question, {
          value: previewAnswers[question.id],
          seed: 'preview',
          onChange: value => { previewAnswers[question.id] = value; preview(); }
        });
      }
    }

    // ─── What the page drives it with ─────────────────────
    // Deliberately small. Everything else is the editor's own business, and a
    // page reaching further in is a page that will be broken by a change in
    // here.
    return {
      render,              // draw the question list
      preview,             // redraw the preview alone
      add: addQuestion,    // add a question of a type
      renderTypeMenu,      // draw the "add a question" menu
      toggleTypeMenu,
      newId,
      // The preview's own answers, so a page can clear them when the form it
      // is previewing changes underneath.
      resetPreview() { previewAnswers = {}; }
    };
  }

  return { create };
})();

// Loaded as a plain script in a builder page, and required by the test that
// checks a card still draws the controls its question type needs. The guard is
// the same one survey-schema.js carries, for the same reason: one definition,
// reachable from both sides.
if (typeof module !== 'undefined' && module.exports) module.exports = QuestionBuilder;
