'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const config = require('./config');
const { q, tx } = require('./db');
const tasks = require('./tasks');
const storage = require('./storage');
const log = require('./log').logger('storage');

const KIND = 'storage-migration';
const TITLE = 'Personal folder migration';
const error = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });
let active = null;
let writes = 0;

function contains(parent, child) {
  const rel = path.relative(parent, child);
  return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
const overlaps = (a, b) => contains(a, b) || contains(b, a);

// Resolve existing ancestors even for unavailable library paths or new destinations.
function canonical(file) {
  try {
    return fs.realpathSync.native(file);
  } catch (e) {
    const parent = path.dirname(file);
    if (e.code !== 'ENOENT') throw e;
    if (parent === file) return file;
    return path.join(canonical(parent), path.basename(file));
  }
}

function configuredRoots() {
  return [...new Set([config.contentDir, ...(process.env.FLYLEAF_USER_STORAGE_ROOTS || '').split(path.delimiter)
    .map(dir => dir.trim()).filter(dir => path.isAbsolute(dir))])];
}

function protect(dir) {
  const content = canonical(config.contentDir);
  const insideContent = contains(content, dir) && !contains(dir, content);
  const internal = [config.root, config.dataDir].map(canonical);
  if ([...internal, ...configuredRoots().map(canonical)].some(root => contains(dir, root)) ||
      (!insideContent && internal.some(root => contains(root, dir)))) {
    throw error('Choose a dedicated folder outside Flyleaf’s program and server data directories.');
  }
}

function checkPersonalFolder(dir, userId = null) {
  const candidate = canonical(path.resolve(dir));
  for (const other of q('SELECT id, home_dir FROM users WHERE home_dir IS NOT NULL').all()) {
    if (other.id !== userId && overlaps(candidate, canonical(path.resolve(other.home_dir)))) {
      throw error('That folder overlaps another account’s personal folder.', 409);
    }
  }
}

function targets(user, requested, admin) {
  if (typeof requested !== 'string' || !requested.trim() || !path.isAbsolute(requested.trim()) || requested.includes('\0')) {
    throw error('Enter an absolute path on the Flyleaf server.');
  }
  const sourcePath = path.resolve(user.home_dir);
  const source = canonical(sourcePath);
  const target = path.resolve(requested.trim());
  if (process.platform === 'win32' && /:|[. ]$/.test(path.basename(target))) throw error('Enter a valid destination folder name.');
  const parent = canonical(path.dirname(target));
  const destination = path.join(parent, path.basename(target));
  if (!admin && !configuredRoots().map(canonical).some(root => contains(root, destination) && !contains(destination, root))) {
    throw error('Choose a new folder inside one of the storage locations approved by your administrator.', 403);
  }
  protect(source);
  protect(destination);
  if (overlaps(source, destination)) throw error('Choose a folder separate from the current personal folder.');
  if (!fs.lstatSync(sourcePath).isDirectory()) throw error('The current personal folder must be a directory.');
  if (!fs.statSync(parent).isDirectory()) throw error('Create the destination’s parent directory first.');
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw error('Choose a new destination folder. That path already exists.', 409);

  checkPersonalFolder(source, user.id);
  checkPersonalFolder(destination, user.id);
  for (const lib of q('SELECT path, owner_id FROM libraries').all()) {
    const folder = canonical(path.resolve(lib.path));
    if (overlaps(destination, folder) || (overlaps(source, folder) && (lib.owner_id !== user.id || !contains(source, folder)))) {
      throw error('The current folder or destination overlaps another library.', 409);
    }
  }
  return { source, sourcePath, destination, parent };
}

async function* tree(root, device, rel = '') {
  const file = path.join(root, rel);
  const stat = await fsp.lstat(file);
  if ((!stat.isDirectory() && !stat.isFile()) || stat.dev !== device) {
    throw error('The personal folder contains a link, mount, or unsupported file. Remove it before moving the folder.');
  }
  yield [rel, stat];
  if (stat.isDirectory()) {
    const dir = await fsp.opendir(file);
    for await (const entry of dir) yield* tree(root, device, path.join(rel, entry.name));
  }
}

function unchanged(before, after) {
  return before && before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function updatePaths(userId, { source, sourcePath, destination }) {
  const relocate = (file) => {
    if (!file) return null;
    const full = path.resolve(file);
    const root = [sourcePath, source].find(dir => contains(dir, full));
    return root ? path.join(destination, path.relative(root, full)) : null;
  };
  const libraryIds = [];
  for (const lib of q('SELECT id, path FROM libraries WHERE owner_id = ?').all(userId)) {
    const next = relocate(lib.path) || relocate(canonical(path.resolve(lib.path)));
    if (!next) continue;
    libraryIds.push(lib.id);
    q('UPDATE libraries SET path = ?, storage_device = NULL, storage_unavailable = 0 WHERE id = ?').run(next, lib.id);
    for (const [table, column] of [['books', 'path'], ['downloads', 'file'], ['uploads', 'file']]) {
      for (const row of q(`SELECT id, ${column} AS file FROM ${table} WHERE library_id = ? AND ${column} IS NOT NULL`).iterate(lib.id)) {
        const nextFile = contains(lib.path, row.file) ? path.join(next, path.relative(lib.path, row.file)) : relocate(row.file);
        if (nextFile) q(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(nextFile, row.id);
      }
    }
  }
  q('UPDATE users SET home_dir = ? WHERE id = ?').run(destination, userId);
  return libraryIds;
}

function phase(job, name, percent) {
  job.phase = name;
  if (job.percent !== percent) {
    job.percent = percent;
    tasks.progress(job.id, percent, 100);
  }
}

async function move(job, user, requested, admin) {
  const scanner = require('./scanner');
  const downloads = require('./plugins/downloads');
  let directories, created = false, committed = false, retired = null;
  try {
    while (writes || scanner.state.running || downloads.activeCount() || require('./fulltext').isRunning()) await delay(200);
    directories = targets(user, requested, admin);
    const { source, destination, parent } = directories;
    phase(job, 'preparing', 0);
    const device = (await fsp.stat(source)).dev;
    const entries = new Map();
    let total = 0;
    for await (const [rel, stat] of tree(source, device)) {
      entries.set(rel, stat);
      if (stat.isFile()) total += stat.size;
    }
    const free = storage.diskFree(parent);
    if (free != null && free - total < (storage.limits().reserveFreeMb || 0) * storage.MB) {
      throw error('The destination drive does not have enough free space for this move.');
    }

    q('UPDATE background_tasks SET error = ? WHERE id = ?').run(`The original folder is still in use. A partial copy may remain at ${destination}.`, job.id);
    await fsp.mkdir(destination, { mode: 0o700 });
    created = true;
    phase(job, 'copying', 0);
    let bytes = 0, lastUpdate = 0;
    for (const [rel, stat] of entries) {
      if (!rel) continue;
      const from = path.join(source, rel);
      const to = path.join(destination, rel);
      if (stat.isDirectory()) {
        await fsp.mkdir(to, { mode: 0o700 });
        continue;
      }
      const count = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (Date.now() - lastUpdate >= 500) {
          lastUpdate = Date.now();
          try {
            phase(job, 'copying', Math.min(94, Math.floor(bytes / total * 95)));
          } catch (e) {
            return callback(e);
          }
        }
        callback(null, chunk);
      } });
      await pipeline(fs.createReadStream(from), count, fs.createWriteStream(to, { flags: 'wx', mode: 0o600, flush: true }));
      if ((await fsp.stat(to)).size !== stat.size) throw error('A file changed while it was being copied. Try the move again.');
      await fsp.utimes(to, stat.atimeMs / 1000, stat.mtimeMs / 1000);
    }
    phase(job, 'verifying', 95);
    for (const [rel, stat] of [...entries].reverse()) {
      if (stat.isDirectory()) await fsp.utimes(path.join(destination, rel), stat.atimeMs / 1000, stat.mtimeMs / 1000);
    }
    let seen = 0;
    for await (const [rel, stat] of tree(source, device)) {
      if (!unchanged(entries.get(rel), stat)) throw error('Files changed during the move. Stop writing to the personal folder and try again.');
      seen++;
    }
    if (seen !== entries.size) throw error('Files changed during the move. Stop writing to the personal folder and try again.');
    phase(job, 'switching', 98);
    const retiredPath = path.join(path.dirname(source), `.flyleaf-moved-${randomUUID()}`);
    const libraryIds = tx(() => {
      const ids = updatePaths(user.id, directories);
      tasks.progress(job.id, 100, 100);
      tasks.finish(job.id);
      q('UPDATE background_tasks SET error = ? WHERE id = ?').run(`Moved successfully. Some original files may remain at ${source} or ${retiredPath}.`, job.id);
      return ids;
    });
    committed = true;
    storage.forget(user.id);
    require('./watcher').sync();
    for (const id of libraryIds) scanner.requestScan(id);

    job.phase = 'cleaning';
    job.percent = 99;
    // Move the original aside before deleting it so a later write at the old path stays separate.
    fs.renameSync(source, retiredPath);
    retired = retiredPath;
    await fsp.rm(retired, { recursive: true });
    q('UPDATE background_tasks SET error = NULL, finished_at = ? WHERE id = ?').run(Date.now(), job.id);
  } catch (e) {
    log.warn(`Personal folder migration for account ${user.id}: ${e.message}`);
    if (committed) {
      // The new folder is live. Preserve the old copy on any cleanup failure.
      const leftover = retired || directories.source;
      q('UPDATE background_tasks SET error = ?, finished_at = ? WHERE id = ?')
        .run(`Moved successfully. Some original files may remain at ${leftover}.`, Date.now(), job.id);
    } else {
      let cleanup = '';
      if (created) await fsp.rm(directories.destination, { force: true, recursive: true }).catch(() => {
        cleanup = ' Some partial files remain in the destination.';
      });
      const message = e.expose ? e.message : ({ ENOSPC: 'The destination drive ran out of space.', ENOENT: 'The current folder or destination parent is unavailable.', EACCES: 'Flyleaf needs access to both folders.', EPERM: 'Flyleaf needs access to both folders.', EROFS: 'The destination drive is read-only.' })[e.code] || 'Flyleaf could not move the personal folder. See the server log.';
      tasks.finish(job.id, `${message}${cleanup}`);
    }
  } finally {
    active = null;
    scanner.resumeQueue();
    downloads.pump();
  }
}

