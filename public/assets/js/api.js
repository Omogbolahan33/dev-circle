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

function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str.replace(' ', 'T'));
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
