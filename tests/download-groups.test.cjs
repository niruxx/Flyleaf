const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

test('downloads group by book and preserve source, owner and library boundaries', async () => {
  const mod = new vm.SourceTextModule(fs.readFileSync('public/js/download-groups.js', 'utf8'));
  await mod.link(() => { throw new Error('Unexpected import'); });
  await mod.evaluate();
  const group = mod.namespace.groupDownloads;
  const base = { userId: 1, libraryId: 1, plugin: 'source', bookTitle: 'Book 2', sourceId: 'book2' };
  const rows = [
    { ...base, id: 1, fileTitle: 'Chapter 10' },
    { ...base, id: 2, fileTitle: 'Chapter 2', cover: 'https://example.com/cover.jpg' },
    { ...base, id: 3, userId: 2 },
    { ...base, id: 4, libraryId: 2 },
    { ...base, id: 5, plugin: 'other' },
    { ...base, id: 6, sourceId: 'book10', bookTitle: 'Book 10' },
  ];
  const groups = group(rows);
  assert.equal(groups.length, 5);
  const book = groups.find(g => g.rows.length === 2);
  assert.deepEqual(Array.from(book.rows, r => r.id), [2, 1]);
  assert.equal(book.cover, 'https://example.com/cover.jpg');
  assert.equal(groups.at(-1).title, 'Book 10');
  assert.equal(group(rows, 'desc')[0].title, 'Book 10');
  assert.equal(rows[0].id, 1, 'sorting leaves the API response order unchanged');
  assert.equal(group([{ id: 1, title: 'Legacy book' }])[0].title, 'Legacy book');
  assert.equal(group([]).length, 0);
});

test('clearing a book removes only its entries in the selected status', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE downloads (id INTEGER PRIMARY KEY, user_id INTEGER, library_id INTEGER,
    plugin_id TEXT, title TEXT, item TEXT, status TEXT, error TEXT)`);
  const insert = db.prepare('INSERT INTO downloads VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const add = (id, { user = 1, library = 1, plugin = 'source', title = 'Book', sourceId = 'book', status = 'done', error = null } = {}) =>
    insert.run(id, user, library, plugin, title, JSON.stringify({ sourceId }), status, error);

  add(1);
  add(2, { title: 'Renamed book' });
  add(3, { sourceId: 'other' });
  add(4, { user: 2 });
  add(5, { library: 2 });
  add(6, { plugin: 'other' });
  add(7, { status: 'failed' });
  add(8, { status: 'failed', error: 'Cancelled' });
  add(9, { status: 'queued' });
  add(10, { user: null, title: ' Older Book ', sourceId: null });
  add(11, { user: null, title: 'older book', sourceId: null });

  const module = { exports: {} };
  const pass = (req, res, next) => next();
  const stubs = {
    '../db': { q: (sql) => db.prepare(sql) },
    '../auth': { requirePermission: () => pass, requireAdmin: pass },
    '../util': require('../server/util'),
  };
  vm.runInNewContext(fs.readFileSync('server/routes/finder.js', 'utf8'), {
    module,
    require: (name) => stubs[name] ?? (name.startsWith('../') ? {} : require(name)),
  });
  const route = module.exports.router.stack.find(({ route }) => route?.path === '/downloads/:id/book').route.stack[0].handle;
  function clear(id, what, user = { id: 1, role: 'member' }) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    route({ params: { id }, query: { what }, user }, res);
    return res;
  }
  const remaining = () => db.prepare('SELECT id FROM downloads ORDER BY id').all().map(({ id }) => id);

  assert.equal(clear(4, 'done').statusCode, 404);
  assert.equal(clear(9, 'queued').statusCode, 400);
  assert.equal(clear(7, 'done').statusCode, 404);
  assert.equal(clear(1, 'done').body.removed, 2);
  assert.deepEqual(remaining(), [3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(clear(8, 'cancelled').body.removed, 1);
  assert.equal(clear(10, 'done', { id: 1, role: 'admin' }).body.removed, 2);
  assert.deepEqual(remaining(), [3, 4, 5, 6, 7, 9]);
});