function accountFor(actor, userId) {
  if (actor.apiKey || (actor.id !== userId && actor.role !== 'admin')) throw error('Use your signed-in account to move a personal folder.', 403);
  const user = q('SELECT id, role, home_dir FROM users WHERE id = ?').get(userId);
  if (!user) throw error('User not found.', 404);
  if (!user.home_dir || user.role === 'admin') throw error('This account has no personal folder to move.', 409);
  return user;
}

function availableTargets(user, destination, admin) {
  try {
    return targets(user, destination, admin);
  } catch (e) {
    if (e.expose) throw e;
    throw error('Check that the current folder and the destination’s parent exist and are accessible.');
  }
}

function start(actor, userId, destination) {
  if (active) throw error('A personal folder migration is already in progress.', 409);
  const user = accountFor(actor, userId);
  const admin = actor.role === 'admin';
  const paths = availableTargets(user, destination, admin);
  const id = tx(() => {
    const taskId = tasks.start(KIND, TITLE, { userId, total: 100 });
    q('UPDATE background_tasks SET destination = ? WHERE id = ?').run(paths.destination, taskId);
    return taskId;
  });
  const job = active = { id, phase: 'waiting', percent: 0 };
  setImmediate(() => move(job, user, destination, admin).catch(e => log.error(e.message)));
  return id;
}

