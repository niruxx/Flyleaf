'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const log = require('./log').logger('server');
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
// OPDS (API-key authenticated, read-only) – mounted before the session API.

app.use('/api/opds', require('./opds').router);

// ---------------------------------------------------------------------------
// API

const api = express.Router();
api.use(express.json({ limit: '512kb' }));
api.use(auth.sessionMiddleware);
// Who did what (Settings → Activity); see activity.js for what's recorded.
api.use(require('./activity').middleware);
api.use(auth.csrfGuard);
api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Machine-readable API description (Settings → API & webhooks renders it).
api.get('/openapi.json', (req, res) => res.json(require('./openapi').build(`${req.protocol}://${req.get('host')}/api`)));

const authRoutes = require('./routes/auth');
const backupRoutes = require('./routes/backup');
const healthRoutes = require('./routes/health');
api.use(authRoutes.router);
api.use(healthRoutes.health);
api.use('/setup/restore', backupRoutes.setup);
api.use(auth.requireUser);
api.use(healthRoutes.metrics);
api.use('/me', authRoutes.me);
api.use('/me', require('./routes/my-libraries').router);
api.use(require('./routes/profile').router);
api.use('/users', authRoutes.users);
api.use('/users', require('./routes/moderation').router);
const finder = require('./routes/finder');
api.use('/admin/plugins', finder.admin);
api.use('/admin', backupRoutes.admin);
api.use('/admin', require('./routes/admin').router);
api.use('/finder', finder.router);
api.use('/uploads', require('./routes/uploads').router);
api.use(require('./routes/library').router);
api.use(require('./routes/series').router);
api.use(require('./routes/books').router);
api.use(require('./routes/reading').router);
api.use(require('./routes/personal').router);
api.use(require('./routes/notifications').router);

api.use((req, res) => res.status(404).json({ error: 'Not found.' }));
api.use((err, req, res, next) => {
  // Expected refusals (bad input, no permission…) go to the log file; only real faults reach the console.
  if (err.expose && (err.status || 500) < 500) log.file(`${req.method} ${req.originalUrl}: ${err.message}`);
  else log.error(`${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong on the server.' });
});

app.use('/api', api);

// ---------------------------------------------------------------------------
// Static front-end and vendored client libraries

const nm = (p) => path.join(config.root, 'node_modules', p);
const vendor = {
  '/vendor/pdfjs': nm('pdfjs-dist/legacy/build'),
  '/vendor/foliate': nm('foliate-js'),
  '/vendor/symbols': nm('material-symbols'),
  '/vendor/roboto-flex': nm('@fontsource-variable/roboto-flex'),
  '/vendor/fonts/literata': nm('@fontsource/literata'),
  '/vendor/fonts/merriweather': nm('@fontsource/merriweather'),
  '/vendor/fonts/atkinson-hyperlegible': nm('@fontsource/atkinson-hyperlegible'),
  '/vendor/fonts/opendyslexic': nm('@fontsource/opendyslexic'),
};
for (const [url, dir] of Object.entries(vendor)) {
  app.use(
    url,
    express.static(dir, {
      maxAge: '7d',
      setHeaders(res, file) {
        if (file.endsWith('.mjs') || file.endsWith('.js')) res.type('text/javascript');
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
  if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/vendor/')) return next();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ---------------------------------------------------------------------------

const server = app.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  log.info(`Flyleaf is running at http://${host}:${config.port}  (data: ${config.dataDir})`);
});
server.on('error', (err) => {
  log.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Set PORT in .env to use another.` : err.message);
  process.exit(1);
});

auth.pruneSessions();
archive.pruneCache().catch(() => {});
scanner.requestScan(null);
require('./plugins/manager').seedBuiltins().then(() => require('./plugins/downloads').resume());
require('./plugins/suwayomi-host').boot();
require('./push').wire();
require('./follows').start();
require('./backup').startSchedule();
require('./activity').start();
// Catch up on full-text indexing a little after start-up.
setTimeout(() => require('./fulltext').indexPending().catch(() => {}), 20_000).unref();
if (config.scanInterval > 0) {
  setInterval(() => scanner.requestScan(null), config.scanInterval * 60_000).unref();
}
setInterval(auth.pruneSessions, 6 * 3600_000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info('Shutting down');
    require('./plugins/suwayomi-host').shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
