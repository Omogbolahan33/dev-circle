// ─── Dev Circle — Application Shell ─────────────────────────
// Renders the navigation, command palette, drawers and confirm dialogs that
// every screen shares. A page declares which nav entry it is and what its
// header says; it never rebuilds the chrome around itself.
//
// Usage:
//   <body><div class="app"><div class="app-main">
//     <header class="page-head"> … </header>
//     <div class="app-body"> … </div>
//   </div></div>
//   <script src="/assets/js/api.js"></script>
//   <script src="/assets/js/shell.js"></script>
//   <script>Shell.admin('members');</script>

// ─── Icons ──────────────────────────────────────────────────
// A 16px stroke set, drawn from currentColor so nav state colours them.

const ICONS = {
  overview:   '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z"/>',
  analytics:  '<path d="M3 20h18M7 20v-7M12 20V5M17 20v-11"/>',
  members:    '<path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 20v-2a4 4 0 0 0-3-3.87"/>',
  onboarding: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
  cohorts:    '<path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
  circles:    '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/>',
  surveys:    '<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4"/><rect x="9" y="1" width="6" height="4" rx="1"/><path d="M8 12h8M8 16h5"/>',
  sessions:   '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  blasts:     '<path d="m22 2-7 20-4-9-9-4 20-7z"/>',
  gifts:      '<rect x="2" y="7" width="20" height="5" rx="1"/><path d="M12 22V7M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  feedback:   '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  activity:   '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  events:     '<path d="M4 17V9M4 9 8 5M4 9l4 4M20 7v8M20 15l-4 4M20 15l-4-4"/>',
  roles:      '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
  code:       '<path d="m8 6-6 6 6 6M16 6l6 6-6 6M14 4l-4 16"/>',
  key:        '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.3-8.3M17 6l3 3M14 9l3 3"/>',
  search:     '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>',
  bell:       '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  menu:       '<path d="M3 6h18M3 12h18M3 18h18"/>',
  close:      '<path d="M18 6 6 18M6 6l12 12"/>',
  plus:       '<path d="M12 5v14M5 12h14"/>',
  chevron:    '<path d="m9 18 6-6-6-6"/>',
  logout:     '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  profile:    '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  home:       '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>'
};

