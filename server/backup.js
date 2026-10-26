'use strict';

// Backups from the admin panel: a zip holding a consistent copy of the database plus the
// small files it points at (covers, profile pictures, backgrounds, fonts) and, optionally,
// every library's book files.
//
//   manifest.json            { app, version, schema, createdAt, includesBooks, libraries: [{ id, name, path }] }
//   flyleaf.db               VACUUM INTO snapshot
//   data/<dir>/...           covers, avatars, backgrounds, fonts
//   books/<library id>/...   library files (only when includesBooks)

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const config = require('./config');
const db = require('./db');
const log = require('./log').logger('backup');

const DATA_DIRS = ['covers', 'avatars', 'backgrounds', 'fonts'];
const err = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

const version = () => require('../package.json').version;

/** Every file under `dir`, as paths relative to it. Skips hidden files. */
async function walk(dir, rel = '') {
  let entries;
  try {
    entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Folder sizes for the admin panel, so they know what a backup with books will weigh. */
async function estimate() {
  const sizeOf = async (dir) => {
    let n = 0;
    for (const f of await walk(dir)) n += (await fsp.stat(path.join(dir, f)).catch(() => ({ size: 0 }))).size;
    return n;
  };
  let dbSize = 0;
  for (const f of [db.DB_PATH, `${db.DB_PATH}-wal`]) dbSize += (await fsp.stat(f).catch(() => ({ size: 0 }))).size;
  let data = 0;
  for (const d of DATA_DIRS) data += await sizeOf(path.join(config.dataDir, d));
  const books = db.q('SELECT COALESCE(SUM(size), 0) AS n, COUNT(*) AS files FROM books WHERE missing = 0').get();
  return { database: dbSize, data, books: books.n, bookFiles: books.files };
}

/** Stream a backup zip to `out` (an HTTP response). */
async function create(out, { includeBooks = false } = {}) {
  const { ZipArchive } = require('archiver');
  const tmp = path.join(config.dataDir, `backup-${crypto.randomBytes(6).toString('hex')}.db`);
  db.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  try {
    const libraries = db.q('SELECT id, name, path FROM libraries ORDER BY id').all();
    const zip = new ZipArchive({ zlib: { level: 6 } });
    // "close" (not "finish"): a backup file must be closed before it's renamed into place.
    const done = new Promise((resolve, reject) => {
      zip.on('error', reject);
      out.on('error', reject);
      out.on('close', resolve);
    });
    zip.on('warning', (e) => log.warn(e.message));
    zip.pipe(out);
    zip.append(JSON.stringify({
      app: 'flyleaf',
      version: version(),
      schema: db.SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      includesBooks: includeBooks,
      libraries,
    }, null, 2), { name: 'manifest.json' });
    zip.file(tmp, { name: 'flyleaf.db' });
    for (const d of DATA_DIRS) {
      const dir = path.join(config.dataDir, d);
      if (fs.existsSync(dir)) zip.directory(dir, `data/${d}`);
    }
    if (includeBooks) {
      for (const lib of libraries) {
        // Book files are already compressed; storing them keeps big backups fast.
        for (const rel of await walk(lib.path)) zip.file(path.join(lib.path, rel), { name: `books/${lib.id}/${rel}`, store: true });
      }
    }
    await zip.finalize();
    await done;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Restore

/** Save an uploaded zip (request body) to a temporary file. */
async function receive(req) {
  const file = path.join(config.dataDir, `restore-${crypto.randomBytes(6).toString('hex')}.zip`);
  await pipeline(req, fs.createWriteStream(file));
  return file;
}

const safeRel = (rel) => {
  const parts = rel.split('/').filter((p) => p && p !== '.' && p !== '..');
  return parts.length ? path.join(...parts) : null;
};

/** Read manifest.json without extracting anything else. */
async function inspect(file) {
  const yauzl = require('yauzl');
  const zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false, strictFileNames: false }).catch(() => {
    throw err('That file isn’t a Flyleaf backup (it’s not a zip).');
  });
  try {
    let manifest = null;
    let hasDb = false;
    let books = 0;
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName === 'manifest.json') {
        const chunks = [];
        for await (const c of await zip.openReadStreamPromise(entry)) chunks.push(c);
        manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } else if (entry.fileName === 'flyleaf.db') hasDb = true;
      else if (entry.fileName.startsWith('books/') && !entry.fileName.endsWith('/')) books++;
    }
    if (manifest?.app !== 'flyleaf' || !hasDb) throw err('That file isn’t a Flyleaf backup.');
    if (manifest.schema > db.SCHEMA_VERSION) throw err(`That backup is from a newer Flyleaf (${manifest.version}). Update Flyleaf first, then restore it.`);
    return { ...manifest, bookFiles: books };
  } finally {
    zip.close();
  }
}

