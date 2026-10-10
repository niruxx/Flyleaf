// Hash router and shared session state.

export const session = { user: null };

const routes = [];
let leaveHandlers = [];
let renderToken = 0;
let currentPath = null;
let prevPath = null;

/** The route shown before the current one (null on first load). */
export const previousPath = () => prevPath;

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

export async function render() {
  const token = ++renderToken;
  for (const fn of leaveHandlers.splice(0)) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
  const [path = '/', query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
  let match = null;
  if (path !== currentPath) {
    prevPath = currentPath;
    currentPath = path;
  }
  const params = { query: new URLSearchParams(query) };
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) {
      match = r;
      r.keys.forEach((k, i) => (params[k] = m[i + 1] != null ? decodeURIComponent(m[i + 1]) : undefined));
      break;
    }
  }
  if (!match) return navigate('/', { replace: true });
  if (match.auth && !session.user) return navigate('/login', { replace: true });

  document.body.classList.toggle('bare', match.bare);
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === match.nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  const view = document.getElementById('view');
  view.replaceChildren();
  window.scrollTo(0, 0);
  try {
    await match.handler(view, params, () => token !== renderToken);
  } catch (err) {
    console.error(err);
    if (token !== renderToken) return;
    const { h, icon } = await import('./ui.js');
    view.replaceChildren(
      h('div.empty', icon('error'), h('h2.title-large', 'Something went wrong'), h('p.body-medium', err.message), h('a.btn.tonal', { href: '#/' }, 'Go home')),
    );
  }
}

addEventListener('popstate', render);
