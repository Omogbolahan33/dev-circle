// ─── Circle branding ───────────────────────────────────────
// A workspace's own look, applied to the whole shell — admin console and
// member portal alike — so everyone in a circle experiences its colours,
// canvas and type, not just while answering a survey.
//
// It is the same data a survey theme is, validated the same way on the way
// in (see survey-theme.js): a handful of custom properties, never arbitrary
// CSS, with contrast measured rather than trusted. This file is only the
// runtime half — it takes a normalised theme and puts it on the document.
(function () {
  const root = document.documentElement;
  const STYLE_ID = 'circle-brand-face';
  const SENTINEL = 'data-circle-branded';

  function apply(theme) {
    if (!theme || typeof theme !== 'object' || !window.SurveyTheme) return false;

    // Resolve to a full theme so derived colours (surfaces, tints, lines)
    // exist even when the brand only set an accent.
    const resolved = SurveyTheme.resolve(theme);
    const vars = SurveyTheme.toCSS(resolved);
    for (const name of ALL_VARS()) {
      // Clear everything first, so switching from an imaged brand to one
      // without imagery does not leave the old photograph behind.
      root.style.removeProperty(name);
    }
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value);
    }

    // A brand typeface has to be declared in a stylesheet rather than set as
    // a custom property, so it arrives separately — exactly as on a survey.
    document.getElementById(STYLE_ID)?.remove();
    const face = SurveyTheme.fontFace(resolved);
    if (face) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = face;
      document.head.appendChild(style);
    }

    // A brand that names a canvas pins light or dark for the duration, the
    // same way a themed survey does; the toggle steps aside rather than
    // pretending to switch a look that has no dark version.
    const branded = Boolean(resolved.background_color || resolved.background_image);
    if (branded) {
      if (resolved.background_color) {
        const lum = SurveyTheme.luminance(SurveyTheme.normalizeHex(resolved.background_color));
        const mode = lum < 0.2 ? 'dark' : 'light';
        root.setAttribute('data-theme', mode);
        // Keep native controls and scrollbars in the same mode the canvas
        // forces, the way the theme toggle does.
        root.style.colorScheme = mode;
      }
      root.setAttribute(SENTINEL, '');
      document.querySelectorAll('[data-theme-toggle]').forEach(t => {
        t.setAttribute('data-brand-hides', '');
        t.classList.add('hide');
      });
    }

    // A wordmark replaces the product name wherever the shell left a hook.
    const logo = resolved.logo_url;
    document.querySelectorAll('[data-brand-logo]').forEach(el => {
      if (logo) {
        el.innerHTML = `<img src="${logo}" alt="" class="brand-logo-img">`;
        el.classList.add('has-logo');
      } else {
        el.innerHTML = '';
        el.classList.remove('has-logo');
      }
    });

    return true;
  }

  // Remove every trace of a brand (used when switching to a workspace that
  // carries none). Properties set inline are simply deleted; the stylesheet
  // and attributes go the same way.
  // Every custom property a brand can set. The derived ones come from
  // toCSS; --survey-canvas only exists when imagery or a wash does, so it is
  // listed explicitly — clearing would otherwise leave the photograph behind
  // a workspace that no longer names one.
  const ALL_VARS = () => [...Object.keys(SurveyTheme.toCSS(SurveyTheme.resolve({}))), '--survey-canvas'];

  function clear() {
    if (!window.SurveyTheme) return;
    for (const name of ALL_VARS()) root.style.removeProperty(name);
    document.getElementById(STYLE_ID)?.remove();
    root.removeAttribute(SENTINEL);
    root.style.colorScheme = '';
    // Hand the light/dark decision back to the member's own preference.
    if (window.Theme) Theme.apply(Theme.stored() || Theme.system());
    document.querySelectorAll('[data-theme-toggle]').forEach(toggle => {
      if (toggle.hasAttribute('data-brand-hides')) {
        toggle.removeAttribute('data-brand-hides');
        toggle.classList.remove('hide');
      }
    });
    document.querySelectorAll('[data-brand-logo]').forEach(el => {
      el.innerHTML = '';
      el.classList.remove('has-logo');
    });
  }

  // Pick the brand of whichever circle is active in a list the API returned.
  function fromList(circles, activeId) {
    if (!Array.isArray(circles) || !circles.length) return null;
    const current = circles.find(c => c.id === activeId) || circles[0];
    return current?.brand || null;
  }

  window.Brand = { apply, clear, fromList };
})();
