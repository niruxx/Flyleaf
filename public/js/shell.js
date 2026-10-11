// App chrome: top app bar with centred search, navigation drawer, bottom navigation.

import { api, can } from './api.js';
import { session, navigate, onRoute, isAdmin } from './router.js';
import { h, icon, iconButton, menu, cover } from './ui.js';
import { setTheme } from './prefs.js';
import { isDark, themeState } from './theme.js';
import { themeReveal } from './motion.js';

let drawerData = { libraries: [], collections: [], genres: [] };
let showAllGenres = false;

export function initShell() {
  const bar = document.querySelector('.app-bar');
  bar.querySelector('.menu-toggle').addEventListener('click', () => document.body.classList.toggle('drawer-open'));
  document.querySelector('.scrim').addEventListener('click', () => document.body.classList.remove('drawer-open'));
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.body.classList.remove('drawer-open');
  });
  addEventListener('scroll', () => document.body.classList.toggle('scrolled', scrollY > 4), { passive: true });

  buildSearch(document.querySelector('.app-search'));
  onRoute(({ r, full }) => {
    if (r.bare) return;
    highlight(full);
  });
}

/** Rebuild account-dependent chrome (after sign-in, or when libraries/collections change). */
export async function refreshShell() {
  if (!session.user) return;
  buildEnd(document.querySelector('.app-bar .end'));
  try {
    const [libraries, collections, genres] = await Promise.all([api.libraries(), api.collections(), api.genres()]);
    drawerData = { libraries, collections, genres };
  } catch {}
  buildDrawer();
  highlight(location.hash.replace(/^#/, '') || '/');
}

// ---------------------------------------------------------------------------
// Top bar actions

function buildEnd(end) {
  const u = session.user;
  const toggle = iconButton(isDark() ? 'light_mode' : 'dark_mode', 'Toggle dark mode', (e) => {
    // The new theme spreads out in a circle from the button.
    themeReveal(e, () => {
      setTheme({ mode: isDark() ? 'light' : 'dark' });
      toggle.querySelector('.icon').textContent = isDark() ? 'light_mode' : 'dark_mode';
    });
  });
  const avatar = h('button.avatar', { type: 'button', title: u.displayName, 'aria-label': 'Account menu' }, (u.displayName || u.username || '?').trim()[0]);
  avatar.addEventListener('click', () => {
    const mode = themeState().mode;
    menu(avatar, [
      { header: `${u.displayName} · ${u.role === 'admin' ? 'Admin' : 'Guest'}` },
      { label: 'Account settings', icon: 'manage_accounts', onClick: () => navigate('/settings/account') },
      { label: 'Reading stats', icon: 'insights', onClick: () => navigate('/stats') },
      '-',
      { label: 'Light', icon: 'light_mode', checked: mode === 'light', onClick: () => setTheme({ mode: 'light' }) },
      { label: 'Dark', icon: 'dark_mode', checked: mode === 'dark', onClick: () => setTheme({ mode: 'dark' }) },
      { label: 'System', icon: 'contrast', checked: mode === 'system', onClick: () => setTheme({ mode: 'system' }) },
      '-',
      { label: 'Sign out', icon: 'logout', onClick: signOut },
    ]);
  });
  end.replaceChildren(toggle, avatar);
}

export async function signOut() {
  await api.logout().catch(() => {});
  session.user = null;
  navigate('/login', { replace: true });
}

// ---------------------------------------------------------------------------
// Search with live suggestions

function buildSearch(host) {
  const input = h('input', { type: 'search', placeholder: 'Search series, books, people…', 'aria-label': 'Search', autocomplete: 'off', enterkeyhint: 'search' });
  const clear = iconButton('close', 'Clear search', () => {
    input.value = '';
    close();
    input.focus();
  });
  clear.hidden = true;
  const kbd = h('kbd', '/');
  const bar = h('div.search-bar', icon('search'), input, kbd, clear);
  host.replaceChildren(bar);

  let panel = null;
  let items = [];
  let active = -1;
  let timer;
  let req = 0;

  function close() {
    panel?.remove();
    panel = null;
    host.classList.remove('open');
    active = -1;
  }
  function go(to) {
    close();
    input.blur();
    navigate(to);
  }

  async function suggest() {
    const term = input.value.trim();
    clear.hidden = !term;
    kbd.hidden = Boolean(term);
    if (!term) return close();
    const id = ++req;
    let r;
    try {
      r = await api.search(term, 6);
    } catch {
      return;
    }
    if (id !== req) return;
    items = [];
    const groups = [];
    const add = (label, rows) => rows.length && groups.push(h('div.group-label', label), ...rows);
    add('Series', r.series.map((s) => item(cover(s, { showProgress: false }), s.name, [s.authors.join(', '), s.libraryName].filter(Boolean).join(' · '), `/series/${s.id}`)));
    add('Books', r.books.map((b) => item(cover(b, { showProgress: false }), b.label, b.series || b.author || '', `/read/${b.id}`)));
    add('People', r.people.map((p) => item(null, p, 'Creator', `/person/${encodeURIComponent(p)}`, 'person')));
    add('Genres', r.genres.map((g) => item(null, g, 'Genre', `/genre/${encodeURIComponent(g)}`, 'sell')));
    add('Collections', r.collections.map((c) => item(null, c.name, 'Collection', `/collection/${c.id}`, 'collections_bookmark')));
    const all = item(null, `Search for “${term}”`, 'See all results', `/search?q=${encodeURIComponent(term)}`, 'search');
    if (!panel) {
      panel = h('div.search-panel', { role: 'listbox' });
      host.append(panel);
      host.classList.add('open');
    }
    panel.replaceChildren(...groups, h('hr.divider', { style: { margin: '6px 0' } }), all);
    active = -1;
  }

  function item(thumb, title, sub, to, ic) {
    const el = h('button.list-item.state', { type: 'button', role: 'option', onclick: () => go(to) },
      thumb ? h('div.thumb', thumb) : icon(ic || 'search'),
      h('div.text', h('div.headline', { style: { fontSize: '15px' } }, title), sub && h('div.supporting', { style: { fontSize: '13px' } }, sub)),
    );
    el.dataset.to = to;
    items.push(el);
    return el;
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(suggest, 180);
  });
  input.addEventListener('focus', () => input.value.trim() && suggest());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      items[active]?.classList.remove('active');
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[active].classList.add('active');
      items[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const term = input.value.trim();
      if (active >= 0 && items[active]) go(items[active].dataset.to);
      else if (term) go(`/search?q=${encodeURIComponent(term)}`);
    } else if (e.key === 'Escape') {
      close();
      input.blur();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (panel && !host.contains(e.target)) close();
  });
  // "/" focuses search from anywhere.
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea, select, [contenteditable]') && !document.body.classList.contains('bare')) {
      e.preventDefault();
      input.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Drawer

const GENRE_LIMIT = 8;
const KIND_ICON = { books: 'menu_book', manga: 'auto_stories', comics: 'photo_library' };

function navItem(to, ic, label, count, extra = {}) {
  return h('a.nav-item', { href: `#${to}`, dataset: { to }, ...extra }, ic ? icon(ic) : h('span.dot'), h('span.label', label), count != null && h('span.count', String(count)));
}

function buildDrawer() {
  const d = drawerData;
  const genres = showAllGenres ? d.genres : d.genres.slice(0, GENRE_LIMIT);
  const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  const children = [
    navItem('/', 'home', 'Home'),
    navItem('/library', 'local_library', 'All series'),
    navItem('/want-to-read', 'bookmark_heart', 'Want to read'),
    navItem('/bookmarks', 'bookmarks', 'Bookmarks & notes'),
    navItem('/stats', 'insights', 'Reading stats'),
    can(session.user, 'contentFinder') && navItem('/finder', 'travel_explore', 'Content Finder'),
    can(session.user, 'upload') && navItem('/upload', 'upload', 'Upload'),

    d.libraries.length && h('div.section-label', 'Libraries'),
    d.libraries.map((l) => navItem(`/library/${l.id}`, KIND_ICON[l.kind], l.name, l.seriesCount)),

    h('div.section-label', 'Collections', iconButton('add', 'New collection', async () => {
      const { newCollection } = await import('./components/actions.js');
      const id = await newCollection();
      if (id) navigate(`/collection/${id}`);
    })),
    d.collections.length
      ? d.collections.map((c) => navItem(`/collection/${c.id}`, c.promoted ? 'public' : 'collections_bookmark', c.name, c.count))
      : h('a.nav-item', { href: '#/collections' }, icon('library_add'), h('span.label', 'Create a collection')),
    d.collections.length > 0 && navItem('/collections', 'grid_view', 'All collections'),

    d.genres.length && h('div.section-label', 'Genres'),
    genres.map((g) => navItem(`/genre/${encodeURIComponent(g.name)}`, null, g.name, g.count, { style: { '--dot': `oklch(0.7 0.13 ${hue(g.name)})` } })),
    d.genres.length > GENRE_LIMIT &&
      h('button.nav-item.more-toggle', {
        type: 'button',
        onclick: () => {
          showAllGenres = !showAllGenres;
          buildDrawer();
        },
      }, icon(showAllGenres ? 'expand_less' : 'expand_more'), h('span.label', showAllGenres ? 'Show fewer' : `Show all ${d.genres.length} genres`)),

    h('hr'),
    navItem('/settings', 'settings', 'Settings'),
    isAdmin() && navItem('/settings/libraries', 'admin_panel_settings', 'Manage libraries'),
  ];
  document.querySelector('.drawer').replaceChildren(...children.flat(Infinity).filter(Boolean));
  highlight(location.hash.replace(/^#/, '') || '/');
}

function highlight(path) {
  const base = path.split('?')[0];
  const root = base.split('/')[1] || '';
  for (const a of document.querySelectorAll('.drawer .nav-item[data-to]')) {
    const to = a.dataset.to;
    const on = to === base || (to === '/settings' && root === 'settings' && base !== '/settings/libraries');
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const navKey = { '': 'home', library: 'library', series: 'library', genre: 'library', person: 'library', collection: 'library', collections: 'library', search: 'library', 'want-to-read': 'want', bookmarks: 'bookmarks' }[root];
  for (const a of document.querySelectorAll('.bottom-nav a')) {
    if (a.dataset.nav === navKey) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}


/** Called once a user is known (boot, sign-in, setup). */
export function afterSignIn() {
  import('./prefs.js').then(({ applyUserPrefs }) => applyUserPrefs());
  refreshShell();
}
