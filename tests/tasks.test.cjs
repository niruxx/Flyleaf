const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function load(file, overrides) {
  const filename = path.resolve(file), realRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(filename),
    require: name => name in overrides ? overrides[name] : realRequire(name), Date, Number, String, Boolean, Set, Map, console });
  return module.exports;
}
test('task migration, history, progress, owner scoping, retries and restart recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyleaf-tasks-'));
  const db = load('server/db.js', { './config': { dataDir: dir } });
  try {
    const { q } = db;
    q("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (1, 'one', 'hash', 'admin', 1), (2, 'two', 'hash', 'guest', 1)").run();
    q("INSERT INTO libraries (id, name, path, kind, mode, created_at) VALUES (1, 'Books', '/books', 'books', 'books', 1)").run();
    const tasks = load('server/tasks.js', { './db': db });
    const own = tasks.start('upload', 'Private title', { userId: 2, libraryId: 1, total: 10 });
    const scan = tasks.start('scan', 'Books', { libraryId: 1 });
    tasks.progress(own, 5, 10);
    assert.equal(tasks.list({ id: 2, role: 'guest' }).length, 1);
    assert.equal(tasks.list({ id: 2, role: 'guest' })[0].done, 5);
    assert.equal(tasks.list({ id: 1, role: 'admin' }).length, 2);
    tasks.finish(own);
    tasks.finish(own, 'late failure');
    tasks.progress(own, 0);
    assert.equal(tasks.list({ id: 2, role: 'guest' })[0].status, 'done');
    assert.equal(tasks.list({ id: 2, role: 'guest' })[0].done, 5);
    tasks.recover();
    assert.equal(q('SELECT status FROM background_tasks WHERE id = ?').get(scan).status, 'failed');
    const calls = [];
    const router = load('server/routes/tasks.js', { '../db': db, '../tasks': tasks, '../util': { json: (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } } }, '../scanner': { state: { running: false }, requestScan: id => calls.push(id) } }).router;
    const request = (method, url, user) => new Promise((resolve, reject) => {
      const req = { method, url, user, headers: {} };
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } };
      router.handle(req, res, e => e ? reject(e) : resolve({ status: 404 }));
    });
    const guest = { id: 2, role: 'guest', permissions: {} }, admin = { id: 1, role: 'admin' };
    const list = await request('GET', '/tasks', guest);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].title, 'Private title');
    q("INSERT INTO downloads (user_id, plugin_id, library_id, title, item, status, error, created_at) VALUES (1, 'source', 1, 'Admin download', '{}', 'queued', NULL, 1), (2, 'source', 1, 'Guest download', '{}', 'failed', NULL, 2), (2, 'source', 1, 'Cancelled download', '{}', 'failed', 'Cancelled', 3)").run();
    assert.equal((await request('GET', '/tasks', guest)).body.items.length, 1, 'finder permission is required to list downloads');
    const downloads = (await request('GET', '/tasks', { ...guest, permissions: { contentFinder: true } })).body.items.filter(item => item.kind === 'download');
    assert.equal(downloads.length, 2);
    assert.ok(downloads.every(item => item.title !== 'Admin download'));
    assert.equal(downloads.find(item => item.title === 'Guest download').status, 'failed', 'failed rows with no error message remain visible');
    assert.equal(downloads.find(item => item.title === 'Cancelled download').status, 'cancelled');

    assert.equal((await request('POST', `/tasks/${scan}/retry`, guest)).status, 403);
    assert.equal((await request('POST', `/tasks/${own}/retry`, admin)).status, 409);
    assert.equal((await request('POST', `/tasks/${scan}/retry`, admin)).status, 202);
    assert.deepEqual(calls, [1]);
    assert.equal((await request('POST', `/tasks/${scan}/retry`, admin)).status, 409);
    const orphan = tasks.start('scan', 'Removed library', { libraryId: 1 });
    tasks.finish(orphan, 'Unavailable');
    q('DELETE FROM libraries WHERE id = 1').run();
    assert.equal((await request('POST', `/tasks/${orphan}/retry`, admin)).status, 404);
    // History retention keeps active jobs, even when they are older than the terminal limit.
    const active = tasks.start('backup', 'Long running');
    for (let i = 0; i < 505; i++) tasks.finish(tasks.start('backup', `Backup ${i}`));
    assert.equal(q('SELECT status FROM background_tasks WHERE id = ?').get(active).status, 'running');
    assert.ok(q('SELECT COUNT(*) AS n FROM background_tasks').get().n <= 502);
  } finally { db.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('metadata provider outages remain retryable rather than being recorded as no match', async () => {
  const writes = [];
  const service = load('server/metadata-service.js', {
    './db': { q: sql => ({ run: (...args) => writes.push([sql, args]) }) },
    './providers': { DEFAULT_SOURCES: { books: ['source'] }, get: () => ({ name: 'Source', search: async () => { throw new Error('Source is unavailable'); } }) },
    './covers': {}, './util': { json: (_, fallback) => fallback, similarity: () => 0, mergeLinks: () => [] },
    './log': { logger: () => ({ file() {} }) },
  });
  await assert.rejects(service.autoMatchSeries({ id: 1, name: 'Book' }, { kind: 'books' }), /Source is unavailable/);
  assert.equal(writes.length, 0, 'an outage must not mark the series as permanently unmatched');
});
