// ─── Dev Circle — Shared Auth & API Module ─────────────────
// Include this script in any page that needs API access.
// Usage: <script src="/assets/js/api.js"></script>

const API_BASE = window.location.origin + '/api';

const Auth = {
  TOKEN_KEY: 'devcircle_token',
  USER_KEY: 'devcircle_user',
  ADMIN_KEY: 'devcircle_is_admin',
  PERMS_KEY: 'devcircle_permissions',

  getToken() {
    return localStorage.getItem(this.TOKEN_KEY);
  },

  getUser() {
    try { return JSON.parse(localStorage.getItem(this.USER_KEY)); } catch { return null; }
  },

  isAdmin() {
    return localStorage.getItem(this.ADMIN_KEY) === 'true';
  },

  // Null rather than [] when nothing was stored: a session that predates this
  // being saved is unknown, not unprivileged, and the two are treated
  // differently by anything that hides a control.
  getPermissions() {
    const raw = localStorage.getItem(this.PERMS_KEY);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },

  // Whether the signed-in admin holds a permission. This only decides what the
  // interface offers — the server gates the route regardless, so an out-of-date
  // answer here can never become access.
  can(permission) {
    const perms = this.getPermissions();
    if (perms === null) return true;          // unknown: let the server decide
    return perms.includes('*') || perms.includes(permission);
  },

  isLoggedIn() {
    return !!this.getToken();
  },

  save(token, user, isAdmin = false, permissions) {
    localStorage.setItem(this.TOKEN_KEY, token);
    localStorage.setItem(this.USER_KEY, JSON.stringify(user));
    localStorage.setItem(this.ADMIN_KEY, String(isAdmin));
    if (Array.isArray(permissions)) {
      localStorage.setItem(this.PERMS_KEY, JSON.stringify(permissions));
    } else {
      localStorage.removeItem(this.PERMS_KEY);
    }
  },

  logout() {
    const token = this.getToken();
    if (token) {
      fetch(API_BASE + '/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
      }).catch(() => {});
    }
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.USER_KEY);
    localStorage.removeItem(this.ADMIN_KEY);
    // The next person to sign in on this machine starts in their own workspace
    localStorage.removeItem(this.CIRCLE_KEY);
    localStorage.removeItem(this.PERMS_KEY);
    window.location.href = '/index.html';
  },

  requireAuth(expectedAdmin = false) {
    if (!this.isLoggedIn()) {
      window.location.href = '/index.html';
      return false;
    }
    if (expectedAdmin && !this.isAdmin()) {
      window.location.href = '/member/dashboard.html';
      return false;
    }
    if (!expectedAdmin && this.isAdmin()) {
      window.location.href = '/admin/dashboard.html';
      return false;
    }
    return true;
  },

  // Which circle the console is working in. A circle is a workspace, so every
  // admin request carries it — the server answers with that workspace's data
  // and refuses one this account cannot reach.
  CIRCLE_KEY: 'devcircle_circle',

  getCircle() {
    return localStorage.getItem(this.CIRCLE_KEY) || null;
  },

  setCircle(id) {
    if (id) localStorage.setItem(this.CIRCLE_KEY, id);
    else localStorage.removeItem(this.CIRCLE_KEY);
  },

  headers() {
    const headers = { 'Content-Type': 'application/json' };

    // Omitted when there is no session rather than sent as "Bearer null".
    // The public survey link is answered with no account at all, and a
    // credential-shaped header carrying nothing is worse than none: it reads
    // as a failed sign-in everywhere it is logged.
    const token = this.getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    // Omitted when unset, so the server falls back to the first circle this
    // account can reach — a single-workspace install needs no ceremony.
    const circle = this.getCircle();
    if (circle) headers['X-Circle-Id'] = circle;

    return headers;
  }
};

// ─── API Client ─────────────────────────────────────────────

async function api(path, options = {}) {
  const url = API_BASE + path;
  const config = {
    headers: Auth.headers(),
    ...options
  };

  const res = await fetch(url, config);

  if (res.status === 401) {
    Auth.logout();
    return null;
  }

  const data = await res.json();

  if (!res.ok) {
    // The message is what gets shown; the body is what a caller needs when a
    // refusal is itemised — a survey that names which questions were rejected
    // can put each one where it belongs instead of printing one sentence.
    const error = new Error(data.error || `API error ${res.status}`);
    error.status = res.status;
    error.body = data;
    throw error;
  }

  return data;
}

// Convenience methods
api.get = (path) => api(path);
api.post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
api.put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body) });
api.patch = (path, body, options = {}) =>
  api(path, { method: 'PATCH', body: JSON.stringify(body), ...options });
api.del = (path) => api(path, { method: 'DELETE' });

// Downloads need the auth header, so they cannot be a plain link. The server
// names the file in Content-Disposition; the fallback is only used when that
// header is missing. The object URL is revoked afterwards — repeated exports
// were leaking one blob each.
api.download = async (path, fallbackName = 'download') => {
  const res = await fetch(API_BASE + path, { headers: Auth.headers() });

  if (res.status === 401) { Auth.logout(); return; }
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try { message = (await res.json()).error || message; } catch { /* not JSON */ }
    throw new Error(message);
  }

  const disposition = res.headers.get('content-disposition') || '';
  const named = /filename="?([^";]+)"?/i.exec(disposition);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = named ? named[1] : fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ─── UI Helpers ─────────────────────────────────────────────

