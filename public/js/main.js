import { api, setUnauthorizedHandler } from './api.js';
import { route, render, session, navigate } from './router.js';
import { syncThemeColor } from './ui.js';
import { initShell, afterSignIn } from './shell.js';
import { initMotion } from './motion.js';
import { setupView, loginView, registerView } from './views/auth.js';
import { welcomeView } from './views/welcome.js';
import { homeView, recommendedView } from './views/home.js';
import { libraryView, wantView, genreView, personView, tagView, searchView, collectionView } from './views/browse.js';
import { seriesView } from './views/series.js';
import { collectionsView } from './views/collections.js';
import { bookmarksView } from './views/bookmarks.js';
import { statsView, yearReviewView } from './views/stats.js';
import { settingsView } from './views/settings.js';
import { readerView } from './reader/reader.js';
import { offlineView } from './views/offline.js';
import { lastUser, rememberUser, flushProgress, savedBooks } from './offline.js';
import { snackbar } from './ui.js';
import { t, initLanguage, setLanguage, currentLanguage } from './i18n.js';

route('/setup', setupView, { bare: true, auth: false });
route('/login', loginView, { bare: true, auth: false });
route('/register', registerView, { bare: true, auth: false });
route('/welcome', welcomeView, { bare: true });
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
route('/recommended', recommendedView);
route('/stats', statsView);
route('/stats/year/:year?', yearReviewView);
route('/finder', (...a) => import('./views/finder.js').then((m) => m.finderView(...a)));
route('/upload', (...a) => import('./views/upload.js').then((m) => m.uploadView(...a)));
route('/finder/downloads', (...a) => import('./views/finder.js').then((m) => m.downloadsView(...a)));
route('/finder/following', (...a) => import('./views/finder.js').then((m) => m.followingView(...a)));
route('/offline', offlineView);
route('/settings/:tab?', settingsView);
route('/admin/users/:id/files', (...a) => import('./views/settings-admin.js').then((m) => m.userFilesView(...a)));
route('/admin/duplicates', (...a) => import('./views/settings-admin.js').then((m) => m.duplicatesView(...a)));
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
  // The language: your setting (remembered from last time), else the browser's.
  await initLanguage(lastUser()?.prefs?.language || null);
  initShell();
  initMotion();
  let status;
  try {
    status = await api.status();
  } catch (err) {
    // No connection: open what's saved on this device, as the last signed-in user.
    const user = lastUser();
    if (err.status === 0 && user) {
      session.user = user;
      document.body.classList.add('is-offline');
      const hash = location.hash.replace(/^#/, '');
      if (!hash.startsWith('/read/')) history.replaceState(null, '', '#/offline');
      afterSignIn();
      render();
      return;
    }
    document.getElementById('view').textContent = err.message;
    return;
  }
  session.user = status.user;
  rememberUser(status.user);
  flushProgress();
  // Signed in on another device with a different language setting.
  const wanted = status.user?.prefs?.language;
  if (wanted && wanted !== currentLanguage()) {
    await setLanguage(wanted);
    initShell({ again: true });
  }
  const hash = location.hash.replace(/^#/, '');
  if (status.needsSetup) {
    history.replaceState(null, '', '#/setup');
  } else if (!status.user && hash !== '/login' && !(hash === '/register' && status.registration)) {
    sessionStorage.setItem('flyleaf.after-login', hash || '/');
    history.replaceState(null, '', '#/login');
  } else if (status.user && (hash === '/login' || hash === '/setup' || hash === '/register')) {
    history.replaceState(null, '', '#/');
  }
  if (session.user) afterSignIn();
  render();
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Tell people when the connection drops or comes back.
addEventListener('offline', () => {
  document.body.classList.add('is-offline');
  if (!session.user) return;
  snackbar(savedBooks().length ? t('You’re offline. Books saved on this device still open.') : t('You’re offline.'), {
    action: savedBooks().length ? t('Saved books') : undefined,
    onAction: () => navigate('/offline'),
    duration: 6000,
  });
});
addEventListener('online', () => {
  document.body.classList.remove('is-offline');
  if (session.user) snackbar(t('Back online'));
});

boot();
