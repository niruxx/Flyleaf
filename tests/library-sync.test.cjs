'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function setup(t) {
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
      process: { env: {} }, setTimeout, setInterval,
      require: (name) => {
        if (name === 'node:sqlite') return { DatabaseSync: function () { return new DatabaseSync(':memory:'); } };
        if (file.endsWith(`${path.sep}db.js`) && name === 'node:fs') return { mkdirSync() {} };
        if (name.endsWith('/config')) return { dataDir: '<memory>' };
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
      const req = { method, url, originalUrl: url, headers, body, user: acting, query: {}, protocol: 'https',
        get(name) { return headers[name.toLowerCase()] || (name.toLowerCase() === 'host' ? 'flyleaf.test' : undefined); } };
      const res = { statusCode: 200, headers: {}, status(n) { this.statusCode = n; return this; }, set(k, v) { if (typeof k === 'object') Object.assign(this.headers, k); else this.headers[k] = v; return this; },
        json(value) { resolve({ status: this.statusCode, body: value, headers: this.headers }); }, end() { resolve({ status: this.statusCode }); } };
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
  user.role = 'guest'; user.visibleLibraryIds = [];
  assert.equal((await request(router, 'GET', '/syncs/progress/'+document, {}, headers)).status, 404);
  user.role = 'admin'; user.visibleLibraryIds = [1];
  q('DELETE FROM api_keys').run();
  assert.equal((await request(router, 'GET', '/users/auth', {}, headers)).status, 401);
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
