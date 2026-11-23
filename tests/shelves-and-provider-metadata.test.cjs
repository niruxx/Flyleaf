const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

function load(file, modules, globals = {}) {
  const filename = path.resolve(file);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, process, URL, AbortSignal, setTimeout, ...globals,
    require: (name) => modules[name] ?? realRequire(name),
  }, { filename });
  return module.exports;
}

function fixture(t, providerReplies = {}) {
  const db = load('server/db.js', {
    'node:sqlite': { DatabaseSync: class extends DatabaseSync { constructor() { super(':memory:'); } } },
    'node:fs': { mkdirSync() {} },
    './config': { dataDir: '.' },
  });
  t.after(() => db.db.close());
  db.db.exec(`
    INSERT INTO users (id, username, password_hash, role, created_at) VALUES (1, 'reader', '', 'guest', 0);
    INSERT INTO libraries (id, name, path, kind, created_at) VALUES (1, 'Public', 'public', 'books', 0), (2, 'Other', 'other', 'books', 0);
    INSERT INTO series (id, library_id, key, name, genres, created_at, updated_at) VALUES
      (1, 1, 'one', 'First', '["Mystery"]', 0, 0),
      (2, 1, 'two', 'Second', '["Fantasy"]', 0, 0),
      (3, 2, 'three', 'Third', '["Mystery"]', 0, 0);
    INSERT INTO books (id, library_id, series_id, path, rel_path, title, format, added_at, updated_at) VALUES
      (1, 1, 1, 'public/one', 'one', 'First', 'epub', 0, 0),
      (2, 1, 2, 'public/two', 'two', 'Second', 'epub', 0, 0),
      (3, 2, 3, 'other/three', 'three', 'Third', 'epub', 0, 0);
    INSERT INTO book_text (book_id, text) VALUES
      (1, 'An old lighthouse was covered in fog.'),
      (2, 'An old lighthouse stood on a cliff.'),
      (3, 'An old lighthouse was covered in fog.');
  `);
  const pass = (req, res, next) => next();
  const auth = { requireAdmin: pass, requirePermission: () => pass };
  const log = { logger: () => ({ file() {} }) };
  const serialize = load('server/serialize.js', { './db': db });
  const fulltext = load('server/fulltext.js', {
    './db': db, './archive': {}, './metadata': {}, './log': log,
  }, { process: { env: {} } });
  const providers = load('server/providers.js', { './settings': { get: () => '' } }, {
    setTimeout: (fn) => fn(),
    fetch: async (url) => {
      const reply = providerReplies[new URL(url).pathname];
      assert.ok(reply, url);
      return { ok: true, json: async () => reply };
    },
  });
  const metadata = load('server/metadata-service.js', {
    './db': db, './providers': providers, './covers': {}, './log': log,
  });
  const shared = { '../db': db, '../auth': auth, '../serialize': serialize };
  const seriesModule = load('server/routes/series.js', {
    ...shared, '../fulltext': fulltext, '../covers': {}, '../providers': providers,
    '../metadata-service': metadata, '../scanner': {},
  });
  const { router: personal } = load('server/routes/personal.js', {
    ...shared, '../profiles': {}, '../mailer': {}, './books': {},
  });
  return { db, series: seriesModule.router, seriesModule, personal, providers, metadata, serialize };
}

function request(router, method, url, { body, query, user = { id: 1, role: 'guest', visibleLibraryIds: [1] } } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url, originalUrl: url, body, query: query || {}, user, headers: {} };
    const res = { code: 200, status(code) { this.code = code; return this; }, set() {}, type() { return this; },
      end() { resolve({ code: this.code }); }, send(data) { resolve({ code: this.code, data }); }, json(data) { resolve({ code: this.code, data }); } };
    router.handle(req, res, (error) => error ? reject(error) : resolve({ code: 404 }));
  });
}

