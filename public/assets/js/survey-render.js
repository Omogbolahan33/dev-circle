// ─── Survey controls ────────────────────────────────────────
// Drawing a question, and reading back what was answered.
//
// Two screens need this: the page a member answers on, and the preview beside
// the builder. Writing it twice is how a preview starts lying — the author
// sets a maximum of two choices, the preview lets them pick four, and the
// survey goes out having been checked against something that was not it. So
// the preview is not a drawing of the control, it is the control.
//
// Answers are held as values, never scraped back out of the DOM: an option
// containing a quote, an apostrophe or a bracket is ordinary English and must
// not be able to change what an answer means.
//
//   SurveyRender.mount(el, question, { value, onChange, disabled })
//
// Everything about what an answer may be lives in survey-schema.js. This file
// only decides how it looks and how it is picked.

const SurveyRender = (() => {

  const esc = value => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const OTHER = '__other__';

  // A stable, order-independent shuffle per member per question. Randomising
  // on every render would move an option out from under the cursor between
  // one keystroke and the next.
  const shuffles = new Map();

  function ordered(question, seedKey) {
    const options = question.options || [];
    if (!question.randomize) return options;

    const key = `${seedKey || ''}:${question.id}`;
    if (!shuffles.has(key)) {
      const shuffled = options.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      shuffles.set(key, shuffled);
    }
    // Options can be edited while a preview is open, so anything no longer
    // offered drops out and anything new joins the end rather than the shuffle
    // being stale.
    const cached = shuffles.get(key).filter(o => options.includes(o));
    return cached.concat(options.filter(o => !cached.includes(o)));
  }

  // Which of the member's picks is the "Other" text: the one thing they wrote
  // that is not on the list.
  function otherValue(question, value) {
    if (!question.allow_other) return '';
    const offered = new Set((question.options || []).map(o => o.toLowerCase()));
    const values = Array.isArray(value) ? value : [value];
    const written = values.find(v => typeof v === 'string' && v.trim() && !offered.has(v.trim().toLowerCase()));
    return written || '';
  }

  const isPicked = (value, option) =>
    (Array.isArray(value) ? value : [value]).some(v =>
      String(v ?? '').trim().toLowerCase() === String(option).trim().toLowerCase());

  // ─── Controls ─────────────────────────────────────────────
  // Each returns the markup, then wires itself up in bind(). Split that way so
  // the whole question paints in one pass rather than element by element.

  function markup(question, value, opts) {
    const seed = opts.seed;

    switch (question.type) {
      case 'section':
        return '';

      case 'text': {
        const current = value == null ? '' : String(value);
        const max = question.max_length || 2000;
        const placeholder = esc(question.placeholder || 'Type your answer…');
        const inputType = question.format === 'email' ? 'email'
          : question.format === 'url' ? 'url'
          : question.format === 'phone' ? 'tel' : 'text';

        const field = question.multiline
          ? `<textarea class="input sv-input" maxlength="${max}" rows="5"
               style="min-height:140px" placeholder="${placeholder}">${esc(current)}</textarea>`
          : `<input type="${inputType}" class="input sv-input" maxlength="${max}"
               placeholder="${placeholder}" value="${esc(current)}">`;

        // A counter only earns its place near the limit, where it is
        // information. Shown always, it reads as a target.
        return `${field}
          <div class="sv-count${current.length > max * 0.7 ? '' : ' hide'}">
            <span class="sv-count-n">${current.length}</span> / ${max}
          </div>`;
      }

      case 'choice':
      case 'multi_choice': {
        const multi = question.type === 'multi_choice';
        const options = ordered(question, seed);
        const other = otherValue(question, value);

        const rows = options.map((option, i) => `
          <button type="button" class="sv-option${isPicked(value, option) ? ' picked' : ''}"
                  data-option="${i}" role="${multi ? 'checkbox' : 'radio'}"
                  aria-checked="${isPicked(value, option)}">
            <span class="sv-mark${multi ? ' box' : ''}"></span>
            <span>${esc(option)}</span>
          </button>`).join('');

        const otherRow = question.allow_other ? `
          <div class="sv-option sv-other${other ? ' picked' : ''}" data-other-row>
            <span class="sv-mark${multi ? ' box' : ''}"></span>
            <input type="text" class="sv-other-input" maxlength="200"
                   placeholder="${esc(question.other_label || 'Something else')}" value="${esc(other)}">
          </div>` : '';

        const limits = multi && (question.min_select || question.max_select)
          ? `<p class="hint">${esc(limitText(question))}</p>` : '';

        return `<div class="sv-options" role="${multi ? 'group' : 'radiogroup'}">${rows}${otherRow}</div>${limits}`;
      }

      case 'dropdown': {
        const options = ordered(question, seed);
        const other = otherValue(question, value);
        return `
          <select class="input sv-select">
            <option value="">Choose one…</option>
            ${options.map((o, i) => `
              <option value="${i}"${isPicked(value, o) ? ' selected' : ''}>${esc(o)}</option>`).join('')}
            ${question.allow_other
              ? `<option value="${OTHER}"${other ? ' selected' : ''}>${esc(question.other_label || 'Something else')}</option>`
              : ''}
          </select>
          ${question.allow_other
            ? `<input type="text" class="input sv-other-input mt-2${other ? '' : ' hide'}"
                 maxlength="200" placeholder="Tell us" value="${esc(other)}">`
            : ''}`;
      }

      case 'rating': {
        const scale = question.scale || 5;
        const labels = question.labels || [];
        const face = ['😞', '🙁', '😐', '🙂', '😀'];

        // The two ends live in one place — the row underneath — and the marks
        // carry only the points between them. Rendering both put "Poor" under
        // the first star and again below it.
        const hasEnds = labels.length > 0 && (labels[0] || labels[scale - 1]);

        const marks = Array.from({ length: scale }, (_, i) => {
          const n = i + 1;
          const picked = Number(value) === n;
          const glyph = question.style === 'stars' ? '★'
            : question.style === 'faces' ? face[Math.min(4, Math.floor((i / Math.max(1, scale - 1)) * 4.99))]
            : n;
          const middle = i > 0 && i < scale - 1 ? labels[i] : '';
          return `
            <button type="button" class="sv-rate${picked ? ' picked' : ''}${question.style === 'stars' ? ' star' : ''}"
                    data-value="${n}" role="radio" aria-checked="${picked}"
                    aria-label="${n} of ${scale}${labels[i] ? ' — ' + esc(labels[i]) : ''}">
              <span class="sv-rate-mark">${glyph}</span>
              ${middle ? `<span class="sv-rate-label">${esc(middle)}</span>` : ''}
            </button>`;
        }).join('');

        const ends = hasEnds
          ? `<div class="sv-ends"><span>${esc(labels[0] || '')}</span><span>${esc(labels[scale - 1] || '')}</span></div>`
          : '';

        return `<div class="sv-rating" role="radiogroup">${marks}</div>${ends}`;
      }

      case 'nps': {
        const marks = Array.from({ length: 11 }, (_, n) => `
          <button type="button" class="sv-nps${Number(value) === n && value !== '' && value !== null && value !== undefined ? ' picked' : ''}"
                  data-value="${n}" role="radio" aria-checked="${Number(value) === n}">${n}</button>`).join('');
        return `
          <div class="sv-nps-row" role="radiogroup">${marks}</div>
          <div class="sv-ends">
            <span>${esc(question.label_low || 'Not at all likely')}</span>
            <span>${esc(question.label_high || 'Extremely likely')}</span>
          </div>`;
      }

      case 'matrix': {
        const rows = question.rows || [];
        const columns = question.columns || [];
        const current = (value && typeof value === 'object') ? value : {};

        return `
          <div class="sv-matrix-scroll">
            <table class="sv-matrix">
              <thead>
                <tr><th></th>${columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
              </thead>
              <tbody>
                ${rows.map((row, r) => `
                  <tr>
                    <th scope="row">${esc(row)}</th>
                    ${columns.map((column, c) => {
                      const picked = isPicked(current[row], column);
                      return `
                        <td>
                          <button type="button" class="sv-mark${question.multi ? ' box' : ''}${picked ? ' on' : ''}"
                                  data-row="${r}" data-col="${c}"
                                  role="${question.multi ? 'checkbox' : 'radio'}" aria-checked="${picked}"
                                  aria-label="${esc(row)}: ${esc(column)}"></button>
                        </td>`;
                    }).join('')}
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`;
      }

      case 'ranking': {
        // Ordered by the member's answer so far, with anything unplaced kept
        // in the author's order at the end.
        const placed = Array.isArray(value) ? value.filter(v => (question.options || []).includes(v)) : [];
        const list = placed.concat((question.options || []).filter(o => !placed.includes(o)));

        return `
          <ol class="sv-rank">
            ${list.map((option, i) => `
              <li class="sv-rank-item" data-index="${i}">
                <span class="sv-rank-n">${i + 1}</span>
                <span class="sv-rank-text">${esc(option)}</span>
                <span class="sv-rank-moves">
                  <button type="button" class="icon-btn" data-move="up" ${i === 0 ? 'disabled' : ''}
                          aria-label="Move ${esc(option)} up">↑</button>
                  <button type="button" class="icon-btn" data-move="down" ${i === list.length - 1 ? 'disabled' : ''}
                          aria-label="Move ${esc(option)} down">↓</button>
                </span>
              </li>`).join('')}
          </ol>
          <p class="hint">Top is the highest priority.</p>`;
      }

      case 'number':
        return `
          <div class="sv-number">
            <input type="number" class="input sv-input" value="${esc(value ?? '')}"
                   ${question.min !== undefined ? `min="${question.min}"` : ''}
                   ${question.max !== undefined ? `max="${question.max}"` : ''}
                   step="${question.integer ? '1' : 'any'}" placeholder="0">
            ${question.unit ? `<span class="sv-unit">${esc(question.unit)}</span>` : ''}
          </div>
          ${question.min !== undefined || question.max !== undefined
            ? `<p class="hint">${esc(rangeText(question))}</p>` : ''}`;

      case 'date':
        return `<input type="date" class="input sv-input" value="${esc(value ?? '')}"
                  ${question.min ? `min="${esc(question.min)}"` : ''}
                  ${question.max ? `max="${esc(question.max)}"` : ''}>`;

      case 'boolean':
        return `
          <div class="sv-options sv-boolean" role="radiogroup">
            <button type="button" class="sv-option${value === true ? ' picked' : ''}" data-bool="yes" role="radio"
                    aria-checked="${value === true}">
              <span class="sv-mark"></span><span>${esc(question.true_label || 'Yes')}</span>
            </button>
            <button type="button" class="sv-option${value === false ? ' picked' : ''}" data-bool="no" role="radio"
                    aria-checked="${value === false}">
              <span class="sv-mark"></span><span>${esc(question.false_label || 'No')}</span>
            </button>
          </div>`;

      default:
        return `<p class="hint">This question type cannot be shown here.</p>`;
    }
  }

  function limitText(question) {
    const { min_select: min, max_select: max } = question;
    if (min && max) return min === max ? `Pick exactly ${min}` : `Pick between ${min} and ${max}`;
    if (min) return `Pick at least ${min}`;
    return `Pick up to ${max}`;
  }

  function rangeText(question) {
    if (question.min !== undefined && question.max !== undefined) {
      return `Between ${question.min} and ${question.max}`;
    }
    if (question.min !== undefined) return `${question.min} or more`;
    return `${question.max} or less`;
  }

  // ─── Wiring ───────────────────────────────────────────────

  function bind(el, question, value, opts) {
    const emit = next => opts.onChange && opts.onChange(next);
    const options = ordered(question, opts.seed);

    const $ = sel => el.querySelector(sel);
    const $$ = sel => Array.from(el.querySelectorAll(sel));

    switch (question.type) {
      case 'text': {
        const input = $('.sv-input');
        input.addEventListener('input', () => {
          const counter = $('.sv-count');
          if (counter) {
            counter.classList.toggle('hide', input.value.length <= (question.max_length || 2000) * 0.7);
            $('.sv-count-n').textContent = input.value.length;
          }
          emit(input.value);
        });
        break;
      }

      case 'choice':
      case 'multi_choice': {
        const multi = question.type === 'multi_choice';
        const otherInput = $('.sv-other-input');

        // Read the whole control rather than patching the previous answer:
        // ticking an exclusive option has to clear the rest, and that is far
        // easier to get right by looking at what is on screen.
        const collect = () => {
          const picked = $$('.sv-option[data-option]')
            .filter(b => b.classList.contains('picked'))
            .map(b => options[Number(b.dataset.option)]);
          const other = otherInput && $('[data-other-row]')?.classList.contains('picked')
            ? otherInput.value.trim() : '';
          if (other) picked.push(other);
          return multi ? picked : (picked[0] ?? '');
        };

        $$('.sv-option[data-option]').forEach(button => {
          button.addEventListener('click', () => {
            const option = options[Number(button.dataset.option)];
            const exclusive = (question.exclusive_options || [])
              .some(o => o.toLowerCase() === String(option).toLowerCase());

            if (!multi) {
              $$('.sv-option').forEach(b => { b.classList.remove('picked'); b.setAttribute('aria-checked', 'false'); });
              button.classList.add('picked');
              button.setAttribute('aria-checked', 'true');
            } else {
              const turningOn = !button.classList.contains('picked');
              // "None of the above" and a list of somethings cannot both be
              // true, so picking one puts the other down.
              if (turningOn && exclusive) {
                $$('.sv-option').forEach(b => { b.classList.remove('picked'); b.setAttribute('aria-checked', 'false'); });
              } else if (turningOn) {
                $$('.sv-option[data-option]').forEach(b => {
                  const value = options[Number(b.dataset.option)];
                  if ((question.exclusive_options || []).some(o => o.toLowerCase() === String(value).toLowerCase())) {
                    b.classList.remove('picked');
                    b.setAttribute('aria-checked', 'false');
                  }
                });
              }
              button.classList.toggle('picked', turningOn);
              button.setAttribute('aria-checked', String(turningOn));
            }
            emit(collect());
          });
        });

        if (otherInput) {
          const row = $('[data-other-row]');
          const activate = () => {
            if (!multi) {
              $$('.sv-option[data-option]').forEach(b => {
                b.classList.remove('picked'); b.setAttribute('aria-checked', 'false');
              });
            }
            row.classList.toggle('picked', otherInput.value.trim().length > 0);
            emit(collect());
          };
          otherInput.addEventListener('input', activate);
          otherInput.addEventListener('focus', activate);
        }
        break;
      }

      case 'dropdown': {
        const select = $('.sv-select');
        const other = $('.sv-other-input');
        const collect = () => {
          if (select.value === OTHER) return other ? other.value.trim() : '';
          return select.value === '' ? '' : options[Number(select.value)];
        };
        select.addEventListener('change', () => {
          if (other) other.classList.toggle('hide', select.value !== OTHER);
          if (select.value === OTHER && other) other.focus();
          emit(collect());
        });
        if (other) other.addEventListener('input', () => emit(collect()));
        break;
      }

      case 'rating':
      case 'nps': {
        const selector = question.type === 'nps' ? '.sv-nps' : '.sv-rate';
        $$(selector).forEach(button => {
          button.addEventListener('click', () => {
            const picked = Number(button.dataset.value);
            $$(selector).forEach(b => {
              const on = Number(b.dataset.value) === picked;
              b.classList.toggle('picked', on);
              b.setAttribute('aria-checked', String(on));
              // Stars fill up to the one chosen; numbers and faces mark one.
              if (question.style === 'stars') b.classList.toggle('lit', Number(b.dataset.value) <= picked);
            });
            emit(picked);
          });
        });
        break;
      }

      case 'matrix': {
        const rows = question.rows || [];
        const columns = question.columns || [];
        const answer = { ...(value && typeof value === 'object' ? value : {}) };

        $$('.sv-matrix .sv-mark').forEach(cell => {
          cell.addEventListener('click', () => {
            const row = rows[Number(cell.dataset.row)];
            const column = columns[Number(cell.dataset.col)];

            if (question.multi) {
              const held = Array.isArray(answer[row]) ? answer[row] : [];
              answer[row] = held.includes(column) ? held.filter(c => c !== column) : held.concat(column);
              if (!answer[row].length) delete answer[row];
            } else {
              // Picking the same cell again clears the row, so a member who
              // answered by accident is not stuck with it.
              if (answer[row] === column) delete answer[row];
              else answer[row] = column;
            }

            $$(`.sv-matrix .sv-mark[data-row="${cell.dataset.row}"]`).forEach(other => {
              const on = isPicked(answer[row], columns[Number(other.dataset.col)]);
              other.classList.toggle('on', on);
              other.setAttribute('aria-checked', String(on));
            });
            emit({ ...answer });
          });
        });
        break;
      }

      case 'ranking': {
        $$('.sv-rank-item').forEach(item => {
          item.querySelectorAll('[data-move]').forEach(button => {
            button.addEventListener('click', () => {
              const list = $$('.sv-rank-item').map(li => li.querySelector('.sv-rank-text').textContent);
              const from = Number(item.dataset.index);
              const to = button.dataset.move === 'up' ? from - 1 : from + 1;
              if (to < 0 || to >= list.length) return;
              [list[from], list[to]] = [list[to], list[from]];
              emit(list);
              // Re-drawn by the host, which owns the value
            });
          });
        });
        break;
      }

      case 'number': {
        const input = $('.sv-input');
        input.addEventListener('input', () => emit(input.value === '' ? '' : Number(input.value)));
        break;
      }

      case 'date': {
        const input = $('.sv-input');
        input.addEventListener('input', () => emit(input.value));
        break;
      }

      case 'boolean': {
        $$('.sv-option').forEach(button => {
          button.addEventListener('click', () => {
            const picked = button.dataset.bool === 'yes';
            $$('.sv-option').forEach(b => {
              const on = (b.dataset.bool === 'yes') === picked;
              b.classList.toggle('picked', on);
              b.setAttribute('aria-checked', String(on));
            });
            emit(picked);
          });
        });
        break;
      }
    }
  }

  // Draw a question into an element and keep it in step with its answer.
  // `onChange` receives the answer in the shape the schema expects, so a host
  // can hand it straight to validateAnswer without translating anything.
  function mount(el, question, { value, onChange, seed, disabled = false } = {}) {
    el.innerHTML = markup(question, value, { seed });
    if (!disabled) bind(el, question, value, { onChange, seed });
    else el.querySelectorAll('button, input, select, textarea').forEach(c => { c.disabled = true; });
    return el;
  }

  // The wording, its note, and whether it must be answered — the part above
  // the control, shared so a required marker never appears on one screen and
  // not the other.
  function heading(question, { number = null } = {}) {
    return `
      ${number ? `<div class="sv-number-kicker">Question ${number}</div>` : ''}
      <h2 class="sv-ask">${esc(question.text)}${
        question.required ? '<span class="sv-required" aria-label="required">*</span>' : ''
      }</h2>
      ${question.description ? `<p class="sv-note">${esc(question.description)}</p>` : ''}`;
  }

  return { mount, markup, bind, heading, esc, ordered, otherValue, OTHER };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SurveyRender;