/**
 * Restore a backup: replaces the database and the data folders, and (when asked and present)
 * writes book files back into their library folders. Existing book files are overwritten;
 * other files in the libraries are left alone.
 */
async function restore(file, { includeBooks = false } = {}) {
  const manifest = await inspect(file);
  const yauzl = require('yauzl');
  const staging = path.join(config.dataDir, `restore-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.mkdir(staging, { recursive: true });
  const zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false, strictFileNames: false });
  const bookEntries = [];
  try {
    // 1. Database and data folders go to a staging folder first, so a broken zip changes nothing.
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (name.endsWith('/')) continue;
      if (name.startsWith('books/')) {
        if (includeBooks) bookEntries.push(entry);
        continue;
      }
      if (name !== 'flyleaf.db' && !DATA_DIRS.some((d) => name.startsWith(`data/${d}/`))) continue;
      const rel = safeRel(name);
      if (!rel) continue;
      const target = path.join(staging, rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await pipeline(await zip.openReadStreamPromise(entry), fs.createWriteStream(target));
    }

    const stagedDb = path.join(staging, 'flyleaf.db');
    const { DatabaseSync } = require('node:sqlite');
    try {
      const check = new DatabaseSync(stagedDb, { readOnly: true });
      check.prepare('SELECT COUNT(*) AS n FROM users').get();
      check.close();
    } catch {
      throw err('The database in that backup is damaged.');
    }

    // 2. Swap in the database, then the data folders.
    db.reopen((live) => {
      for (const ext of ['-wal', '-shm']) fs.rmSync(live + ext, { force: true });
      fs.copyFileSync(stagedDb, live);
    });
    for (const d of DATA_DIRS) {
      const from = path.join(staging, 'data', d);
      const to = path.join(config.dataDir, d);
      if (!fs.existsSync(from)) continue;
      await fsp.rm(to, { recursive: true, force: true });
      await fsp.rename(from, to).catch(async () => {
        await fsp.cp(from, to, { recursive: true });
      });
    }

    // 3. Book files, into the library folders as the restored database knows them.
    let written = 0;
    const failed = [];
    if (bookEntries.length) {
      const libs = new Map(db.q('SELECT id, path FROM libraries').all().map((l) => [String(l.id), l.path]));
      for (const entry of bookEntries) {
        const [, libId, ...rest] = entry.fileName.split('/');
        const root = libs.get(libId);
        const rel = safeRel(rest.join('/'));
        if (!root || !rel) continue;
        const target = path.resolve(root, rel);
        if (!target.startsWith(path.resolve(root) + path.sep)) continue;
        try {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await pipeline(await zip.openReadStreamPromise(entry), fs.createWriteStream(target));
          written++;
        } catch (e) {
          if (failed.length < 5) failed.push(`${rel}: ${e.code || e.message}`);
        }
      }
    }

    // 4. Forget anything cached from the old database.
    require('./settings').clearCache();
    require('./plugins/manager').refreshSources?.();
    require('./scanner').requestScan(null);
    log.info(`Restored a backup from ${manifest.createdAt}${written ? ` with ${written} book files` : ''}`);
    return { createdAt: manifest.createdAt, version: manifest.version, bookFiles: written, failed };
  } finally {
    zip.close();
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Scheduled backups: kept in a folder (data/backups/auto, or another disk), the newest N kept.

const SCHEDULE = 'backupSchedule';
const SCHEDULE_DEFAULTS = { enabled: false, every: 'daily', hour: 3, keep: 7, includeBooks: false, folder: '' };
const NAME_RE = /^flyleaf-backup-[\w-]+\.zip$/;
let backupRunning = null;

const schedule = () => ({ ...SCHEDULE_DEFAULTS, ...(require('./settings').get(SCHEDULE) || {}) });
const backupFolder = (s = schedule()) => (s.folder ? path.resolve(s.folder) : path.join(config.dataDir, 'backups', 'auto'));

function setSchedule(patch) {
  const cur = schedule();
  const next = {
    enabled: patch.enabled === undefined ? cur.enabled : Boolean(patch.enabled),
    every: ['daily', 'weekly'].includes(patch.every) ? patch.every : cur.every,
    hour: patch.hour === undefined ? cur.hour : Math.min(23, Math.max(0, Math.round(Number(patch.hour) || 0))),
    keep: patch.keep === undefined ? cur.keep : Math.min(100, Math.max(1, Math.round(Number(patch.keep) || 1))),
    includeBooks: patch.includeBooks === undefined ? cur.includeBooks : Boolean(patch.includeBooks),
    folder: patch.folder === undefined ? cur.folder : String(patch.folder || '').trim(),
  };
  if (next.folder) {
    if (!path.isAbsolute(next.folder)) throw err('The backup folder must be an absolute path, e.g. /mnt/backup/flyleaf.');
    try {
      fs.mkdirSync(next.folder, { recursive: true });
      fs.accessSync(next.folder, fs.constants.W_OK);
    } catch (e) {
      throw err(`Flyleaf can’t write to ${next.folder} (${e.code || e.message}).`);
    }
  }
  require('./settings').set(SCHEDULE, next);
  return next;
}

/** Stored backups, newest first. */
async function listStored() {
  const dir = backupFolder();
  let names = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => NAME_RE.test(n));
  } catch {}
  const out = [];
  for (const name of names) {
    const st = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (st) out.push({ name, size: st.size, createdAt: st.mtimeMs, books: name.includes('-with-books') });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** A stored backup's full path, refusing anything that isn't one of ours. */
function storedPath(name) {
  if (!NAME_RE.test(String(name))) throw err('That isn’t a Flyleaf backup.', 404);
  const file = path.join(backupFolder(), name);
  if (!fs.existsSync(file)) throw err('That backup is gone.', 404);
  return file;
}

/** Write a backup into the backup folder now, then remove the oldest beyond `keep`. */
async function runScheduled({ manual = false } = {}) {
  if (backupRunning) return backupRunning;
  backupRunning = (async () => {
    const s = schedule();
    const dir = backupFolder(s);
    await fsp.mkdir(dir, { recursive: true });
    // To the second, so a manual backup right after a scheduled one doesn't replace it.
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const name = `flyleaf-backup-${stamp}${s.includeBooks ? '-with-books' : ''}.zip`;
    const tmp = path.join(dir, `.${name}.part`);
    try {
      await create(fs.createWriteStream(tmp), { includeBooks: s.includeBooks });
      await fsp.rename(tmp, path.join(dir, name));
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      require('./settings').set('backupLast', { at: Date.now(), error: e.message });
      log.warn(`Backup failed: ${e.message}`);
      throw e;
    }
    for (const old of (await listStored()).slice(s.keep)) await fsp.rm(path.join(dir, old.name), { force: true }).catch(() => {});
    require('./settings').set('backupLast', { at: Date.now(), name, error: null });
    log.info(`${manual ? 'Backup' : 'Scheduled backup'} saved: ${path.join(dir, name)}`);
    return { name };
  })().finally(() => {
    backupRunning = null;
  });
  return backupRunning;
}

/** Whether a scheduled backup is due: at the chosen hour, once a day or once a week. */
function due(now = new Date()) {
  const s = schedule();
  if (!s.enabled) return false;
  const last = require('./settings').get('backupLast')?.at || 0;
  const gap = (s.every === 'weekly' ? 7 : 1) * 86400_000;
  // At or after the chosen hour, and not since the last slot.
  const slot = new Date(now);
  slot.setHours(s.hour, 0, 0, 0);
  if (slot > now) slot.setDate(slot.getDate() - 1);
  return now - last >= gap - 3600_000 && last < slot.getTime();
}

function startSchedule() {
  setInterval(() => {
    if (due()) runScheduled().catch(() => {});
  }, 10 * 60_000).unref();
}

module.exports = {
  create, estimate, receive, inspect, restore,
  schedule, setSchedule, listStored, storedPath, runScheduled, startSchedule, backupFolder, isRunning: () => Boolean(backupRunning),
};
