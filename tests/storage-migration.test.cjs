'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Writable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');

function request(router, user, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = { method, url, body, user, headers: {}, query: Object.fromEntries(new URL(url, 'http://localhost').searchParams) };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { resolve({ code: this.code, data }); } };
    router.handle(req, res, error => error ? reject(error) : resolve({ code: 404 }));
  });
}

function load(file, overrides, env = {}) {
  const filename = path.resolve(file);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process: { env, platform: process.platform }, setImmediate,
    require: name => overrides[name] ?? realRequire(name),
  }, { filename });
  return module.exports;
}

function fixture(t, filesystem = fs) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'flyleaf-move-')));
  const dataDir = path.join(root, 'data');
  const contentDir = path.join(dataDir, 'content');
  const homeDir = path.join(contentDir, 'reader');
  const library = path.join(homeDir, 'Books');
  const book = path.join(library, 'Book.epub');
  const approved = path.join(root, 'ssd');
  const destination = path.join(approved, 'new home');
  fs.mkdirSync(library, { recursive: true });
  fs.mkdirSync(approved);
  fs.mkdirSync(path.join(homeDir, 'empty'));
  fs.writeFileSync(book, 'book content');
  fs.utimesSync(book, 1700000000.12345, 1700000000.12345);
  fs.writeFileSync(path.join(homeDir, '.extra'), 'unindexed content');
  const config = { root: path.join(root, 'app'), dataDir, contentDir };
  const db = load('server/db.js', { './config': config });
  t.after(() => {
    db.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { q } = db;
  const tasks = load('server/tasks.js', { './db': db });
  const scans = [];
  const migration = load('server/storage-migration.js', {
    'node:fs': filesystem,
    './config': config,
    './db': db,
    './tasks': tasks,
    './storage': { diskFree: () => 200, limits: () => ({ reserveFreeMb: 0 }), MB: 1048576, forget() {} },
    './scanner': { state: {}, requestScan: id => scans.push(id), resumeQueue() {} },
    './watcher': { sync() {} },
    './plugins/downloads': { activeCount: () => 0, pump() {} },
    './fulltext': { isRunning: () => false },
    './log': { logger: () => ({ warn() {}, error: assert.fail }) },
  }, { FLYLEAF_USER_STORAGE_ROOTS: approved });
  q("INSERT INTO users (id, username, password_hash, role, created_at, home_dir) VALUES (1, 'reader', '', 'guest', 0, ?), (2, 'other', '', 'guest', 0, ?)")
    .run(homeDir, path.join(contentDir, 'other'));
  q("INSERT INTO libraries (id, name, path, kind, owner_id, created_at) VALUES (20, 'Books', ?, 'books', 1, 0)").run(library);
  q("INSERT INTO books (id, library_id, path, rel_path, format, title, added_at, updated_at) VALUES (30, 20, ?, 'Book.epub', 'epub', 'Book', 0, 0)").run(book);
  q('INSERT INTO progress (user_id, book_id, page, started_at, updated_at) VALUES (1, 30, 12, 0, 0)').run();
  q('INSERT INTO uploads (id, user_id, library_id, file, created_at) VALUES (40, 1, 20, ?, 0)').run(book);
  q("INSERT INTO downloads (id, user_id, plugin_id, library_id, title, item, status, file, created_at) VALUES (50, 1, 'fixture', 20, 'Book', '{}', 'done', ?, 0)").run(book);
  const user = { id: 1, role: 'guest', homeDir, ownLibraryIds: [20] };
  const other = { id: 2, role: 'guest' };
  async function result() {
    for (let tries = 0; tries < 100; tries++) {
      const current = migration.status(user).ownMigration;
      if (current && current.status !== 'running') return current;
      await delay(25);
    }
    assert.fail('The migration did not finish');
  }
  return { db, q, tasks, migration, scans, user, other, destination, contentDir, homeDir, book, result };
}

test('a personal folder move preserves library, book, progress and transfer records', async (t) => {
  const { q, migration, scans, user, other, destination, contentDir, homeDir, result } = fixture(t);
  const modified = fs.statSync(path.join(homeDir, 'Books', 'Book.epub')).mtimeMs;
  assert.throws(() => migration.start(other, user.id, destination), { status: 403 });
  assert.throws(() => migration.start({ ...user, apiKey: {} }, user.id, destination), { status: 403 });
  assert.throws(() => migration.start(user, user.id, path.join(contentDir, 'other')), { status: 409 });
  assert.throws(() => migration.start(user, user.id, path.join(os.tmpdir(), 'unapproved')), { status: 403 });
  assert.throws(() => migration.start(user, user.id, path.join(homeDir, 'Books')), /separate/);

  const release = migration.beginWrite();
  const id = migration.start(user, user.id, destination);
  assert.equal(migration.status(other).migration.id, id);
  assert.equal(migration.status(other).migration.phase, 'waiting');
  assert.equal(migration.status(other).ownMigration, null);
  assert.throws(() => migration.start(user, user.id, destination), { status: 409 });
  assert.throws(() => migration.beginWrite(), { status: 409 });
  release();

  const end = await result();
  assert.equal(end.status, 'done');
  assert.equal(end.percent, 100);
  assert.equal(end.detail, null);
  assert.equal(q('SELECT home_dir FROM users WHERE id = 1').get().home_dir, destination);
  assert.equal(q('SELECT path FROM libraries WHERE id = 20').get().path, path.join(destination, 'Books'));
  const book = path.join(destination, 'Books', 'Book.epub');
  assert.equal(q('SELECT path FROM books WHERE id = 30').get().path, book);
  assert.equal(q('SELECT page FROM progress WHERE book_id = 30').get().page, 12);
  assert.equal(q('SELECT file FROM uploads WHERE id = 40').get().file, book);
  assert.equal(q('SELECT file FROM downloads WHERE id = 50').get().file, book);
  assert.equal(fs.readFileSync(book, 'utf8'), 'book content');
  assert.equal(Math.floor(fs.statSync(book).mtimeMs), Math.floor(modified));
  assert.equal(fs.readFileSync(path.join(destination, '.extra'), 'utf8'), 'unindexed content');
  assert.ok(fs.statSync(path.join(destination, 'empty')).isDirectory());
  assert.equal(fs.existsSync(homeDir), false);
  assert.deepEqual(scans, [20]);
});

test('a failed copy keeps the original paths and files and allows a retry', async (t) => {
  let fail = true;
  const filesystem = { ...fs, createWriteStream(...args) {
    if (fail) return new Writable({ write(_data, _encoding, callback) {
      callback(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    } });
    return fs.createWriteStream(...args);
  } };
  const { q, migration, user, other, book, homeDir, destination, result } = fixture(t, filesystem);
  migration.start(user, user.id, destination);
  const end = await result();
  assert.equal(end.status, 'failed');
  assert.match(end.detail, /ran out of space/);
  assert.equal(migration.status(other).migration.detail, null);
  assert.equal(q('SELECT home_dir FROM users WHERE id = 1').get().home_dir, homeDir);
  assert.equal(q('SELECT path FROM books WHERE id = 30').get().path, book);
  assert.equal(fs.readFileSync(book, 'utf8'), 'book content');
  assert.equal(fs.existsSync(destination), false);
  fail = false;
  migration.start(user, user.id, destination);
  assert.equal((await result()).status, 'done');
});

test('restart recovery reports an unfinished copy while the account still uses its original folder', (t) => {
  const { q, tasks, migration, user, other, book, homeDir, destination } = fixture(t);
  const id = tasks.start('storage-migration', 'Personal folder migration', { userId: user.id, total: 100 });
  tasks.progress(id, 40, 100);
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'partial copy'), 'incomplete');
  q('UPDATE background_tasks SET error = ? WHERE id = ?')
    .run(`The original folder is still in use. A partial copy may remain at ${destination}.`, id);

  tasks.recover();

  const recovered = migration.status(user).ownMigration;
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.percent, 40);
  assert.match(recovered.detail, /Interrupted by a server restart/);
  assert.ok(recovered.detail.includes(destination));
  assert.equal(migration.status(other).migration.detail, null);
  assert.equal(q('SELECT home_dir FROM users WHERE id = ?').get(user.id).home_dir, homeDir);
  assert.equal(fs.readFileSync(book, 'utf8'), 'book content');
});

