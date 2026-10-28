import { t } from './i18n.js';
// Hash router, shared session state and animated route transitions.

import { motionEnabled } from './theme.js';
import { markNavigation } from './motion.js';

export const session = { user: null };

const routes = [];
let leaveHandlers = [];
let renderToken = 0;
let currentPath = null;
let prevPath = null;
const listeners = new Set();

/** The route shown before the current one (null on first load). */
export const previousPath = () => prevPath;
export const currentRoute = () => currentPath;
/** Called after every route render with the matched route info. */
export const onRoute = (fn) => listeners.add(fn);

export function route(pattern, handler, { bare = false, nav = null, auth = true } = {}) {
  const keys = [];
  const re = new RegExp(
    `^${pattern.replace(/\/:(\w+)\??/g, (m, k) => {
      keys.push(k);
      return m.endsWith('?') ? '(?:/([^/]+))?' : '/([^/]+)';
    })}/?$`,
  );
  routes.push({ re, keys, handler, bare, nav, auth });
}

/** Register cleanup for the current view (event listeners, timers…). */
export function onLeave(fn) {
  leaveHandlers.push(fn);
}

export function navigate(path, { replace = false } = {}) {
  const hash = `#${path}`;
  if (replace) history.replaceState(null, '', hash);
  else if (location.hash !== hash) history.pushState(null, '', hash);
  render();
}

export const isAdmin = () => session.user?.role === 'admin';
export const prefs = () => session.user?.prefs || {};

function resolve() {
  const [path = '/', query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
  const params = { query: new URLSearchParams(query) };
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) {
      r.keys.forEach((k, i) => (params[k] = m[i + 1] != null ? decodeURIComponent(m[i + 1]) : undefined));
      return { r, params, path, full: location.hash.replace(/^#/, '') || '/' };
    }
  }
  return null;
}

export async function render() {
  const token = ++renderToken;
  const match = resolve();
  if (!match) return navigate('/', { replace: true });
  if (match.r.auth && !session.user) return navigate('/login', { replace: true });
  // New accounts go through the setup wizard first.
  if (session.user?.prefs?.onboarded === false && match.path !== '/welcome' && match.r.auth) return navigate('/welcome', { replace: true });

  const run = async () => {
    for (const fn of leaveHandlers.splice(0)) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
    if (match.full !== currentPath) {
      prevPath = currentPath;
      currentPath = match.full;
    }
    // Dialogs, sheets and menus live on <body>; don't let them leak into the next page.
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    document.querySelectorAll('.menu, .sel-toolbar').forEach((m) => m.remove());
    document.body.classList.toggle('bare', match.r.bare);
    document.body.classList.remove('drawer-open');
    const view = document.getElementById('view');
    view.replaceChildren();
    window.scrollTo(0, 0);
    for (const fn of listeners) fn(match);
    try {
      await match.r.handler(view, match.params, () => token !== renderToken);
    } catch (err) {
      console.error(err);
      if (token !== renderToken) return;
      const { h, icon } = await import('./ui.js');
      view.replaceChildren(
        h('div.empty', icon('error'), h('h2.title-large', t('Something went wrong')), h('p.body-medium', err.message), h('a.btn.tonal', { href: '#/' }, t('Go home'))),
      );
    }
  };

  // Animate between pages with the View Transitions API where available.
  if (document.startViewTransition && motionEnabled() && currentPath !== null && !match.r.bare && !document.body.classList.contains('bare')) {
    let resolveReady;
    const ready = new Promise((r) => (resolveReady = r));
    markNavigation();
    const vt = document.startViewTransition(async () => {
      // Snapshot once the new page has content, or after a short cap: pages show
      // skeletons while loading, so the screen never freezes waiting on the network.
      const p = run();
      await Promise.race([p, new Promise((r) => setTimeout(r, 140))]);
      resolveReady();
    });
    vt.finished.catch(() => {});
    vt.ready.catch(() => resolveReady());
    await ready;
  } else {
    await run();
  }
}

addEventListener('popstate', render);
