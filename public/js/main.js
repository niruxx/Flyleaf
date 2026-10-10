import { api, setUnauthorizedHandler } from './api.js';
import { route, render, session, navigate } from './router.js';
import { syncThemeColor } from './ui.js';
import { initShell, afterSignIn } from './shell.js';
import { setupView, loginView } from './views/auth.js';
import { homeView } from './views/home.js';
import { libraryView, wantView, genreView, personView, tagView, searchView, collectionView } from './views/browse.js';
import { seriesView } from './views/series.js';
import { collectionsView } from './views/collections.js';
import { bookmarksView } from './views/bookmarks.js';
import { statsView } from './views/stats.js';
import { settingsView } from './views/settings.js';
import { readerView } from './reader/reader.js';

route('/setup', setupView, { bare: true, auth: false });
route('/login', loginView, { bare: true, auth: false });
route('/', homeView);
route('/library/:id?', libraryView);
route('/want-to-read', wantView);
route('/genre/:name', genreView);
route('/person/:name', personView);
route('/tag/:name', tagView);
route('/search', searchView);
route('/collections', collectionsView);
route('/collection/:id', collectionView);
route('/series/:id', seriesView);
route('/bookmarks', bookmarksView);
route('/stats', statsView);
route('/settings/:tab?', settingsView);
route('/read/:id', readerView, { bare: true });
// Old links from v1.
route('/book/:id', async (view, params) => {
  const b = await api.book(params.id).catch(() => null);
  navigate(b?.seriesId ? `/series/${b.seriesId}` : '/', { replace: true });
});

setUnauthorizedHandler(() => {
  session.user = null;
  if (!location.hash.startsWith('#/login')) navigate('/login', { replace: true });
});

async function boot() {
  syncThemeColor();
  initShell();
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
  if (session.user) afterSignIn();
  render();
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
