import { api, setUnauthorizedHandler } from './api.js';
import { route, render, session, navigate } from './router.js';
import { syncThemeColor } from './ui.js';
import { setupView, loginView } from './views/auth.js';
import { homeView } from './views/home.js';
import { libraryView, seriesView } from './views/library.js';
import { bookView } from './views/book.js';
import { statsView } from './views/stats.js';
import { settingsView } from './views/settings.js';
import { readerView } from './reader/reader.js';

route('/setup', setupView, { bare: true, auth: false });
route('/login', loginView, { bare: true, auth: false });
route('/', homeView, { nav: 'home' });
route('/library/:id?', libraryView, { nav: 'library' });
route('/series/:lib/:name', seriesView, { nav: 'library' });
route('/book/:id', bookView, { nav: 'library' });
route('/read/:id', readerView, { bare: true });
route('/stats', statsView, { nav: 'stats' });
route('/settings', settingsView, { nav: 'settings' });

setUnauthorizedHandler(() => {
  session.user = null;
  if (!location.hash.startsWith('#/login')) navigate('/login', { replace: true });
});

async function boot() {
  syncThemeColor();
  let status;
  try {
    status = await api.status();
  } catch (err) {
    document.getElementById('view').textContent = err.message;
    return;
  }
  session.user = status.user;
  const hash = location.hash.replace(/^#/, '');
  if (status.needsSetup) {
    history.replaceState(null, '', '#/setup');
  } else if (!status.user && hash !== '/login') {
    sessionStorage.setItem('flyleaf.after-login', hash || '/');
    history.replaceState(null, '', '#/login');
  } else if (status.user && (hash === '/login' || hash === '/setup')) {
    history.replaceState(null, '', '#/');
  }
  render();
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
