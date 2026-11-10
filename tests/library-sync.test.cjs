'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function setup(t, dataDir) {
  const cache = new Map();
  const events = [];
  const user = { id: 1, username: 'reader', role: 'admin', visibleLibraryIds: [1], permissions: { download: true, apiAccess: true }, prefs: { koboCollectionId: 1 }, apiKey: { id: 1, scope: 'full' } };
  const auth = { userFromApiKey: (key) => key === 'full-access-key-123456789' ? user : key === 'read-access-key-123456789' ? { ...user, apiKey: { id: 2, scope: 'read' } } : null,
    requireAdmin: (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' }), requirePermission: () => (req, res, next) => next() };
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} }; cache.set(file, mod);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module: mod, exports: mod.exports, Buffer, Date, Set, Map, Intl,
      process: { env: {} }, setTimeout, clearTimeout, setInterval,
      require: (name) => {
        if (name === 'node:sqlite') return { DatabaseSync: function () { return new DatabaseSync(':memory:'); } };
        if (file.endsWith(`${path.sep}db.js`) && name === 'node:fs') return { mkdirSync() {} };
        if (name.endsWith('/config')) return { dataDir: dataDir || '<memory>', cacheDir: dataDir && path.join(dataDir, 'cache') };
        if (name.endsWith('/auth')) return auth;
        if (name.endsWith('/events')) return { emit: (...args) => events.push(args) };
        if (['./plugins/manager', './plugins/downloads', '../covers', '../providers', '../metadata-service', '../scanner'].includes(name)) return {};
        if (name.endsWith('/log')) return { logger: () => ({ file() {} }) };
        if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.js'));
        return require(name);
      } }, { filename: file });
    return mod.exports;
  }
  const db = load('server/db.js'); t.after(() => db.db.close());
  const { q } = db;
  q("INSERT INTO users (id,username,password_hash,role,created_at) VALUES (1,'reader','unused','admin',1)").run();
  q("INSERT INTO libraries (id,name,path,kind,created_at) VALUES (1,'Books','/books','books',1)").run();
  for (const id of [1, 2]) {
    q('INSERT INTO series (id,library_id,key,name,created_at,updated_at) VALUES (?,1,?,?,1,1)').run(id, 'series'+id, 'Series '+id);
    q("INSERT INTO books (id,library_id,path,rel_path,format,title,series_id,page_count,added_at,updated_at) VALUES (?,1,?,?,'epub',?,?,100,1,1)").run(id, '/books/'+id+'.epub', id+'.epub', 'Book '+id, id);
  }
  q("INSERT INTO collections (id,user_id,name,created_at,updated_at) VALUES (1,1,'Kobo',1,1)").run();
  q('INSERT INTO collection_items VALUES (1,1,1)').run();
  q("INSERT INTO api_keys (id,user_id,name,key,scope,created_at) VALUES (1,1,'Device','full-access-key-123456789','full',1)").run();
  function request(router, method, url, body = {}, headers = {}, acting = user) {
    return new Promise((resolve, reject) => {
      const req = { method, url, originalUrl: url, headers, body, user: acting, query: Object.fromEntries(new URL(url, 'https://flyleaf.test').searchParams), protocol: 'https',
        get(name) { return headers[name.toLowerCase()] || (name.toLowerCase() === 'host' ? 'flyleaf.test' : undefined); } };
      const res = { statusCode: 200, headers: {}, status(n) { this.statusCode = n; return this; }, set(k, v) { if (typeof k === 'object') Object.assign(this.headers, k); else this.headers[k] = v; return this; },
        json(value) { resolve({ status: this.statusCode, body: value, headers: this.headers }); }, end() { resolve({ status: this.statusCode }); },
        download(file, filename, options, callback) { const body = fs.readFileSync(file); callback?.(); resolve({ status: this.statusCode, body, filename, headers: this.headers }); } };
      router.handle(req, res, (err) => err ? reject(err) : resolve({ status: 404 }));
    });
  }
  return { ...db, load, user, request, events };
}

