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

  function apply(theme, name) {
    if (!theme || typeof theme !== 'object' || !window.SurveyTheme) return false;

    // Resolve to a full theme so derived colours (surfaces, tints, lines)
    // exist even when the brand only set an accent.
    const resolved = SurveyTheme.resolve(theme);
    const vars = SurveyTheme.toCSS(resolved);
    for (const prop of ALL_VARS()) {
      // Clear everything first, so switching from an imaged brand to one
      // without imagery does not leave the old photograph behind.
      root.style.removeProperty(prop);
    }
    for (const [prop, value] of Object.entries(vars)) {
      root.style.setProperty(prop, value);
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
    wordmark(resolved.logo_url, name);

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

  function clear(name) {
    if (!window.SurveyTheme) return;
    for (const prop of ALL_VARS()) root.style.removeProperty(prop);
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
    wordmark(null, name);
  }

  // ─── The wordmark ──────────────────────────────────────────
  // Whose circle is this? Answered in the chrome, in the order the answer is
  // worth having: the workspace's own logo if it uploaded one, its name if it
  // did not, and the product's mark only when there is no workspace to name.
  //
  // The mark used to be blanked outright whenever a circle carried no logo,
  // which left the corner of the shell empty for every workspace that had not
  // uploaded one — and named the product rather than the circle even when it
  // had a name to give.
  //
  // The shell writes the product mark into the hook itself, so the fallback is
  // captured from the DOM on first touch rather than repeated here, where it
  // would be a second copy to keep in step.
  const PRODUCT_MARK = new WeakMap();

  function wordmark(logo, name) {
    document.querySelectorAll('[data-brand-logo]').forEach(el => {
      if (!PRODUCT_MARK.has(el)) PRODUCT_MARK.set(el, el.innerHTML);

      if (logo) {
        // Built rather than interpolated: normalizeAsset() already confines a
        // logo to an own-origin upload path, and this keeps it that way if that
        // ever loosens.
        const img = document.createElement('img');
        img.src = logo;
        img.alt = name || '';
        img.className = 'brand-logo-img';
        el.replaceChildren(img);
        el.classList.add('has-logo');
        return;
      }

      el.classList.remove('has-logo');
      // textContent, so a workspace cannot name itself in markup.
      if (name) el.textContent = name;
      else el.innerHTML = PRODUCT_MARK.get(el);
    });
  }

  // The circle that is active in a list the API returned. Both /auth/me and
  // /users/profile carry the name beside the brand, so one lookup answers both
  // halves of "whose circle am I in".
  function activeIn(circles, activeId) {
    if (!Array.isArray(circles) || !circles.length) return null;
    return circles.find(c => c.id === activeId) || circles[0];
  }

  // Kept for callers that only want the look.
  function fromList(circles, activeId) {
    return activeIn(circles, activeId)?.brand || null;
  }

  window.Brand = { apply, clear, fromList, activeIn };
})();
