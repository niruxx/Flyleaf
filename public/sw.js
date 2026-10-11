// Flyleaf service worker: keeps the app shell available offline and caches
// covers. Book files, pages and API data always go to the network.

const VERSION = 'flyleaf-v3';
const SHELL = [
  '/',
  '/css/m3.css',
  '/css/app.css',
  '/js/main.js',
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
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'flyleaf-covers').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Covers are immutable per ?v= – cache-first.
  if (/^\/api\/books\/\d+\/cover$/.test(url.pathname)) {
    event.respondWith(
      caches.open('flyleaf-covers').then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
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