test('book languages come from each file, including mixed-language series', (t) => {
  const { q, load, user } = setup(t);
  q('UPDATE series SET language = ? WHERE id = 1').run('ja');
  q('UPDATE books SET embedded = ? WHERE id = 1').run(JSON.stringify({ language: 'en' }));
  q('UPDATE books SET series_id = 1, embedded = ? WHERE id = 2').run(JSON.stringify({ language: ['es', 'fr'] }));
  const { seriesBooks, getBook, toBook, listSeries, getSeries } = load('server/serialize.js');
  const books = seriesBooks(1, user);
  assert.equal(books[0].language, 'en');
  assert.deepEqual(Array.from(books[1].language), ['es', 'fr']);
  assert.deepEqual(Array.from(listSeries(user).items[0].languages).sort(), ['en', 'es', 'fr']);
  assert.deepEqual(Array.from(getSeries(1, user).languages).sort(), ['en', 'es', 'fr']);
  q('UPDATE books SET missing = 1 WHERE id = 2').run();
  assert.deepEqual(Array.from(listSeries(user).items[0].languages), ['en'], 'missing translations are excluded from badges');
  q('UPDATE books SET embedded = ? WHERE id = 1').run('{}');
  assert.equal(toBook(getBook(1, user), false, user).language, null, 'series language must not mislabel a translation');
  assert.equal(toBook(getBook(1, user), false, user).ageRating, null);
  q('UPDATE series SET age_rating = 1 WHERE id = 1').run();
  assert.equal(toBook(getBook(1, user), false, user).ageRating, 1);
  q('UPDATE books SET embedded = ? WHERE id = 1').run(JSON.stringify({ ageRating: 3 }));
  assert.equal(toBook(getBook(1, user), false, user).ageRating, 3, 'adult file metadata takes precedence over a teen series rating');
});

test('bulk metadata edits validate atomically, lock fields, and enforce ownership', async (t) => {
  const { load, request, q, user } = setup(t);
  const router = load('server/routes/series.js').router;
  assert.equal((await request(router, 'PATCH', '/series/bulk', { ids: [1, 999], tags: ['New'] })).status, 404);
  assert.equal(q('SELECT tags FROM series WHERE id = 1').get().tags, '[]');
  assert.equal((await request(router, 'PATCH', '/series/bulk', { ids: [1, 2], ageRating: 8 })).status, 400);
  assert.equal((await request(router, 'PATCH', '/series/bulk', { ids: [1, 2], tags: ['New', 'new'], ageRating: 1, collectionId: 1 })).status, 200);
  assert.equal(q('SELECT COUNT(*) n FROM collection_items').get().n, 2);
  assert.equal(q('SELECT tags FROM series WHERE id = 2').get().tags, '["New"]');
  assert.ok(JSON.parse(q('SELECT locked FROM series WHERE id = 2').get().locked).includes('age_rating'));
  assert.equal((await request(router, 'PATCH', '/series/bulk', { ids: [1], genres: [] }, {}, { ...user, role: 'guest' })).status, 403);
  assert.equal((await request(router, 'PATCH', '/series/bulk', { ids: [1], collectionId: 1 }, {}, { ...user, id: 2, role: 'guest' })).status, 404);
});

test('source schedules override defaults, pause, and survive reload', (t) => {
  const { q, load } = setup(t);
  const f = load('server/follows.js');
  const follow = { user_id: 1, plugin_id: 'source', last_checked_at: 1000 };
  assert.equal(f.isDue(follow, 1000 + 5 * 3600_000), false);
  q('INSERT INTO source_schedules VALUES (1,?,1)').run('source');
  assert.equal(f.isDue(follow, 1000 + 3600_000), true);
  q('UPDATE source_schedules SET hours = 168').run();
  assert.equal(f.isDue(follow, 1000 + 24 * 3600_000), false);
  q('UPDATE source_schedules SET hours = 0').run();
  assert.equal(f.isDue(follow, 1000 + 9000 * 3600_000), false);
});

