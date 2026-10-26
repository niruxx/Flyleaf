// Flyleaf service worker: keeps the app shell available offline, caches covers, and serves
// books saved for offline reading (flyleaf-offline, never cleared on update). Other API calls
// always go to the network.

const VERSION = 'flyleaf-v14';
const SHELL = [
  '/',
  '/css/m3.css',
  '/css/app.css',
  '/css/ambience.css',
  '/css/motion.css',
  '/js/motion.js',
  '/js/main.js',
  '/js/offline.js',
  '/js/views/offline.js',
  '/js/api.js',
  '/js/ui.js',
  '/js/router.js',
  '/js/shell.js',
  '/js/theme.js',
  '/css/reader.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'flyleaf-covers' && k !== 'flyleaf-offline').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Books saved for offline reading (see js/offline.js): files and pages from the cache,
  // reader data from the network when it's there.
  if (OFFLINE_RE.test(url.pathname)) {
    event.respondWith(fromOffline(req, url));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;

  // App shell & static assets: network first, fall back to cache when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (url.pathname.startsWith('/vendor/') || SHELL.includes(url.pathname) || /\.(js|css|woff2|png|svg)$/.test(url.pathname))) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('/') : Response.error())),
  );
});

const OFFLINE_RE = /^\/api\/books\/\d+\/(reader|file|cover|pages(\/\d+)?)$/;

async function fromOffline(req, url) {
  // Page images are saved at full size; the data-saver width doesn't change what's offline.
  const key = new URL(url);
  key.searchParams.delete('w');
  const saved = await (await caches.open('flyleaf-offline')).match(key.pathname + key.search);
  const kind = url.pathname.split('/')[4];

  if (kind === 'reader') {
    // Fresh progress and notes when online; the saved copy when not.
    try {
      const res = await fetch(req);
      if (res.ok || !saved) return res;
    } catch (e) {
      if (!saved) throw e;
    }
    return saved;
  }
  if (saved && !req.headers.has('range')) return saved;
  if (kind === 'cover') {
    // Covers are immutable per ?v= – cache-first.
    const cache = await caches.open('flyleaf-covers');
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  }
  return fetch(req);
}

// Push notifications (Settings → Notifications). Payload: { title, body, url, tag }.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Flyleaf', {
      body: data.body || '',
      tag: data.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.startsWith(self.location.origin));
      if (open) return open.navigate(url).then((c) => (c || open).focus());
      return self.clients.openWindow(url);
    }),
  );
});