// ─── Reading a timestamp ────────────────────────────────────
// One parser, because the two databases hand the browser two different shapes
// and every page that rolled its own got at least one of them wrong.
//
//   SQLite     "2026-08-26 22:14:19"        — datetime('now'), which is UTC
//                                             but does not say so
//   Postgres   "2026-08-26T22:14:19.041Z"   — TIMESTAMPTZ, a Date on the way
//                                             through JSON, so already ISO
//
// Two bugs came out of that. Three pages wrote `.replace(' ','T') + 'Z'` to
// force the SQLite form to UTC — which appended a second Z to the Postgres
// form and produced the literal words "Invalid Date" on every session and
// dashboard time after the move to Postgres. And formatDate, which did the
// replace without the Z, read the SQLite form as *local* time: correct-looking
// and an hour out in WAT, which "Just now" quietly swallowed.
//
// So: normalise to ISO, assume UTC when no zone is stated, and hand back null
// rather than an Invalid Date for anything unreadable — a caller can render a
// dash for null, and cannot render anything sensible for NaN.
function parseStamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const text = String(value).trim();
  if (!text) return null;

  // A date with no time is already UTC midnight by the spec, and appending a
  // zone to it produces nothing a browser will parse.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const dateOnly = new Date(text);
    return Number.isNaN(dateOnly.getTime()) ? null : dateOnly;
  }

  const iso = text.includes('T') ? text : text.replace(' ', 'T');
  const zoned = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;

  const parsed = new Date(zoned);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(str) {
  const d = parseStamp(str);
  if (!d) return '—';
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Toasts stack in the corner rather than replacing one another, so a burst
// of results (a blast that sent, then failed a channel) stays readable.
function showToast(message, type = 'success') {
  let stack = document.getElementById('toastStack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toastStack';
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = '<span class="mark"></span>';
  toast.appendChild(document.createTextNode(message));
  stack.appendChild(toast);

  setTimeout(() => toast.remove(), 3600);
}

// ─── Button loading state ──────────────────────────────────
// The one proper loading state for an action button. `busy` disables the
// button, swaps in a spinner next to a busy label for the duration of `work`,
// and restores the button's original label and state when `work` settles —
// whether it succeeded or threw. Callers run their work inside the callback
// and let exceptions propagate to their own catch, so each page keeps control
// of its error message while every button gets the same in-flight look.
//
//   await busy($('saveBtn'), 'Saving…', async () => { await api.post(...); });
//
// Buttons that appear to do nothing while a request is in flight are how
// double-submits happen (a survey published twice is a survey sent twice), so
// this also guards against the same handler firing again mid-flight.
function busy(btn, busyLabel, work) {
  if (!btn) return Promise.resolve().then(work);

  const original = btn.dataset.busyRestore || btn.innerHTML;
  btn.dataset.busyRestore = original;
  btn.classList.add('is-loading');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="busy-label">${escapeHtml(busyLabel || 'Working…')}</span>`;

  return Promise.resolve()
    .then(work)
    .finally(() => {
      btn.classList.remove('is-loading');
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
      btn.innerHTML = original;
    });
}

// ─── Page & section loading states ─────────────────────────
// A page that fills containers after an async fetch usually shows nothing
// while it waits — a blank body is read as a frozen page. These helpers paint
// skeleton placeholders into those containers so the shape of the content is
// visible while the data is on its way, then the page renders over them.
//
//   <div class="stat-grid" id="stats">…</div>            → empty on first paint
//   <div class="stat-grid" id="stats">${skelStats(4)}</div>
//
// Skeleton columns mirror the width of a typical column (avator, name,
// sub-line) rather than a uniform row, so the placeholder reads as a table.

function skelLine(width = '60%', height = 12) {
  return `<div class="skeleton" style="width:${width};height:${height}px"></div>`;
}

function skelRows(rows = 5, cols = 4) {
  return Array.from({ length: rows }, () => `
    <tr>${Array.from({ length: cols }, (_, c) => `
      <td><div class="skeleton" style="width:${c === 0 ? 60 : 30 + (c * 10)}%"></div></td>`).join('')}
    </tr>`).join('');
}

function skelStats(count = 4) {
  return Array.from({ length: count }, () => `
    <div class="stat">
      <div class="stat-label"><div class="skeleton" style="width:50%;height:10px"></div></div>
      <div class="stat-value"><div class="skeleton" style="width:56px;height:26px"></div></div>
    </div>`).join('');
}

function skelList(items = 5, { avatar = false, lines = 1 } = {}) {
  return Array.from({ length: items }, () => `
    <div class="skeleton-row">
      ${avatar ? '<div class="skeleton skeleton-avatar"></div>' : ''}
      <div class="skeleton-row-lines">
        ${Array.from({ length: lines }, (_, i) => `<div class="skeleton" style="width:${i === 0 ? 60 : 40}%;height:${i === 0 ? 13 : 11}px"></div>`).join('')}
      </div>
    </div>`).join('');
}

// Paint the page's section containers with skeleton placeholders, so a slow
// first load never leaves the screen empty. Each selector maps to a builder
// that knows the shape of that section (a stat grid, a table body, a list).
function showSkeletons(spec) {
  for (const selector in spec) {
    const el = document.querySelector(selector);
    if (el) el.innerHTML = spec[selector]();
  }
}