test('Kobo sync sends a selected EPUB shelf, incremental updates, progress and removals', async (t) => {
  const { load, q, request, user, events } = setup(t);
  const { router, uuid } = load('server/kobo.js');
  const base = '/full-access-key-123456789';
  assert.equal((await request(router, 'GET', '/bad/v1/library/sync')).status, 401);
  assert.equal((await request(router, 'GET', '/read-access-key-123456789/v1/library/sync')).status, 403);
  const init = (await request(router, 'GET', base+'/v1/initialization')).body.Resources;
  assert.ok(init.device_auth.endsWith('/v1/auth/device'));
  assert.ok(init.reading_state.endsWith('/{Ids}/state'));
  assert.ok(init.image_url_template.includes('{Width}/{Height}'));
  const first = await request(router, 'GET', base+'/v1/library/sync');
  assert.equal(first.body.filter((v) => v.NewEntitlement).length, 1);
  assert.equal(first.body[0].NewEntitlement.BookMetadata.Title, 'Book 1');
  assert.ok(first.body[1].NewTag);
  const headers = { 'x-kobo-synctoken': first.headers['x-kobo-synctoken'] };
  assert.equal((await request(router, 'GET', base+'/v1/library/sync', {}, headers)).body.length, 0);
  assert.equal((await request(router, 'GET', base+'/v1/library/'+uuid(2)+'/state')).status, 404);
  assert.equal((await request(router, 'PUT', base+'/v1/library/'+uuid(1)+'/state', { ReadingStates: [{ CurrentBookmark: { ProgressPercent: 125 } }] })).status, 400);
  const saved = await request(router, 'PUT', base+'/v1/library/'+uuid(1)+'/state', { ReadingStates: [{ CurrentBookmark: { ProgressPercent: 50, Location: { Value: 'native', Type: 'KoboSpan', Source: 'Kobo' } }, StatusInfo: { Status: 'Reading' } }] });
  assert.equal(saved.status, 200);
  assert.equal(q('SELECT percent FROM progress').get().percent, 0.5);
  assert.equal((await request(router, 'GET', base+'/v1/library/'+uuid(1)+'/state')).body[0].CurrentBookmark.Location.Value, 'native');
  load('server/client-sync.js').saveProgress(user, { id: 1 }, { percent: 0.75 });
  const state = (await request(router, 'GET', base+'/v1/library/'+uuid(1)+'/state')).body[0];
  assert.equal(state.CurrentBookmark.ProgressPercent, 75);
  assert.equal(state.CurrentBookmark.Location, undefined);
  assert.ok(events.some(([name]) => name === 'progress.updated'));
  const second = await request(router, 'GET', base+'/v1/library/sync');
  q('DELETE FROM collection_items').run();
  const removed = await request(router, 'GET', base+'/v1/library/sync', {}, { 'x-kobo-synctoken': second.headers['x-kobo-synctoken'] });
  assert.equal(removed.body[0].ChangedEntitlement.BookEntitlement.IsRemoved, true);
  user.visibleLibraryIds = [];
  assert.equal((await request(router, 'GET', base+'/v1/library/'+uuid(1)+'/state')).status, 404);
});

