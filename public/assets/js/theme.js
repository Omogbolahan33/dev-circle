// ─── Dev Circle — Theme ─────────────────────────────────────
// Loaded synchronously in <head>, before anything paints, so the stored
// preference is on <html> for the first frame — no flash of the wrong theme.
//
// Three states collapse into two: an explicit choice wins, otherwise we take
// the operating system's. Only the explicit choice is ever written down, so a
// developer who has not chosen keeps following their system as it changes.

const Theme = {
  KEY: 'devcircle_theme',

  stored() {
    try { return localStorage.getItem(this.KEY); } catch { return null; }
  },

  system() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light' : 'dark';
  },

  current() {
    return document.documentElement.getAttribute('data-theme') || this.stored() || this.system();
  },

  apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // Keep the browser's own UI (form controls, scrollbars) in step.
    document.documentElement.style.colorScheme = theme;
    this.sync();
  },

  set(theme) {
    try { localStorage.setItem(this.KEY, theme); } catch { /* private mode */ }
    this.apply(theme);
  },

  toggle() {
    this.set(this.current() === 'light' ? 'dark' : 'light');
  },

  // Every toggle on the page reflects the same state, and says what it will
  // do rather than what is currently on.
  sync() {
    const next = this.current() === 'light' ? 'dark' : 'light';
    document.querySelectorAll('[data-theme-toggle]').forEach(el => {
      el.setAttribute('aria-label', `Switch to ${next} mode`);
      el.setAttribute('title', `Switch to ${next} mode`);
      const icon = el.querySelector('[data-theme-icon]');
      if (icon) icon.innerHTML = this.current() === 'light' ? Theme.MOON : Theme.SUN;
    });
  },

  button(extraClass = '') {
    return `
      <button class="icon-btn ${extraClass}" data-theme-toggle onclick="Theme.toggle()">
        <span data-theme-icon>${this.current() === 'light' ? Theme.MOON : Theme.SUN}</span>
      </button>`;
  }
};

Theme.SUN = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/>
  <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>`;

Theme.MOON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>`;

// Set the theme immediately — this file is in <head> for exactly this reason.
Theme.apply(Theme.stored() || Theme.system());

// Follow the system while the developer has expressed no preference of
// their own; the moment they choose, we stop moving under them.
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
    if (!Theme.stored()) Theme.apply(e.matches ? 'light' : 'dark');
  });
}

// Toggles are rendered by the shells after this file runs, so re-sync once
// the document is ready.
document.addEventListener('DOMContentLoaded', () => Theme.sync());