test('an interrupted cleanup leaves the new folder in use and reports the original copy', async (t) => {
  const filesystem = { ...fs, renameSync() {
    throw Object.assign(new Error('original folder is busy'), { code: 'EBUSY' });
  } };
  const { q, tasks, migration, user, other, book, homeDir, destination, result } = fixture(t, filesystem);
  migration.start(user, user.id, destination);
  const end = await result();
  tasks.recover();

  assert.equal(end.status, 'done');
  assert.equal(end.percent, 100);
  assert.ok(end.detail.includes(homeDir));
  assert.equal(migration.status(user).ownMigration.status, 'done');
  assert.equal(migration.status(other).migration.detail, null);
  assert.equal(q('SELECT home_dir FROM users WHERE id = ?').get(user.id).home_dir, destination);
  assert.equal(fs.readFileSync(path.join(destination, 'Books', path.basename(book)), 'utf8'), 'book content');
  assert.equal(fs.readFileSync(book, 'utf8'), 'book content');
});

test('destination preview checks size, approved folders, and privacy', async (t) => {
  const { migration, user, other, destination, contentDir } = fixture(t);
  const locations = await migration.browse(user, user.id);
  assert.ok(locations.roots.includes(path.dirname(destination)));
  fs.mkdirSync(path.join(contentDir, 'other'));
  const homeRoots = await migration.browse(user, user.id, contentDir);
  assert.ok(homeRoots.folders.every(folder => folder.name !== 'other'));
  await assert.rejects(migration.preview(other, user.id, destination), { status: 403 });
  const preview = await migration.preview(user, user.id, destination);
  assert.equal(preview.destination, destination);
  assert.equal(preview.files, 2);
  assert.equal(preview.bytes, Buffer.byteLength('book contentunindexed content'));
  assert.equal(preview.free, 200);
  assert.equal(preview.fits, true);
  assert.equal(fs.existsSync(destination), false);
});