test('kosync authenticates revocable key digests and exchanges page progress with the web', async (t) => {
  const { load, q, request, user } = setup(t);
  const { router } = load('server/kosync.js');
  const document = crypto.createHash('md5').update('1.epub').digest('hex');
  const headers = { 'x-auth-user': 'reader', 'x-auth-key': crypto.createHash('md5').update('full-access-key-123456789').digest('hex') };
  q("UPDATE books SET format = 'pdf' WHERE id = 1").run();
  assert.equal((await request(router, 'GET', '/users/auth')).status, 401);
  assert.equal((await request(router, 'GET', '/users/auth', {}, headers)).status, 200);
  assert.equal((await request(router, 'PUT', '/syncs/progress', { document, progress: '21', percentage: 0.2 }, headers)).status, 200);
  assert.equal(q('SELECT page FROM progress').get().page, 20);
  load('server/client-sync.js').saveProgress(user, { id: 1 }, { percent: 0.4, page: 40 });
  const result = await request(router, 'GET', '/syncs/progress/'+document, {}, headers);
  assert.equal(result.body.progress, '41'); assert.equal(result.body.percentage, 0.4);
  assert.equal((await request(router, 'PUT', '/syncs/progress', { document, progress: '21', percentage: -1 }, headers)).status, 400);
  assert.equal((await request(router, 'PUT', '/syncs/progress', { document, progress: '0', percentage: 0 }, headers)).status, 400);
  assert.equal((await request(router, 'PUT', '/syncs/progress', { document, progress: '/body/p/text().0', percentage: 0.5 }, headers)).status, 400);
  user.role = 'guest'; user.visibleLibraryIds = [];
  assert.equal((await request(router, 'GET', '/syncs/progress/'+document, {}, headers)).status, 404);
  user.role = 'admin'; user.visibleLibraryIds = [1];
  q('DELETE FROM api_keys').run();
  assert.equal((await request(router, 'GET', '/users/auth', {}, headers)).status, 401);
});

test('Kobo pages large libraries, supports token retries and rechecks access between pages', async t => {
  const { load, q, request, user } = setup(t);
  const { router, uuid } = load('server/kobo.js');
  const base = '/full-access-key-123456789/v1/library/sync';
  for (let id = 3; id <= 207; id++) {
    q("INSERT INTO books (id, library_id, path, rel_path, format, title, series_id, added_at, updated_at) VALUES (?,1,?,?,'epub',?,1,1,1)")
      .run(id, '/books/' + id + '.epub', id + '.epub', 'Book ' + id);
  }
  const first = await request(router, 'GET', base);
  assert.equal(first.body.length, 100);
  assert.equal(first.headers['x-kobo-sync'], 'continue');
  const headers = { 'x-kobo-synctoken': first.headers['x-kobo-synctoken'] };
  const second = await request(router, 'GET', base, {}, headers);
  const retry = await request(router, 'GET', base, {}, headers);
  assert.deepEqual(JSON.parse(JSON.stringify(retry.body)), JSON.parse(JSON.stringify(second.body)), 'retry never resets to the first page');
  assert.equal(second.body.length, 100);
  const last = await request(router, 'GET', base, {}, { 'x-kobo-synctoken': second.headers['x-kobo-synctoken'] });
  assert.equal(last.headers['x-kobo-sync'], 'complete');
  const ids = [...first.body, ...second.body, ...last.body].filter(r => r.NewEntitlement).map(r => r.NewEntitlement.BookEntitlement.Id);
  assert.equal(ids.length, 206);
  assert.equal(new Set(ids).size, 206);
  assert.equal((await request(router, 'GET', base, {}, { 'x-kobo-synctoken': last.headers['x-kobo-synctoken'] })).body.length, 0);
  user.role = 'guest'; user.visibleLibraryIds = [];
  const revoked = await request(router, 'GET', base, {}, headers);
  assert.ok(revoked.body.every(r => !r.NewEntitlement));
  assert.ok(revoked.body.filter(r => r.ChangedEntitlement).every(r => r.ChangedEntitlement.BookEntitlement.IsRemoved));
  assert.equal(revoked.body[0].ChangedEntitlement.BookEntitlement.Id, uuid(1));
});