function icon(name, size = 16) {
  const path = ICONS[name] || ICONS.circles;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${path}</svg>`;
}

// ─── Navigation map ─────────────────────────────────────────
// The single source of truth for where the admin console can go. Grouping
// is deliberate: five short groups are navigable, twelve flat links are not.

const ADMIN_NAV = [
  { group: 'Overview', items: [
    { id: 'dashboard', label: 'Overview',  icon: 'overview',  href: '/admin/dashboard.html' },
    { id: 'analytics', label: 'Analytics', icon: 'analytics', href: '/admin/analytics.html' }
  ]},
  { group: 'People', items: [
    { id: 'members', label: 'Members', icon: 'members', href: '/admin/members.html' },
    { id: 'cohorts', label: 'Cohorts', icon: 'cohorts', href: '/admin/cohorts.html' },
    // With the members it makes rather than with the surveys it is built like:
    // an onboarding form is how somebody becomes a member, and filing it under
    // Programs would read as a kind of survey, which is the one thing it is not.
    { id: 'onboarding', label: 'Onboarding', icon: 'onboarding', href: '/admin/onboarding.html', permission: 'onboarding.read' }
  ]},
  { group: 'Programs', items: [
    { id: 'surveys',  label: 'Surveys',    icon: 'surveys',  href: '/admin/surveys.html' },
    { id: 'sessions', label: 'Sessions',   icon: 'sessions', href: '/admin/sessions.html' },
    { id: 'blasts',   label: 'Broadcasts', icon: 'blasts',   href: '/admin/blasts.html' },
    { id: 'gifts',    label: 'Rewards',    icon: 'gifts',    href: '/admin/gifts.html' }
  ]},
  { group: 'Signals', items: [
    { id: 'feedback',     label: 'Feedback',  icon: 'feedback', href: '/admin/feedback.html' },
    { id: 'activity',     label: 'Activity',  icon: 'activity', href: '/admin/activity.html' },
    { id: 'integrations', label: 'Event log', icon: 'events',   href: '/admin/integrations.html' }
  ]},
  { group: 'Workspace', items: [
    { id: 'roles', label: 'Roles & access', icon: 'roles', href: '/admin/roles.html' },
    // An item may name the permission it needs. The nav then hides it from a
    // role that does not hold it, so nobody is offered a page that answers 403.
    { id: 'credentials', label: 'Credentials', icon: 'key', href: '/admin/credentials.html', permission: 'credentials.read' },
    { id: 'api-docs', label: 'API reference', icon: 'code', href: '/admin/api-docs.html', permission: 'docs.read' }
  ]}
];

// Groups with the permission-gated items removed, and any group left empty
// dropped with them — the source of truth for both the sidebar and the palette.
function visibleNav() {
  return ADMIN_NAV
    .map(g => ({ ...g, items: g.items.filter(i => !i.permission || Auth.can(i.permission)) }))
    .filter(g => g.items.length);
}

// The developer's side of the product. Every engagement type the blueprint
// names is a destination here — surveys, sessions, self-initiated feedback,
// rewards, and the history of all of it — rather than a card buried on Home.
// Account settings live in the avatar menu, keeping the bar to the things a
// developer actually came to do.
const PORTAL_NAV = [
  { id: 'dashboard',   label: 'Home',     href: '/member/dashboard.html' },
  { id: 'surveys',     label: 'Surveys',  href: '/member/surveys.html' },
  { id: 'sessions',    label: 'Sessions', href: '/member/sessions.html' },
  { id: 'feedback',    label: 'Feedback', href: '/member/feedback.html' },
  { id: 'gifts',       label: 'Rewards',  href: '/member/gifts.html' },
  { id: 'engagement',  label: 'History',  href: '/member/engagement.html' }
];

// ─── Shell ──────────────────────────────────────────────────

const Shell = {
  activeId: null,

  // Admin console: fixed sidebar, command palette, user menu.
  admin(activeId) {
    if (!Auth.requireAuth(true)) throw new Error('Redirecting');
    this.activeId = activeId;

    const app = document.querySelector('.app');
    const main = document.querySelector('.app-main');
    if (!app || !main) return;

    app.insertAdjacentHTML('afterbegin', this._sidebar(activeId));
    app.insertAdjacentHTML('beforeend', '<div class="sidebar-scrim" onclick="Shell.closeNav()"></div>');
    main.insertAdjacentHTML('afterbegin', this._mobileBar(activeId));

    this._mountOverlays();
    this._bindKeys(true);
    this._loadCircles();
  },

  // Member portal: top bar, no palette — four destinations do not need one.
  portal(activeId) {
    if (!Auth.requireAuth(false)) throw new Error('Redirecting');
    this.activeId = activeId;

    const portal = document.querySelector('.portal');
    if (!portal) return;

    portal.insertAdjacentHTML('afterbegin', this._portalBar(activeId));
    this._mountOverlays();
    this._bindKeys(false);
    this._loadUnread();
  },

  _sidebar(activeId) {
    const user = Auth.getUser() || {};
    const groups = visibleNav().map(g => `
      <div class="nav-group">
        <div class="nav-group-label">${g.group}</div>
        ${g.items.map(i => `
          <a href="${i.href}" class="nav-item${i.id === activeId ? ' active' : ''}">
            <span class="nav-icon">${icon(i.icon)}</span>
            <span>${i.label}</span>
            <span class="nav-count hide" data-count="${i.id}"></span>
          </a>`).join('')}
      </div>`).join('');

    return `
      <aside class="sidebar" id="sidebar">
        <a href="/admin/dashboard.html" class="sidebar-brand">
          <span class="brand-mark" id="brandMark">dev<span>.</span>circle</span>
          <span class="brand-badge">Admin</span>
        </a>
        <button class="sidebar-search" onclick="Shell.openPalette()">
          ${icon('search', 14)}
          <span>Search…</span>
          <kbd>⌘K</kbd>
        </button>
        <nav class="sidebar-nav">${groups}</nav>
        <div class="sidebar-foot">
          <!-- Which workspace you are in, sat with your account. Rendered once
               the circles are known, and left out entirely when there is only
               one — a control that offers no choice is just more to read. -->
          <div class="circle-switch hide" id="circleSwitch"></div>

          <div class="user-menu" id="userMenu">
            <a href="/admin/roles.html">${icon('roles', 14)} Roles &amp; access</a>
            <button class="danger" onclick="Auth.logout()">${icon('logout', 14)} Sign out</button>
          </div>
          <div class="row-tight">
            <button class="user-button" onclick="Shell.toggleUserMenu(event)">
              <span class="avatar avatar-sm">${initials(user.name || 'A')}</span>
              <span class="user-meta">
                <span class="user-name">${escapeHtml(user.name || 'Admin')}</span>
                <span class="user-role">${escapeHtml(user.role || 'Administrator')}</span>
              </span>
            </button>
            ${Theme.button()}
          </div>
        </div>
      </aside>`;
  },

  _mobileBar(activeId) {
    const all = visibleNav().flatMap(g => g.items);
    const current = all.find(i => i.id === activeId);
    return `
      <div class="mobile-bar">
        <button class="icon-btn" onclick="Shell.openNav()" aria-label="Open navigation">${icon('menu', 18)}</button>
        <span class="brand-mark">dev<span>.</span>circle</span>
        <span class="spacer"></span>
        <span class="badge badge-info">${current ? current.label : 'Admin'}</span>
      </div>`;
  },

  _portalBar(activeId) {
    const user = Auth.getUser() || {};
    return `
      <header class="portal-bar">
        <div class="portal-bar-inner">
          <a href="/member/dashboard.html" class="sidebar-brand" style="padding:0;height:auto">
            <span class="brand-mark">dev<span>.</span>circle</span>
          </a>
          <nav class="portal-links">
            ${PORTAL_NAV.map(i => `
              <a href="${i.href}" class="portal-link${i.id === activeId ? ' active' : ''}">${i.label}</a>`).join('')}
          </nav>
          ${Theme.button()}

          <a href="/member/notifications.html" class="icon-btn bell" aria-label="Notifications" title="Notifications">
            ${icon('bell', 18)}<span class="unread hide" id="bellUnread"></span>
          </a>

          <div class="account">
            <button class="account-button" onclick="Shell.toggleAccount(event)" aria-label="Your account">
              <span class="avatar avatar-sm">${initials(user.name || '?')}</span>
            </button>
            <div class="account-menu" id="accountMenu">
              <div class="account-head">
                <div class="account-name">${escapeHtml(user.name || 'You')}</div>
                <div class="account-mail">${escapeHtml(user.email || '')}</div>
              </div>
              <a href="/member/profile.html">${icon('profile', 14)} Your profile</a>
              <a href="/member/notifications.html">${icon('bell', 14)} Notifications &amp; consent</a>
              <button class="danger" onclick="Auth.logout()">${icon('logout', 14)} Sign out</button>
            </div>
          </div>
        </div>
      </header>`;
  },

  toggleAccount(e) {
    e.stopPropagation();
    document.getElementById('accountMenu').classList.toggle('open');
  },

  // Overlay furniture every page needs exactly once.
  _mountOverlays() {
    document.body.insertAdjacentHTML('beforeend', `
      <div class="scrim" id="scrim" onclick="Shell.closeTop()"></div>
      <div class="toast-stack" id="toastStack"></div>
      <div class="palette" id="palette">
        <input class="palette-input" id="paletteInput" placeholder="Jump to a page or search members…" autocomplete="off">
        <div class="palette-list" id="paletteList"></div>
      </div>
      <div class="modal" id="confirmModal">
        <div class="modal-title" id="confirmTitle">Are you sure?</div>
        <div class="modal-text" id="confirmText"></div>
        <div class="modal-foot">
          <button class="btn btn-secondary" onclick="Shell._resolveConfirm(false)">Cancel</button>
          <button class="btn btn-danger" id="confirmOk" onclick="Shell._resolveConfirm(true)">Confirm</button>
        </div>
      </div>`);
  },

  _bindKeys(withPalette) {
    document.addEventListener('keydown', e => {
      if (withPalette && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.openPalette();
        return;
      }
      if (e.key === 'Escape') this.closeTop();
      if (withPalette && document.getElementById('palette').classList.contains('open')) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this._movePalette(e.key === 'ArrowDown' ? 1 : -1); }
        if (e.key === 'Enter') { e.preventDefault(); this._runPalette(); }
      }
    });

    document.addEventListener('click', e => {
      const menu = document.getElementById('userMenu');
      if (menu && menu.classList.contains('open') && !e.target.closest('.sidebar-foot')) menu.classList.remove('open');

      const account = document.getElementById('accountMenu');
      if (account && account.classList.contains('open') && !e.target.closest('.account')) account.classList.remove('open');

      const circles = document.getElementById('circleMenu');
      if (circles && circles.classList.contains('open') && !e.target.closest('.circle-switch')) {
        circles.classList.remove('open');
        document.getElementById('circleButton')?.setAttribute('aria-expanded', 'false');
      }
    });
  },

  // ── Mobile navigation ──
  openNav()  { document.getElementById('sidebar')?.classList.add('open'); },
  closeNav() { document.getElementById('sidebar')?.classList.remove('open'); },

  toggleUserMenu(e) {
    e.stopPropagation();
    document.getElementById('circleMenu')?.classList.remove('open');
    document.getElementById('userMenu').classList.toggle('open');
  },

  // ── Circles ──
  // A circle is a workspace. The one you are in is named in full next to your
  // account, and switching reloads into it so nothing on screen is left over
  // from the last one.

  async _loadCircles() {
    const mount = document.getElementById('circleSwitch');
    if (!mount) return;

    let data;
    try {
      // The session already joined the reachable circles. /auth/me returns
      // them without recounting members — enough to name and switch.
      const me = await api.get('/auth/me');
      if (Array.isArray(me.circles) && me.circles.length) {
        const stored = Auth.getCircle();
        const current = me.circles.find(c => c.id === stored) || me.circles[0];
        data = {
          circles: me.circles,
          current,
          can_create: Boolean(me.can_create_circles)
        };
      } else {
        data = await api.get('/admin/circles');
      }
    } catch {
      return;   // the console still works in whichever circle the server picked
    }

    // Keep the stored choice honest: a circle taken away should not leave the
    // console asking for it on every request
    const current = data.current;
    if (Auth.getCircle() !== current.id) Auth.setCircle(current.id);

    // Name the workspace everywhere it is claimed, so a switch is visibly a
    // switch rather than something you have to take on trust
    this._nameCircle(current.name);

    // One workspace and no power to make another means there is nothing here
    // to decide, so nothing is shown
    if (data.circles.length < 2 && !data.can_create) return;

    const options = data.circles.map(c => `
      <button class="circle-option${c.id === current.id ? ' current' : ''}"
              data-circle="${c.id}" role="menuitemradio"
              aria-checked="${c.id === current.id}">
        <span class="circle-check" aria-hidden="true">${c.id === current.id ? '✓' : ''}</span>
        <span class="circle-option-body">
          <span class="circle-option-name">${escapeHtml(c.name)}</span>
          ${c.member_count != null
            ? `<span class="circle-option-meta">${c.member_count} member${c.member_count === 1 ? '' : 's'}</span>`
            : ''}
        </span>
      </button>`).join('');

    mount.innerHTML = `
      <button class="circle-button" id="circleButton" aria-haspopup="true" aria-expanded="false"
              onclick="Shell.toggleCircles(event)">
        <span class="circle-dot" style="background:${current.color || 'var(--cd-blue)'}"></span>
        <span class="circle-current">
          <span class="circle-label">Circle</span>
          <span class="circle-name">${escapeHtml(current.name)}</span>
        </span>
        <span class="circle-caret" aria-hidden="true">${icon('chevron', 14)}</span>
      </button>
      <div class="circle-menu" id="circleMenu" role="menu">
        <div class="circle-menu-head">Switch circle</div>
        ${options}
        ${data.can_create ? `
          <div class="circle-menu-divider"></div>
          <a class="circle-manage" href="/admin/circles.html">Manage circles…</a>` : ''}
      </div>`;

    mount.classList.remove('hide');

    mount.querySelectorAll('.circle-option').forEach(button => {
      button.addEventListener('click', () => Shell.switchCircle(button.dataset.circle));
    });
  },

  closeCircles() {
    document.getElementById('circleMenu')?.classList.remove('open');
    document.getElementById('circleButton')?.setAttribute('aria-expanded', 'false');
  },

  // The sidebar heading and the browser tab both said "dev.circle" whichever
  // circle you were in, which read as though switching had not worked.
  _nameCircle(name) {
    const mark = document.getElementById('brandMark');
    if (mark) mark.textContent = name;

    // Keep whatever the page called itself, and say which workspace it is in
    const page = document.title.split('—').pop().trim();
    document.title = `${name} — ${page}`;
  },

  toggleCircles(e) {
    e.stopPropagation();
    const menu = document.getElementById('circleMenu');
    const button = document.getElementById('circleButton');
    const open = menu.classList.toggle('open');
    button?.setAttribute('aria-expanded', String(open));
  },

  switchCircle(id) {
    if (!id || id === Auth.getCircle()) {
      document.getElementById('circleMenu')?.classList.remove('open');
      return;
    }

    Auth.setCircle(id);
    // A full reload rather than refetching each panel: every screen is scoped
    // to one workspace, and half-swapped data would be worse than a moment's wait
    window.location.reload();
  },

  // ── Drawers ──
  // Open by element id. The scrim is shared, so only one layer is ever up.
  openDrawer(id) {
    document.getElementById(id)?.classList.add('open');
    document.getElementById('scrim')?.classList.add('open');
    document.body.style.overflow = 'hidden';
    document.getElementById(id)?.querySelector('input, textarea, select')?.focus();
  },

  closeDrawer(id) {
    document.getElementById(id)?.classList.remove('open');
    if (!document.querySelector('.drawer.open, .modal.open, .palette.open')) {
      document.getElementById('scrim')?.classList.remove('open');
      document.body.style.overflow = '';
    }
  },

  // Closes whatever layer is currently on top — used by Esc and the scrim.
  closeTop() {
    const circles = document.getElementById('circleMenu');
    if (circles?.classList.contains('open')) return this.closeCircles();

    const palette = document.getElementById('palette');
    if (palette?.classList.contains('open')) return this.closePalette();

    const modal = document.querySelector('.modal.open');
    if (modal) return this._resolveConfirm(false);

    const drawer = document.querySelector('.drawer.open');
    if (drawer) return this.closeDrawer(drawer.id);

    this.closeNav();
  },

  // ── Confirm dialog ──
  // Replaces window.confirm so destructive actions look like the product.
  confirm({ title = 'Are you sure?', text = '', ok = 'Confirm', danger = true } = {}) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmText').textContent = text;
    const btn = document.getElementById('confirmOk');
    btn.textContent = ok;
    btn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    document.getElementById('confirmModal').classList.add('open');
    document.getElementById('scrim').classList.add('open');
    return new Promise(resolve => { this._confirmResolver = resolve; });
  },

  _resolveConfirm(value) {
    document.getElementById('confirmModal')?.classList.remove('open');
    if (!document.querySelector('.drawer.open')) {
      document.getElementById('scrim')?.classList.remove('open');
      document.body.style.overflow = '';
    }
    if (this._confirmResolver) { this._confirmResolver(value); this._confirmResolver = null; }
  },

  // ── Command palette ──
  _paletteItems: [],
  _paletteIndex: 0,

  openPalette() {
    const el = document.getElementById('palette');
    el.classList.add('open');
    document.getElementById('scrim').classList.add('open');
    const input = document.getElementById('paletteInput');
    input.value = '';
    input.focus();
    input.oninput = () => this._fillPalette(input.value);
    this._fillPalette('');
  },

  closePalette() {
    document.getElementById('palette')?.classList.remove('open');
    if (!document.querySelector('.drawer.open, .modal.open')) {
      document.getElementById('scrim')?.classList.remove('open');
      document.body.style.overflow = '';
    }
  },

  async _fillPalette(term) {
    const q = term.trim().toLowerCase();
    const pages = visibleNav().flatMap(g => g.items.map(i => ({ ...i, group: g.group })))
      .filter(i => !q || i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q))
      .map(i => ({ kind: 'page', label: i.label, sub: i.group, icon: i.icon, href: i.href }));

    let people = [];
    if (q.length >= 2) {
      try {
        const data = await api.get(`/admin/members?search=${encodeURIComponent(q)}&limit=5`);
        people = (data.members || []).map(m => ({
          kind: 'member', label: m.name, sub: m.email, icon: 'profile',
          href: `/admin/member.html?id=${m.id}`
        }));
      } catch { /* palette stays useful even if the lookup fails */ }
    }

    this._paletteItems = [...pages, ...people];
    this._paletteIndex = 0;
    this._renderPalette();
  },

  _renderPalette() {
    const list = document.getElementById('paletteList');
    if (!this._paletteItems.length) {
      list.innerHTML = '<div class="empty" style="padding:var(--sp-8)"><div class="empty-text">Nothing matches that.</div></div>';
      return;
    }
    let html = '';
    let lastKind = null;
    this._paletteItems.forEach((item, idx) => {
      if (item.kind !== lastKind) {
        html += `<div class="palette-group">${item.kind === 'page' ? 'Go to' : 'Members'}</div>`;
        lastKind = item.kind;
      }
      html += `
        <button class="palette-item${idx === this._paletteIndex ? ' active' : ''}" data-idx="${idx}"
                onclick="Shell._runPalette(${idx})" onmouseenter="Shell._hoverPalette(${idx})">
          ${icon(item.icon, 14)}
          <span>${escapeHtml(item.label)}</span>
          <span class="sub">${escapeHtml(item.sub || '')}</span>
        </button>`;
    });
    list.innerHTML = html;
  },

  _hoverPalette(idx) { this._paletteIndex = idx; this._syncPalette(); },

  _movePalette(delta) {
    const n = this._paletteItems.length;
    if (!n) return;
    this._paletteIndex = (this._paletteIndex + delta + n) % n;
    this._syncPalette();
    document.querySelector(`.palette-item[data-idx="${this._paletteIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  },

  _syncPalette() {
    document.querySelectorAll('.palette-item').forEach(el => {
      el.classList.toggle('active', Number(el.dataset.idx) === this._paletteIndex);
    });
  },

  _runPalette(idx) {
    const item = this._paletteItems[idx ?? this._paletteIndex];
    if (item) window.location.href = item.href;
  },

  // Unread marker on the portal bell.
  async _loadUnread() {
    try {
      const data = await api.get('/users/notifications?limit=1');
      if (Number(data.unread_count || 0)) document.getElementById('bellUnread')?.classList.remove('hide');
    } catch { /* the bell simply stays quiet */ }
  }
};

// ─── Shared render helpers ──────────────────────────────────
// Small builders the pages call so that a member, a badge or an empty state
// looks identical wherever it appears.

function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function avatar(name, cls = '') {
  return `<span class="avatar ${cls}">${initials(name)}</span>`;
}

// Engagement depth drawn as rings around the avatar: more rings, deeper in.
function orbitAvatar(name, level = 1, cls = '') {
  const rings = Array.from({ length: Math.max(0, Math.min(4, level)) }, () => '<span class="ring"></span>').join('');
  return `<span class="orbit">${rings}${avatar(name, cls)}</span>`;
}

// Engagement level from streak length — the product's one shared definition.
function orbitLevel(streak = 0) {
  if (streak >= 30) return 4;
  if (streak >= 14) return 3;
  if (streak >= 5) return 2;
  return 1;
}

function identityCell(name, sub, level) {
  return `
    <div class="identity">
      ${level ? orbitAvatar(name, level) : avatar(name)}
      <div class="identity-meta">
        <div class="identity-name">${escapeHtml(name || '—')}</div>
        <div class="identity-sub">${escapeHtml(sub || '')}</div>
      </div>
    </div>`;
}

function badge(text, kind = '') {
  return `<span class="badge ${kind ? 'badge-' + kind : ''}">${escapeHtml(text)}</span>`;
}

function emptyState({ title, text = '', action = '' }) {
  return `
    <div class="empty">
      <div class="empty-title">${escapeHtml(title)}</div>
      ${text ? `<div class="empty-text">${escapeHtml(text)}</div>` : ''}
      ${action}
    </div>`;
}

function skeletonRows(rows = 5, cols = 4) {
  return Array.from({ length: rows }, () => `
    <tr>${Array.from({ length: cols }, (_, c) => `
      <td><div class="skeleton" style="width:${c === 0 ? 60 : 30 + (c * 10)}%"></div></td>`).join('')}
    </tr>`).join('');
}

function money(value, currency = 'NGN') {
  const symbol = currency === 'NGN' ? '₦' : currency === 'USD' ? '$' : '';
  return `${symbol}${Number(value || 0).toLocaleString()}`;
}

function fmtDateTime(str) {
  if (!str) return '—';
  return new Date(str.replace(' ', 'T')).toLocaleString('en-NG', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
}

// Read a query-string parameter — detail pages are addressable by id.
function param(key) {
  return new URLSearchParams(window.location.search).get(key);
}
