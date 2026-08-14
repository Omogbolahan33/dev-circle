// ─── Dev Circle — Shared Auth & API Module ─────────────────
// Include this script in any page that needs API access.
// Usage: <script src="/assets/js/api.js"></script>

const API_BASE = window.location.origin + '/api';

const Auth = {
  TOKEN_KEY: 'devcircle_token',
  USER_KEY: 'devcircle_user',
  ADMIN_KEY: 'devcircle_is_admin',

  getToken() {
    return localStorage.getItem(this.TOKEN_KEY);
  },

  getUser() {
    try { return JSON.parse(localStorage.getItem(this.USER_KEY)); } catch { return null; }
  },

  isAdmin() {
    return localStorage.getItem(this.ADMIN_KEY) === 'true';
  },

  isLoggedIn() {
    return !!this.getToken();
  },

  save(token, user, isAdmin = false) {
    localStorage.setItem(this.TOKEN_KEY, token);
    localStorage.setItem(this.USER_KEY, JSON.stringify(user));
    localStorage.setItem(this.ADMIN_KEY, String(isAdmin));
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

  headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + this.getToken()
    };
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
    throw new Error(data.error || `API error ${res.status}`);
  }

  return data;
}

// Convenience methods
api.get = (path) => api(path);
api.post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
api.put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body) });
api.del = (path) => api(path, { method: 'DELETE' });

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

function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; z-index: 9999;
    padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 500;
    font-family: var(--font-body); color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    animation: slideUp 0.3s cubic-bezier(0.16,1,0.3,1);
    background: ${type === 'error' ? 'var(--rose)' : type === 'warning' ? 'var(--cd-gold)' : 'var(--emerald)'};
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// Inject toast animation
if (!document.getElementById('toast-styles')) {
  const style = document.createElement('style');
  style.id = 'toast-styles';
  style.textContent = `@keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`;
  document.head.appendChild(style);
}