test('Kobo shelf edits enforce ownership, validate atomically and preserve individual book membership', async t => {
  const { load, q, request, user } = setup(t);
  const { router, uuid } = load('server/kobo.js');
  const base = '/full-access-key-123456789/v1/library/tags';
  const item = id => ({ RevisionId: uuid(id), Type: 'ProductRevisionTagItem' });
  const initial = await request(router, 'GET', '/full-access-key-123456789/v1/library/sync');
  const created = await request(router, 'POST', base, { Name: 'Device shelf', Items: [item(1)] });
  assert.equal(created.status, 201);
  const id = Number(created.body.slice(-12));
  const members = () => JSON.parse(load('server/client-sync.js').load(user, 'kobo-shelf', `collection:${id}`).data).include;
  assert.deepEqual(members(), [1]);
  assert.equal((await request(router, 'PUT', base + '/' + created.body, { Name: 'Renamed' })).status, 200);
  assert.equal(q('SELECT name FROM collections WHERE id = ?').get(id).name, 'Renamed');
  assert.equal((await request(router, 'POST', base + '/' + created.body + '/items', { Items: [item(2), item(999)] })).status, 400);
  assert.deepEqual(members(), [1], 'invalid batch makes no partial changes');
  assert.equal((await request(router, 'POST', base + '/' + created.body + '/items', { Items: [item(2)] })).status, 201);
  assert.equal((await request(router, 'POST', base + '/' + created.body + '/items/delete', { Items: [item(1)] })).status, 200);
  assert.deepEqual(members(), [2]);
  const updated = await request(router, 'GET', '/full-access-key-123456789/v1/library/sync', {}, { 'x-kobo-synctoken': initial.headers['x-kobo-synctoken'] });
  assert.ok(updated.body.some(r => r.NewTag?.Tag.Name === 'Renamed'));
  q("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (2, 'other', 'unused', 'guest', 1)").run();
  q("INSERT INTO collections (id,user_id,name,created_at,updated_at) VALUES (99,2,'Private',1,1)").run();
  assert.equal((await request(router, 'PUT', base + '/' + uuid(99), { Name: 'Stolen' })).status, 404);
  assert.equal((await request(router, 'DELETE', base + '/' + uuid(99))).status, 404);
  assert.ok(!(await request(router, 'GET', base)).body.some(tag => tag.Name === 'Private'));
  assert.equal((await request(router, 'DELETE', base + '/' + created.body)).status, 200);
  const deleted = await request(router, 'GET', '/full-access-key-123456789/v1/library/sync', {}, { 'x-kobo-synctoken': updated.headers['x-kobo-synctoken'] });
  assert.ok(deleted.body.some(r => r.DeletedTag?.Tag.Id === created.body));
  q("INSERT INTO books (id,library_id,path,rel_path,format,title,series_id,added_at,updated_at) VALUES (3,1,'/books/3.epub','3.epub','epub','Sibling',1,1,1)").run();
  await request(router, 'POST', base + '/' + uuid(1) + '/items/delete', { Items: [item(1)] });
  assert.equal((await request(router, 'GET', '/full-access-key-123456789/v1/library/' + uuid(1) + '/state')).status, 404);
  assert.equal((await request(router, 'GET', '/full-access-key-123456789/v1/library/' + uuid(3) + '/state')).status, 200, 'removing one book leaves its sibling available');
  await request(router, 'POST', base + '/' + uuid(1) + '/items', { Items: [item(2)] });
  assert.equal((await request(router, 'GET', '/full-access-key-123456789/v1/library/' + uuid(2) + ',' + uuid(3) + '/state')).body.length, 2);
  assert.equal((await request(router, 'GET', '/full-access-key-123456789/v1/library/' + uuid(2) + ',' + uuid(99) + '/state')).status, 404);
  user.permissions.download = false;
  assert.equal((await request(router, 'POST', base, { Name: 'Blocked', Items: [] })).status, 403);
});

test('kosync ebook return uses an observed native anchor and leaves web locators clear', async (t) => {
  const { load, q, request, user } = setup(t);
  const { router } = load('server/kosync.js');
  const document = crypto.createHash('md5').update('1.epub').digest('hex');
  const headers = { 'x-auth-user': 'reader', 'x-auth-key': crypto.createHash('md5').update('full-access-key-123456789').digest('hex') };
  load('server/client-sync.js').saveProgress(user, { id: 1 }, { percent: 0.4 });
  assert.equal((await request(router, 'GET', '/syncs/progress/'+document, {}, headers)).status, 409);
  const native = '/body/DocFragment[2]/body/p[3]/text().0';
  await request(router, 'PUT', '/syncs/progress', { document, progress: native, percentage: 0.4 }, headers);
  assert.equal(q('SELECT position FROM progress').get().position, null);
  load('server/client-sync.js').saveProgress(user, { id: 1 }, { percent: 0.45 });
  const result = await request(router, 'GET', '/syncs/progress/'+document, {}, headers);
  assert.equal(result.body.progress, native);
  assert.equal(result.body.percentage, 0.4);
});

