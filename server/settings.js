'use strict';

// Server-wide settings (admin): stored as JSON values in the settings table.

const { q } = require('./db');

const DEFAULTS = {
  comicvineKey: '',
  googleBooksKey: '',
  malClientId: '',
  publicUrl: '',
  opdsEnabled: true,
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
  // Public sign-up: sharedLibraries 'all' | 'none'; permissions as auth.PERMISSION_DEFAULTS (null = defaults).
  registration: { enabled: false, inviteCode: '', sharedLibraries: 'all', permissions: null },
};

const cache = new Map();

function get(key) {
  if (cache.has(key)) return cache.get(key);
  const row = q('SELECT value FROM settings WHERE key = ?').get(key);
  let value = DEFAULTS[key];
  if (row) {
    try {
      value = JSON.parse(row.value);
    } catch {}
  }
  cache.set(key, value);
  return value;
}

function set(key, value) {
  q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  cache.set(key, value);
}

function all() {
  return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, get(k)]));
}

/** Forget cached values (after a backup is restored). */
const clearCache = () => cache.clear();

module.exports = { get, set, all, clearCache, DEFAULTS };