test('a saved text rule combines with catalog filters and follows the index', async (t) => {
  const { db, series, personal } = fixture(t);
  const saved = await request(personal, 'POST', '/filters', {
    body: { name: 'Lighthouses', filter: { genre: ['Mystery'], text: '  "old lighthouse"  ' } },
  });
  assert.equal(saved.code, 201);
  const { data: shelves } = await request(personal, 'GET', '/filters');
  const query = shelves[0].filter;
  assert.equal(query.text, '"old lighthouse"');
  async function matches(query) {
    const { data } = await request(series, 'GET', '/series', { query });
    return Array.from(data.items, ({ id }) => id);
  }
  assert.deepEqual(await matches({ text: 'lighthou' }), [1, 2]);
  assert.deepEqual(await matches(query), [1]);
  assert.deepEqual(await matches({ text: '"old cliff"' }), []);
  db.q('UPDATE books SET missing = 1 WHERE id = 1').run();
  assert.deepEqual(await matches(query), []);
});

test('OPDS 1 and 2 expose only owned Magic Shelves and use the web filter rules', async (t) => {
  const { db, personal, seriesModule, serialize } = fixture(t);
  db.q("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (2, 'other', '', 'guest', 0)").run();
  db.q('INSERT INTO smart_filters (id, user_id, name, filter, created_at) VALUES (22, 2, ?, ?, 0)').run('Private shelf', '{"kind":"books"}');
  const saved = await request(personal, 'POST', '/filters', {
    body: { name: 'Lighthouses', filter: { genre: ['Mystery'], text: 'lighthouse', read: 'unread' } },
  });
  const user = { id: 1, role: 'admin', visibleLibraryIds: [1], prefs: {} };
  const { router } = load('server/opds.js', { './db': db, './auth': { userFromApiKey: () => user }, './archive': {}, './settings': { get() {} },
    './serialize': serialize, './routes/books': {}, './routes/series': seriesModule });
  const id = saved.data.id;
  for (const base of ['/key', '/key/v2']) {
    const get = (suffix) => request(router, 'GET', `${base}${suffix}`);
    assert.match((await get('')).data, /Magic Shelves/);
    const shelves = (await get('/magic-shelves')).data;
    assert.match(shelves, /Lighthouses/);
    assert.doesNotMatch(shelves, /Private shelf/);
    assert.equal((await get('/magic-shelves/22')).code, 404);
    const shelf = (await get(`/magic-shelves/${id}`)).data;
    assert.match(shelf, /First/);
    assert.doesNotMatch(shelf, /Second|Third/);
  }
  db.q('INSERT INTO progress (user_id, book_id, percent, finished, started_at, updated_at) VALUES (1, 1, 1, 1, 1, 1)').run();
  assert.doesNotMatch((await request(router, 'GET', `/key/magic-shelves/${id}`)).data, /First/);
});

test('book providers import attributed ratings and manual edits survive auto-matching', async (t) => {
  const { series, providers, metadata, serialize } = fixture(t, {
    '/books/v1/volumes/one': { id: 'one', volumeInfo: { title: 'First', averageRating: 4.25, ratingsCount: 12 } },
    '/works/OL1W.json': { key: '/works/OL1W', title: 'First', description: { value: 'A mystery' }, covers: [0, 123] },
    '/search.json': { docs: [{ key: '/works/OL1W', title: 'First', ratings_average: 3.5, ratings_count: 8 }] },
  });
  const google = await providers.get('googlebooks').details('one');
  const library = await providers.get('openlibrary').details('OL1W');
  assert.equal(library.summary, 'A mystery');
  assert.match(library.coverUrl, /123-L\.jpg$/);
  assert.equal(library.externalRating.average, 3.5);
  assert.equal(google.externalRating.count, 12);
  const user = { id: 1, role: 'admin' };
  const rating = () => serialize.getSeries(1, user).externalRating;
  await metadata.applyToSeries(1, google, { fields: ['external_rating'] });
  assert.equal(rating().source, 'Google Books');
  assert.equal((await request(series, 'PATCH', '/series/1', { user, body: { externalRating: { average: 6 } } })).code, 400);
  assert.equal((await request(series, 'PATCH', '/series/1', { user, body: { externalRating: { average: 4 } } })).code, 200);
  await metadata.applyToSeries(1, library, { fields: ['external_rating'] });
  assert.equal(rating().average, 4);
  assert.equal(rating().source, null);
  await metadata.applyToSeries(1, library, { fields: ['external_rating'], force: true });
  assert.equal(rating().source, 'Open Library');
});