test('Kobo batch progress writes match entitlement IDs and reject invalid batches without partial updates', async t => {
  const { load, q, request } = setup(t);
  q('INSERT INTO collection_items VALUES (1,2,1)').run();
  const { router, uuid } = load('server/kobo.js');
  const url = '/full-access-key-123456789/v1/library/' + uuid(1) + ',' + uuid(2) + '/state';
  const progress = (id, percent) => ({ EntitlementId: uuid(id), CurrentBookmark: { ProgressPercent: percent } });
  const result = await request(router, 'PUT', url, { ReadingStates: [progress(2, 75), progress(1, 25)] });
  assert.equal(result.status, 200);
  assert.equal(result.body.UpdateResults.length, 2);
  assert.equal(q('SELECT percent FROM progress WHERE book_id = 1').get().percent, 0.25);
  assert.equal(q('SELECT percent FROM progress WHERE book_id = 2').get().percent, 0.75);
  for (const input of [[progress(1, 50), progress(2, 101)], [progress(1, 50), progress(1, 60)], [progress(1, 50), progress(99, 60)]]) {
    assert.equal((await request(router, 'PUT', url, { ReadingStates: input })).status, 400);
    assert.equal(q('SELECT percent FROM progress WHERE book_id = 1').get().percent, 0.25);
    assert.equal(q('SELECT percent FROM progress WHERE book_id = 2').get().percent, 0.75);
  }
  q('DELETE FROM collection_items WHERE series_id = 2').run();
  assert.equal((await request(router, 'PUT', url, { ReadingStates: [progress(1, 50), progress(2, 50)] })).status, 404);
  assert.equal(q('SELECT percent FROM progress WHERE book_id = 1').get().percent, 0.25);
});

test('kosync imports and exports precise FB2 positions through the real converter', async t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'flyleaf-fb2-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { load, q, request, user } = setup(t, dir);
  const file = path.join(dir, 'book.fb2');
  fs.writeFileSync(file, '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>Test</book-title><lang>en</lang></title-info></description><body><section><p>Round trip text.</p></section></body></FictionBook>');
  q("UPDATE books SET path = ?, format = 'fb2' WHERE id = 1").run(file);
  const { router } = load('server/kosync.js');
  const document = crypto.createHash('md5').update('book.fb2').digest('hex');
  const headers = { 'x-auth-user': 'reader', 'x-auth-key': crypto.createHash('md5').update('full-access-key-123456789').digest('hex') };
  const native = '/FictionBook/body[1]/section[1]/p[1]/text()[1].4';
  assert.equal((await request(router, 'PUT', '/syncs/progress', { document, progress: native, percentage: 0.2 }, headers)).status, 200);
  const cfi = q('SELECT position FROM progress WHERE book_id = 1').get().position;
  assert.ok(cfi?.startsWith('epubcfi('));
  load('server/client-sync.js').saveProgress(user, { id: 1 }, { percent: 0.5, position: cfi.replace(/:\d+\)$/, ':8)') });
  const pulled = await request(router, 'GET', '/syncs/progress/' + document, {}, headers);
  assert.equal(pulled.body.progress, '/FictionBook/body[1]/section[1]/p[1]/text()[1].8');
  assert.equal(pulled.body.percentage, 0.5);
});