async function browse(actor, userId, requested) {
  const user = accountFor(actor, userId);
  const admin = actor.role === 'admin';
  const roots = [...new Set([...configuredRoots(), ...(admin ? [path.dirname(user.home_dir)] : [])])];
  const separator = path.sep;
  if (!requested) return { roots, separator, path: null, parent: null, folders: [] };
  if (typeof requested !== 'string' || !path.isAbsolute(requested) || requested.includes('\0')) throw error('Enter an absolute path on the Flyleaf server.');
  const dir = canonical(path.resolve(requested));
  const approved = roots.map(canonical);
  const privateFolders = admin ? [] : q('SELECT home_dir FROM users WHERE id != ? AND home_dir IS NOT NULL').all(userId).map(row => canonical(path.resolve(row.home_dir)));
  const permitted = value => admin || (approved.some(root => contains(root, value)) && !privateFolders.some(root => contains(root, value)));
  if (!permitted(dir)) throw error('Choose an approved storage location.', 403);
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => { throw error('This folder is unavailable or cannot be read.'); });
  const parent = path.dirname(dir);
  return { roots, separator, path: dir, parent: parent !== dir && permitted(parent) ? parent : null,
    folders: entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && permitted(path.join(dir, entry.name))).slice(0, 500)
      .sort((a, b) => a.name.localeCompare(b.name)).map(entry => ({ name: entry.name, path: path.join(dir, entry.name) })) };
}