test('BookDrop waits for stable files, previews online metadata and imports without overwriting', async (t) => {
  const { db } = fixture(t);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flyleaf-bookdrop-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const inbox = fs.mkdirSync(path.join(temp, 'inbox'), { recursive: true });
  const library = fs.mkdirSync(path.join(temp, 'library'), { recursive: true });
  db.q('UPDATE libraries SET path = ? WHERE id = 1').run(library);
  const source = path.join(inbox, 'First.epub');
  fs.writeFileSync(source, 'first part');
  const destination = path.join(library, 'Author', 'Series');
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'First.epub'), 'existing copy');
  fs.writeFileSync(path.join(inbox, 'Other.epub'), 'to dismiss');
  fs.writeFileSync(path.join(inbox, 'Incomplete.epub.part'), 'ignored');
  const now = { at: 10_000 };
  const applied = [];
  const match = { id: '1', title: 'First', provider: 'openlibrary', people: [{ name: 'Author' }], summary: 'Catalog description' };
  const scanner = {
    FILE_FORMATS: { '.epub': 'epub' }, resolveFormat: async (file) => file.format,
    readBookMetadata: async (file) => ({ update: { title: path.basename(file.name, '.epub'), author: 'Author' }, embedded: {} }),
    scanAndWait: async (id) => {
      assert.equal(id, 1);
      assert.equal(fs.readFileSync(path.join(destination, 'First (2).epub'), 'utf8'), 'first part and the rest');
      db.q('UPDATE books SET rel_path = ? WHERE id = 1').run(path.join('Author', 'Series', 'First (2).epub'));
    },
  };
  const drop = load('server/book-drop.js', {
    './db': db, './config': { bookDropDir: inbox, bookDropOnline: true }, './scanner': scanner,
    './audio': { AUDIO_EXT: new Set() }, './log': { logger: () => ({ file() {} }) },
    './storage': { check: async () => {}, forget() {} },
    './providers': { get: () => ({ search: async () => [match], details: async () => match }) },
    './metadata-service': { FIELDS: ['summary'], applyToSeries: async (id, data) => applied.push([id, data]) },
  }, { Date: { now: () => now.at } });
  await drop.poll();
  assert.equal(drop.inbox().items.length, 0);
  now.at += 5000;
  fs.appendFileSync(source, ' and the rest');
  await drop.poll();
  assert.equal(drop.inbox().items.length, 1);
  drop.dismiss(drop.inbox().items[0].id);
  now.at += 5000;
  await drop.poll();
  const [item] = drop.inbox().items;
  assert.equal(drop.inbox().items.length, 1);
  assert.equal(item.metadata.match.summary, 'Catalog description');
  await assert.rejects(drop.importFile(item.id, 1, 1, true, '../inbox'), { status: 400 });
  assert.equal((await drop.importFile(item.id, 1, 1, true, 'Author/Series')).seriesId, 1);
  assert.equal(applied.length, 1);
  assert.equal(fs.readFileSync(path.join(destination, 'First.epub'), 'utf8'), 'existing copy');
  assert.equal(fs.readFileSync(source, 'utf8'), 'first part and the rest');
  assert.equal(fs.readFileSync(path.join(inbox, 'Other.epub'), 'utf8'), 'to dismiss');
  await drop.poll();
  assert.equal(drop.inbox().items.length, 0);
});
