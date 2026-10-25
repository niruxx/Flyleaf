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
    const done = new Promise((resolve, reject) => {
      zip.on('error', reject);
      out.on('close', resolve);
      out.on('finish', resolve);
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

module.exports = { create, estimate, receive, inspect, restore };