test('an unavailable subtree preserves the catalog and recorded reading position', async (t) => {
  const { db, q, tasks, book } = fixture(t);
  const realFs = require('node:fs/promises');
  const scanner = load('server/scanner.js', {
    './db': db, './tasks': tasks, './archive': {}, './metadata': {}, './formats': {}, './covers': {}, './audio': { AUDIO_EXT: new Set() },
    './log': { logger: () => ({ warn() {} }) }, './storage-migration': { busy: () => false },
    './fulltext': { indexPending: async () => {} },
    'node:fs/promises': { ...realFs, async readdir() { throw Object.assign(new Error('Drive unavailable'), { code: 'EIO' }); } },
  });
  await assert.rejects(scanner.scanAndWait(20), /storage is unavailable/);
  assert.equal(q('SELECT storage_unavailable FROM libraries WHERE id = 20').get().storage_unavailable, 1);
  const row = q('SELECT path, missing FROM books WHERE id = 30').get();
  assert.equal(row.path, book);
  assert.equal(row.missing, 0);
  assert.equal(q('SELECT page FROM progress WHERE book_id = 30').get().page, 12);
});

test('Content Finder relinks moved downloads and accepts a confirmed private link for imports', async (t) => {
  const { db, q, tasks, user, other, book } = fixture(t);
  q("INSERT INTO series (id, library_id, key, name, created_at, updated_at) VALUES (60, 20, 'book', 'Book', 0, 0), (61, 20, 'import', 'Imported series', 0, 0)").run();
  q('UPDATE books SET series_id = 60, size = ? WHERE id = 30').run(12);
  q(`UPDATE downloads SET item = ?, file = ?, total = 12 WHERE id = 50`)
    .run(JSON.stringify({ sourceId: 'book', fileId: 'volume', title: 'Book' }), path.join(path.dirname(book), 'old folder', path.basename(book)));
  q("INSERT INTO books (id, library_id, series_id, path, rel_path, format, title, chapter, added_at, updated_at) VALUES (31, 20, 61, ?, 'chapter.cbz', 'cbz', 'Chapter 2', 2, 0, 0)")
    .run(path.join(path.dirname(book), 'chapter.cbz'));
  const router = load('server/routes/finder.js', {
    '../db': db, '../tasks': tasks, '../scanner': { scanAndWait: async id => assert.equal(id, 20) },
    '../auth': { requirePermission: () => (_req, _res, next) => next(), requireAdmin() {} },
    '../serialize': { getSeries: id => q('SELECT * FROM series WHERE id = ?').get(id) },
    '../plugins/manager': { run: async () => ({ title: 'Imported series', files: [{ id: 'chapter-two', chapter: 2, format: 'cbz' }, { id: 'chapter-three', chapter: 3 }] }) },
    '../plugins/downloads': {}, '../follows': {}, '../plugins/suwayomi': {}, '../plugins/suwayomi-host': {},
    '../log': { logger: () => ({}) },
  }).router;
  const accepted = await request(router, user, 'POST', '/libraries/20/relink');
  assert.equal(accepted.code, 202);
  for (let tries = 0; tries < 100 && tasks.list(user)[0].status === 'running'; tries++) await delay(10);
  assert.equal(tasks.list(user)[0].status, 'done');
  const recovered = await request(router, user, 'GET', '/series/60/follow');
  assert.equal(recovered.data.source.sourceId, 'book');
  assert.equal((await request(router, other, 'GET', '/series/60/follow')).data.source, null);
  const review = await request(router, user, 'GET', '/libraries/20/unlinked');
  assert.deepEqual(Array.from(review.data.items, item => item.id), [61]);
  const linked = await request(router, user, 'PUT', '/series/61/source', { plugin: 'fixture', sourceId: 'imported' });
  assert.equal(linked.data.matchedFiles, 1);
  const saved = q('SELECT source_id, items FROM finder_series_links WHERE series_id = 61 AND user_id = 1').get();
  assert.equal(saved.source_id, 'imported');
  assert.equal(JSON.parse(saved.items)[0].fileId, 'chapter-two');
  assert.equal((await request(router, user, 'GET', '/libraries/20/unlinked')).data.items.length, 0);
});