test('kosync exchanges precise legacy MOBI positions while retaining native fallback for guarded files', async t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'flyleaf-mobi-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { load, q, request, user } = setup(t, dir);
  const file = path.join(dir, 'book.mobi');
  fs.writeFileSync(file, require('./mobi-fixture.cjs')('<html><head><title>Test</title></head><body><p>Legacy text.</p></body></html>', { compression: 2 }));
  q("UPDATE books SET path = ?, format = 'mobi' WHERE id = 1").run(file);
  const { router } = load('server/kosync.js');
  const document = crypto.createHash('md5').update('book.mobi').digest('hex');
  const headers = { 'x-auth-user': 'reader', 'x-auth-key': crypto.createHash('md5').update('full-access-key-123456789').digest('hex') };
  assert.equal((await request(router, 'PUT', '/syncs/progress', { document, progress: '/body/p[1]/text()[1].3', percentage: 0.2 }, headers)).status, 200);
  const cfi = q('SELECT position FROM progress WHERE book_id = 1').get().position;
  assert.ok(cfi?.startsWith('epubcfi('));
  load('server/client-sync.js').saveProgress(user, { id: 1 }, { percent: 0.6, position: cfi.replace(/:\d+\)$/, ':7)') });
  const pulled = await request(router, 'GET', '/syncs/progress/' + document, {}, headers);
  assert.equal(pulled.body.progress, '/body/p[1]/text()[1].7');
  assert.equal(pulled.body.percentage, 0.6);
  const binary = await load('server/kosync.js').partialMD5(file);
  assert.equal((await request(router, 'PUT', '/syncs/progress', { document: binary, progress: '/body/p[1]/text()[1].3', percentage: 0.2 }, headers)).status, 200);
  fs.writeFileSync(file, require('./mobi-fixture.cjs')('<html><head><title>New edition</title></head><body><p>Changed content.</p></body></html>'));
  assert.equal((await request(router, 'GET', '/syncs/progress/' + binary, {}, headers)).status, 404, 'cached binary digests do not bind replaced editions');
});

test('Kobo downloads generated KEPUB and maps device progress only for the downloaded revision', async t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'flyleaf-kobo-rendition-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { load, q, request, user } = setup(t, dir);
  const zip = new (require('jszip'))();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>');
  zip.file('package.opf', '<package><metadata/><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>');
  zip.file('c.xhtml', '<html><head><title>Chapter</title></head><body><p>First sentence. Second sentence.</p></body></html>');
  const file = path.join(dir, 'book.epub');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  q('UPDATE books SET path = ? WHERE id = 1').run(file);
  const { router, uuid } = load('server/kobo.js');
  const base = '/full-access-key-123456789';
  const metadata = await request(router, 'GET', base + '/v1/library/' + uuid(1) + '/metadata');
  const offer = metadata.body[0].DownloadUrls[0];
  assert.equal(offer.Format, 'KEPUB');
  const downloadPath = new URL(offer.Url).pathname.replace('/api/kobo', '') + new URL(offer.Url).search;
  const downloaded = await request(router, 'GET', downloadPath);
  assert.ok(downloaded.filename.endsWith('.kepub.epub'));
  const converted = await require('jszip').loadAsync(downloaded.body);
  assert.match(await converted.file('c.xhtml').async('string'), /koboSpan/);
  const data = { ReadingStates: [{ CurrentBookmark: { ProgressPercent: 60, ContentSourceProgressPercent: 50, Location: { Source: 'c.xhtml', Type: 'KoboSpan', Value: 'kobo.2.1' } } }] };
  assert.equal((await request(router, 'PUT', base + '/v1/library/' + uuid(1) + '/state', data)).status, 200);
  assert.equal(q('SELECT position FROM progress WHERE book_id = 1').get().position, 'epubcfi(/6/2!/4/2/1:16)');
  const before = q('SELECT * FROM progress WHERE book_id = 1').get();
  assert.equal((await request(router, 'PUT', base + '/v1/library/' + uuid(1) + '/state', { ReadingStates: [{ Statistics: { SpentReadingMinutes: 12 } }] })).status, 200);
  assert.equal(q('SELECT updated_at FROM progress WHERE book_id = 1').get().updated_at, before.updated_at, 'statistics do not overwrite reading progress');
  assert.equal((await request(router, 'GET', base + '/v1/library/' + uuid(1) + '/state')).body[0].Statistics.SpentReadingMinutes, 12);
  zip.file('c.xhtml', '<html><head><title>Chapter</title></head><body><p>Completely changed edition.</p></body></html>');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal((await request(router, 'GET', downloadPath)).status, 409, 'old download URL cannot deliver a changed rendition');
  await request(router, 'PUT', base + '/v1/library/' + uuid(1) + '/state', data);
  assert.equal(q('SELECT position FROM progress WHERE book_id = 1').get().position, null, 'old device spans never become CFIs in the new edition');
  assert.equal((await request(router, 'GET', base + '/v1/library/' + uuid(1) + '/state')).body[0].CurrentBookmark.Location, undefined);
});

