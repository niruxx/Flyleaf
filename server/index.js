'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
require('./db');
const auth = require('./auth');
const scanner = require('./scanner');
const archive = require('./archive');

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  });
  next();
});

// ---------------------------------------------------------------------------
// API

const api = express.Router();
api.use(express.json({ limit: '256kb' }));
api.use(auth.sessionMiddleware);
api.use(auth.csrfGuard);
api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const authRoutes = require('./routes/auth');
api.use(authRoutes.router);
api.use(auth.requireUser);
api.use('/users', authRoutes.users);
api.use(require('./routes/library').router);
api.use(require('./routes/reading').router);

api.use((req, res) => res.status(404).json({ error: 'Not found.' }));
api.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong on the server.' });
});

app.use('/api', api);

// ---------------------------------------------------------------------------
// Static front-end and vendored client libraries

const nm = (p) => path.join(config.root, 'node_modules', p);
const staticOpts = { maxAge: '7d', immutable: false };
const vendor = {
  '/vendor/epub': nm('epubjs/dist'),
  '/vendor/jszip': nm('jszip/dist'),
  '/vendor/pdfjs': nm('pdfjs-dist/legacy/build'),
  '/vendor/symbols': nm('material-symbols'),
  '/vendor/roboto-flex': nm('@fontsource-variable/roboto-flex'),
};
for (const [url, dir] of Object.entries(vendor)) {
  app.use(
    url,
    express.static(dir, {
      ...staticOpts,
      setHeaders(res, file) {
        if (file.endsWith('.mjs')) res.type('text/javascript');
      },
    }),
  );
}

const publicDir = path.join(config.root, 'public');
app.use(
  express.static(publicDir, {
    index: false,
    setHeaders(res, file) {
      // The app shell must revalidate so updates roll out; the service worker handles offline.
      if (/\.(html|js|css|webmanifest)$/.test(file)) res.set('Cache-Control', 'no-cache');
      if (file.endsWith('sw.js')) res.set('Service-Worker-Allowed', '/');
    },
  }),
);

// SPA fallback.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ---------------------------------------------------------------------------

app.listen(config.port, config.host, () => {
  console.log(`Flyleaf is running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
});

auth.pruneSessions();
archive.pruneRarCache().catch(() => {});
scanner.requestScan(null);
if (config.scanInterval > 0) {
  setInterval(() => scanner.requestScan(null), config.scanInterval * 60_000).unref();
}
setInterval(auth.pruneSessions, 6 * 3600_000).unref();
