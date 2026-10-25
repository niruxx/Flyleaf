'use strict';

const path = require('node:path');

const root = path.resolve(__dirname, '..');

function bool(v, fallback = false) {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const dataDir = path.resolve(root, process.env.FLYLEAF_DATA_DIR || 'data');

module.exports = {
  root,
  port: Number(process.env.PORT) || 7878,
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  coverDir: path.join(dataDir, 'covers'),
  // New users' personal folders: content/<username>/{Books,Comics,Manga}.
  contentDir: path.join(dataDir, 'content'),
  cacheDir: path.join(dataDir, 'cache'),
  // Set when running behind a reverse proxy (Caddy, nginx, Cloudflare tunnel...)
  trustProxy: bool(process.env.TRUST_PROXY),
  // Force the Secure flag on cookies (do this when served over HTTPS).
  secureCookies: bool(process.env.SECURE_COOKIES),
  sessionDays: Number(process.env.SESSION_DAYS) || 30,
  // Automatic rescan interval in minutes (0 disables).
  scanInterval: Number(process.env.SCAN_INTERVAL_MINUTES ?? 60),
};
