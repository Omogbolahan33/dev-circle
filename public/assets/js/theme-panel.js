// ─── The theme panel ────────────────────────────────────────
// Every control that decides how a form looks to the person filling it in:
// colours and the contrast between them, type, corners, imagery, layout, the
// shape of its progress, and the words on its opening and closing screens.
//
// Shared between the survey builder and the onboarding builder for the same
// reason the question editor is — see the top of question-builder.js. A
// workspace has one look, stored on the circle, and both kinds of form resolve
// against it. Two panels would mean a brand control that exists on one and not
// the other, and an author discovering it only when the wrong form is the one
// that needs it.
//
// What it never holds is the theme itself. `state.theme` belongs to the page,
// and is written in place — the page is what saves it, so the page is what
// owns it.
//
//   const panel = ThemePanel.create({
//     schema,                       // from GET .../schema
//     state,                        // { theme, circleTheme }
//     mount: document.getElementById('rail-theme'),
//     noun: 'form',                 // what the workspace default applies to
//     onChange: () => preview(),    // the look changed
//     onReset: () => {}             // optional, when it goes back to the default
//   });
//   panel.render();

const ThemePanel = (() => {

  function create(opts) {
    const { schema, state, mount } = opts;
    const noun = opts.noun || 'form';

    // The look changed. Redrawing the preview is the caller's business, because
    // what a preview looks like differs between a survey and an onboarding form
    // even though the controls above it do not.
    const changed = () => { if (opts.onChange) opts.onChange(); };

    // ─── Theme panel ──────────────────────────────────────────

    const PRESETS = ['#107EBC', '#E6B473', '#0D9488', '#8B7CF6', '#E11D48', '#16A34A', '#945A39', '#1A1A2E'];

    // A colour input cannot be empty, so an unset one shows where it would land
    // rather than a misleading black.
    function fallbackFor(key) {
      const theme = SurveyTheme.resolve(state.theme, state.circleTheme);
      if (theme[key]) return theme[key];
      const light = !theme.background_color || SurveyTheme.luminance(theme.background_color) >= 0.2;
      if (key === 'background_color') return light ? '#f5f2ed' : '#16162a';
      if (key === 'text_color') return light ? '#1a1a2e' : '#ffffff';
      if (key === 'surface_color') return light ? '#ffffff' : '#242438';
      if (key === 'muted_color') return light ? '#5a5a6e' : '#a0a0b8';
      return theme.accent || '#107ebc';
    }

    // ─── Uploading a brand asset ──────────────────────────────
    // Files are uploaded rather than linked. A survey only ever loads images and
    // fonts from this origin — which is what stops a member's browser being sent
    // to somebody else's server, and what stops an approved image being swapped
    // for something else after the fact.

    function assetRow(key, current, kind = 'image') {
      const accept = kind === 'font'
        ? '.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf'
        : 'image/png,image/jpeg,image/gif,image/webp';

      return `
        <div class="asset" data-asset="${key}" data-kind="${kind}">
          ${current && kind === 'image'
            ? `<img class="asset-thumb" src="${escapeHtml(current)}" alt="">`
            : `<span class="asset-thumb empty">${kind === 'font' ? 'Aa' : '+'}</span>`}
          <div class="asset-meta">
            ${current
              ? `<span class="asset-name mono">${escapeHtml(current.split('/').pop())}</span>`
              : `<span class="asset-name dim">Nothing uploaded</span>`}
            <div class="row" style="gap:var(--sp-2);margin-top:4px">
              <label class="btn btn-sm btn-secondary">
                ${current ? 'Replace' : 'Upload'}
                <input type="file" accept="${accept}" hidden data-upload="${key}" data-upload-kind="${kind}">
              </label>
              ${current ? `<button class="btn btn-sm btn-ghost" data-clear-asset="${key}">Remove</button>` : ''}
            </div>
          </div>
        </div>`;
    }

    // Which sections are open, remembered across the re-renders a colour drag
    // or a font pick causes. Colours starts open — it is where most theming
    // begins — and anything the form has customised opens on first paint.
    const openSections = new Set(['colours']);
    let firstRender = true;

    function render() {
      const theme = SurveyTheme.resolve(state.theme, state.circleTheme);
      const panel = mount;

      const asset = (key, label, hint = '') => `
        <div class="field">
          <label class="label">${escapeHtml(label)}</label>
          ${assetRow(key, theme[key])}
          ${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ''}
        </div>`;

      const choose = (key, values, labels) => `
        <select class="input" data-theme="${key}">
          ${values.map(v => `<option value="${v}"${theme[key] === v ? ' selected' : ''}>
            ${escapeHtml(labels ? labels[v] || v : v)}</option>`).join('')}
        </select>`;

      // A colour the author names outright. The text field takes a hex from a
      // brand guide, which is how these actually arrive.
      const colour = (key, label, { hint = '', clearable = false } = {}) => `
        <div class="field">
          <label class="label">${escapeHtml(label)}</label>
          <div class="row" style="gap:var(--sp-2)">
            <input type="color" class="input" data-theme="${key}"
                   value="${theme[key] || fallbackFor(key)}" style="width:46px;padding:2px;height:36px;flex:none">
            <input type="text" class="input" data-theme-hex="${key}" placeholder="${clearable ? 'Follows the theme' : ''}"
                   value="${escapeHtml(theme[key] || '')}" style="font-family:var(--font-mono)">
            ${clearable ? `<button class="icon-btn" data-clear-theme="${key}" title="Back to the default">×</button>` : ''}
          </div>
          ${hint ? `<p class="hint">${hint}</p>` : ''}
        </div>`;

      const chosenFont = schema.theme.fonts.find(f => f.value === theme.font) || {};

      // What is on screen right now, so a warning is about the combination the
      // member will see rather than about one colour in isolation
      const readable = SurveyTheme.legibility(theme);
      const ratio = theme.background_color && theme.text_color
        ? SurveyTheme.contrast(theme.text_color, theme.background_color) : null;

      // Which keys count as "this form has customised this section", so a
      // collapsed section can still show where the customisation lives.
      const has = (...keys) => keys.some(k => state.theme && state.theme[k] != null && state.theme[k] !== '');
      const hasCopy = group => state.theme && state.theme[group] &&
        Object.values(state.theme[group]).some(v => v && String(v).trim());
      const customised = {
        colours: has('accent', 'background_color', 'text_color', 'surface_color', 'muted_color', 'background'),
        type: has('font', 'brand_font', 'scale') || has('brand_font_name'),
        layout: has('mode', 'layout', 'page_size', 'progress', 'corner'),
        images: has('logo_url', 'header_image', 'background_image'),
        opening: hasCopy('intro'),
        closing: hasCopy('thank_you')
      };

      // A collapsing section. It starts open on the first render when the
      // caller asks or the form has already customised it, then its state is
      // remembered by id across the re-renders a colour drag causes.
      const section = (id, title, sub, body, { open = false, marked = false } = {}) => {
        if (firstRender && (open || marked)) openSections.add(id);
        const isOpen = openSections.has(id);
        return `
        <details class="theme-section" id="theme-${id}"${isOpen ? ' open' : ''} data-section="${id}">
          <summary${marked ? ' data-has-custom' : ''}>
            <span class="section-dot" aria-hidden="true"></span>
            <span>${escapeHtml(title)}</span>
            ${sub ? `<span class="section-sub">${escapeHtml(sub)}</span>` : ''}
            <span class="section-caret" aria-hidden="true">›</span>
          </summary>
          <div class="section-body">${body}</div>
        </details>`;
      };

      // ── Colours ──────────────────────────────────────────
      const coloursBody = `
        <div class="field">
          <label class="label">Accent</label>
          <div class="row" style="gap:var(--sp-3)">
            <input type="color" class="input" data-theme="accent" value="${theme.accent}" style="width:52px;padding:2px;height:36px">
            <input type="text" class="input" data-theme-hex="accent" value="${theme.accent}" style="font-family:var(--font-mono)">
          </div>
          <div class="swatches">
            ${PRESETS.map(hex => `
              <button class="swatch${theme.accent.toLowerCase() === hex.toLowerCase() ? ' on' : ''}"
                      style="background:${hex}" data-swatch="${hex}" aria-label="${hex}"></button>`).join('')}
          </div>
          <p class="hint">Buttons and progress take this. Text on it is worked out from its brightness, so a pale accent gets dark type rather than white on white.</p>
        </div>

        <p class="hint" style="margin-top:0;margin-bottom:var(--sp-3)">
          Leave the brand colours empty and the ${noun} follows the member's light or dark setting.
          Name a background and everything between it and the text — cards, borders,
          secondary labels — is worked out from the pair.
        </p>
        ${colour('background_color', 'Background', { clearable: true })}
        ${colour('text_color', 'Text', { clearable: true })}

        ${ratio ? `
          <div class="contrast ${readable.issues.length ? 'bad' : readable.warnings.length ? 'warn' : 'good'}">
            <strong>${ratio.toFixed(1)}:1</strong>
            ${readable.issues.length ? 'Not readable — this will be refused'
              : readable.warnings.length ? 'Readable, but tight for body text'
              : 'Comfortable to read'}
          </div>` : ''}
        ${readable.warnings.filter(w => w.field !== 'text_color').map(w =>
          `<p class="hint" style="color:var(--gold-ink)">${escapeHtml(w.message)}</p>`).join('')}

        <details class="theme-more">
          <summary>Finer control</summary>
          ${colour('surface_color', 'Cards and controls', { clearable: true, hint: 'Defaults to a shade off the background.' })}
          ${colour('muted_color', 'Secondary text', { clearable: true, hint: 'Hints, counts and labels.' })}
        </details>

        <div class="field-row">
          <div class="field">
            <label class="label">Wash</label>
            ${choose('background', schema.theme.backgrounds, { plain: 'None', tinted: 'Tinted', gradient: 'Gradient' })}
          </div>
        </div>`;

      // ── Type ─────────────────────────────────────────────
      // A font picker: real families, chosen by name, each set in itself.
      // Grouped, because fifteen names in a flat list is a wall.
      const typeBody = `
        <div class="field">
          <label class="label">Font</label>
          <select class="input font-select" id="fontSelect"
                  style="font-family:${(schema.theme.fonts.find(f => f.value === theme.font) || {}).stack || 'inherit'}">
            ${['sans', 'serif', 'mono', 'device', 'custom'].map(group => {
              const inGroup = schema.theme.fonts.filter(f => f.category === group);
              if (!inGroup.length) return '';
              const names = {
                sans: 'Sans serif', serif: 'Serif', mono: 'Monospace',
                device: 'From the reader’s device', custom: 'Your own'
              };
              return `<optgroup label="${names[group]}">
                ${inGroup.map(f => `
                  <option value="${f.value}"${theme.font === f.value ? ' selected' : ''}
                          style="font-family:${f.stack}">${escapeHtml(f.label)}</option>`).join('')}
              </optgroup>`;
            }).join('')}
          </select>
          <p class="font-preview" style="font-family:${
            (schema.theme.fonts.find(f => f.value === theme.font) || {}).stack || 'inherit'}">
            How clear is our API documentation?
          </p>
          ${chosenFont.note ? `<p class="hint">${escapeHtml(chosenFont.note)}</p>` : ''}
          ${chosenFont.device ? `
            <p class="hint" style="color:var(--gold-ink)">
              This one is not sent with the ${noun} — it renders only for readers who already have it.
              To be certain everyone sees it, upload the font file and it will be served from here.
            </p>` : ''}
        </div>

        ${theme.font === 'brand' || theme.brand_font ? `
          <div class="field">
            <label class="label">Font file</label>
            ${assetRow('brand_font', theme.brand_font, 'font')}
            <input type="text" class="input mt-2" data-theme="brand_font_name" placeholder="What to call it, e.g. Acme Grotesk"
                   value="${escapeHtml(theme.brand_font_name || '')}">
            <p class="hint">A .woff2 loads fastest. Whatever you upload is served from here, so nothing about the member reaches its foundry.</p>
          </div>` : ''}

        <div class="field-row">
          <div class="field">
            <label class="label">Text size</label>
            ${choose('scale', Object.keys(schema.theme.scales),
              { small: 'Small', regular: 'Regular', large: 'Large', larger: 'Larger' })}
          </div>
        </div>`;

      // ── Layout ───────────────────────────────────────────
      const layoutBody = `
        <div class="field-row">
          <div class="field">
            <label class="label">Corners</label>
            ${choose('corner', schema.theme.corners, { sharp: 'Sharp', soft: 'Soft', round: 'Round' })}
          </div>
          <div class="field">
            <label class="label">Light or dark</label>
            ${choose('mode', schema.theme.modes, { auto: 'Follow the member', light: 'Always light', dark: 'Always dark' })}
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label class="label">How the pages are made</label>
            ${choose('layout', schema.theme.layouts, {
              one_per_page: 'One at a time',
              all_at_once: 'All on one page',
              n_per_page: 'N per page',
              by_section: 'Sections split the pages'
            })}
          </div>
          <div class="field">
            <label class="label">Progress</label>
            ${choose('progress', schema.theme.progress, { bar: 'Bar', steps: 'Steps', count: 'Count only', none: 'None' })}
          </div>
        </div>
        ${theme.layout === 'n_per_page' ? `
          <div class="field">
            <label class="label">Questions per page</label>
            <input type="number" class="input" data-theme="page_size"
                   min="${schema.theme.page_size ? schema.theme.page_size.min : 2}"
                   max="${schema.theme.page_size ? schema.theme.page_size.max : 10}"
                   value="${theme.page_size || 3}">
          </div>` : ''}
        ${theme.layout === 'by_section' ? `
          <p class="hint">A section heading starts a new page, and the questions under it stay with it — the point where a section is introduced is where the page is divided. Questions before the first section make up the first page.</p>` : ''}`;

      // ── Images ───────────────────────────────────────────
      const imagesBody = `
        ${asset('logo_url', 'Wordmark', 'Replaces the Dev Circle mark in the bar and on the opening screen.')}
        ${asset('header_image', 'Opening image', 'Sits above the headline on the first screen.')}
        ${asset('background_image', 'Background image')}
        ${theme.background_image ? `
          <div class="field-row">
            <div class="field">
              <label class="label">How it sits</label>
              ${choose('background_fit', schema.theme.fits, { cover: 'Fills the screen', contain: 'Fits inside', tile: 'Tiles' })}
            </div>
            <div class="field">
              <label class="label">Dimmed by ${Math.round((theme.background_overlay ?? 0.55) * 100)}%</label>
              <input type="range" min="0" max="95" step="5" data-theme-range="background_overlay"
                     value="${Math.round((theme.background_overlay ?? 0.55) * 100)}" style="width:100%">
            </div>
          </div>
          <p class="hint">A photograph behind text is the quickest way to make a ${noun} unreadable, so it is dimmed unless you say otherwise.</p>` : ''}`;

      // ── Opening / closing screens ────────────────────────
      const openingBody = `
        <div class="field">
          <input type="text" class="input" data-theme-copy="intro.headline" placeholder="Headline — leave empty to open on the first question"
                 value="${escapeHtml(theme.intro?.headline || '')}">
        </div>
        <div class="field">
          <textarea class="input" data-theme-copy="intro.body" placeholder="Why you are asking, and what happens to the answers">${escapeHtml(theme.intro?.body || '')}</textarea>
        </div>
        <div class="field">
          <input type="text" class="input" data-theme-copy="intro.button" placeholder="Button — defaults to Start"
                 value="${escapeHtml(theme.intro?.button || '')}">
        </div>`;

      const closingBody = `
        <div class="field">
          <input type="text" class="input" data-theme-copy="thank_you.headline" placeholder="Headline — defaults to thanking them by name"
                 value="${escapeHtml(theme.thank_you?.headline || '')}">
        </div>
        <div class="field">
          <textarea class="input" data-theme-copy="thank_you.body" placeholder="What happens next">${escapeHtml(theme.thank_you?.body || '')}</textarea>
        </div>`;

      panel.innerHTML = `
        ${section('colours', 'Colours', 'Accent, background and text', coloursBody, { open: true, marked: customised.colours })}
        ${section('type', 'Type', 'Font and text size', typeBody, { marked: customised.type })}
        ${section('layout', 'Shape & layout', 'Corners, light/dark, paging and progress', layoutBody, { marked: customised.layout })}
        ${section('images', 'Images', 'Wordmark, opening image and background', imagesBody, { marked: customised.images })}
        ${section('opening', 'Opening screen', 'Shown before the first question', openingBody, { marked: customised.opening })}
        ${section('closing', 'Closing screen', 'Shown after the last answer', closingBody, { marked: customised.closing })}

        <div class="row wrap" style="gap:var(--sp-2);margin-top:var(--sp-4)">
          <button class="btn btn-sm btn-secondary" data-theme-reset>Reset to the workspace look</button>
          <button class="btn btn-sm btn-ghost" data-theme-default>Make this the workspace default</button>
        </div>`;

      panel.querySelector('[data-theme-reset]')?.addEventListener('click', reset);
      panel.querySelector('[data-theme-default]')?.addEventListener('click', saveAsCircleDefault);

      // Remember a section being opened or closed so a drag-driven re-render
      // does not snap it shut (or open) under the cursor.
      panel.querySelectorAll('[data-section]').forEach(el => {
        el.addEventListener('toggle', () => {
          const id = el.dataset.section;
          if (el.open) openSections.add(id); else openSections.delete(id);
        });
      });

      firstRender = false;

      // Colour pickers and plain fields. The contrast readout has to move with
      // them, so anything that changes a colour redraws the panel — but only
      // after the value settles, or the picker closes on every drag.
      const colourKeys = ['accent', 'background_color', 'text_color', 'surface_color', 'muted_color'];

      panel.querySelectorAll('[data-theme]').forEach(input => {
        const key = input.dataset.theme;
        const apply = ({ settle }) => {
          state.theme[key] = input.value;
          if (colourKeys.includes(key)) {
            const twin = panel.querySelector(`[data-theme-hex="${key}"]`);
            if (twin) twin.value = input.value;
            if (settle) { render(); changed(); return; }
          }
          changed();
        };
        input.addEventListener('input', () => apply({ settle: false }));
        input.addEventListener('change', () => apply({ settle: true }));
      });

      // A hex typed from a brand guide. Applied only once it is a whole colour,
      // so the preview does not flicker through "#1", "#1a", "#1a2".
      panel.querySelectorAll('[data-theme-hex]').forEach(input => {
        input.addEventListener('input', () => {
          const key = input.dataset.themeHex;
          const value = SurveyTheme.normalizeHex(input.value);
          if (!value && input.value.trim()) return;
          if (value) state.theme[key] = value;
          else delete state.theme[key];
          const picker = panel.querySelector(`[data-theme="${key}"]`);
          if (picker && value) picker.value = value;
          changed();
        });
        input.addEventListener('blur', renderThemePanel);
      });

      panel.querySelectorAll('[data-clear-theme]').forEach(button => {
        button.addEventListener('click', () => {
          delete state.theme[button.dataset.clearTheme];
          render();
          changed();
        });
      });

      panel.querySelectorAll('[data-theme-range]').forEach(input => {
        input.addEventListener('input', () => {
          state.theme[input.dataset.themeRange] = Number(input.value) / 100;
          changed();
        });
        input.addEventListener('change', renderThemePanel);
      });

      panel.querySelectorAll('[data-swatch]').forEach(swatch => {
        swatch.addEventListener('click', () => {
          state.theme.accent = swatch.dataset.swatch;
          render();
          changed();
        });
      });

      panel.querySelector('#fontSelect')?.addEventListener('change', e => {
        state.theme.font = e.target.value;
        render();
        changed();
      });

      panel.querySelectorAll('[data-upload]').forEach(input => {
        input.addEventListener('change', () => uploadAsset(input));
      });

      panel.querySelectorAll('[data-clear-asset]').forEach(button => {
        button.addEventListener('click', () => {
          delete state.theme[button.dataset.clearAsset];
          render();
          changed();
        });
      });

      panel.querySelectorAll('[data-theme-copy]').forEach(input => {
        input.addEventListener('input', () => {
          const [group, key] = input.dataset.themeCopy.split('.');
          state.theme[group] = { ...(state.theme[group] || {}), [key]: input.value };
          changed();
        });
      });
    }

    // Sent as base64 in JSON, the same way the member import sends a workbook.
    // The server reads the bytes to decide what the file really is — the name
    // and the type the browser declares are both the uploader's to choose, so
    // neither is worth believing.
    async function uploadAsset(input) {
      const file = input.files?.[0];
      if (!file) return;

      const key = input.dataset.upload;
      const kind = input.dataset.uploadKind || 'image';
      const holder = input.closest('.asset');
      holder?.classList.add('busy');

      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(new Error('That file could not be read'));
          reader.readAsDataURL(file);
        });

        const { asset } = await api.post('/admin/uploads', {
          file: base64, kind, filename: file.name
        });
        state.theme[key] = asset.path;

        // Naming a brand font after the file it came from is right often enough
        // to be worth doing, and always editable
        if (key === 'brand_font') {
          state.theme.font = 'brand';
          if (!state.theme.brand_font_name) {
            state.theme.brand_font_name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
          }
        }

        render();
        changed();
      } catch (err) {
        holder?.classList.remove('busy');
        showToast(err.message, 'error');
      }
    }

    function reset() {
      state.theme = {};
      if (opts.onReset) opts.onReset();
      render();
      changed();
    }

    async function saveAsCircleDefault() {
      const circleId = Auth.getCircle();
      if (!circleId) { showToast('Pick a workspace first', 'warning'); return; }
      try {
        await api.put(`/admin/circles/${circleId}`, { survey_theme: state.theme });
        state.circleTheme = { ...state.theme };
        showToast(`Every new ${noun} here starts from this look`);
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    return { render, reset, saveAsCircleDefault };
  }

  return { create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ThemePanel;