async function preview(actor, userId, destination) {
  const user = accountFor(actor, userId);
  const { source, parent, destination: resolved } = availableTargets(user, destination, actor.role === 'admin');
  await fsp.access(parent, fs.constants.W_OK).catch(() => { throw error('Flyleaf cannot write to the destination parent.'); });
  const { dev } = await fsp.stat(source);
  let bytes = 0, files = 0;
  for await (const [, stat] of tree(source, dev)) {
    if (stat.isFile()) { bytes += stat.size; files++; }
  }
  const free = storage.diskFree(parent);
  const reserve = (storage.limits().reserveFreeMb || 0) * storage.MB;
  return { source, destination: resolved, bytes, files, free, reserve, fits: free == null ? null : free - reserve >= bytes };
}

function status(user) {
  const row = q('SELECT * FROM background_tasks WHERE kind = ? ORDER BY id DESC LIMIT 1').get(KIND);
  const own = q('SELECT * FROM background_tasks WHERE kind = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(KIND, user.id);
  const snapshot = (r) => {
    if (!r) return null;
    const live = active?.id === r.id ? active : null;
    const own = r.user_id === user.id || user.role === 'admin';
    return {
      id: r.id, status: live ? 'running' : r.status, percent: live?.percent ?? r.done, phase: live?.phase ?? null,
      finishedAt: live ? null : r.finished_at, detail: !live && own ? r.error : null,
      ...(own && { destination: r.destination, userId: r.user_id }),
    };
  };
  const homeDir = user.homeDir || null;
  const canMove = Boolean(homeDir && user.role !== 'admin' && !user.apiKey);
  return { migration: snapshot(row), ownMigration: snapshot(own), homeDir, canMove, roots: canMove ? configuredRoots() : [] };
}

// These operations can change library files, assignments, or the database itself.
function guard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) ||
      !/^\/(?:uploads(?:\/|$)|(?:me\/)?libraries(?:\/|$)|me\/folders\/?$|users(?:\/|$)|(?:books|series)\/[^/]+(?:\/move)?\/?$|admin\/(?:backups|restore|duplicates)(?:\/|$)|register\/?$|setup(?:\/|$))/i.test(req.path) ||
      /^\/users\/[^/]+\/storage-migration\/?$/i.test(req.path)) return next();
  if (active) return next(error('Library and storage changes are paused during a personal folder migration. Try again when it finishes.', 409));
  const release = beginWrite();
  const done = () => {
    res.off('finish', done);
    res.off('close', done);
    release();
  };
  res.once('finish', done);
  res.once('close', done);
  next();
}

function beginWrite() {
  if (active) throw error('Storage changes are paused during a personal folder migration.', 409);
  writes++;
  return () => { writes--; };
}

async function withWrite(handler) {
  const release = beginWrite();
  try {
    return await handler();
  } finally {
    release();
  }
}

module.exports = { start, status, browse, preview, guard, beginWrite, withWrite, checkPersonalFolder, live: () => active, busy: () => Boolean(active) };
