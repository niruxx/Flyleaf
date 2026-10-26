'use strict';

// Watching library folders: new, changed and removed files show up within seconds instead of at
// the next scheduled scan. Each library folder gets one recursive watcher; a burst of changes
// (a folder being copied in) waits until things have been quiet for a few seconds, then that
// library is scanned. Network shares (SMB, NFS) often don't report changes, so the scheduled
// scan (SCAN_INTERVAL_MINUTES) stays on as a fallback. WATCH_FOLDERS=0 turns watching off.

const fs = require('node:fs');
const path = require('node:path');
const { q } = require('./db');
const log = require('./log').logger('watch');

const ENABLED = process.env.WATCH_FOLDERS !== '0';
const QUIET_MS = Math.max(500, Number(process.env.WATCH_DELAY_SECONDS ?? 5) * 1000); // wait for copies to finish
const MAX_WAIT_MS = 60_000; // …but scan at least once a minute during a long copy
// Temporary files from downloads, editors and copy tools: not worth a scan on their own.
const IGNORED = /(^|[\\/])(\.|@eaDir|#recycle|__MACOSX)|\.(part|partial|crdownload|download|tmp|temp|!ut|aria2)$|~$/i;

const watchers = new Map(); // library id → { path, watcher, timer, first, error }

let realData = null;
/** Flyleaf's data folder as a real, long path (to compare with watched paths). */
function dataDir() {
  if (!realData) {
    const dir = require('./config').dataDir;
    try {
      realData = fs.realpathSync.native(dir);
    } catch {
      realData = path.resolve(dir);
    }
  }
  return realData;
}

/**
 * A "change" event (not a create, delete or rename) for something that hasn't been written since
 * the last scan: Windows reports files being read (last-access time) too, and folders "change"
 * whenever something inside them does – which has its own event.
 */
async function onlyRead(lib, file) {
  try {
    const st = await fs.promises.stat(path.resolve(lib.path, String(file)));
    if (st.isDirectory()) return true;
    const lastScan = q('SELECT last_scan_at FROM libraries WHERE id = ?').get(lib.id)?.last_scan_at || 0;
    return st.mtimeMs < lastScan - 2000;
  } catch {
    return false; // gone: that's a real change
  }
}

async function changed(lib, file, type) {
  const w = watchers.get(lib.id);
  if (!w) return;
  if (file && IGNORED.test(String(file))) return;
  if (type === 'change' && file && (await onlyRead(lib, file))) return;
  // A library that contains Flyleaf's own data folder: the database changing during a scan
  // mustn't start another scan (personal folders under data/content are fine).
  if (file) {
    const full = path.resolve(lib.path, String(file));
    const data = dataDir();
    if (full.startsWith(data + path.sep) && !full.startsWith(path.join(data, 'content') + path.sep)) return;
  }
  const now = Date.now();
  w.first ||= now;
  w.lastChange = now;
  clearTimeout(w.timer);
  // Scan once the folder has been quiet for a moment, or after a minute of non-stop changes.
  const wait = Math.max(0, Math.min(QUIET_MS, w.first + MAX_WAIT_MS - now));
  w.timer = setTimeout(() => {
    w.first = 0;
    w.scans = (w.scans || 0) + 1;
    w.lastScan = Date.now();
    log.file(`"${lib.name}" changed – scanning`);
    require('./scanner').requestScan(lib.id);
  }, wait);
  w.timer.unref?.();
}

function watch(lib) {
  const entry = { path: lib.path, watcher: null, timer: null, first: 0, error: null, since: Date.now() };
  watchers.set(lib.id, entry);
  try {
    // The real, long path: on Windows, watching a path with 8.3 short names (C:\Users\JOHNSM~1)
    // crashes Node when an event arrives (libuv compares it with the long name).
    const real = fs.realpathSync.native(lib.path);
    entry.watcher = fs.watch(real, { recursive: true, persistent: false }, (type, file) => changed({ ...lib, path: real }, file, type).catch(() => {}));
    entry.watcher.on('error', (e) => {
      entry.error = e.message;
      log.file(`Stopped watching "${lib.name}": ${e.message}`);
      entry.watcher?.close();
      entry.watcher = null;
    });
  } catch (e) {
    // ENOSPC: the system's inotify limit; ENOENT: the folder is missing. The scheduled scan still runs.
    entry.error = e.code === 'ENOSPC'
      ? 'The system’s file-watch limit was reached (raise fs.inotify.max_user_watches)'
      : e.message;
    log.file(`Can't watch "${lib.name}" (${lib.path}): ${e.message}`);
  }
}

function unwatch(id) {
  const w = watchers.get(id);
  if (!w) return;
  clearTimeout(w.timer);
  w.watcher?.close();
  watchers.delete(id);
}

/** Start, stop or restart watchers so they match the libraries table. */
function sync() {
  if (!ENABLED) return;
  const libs = q('SELECT id, name, path FROM libraries').all();
  const ids = new Set(libs.map((l) => l.id));
  for (const id of [...watchers.keys()]) if (!ids.has(id)) unwatch(id);
  for (const lib of libs) {
    const w = watchers.get(lib.id);
    if (w && path.resolve(w.path) === path.resolve(lib.path) && (w.watcher || Date.now() - w.since < 10 * 60_000)) continue;
    // New library, a moved folder, or a watcher that failed a while ago (try again).
    unwatch(lib.id);
    watch(lib);
  }
}

/** For the Libraries page: is each library being watched? */
function status(libraryId) {
  if (!ENABLED) return { watching: false, reason: 'off' };
  const w = watchers.get(libraryId);
  if (!w) return { watching: false, reason: 'starting' };
  return { watching: Boolean(w.watcher), error: w.error, lastChange: w.lastChange || null, lastScan: w.lastScan || null };
}

function start() {
  if (!ENABLED) return;
  sync();
  // Libraries added, edited or removed are picked up within half a minute.
  setInterval(sync, 30_000).unref();
  const n = [...watchers.values()].filter((w) => w.watcher).length;
  if (n) log.file(`Watching ${n} ${n === 1 ? 'library folder' : 'library folders'} for changes`);
}

function stop() {
  for (const id of [...watchers.keys()]) unwatch(id);
}

module.exports = { start, stop, sync, status, ENABLED };