test('kosync returns new web EPUB positions before any KOReader push and prefers them over old anchors', async (t) => {
  const { load, q, request, user } = setup(t);
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'flyleaf-kosync-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'book.epub');
  const zip = new (require('jszip'))();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>');
  zip.file('package.opf', '<package><metadata/><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>');
  zip.file('c.xhtml', '<html><head><title>Chapter</title></head><body><p>Arbitrary reading position.</p><p><span id="kobo.1.1">Device position</span></p></body></html>');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  q('UPDATE books SET path = ? WHERE id = 1').run(file);
  const { router } = load('server/kosync.js');
  const document = crypto.createHash('md5').update('book.epub').digest('hex');
  const headers = { 'x-auth-user': 'reader', 'x-auth-key': crypto.createHash('md5').update('full-access-key-123456789').digest('hex') };
  const webSave = () => {
    load('server/client-sync.js').saveProgress(user, { id: 1 }, { percent: 0.6 });
    q('UPDATE progress SET position = ? WHERE book_id = 1').run('epubcfi(/6/2!/4/2/1:12)');
  };
  webSave();
  let result = await request(router, 'GET', '/syncs/progress/' + document, {}, headers);
  assert.equal(result.status, 200);
  assert.equal(result.body.progress, '/body/DocFragment[1]/body/p[1]/text()[1].12');
  assert.equal(result.body.percentage, 0.6);
  await request(router, 'PUT', '/syncs/progress', { document, progress: '/body/DocFragment[1]/body/p[1]/text().0', percentage: 0.1 }, headers);
  webSave();
  result = await request(router, 'GET', '/syncs/progress/' + document, {}, headers);
  assert.equal(result.body.progress, '/body/DocFragment[1]/body/p[1]/text()[1].12');
  assert.equal(result.body.percentage, 0.6);
  q('UPDATE progress SET position = ? WHERE book_id = 1').run('epubcfi(/6/2!/4/4/2/1:3)');
  const kobo = load('server/kobo.js');
  const state = await request(kobo.router, 'GET', '/full-access-key-123456789/v1/library/' + kobo.uuid(1) + '/state');
  assert.equal(state.body[0].CurrentBookmark.Location.Source, 'c.xhtml');
  assert.equal(state.body[0].CurrentBookmark.Location.Value, 'kobo.1.1');
  assert.equal(state.body[0].CurrentBookmark.ProgressPercent, 60);
  const received = await request(kobo.router, 'PUT', '/full-access-key-123456789/v1/library/' + kobo.uuid(1) + '/state', {
    ReadingStates: [{ CurrentBookmark: { ProgressPercent: 70, ContentSourceProgressPercent: 25, Location: { Source: 'c.xhtml', Type: 'KoboSpan', Value: 'kobo.1.1' } } }],
  });
  assert.equal(received.status, 200);
  assert.equal(q('SELECT position FROM progress WHERE book_id = 1').get().position, 'epubcfi(/6/2!/4/4/2/1:0)');
  const returned = await request(kobo.router, 'GET', '/full-access-key-123456789/v1/library/' + kobo.uuid(1) + '/state');
  assert.equal(returned.body[0].CurrentBookmark.ContentSourceProgressPercent, 25);
  user.visibleLibraryIds = []; user.role = 'guest';
  assert.equal((await request(router, 'GET', '/syncs/progress/' + document, {}, headers)).status, 404);
});
