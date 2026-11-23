const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { estimateRemaining, validDay } = require('../server/reading-room');
function load(file, overrides) {
  const filename = path.resolve(file), real = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(filename),
    require: name => name in overrides ? overrides[name] : real(name), Date, Number, String, Boolean, Set, Map, Intl, console });
  return module.exports;
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyleaf-reading-room-'));
  const db = load('server/db.js', { './config': { dataDir: dir } });
  t.after(() => { db.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { q } = db;
  q("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (1,'one','hash','guest',1),(2,'two','hash','guest',1),(3,'admin','hash','admin',1)").run();
  q("INSERT INTO libraries (id,name,path,kind,created_at) VALUES (1,'Shared','/books','books',1),(2,'Hidden','/hidden','books',1)").run();
  for (let i = 1; i <= 6; i++) q('INSERT INTO series (id,library_id,key,name,age_rating,created_at,updated_at) VALUES (?,?,?,?,?,1,1)').run(i, i === 2 ? 2 : 1, `series${i}`, `Series ${i}`, i === 6 ? 3 : 0);
  const insert = q('INSERT INTO books (id,library_id,series_id,path,rel_path,format,title,volume,page_count,embedded,mtime,added_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,1,1)');
  for (const [id, series, format, pages, volume, embedded] of [[1,1,'cbz',20,1,{}],[2,1,'cbz',10,2,{}],[3,2,'cbz',5,1,{}],[4,3,'epub',0,1,{}],[5,4,'audio',1,1,{duration:3600}],[6,5,'epub',0,1,{}],[7,6,'cbz',5,1,{}]])
    insert.run(id, series === 2 ? 2 : 1, series, `/books/${id}`, `${id}`, format, `Book ${id}`, volume, pages, JSON.stringify(embedded));
  q('INSERT INTO book_text_state (book_id,mtime,sections,chars,indexed_at) VALUES (4,1,1,3000,1)').run();
  const serialize = load('server/serialize.js', { './db': db });
  const events = [];
  const router = load('server/routes/reading-room.js', { '../db': db, '../serialize': serialize }).router;
  const positions = load('server/routes/position-history.js', { '../db': db, '../serialize': serialize, '../events': { emit: (...args) => events.push(args) } }).router;
  const progress = load('server/routes/reading.js', { '../db': db, '../serialize': serialize, '../events': { emit: (...args) => events.push(args) } }).router;
  const user = { id: 1, username: 'one', role: 'guest', visibleLibraryIds: [1], maxAgeRating: 1, ageIncludeUnknown: true, permissions: {}, prefs: {} };
  const request = (method, url, body, acting = user, target = router) => new Promise((resolve, reject) => {
    const req = { method, url, user: acting, body, query: Object.fromEntries(new URL(url, 'http://test').searchParams), headers: {} };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } };
    target.handle(req, res, e => e ? reject(e) : resolve({ status: 404 }));
  });
  return { q, request, user, positions, progress, events };
}

test('reading estimates require reliable length, learn bounded pace and respect playback speed', () => {
  assert.equal(estimateRemaining({ format: 'epub', size: 2000000 }), null);
  assert.equal(estimateRemaining({ format: 'cbz', page_count: 20, p_percent: .5 }).seconds, 300);
  assert.equal(estimateRemaining({ format: 'epub', text_chars: 3000 }).seconds, 120);
  assert.equal(estimateRemaining({ format: 'audio', embedded: '{"duration":3600}' }, {}, 2).seconds, 1800);
  assert.equal(estimateRemaining({ format: 'cbz', page_count: 20 }, { comic: { seconds: 600, pages: 10 } }).basis, 'personal');
  assert.equal(estimateRemaining({ format: 'cbz', page_count: 20, p_finished: 1 }), null);
  assert.equal(validDay('2026-02-31'), false);
  assert.equal(validDay('2024-02-29'), true);
});
test('tonight respects library and age permissions, reading order, unknown length and input bounds', async t => {
  const { q, request } = setup(t);
  q('INSERT INTO progress (user_id,book_id,percent,finished,started_at,updated_at) VALUES (1,1,.5,0,1,1)').run();
  const r = await request('GET', '/reading/tonight?minutes=10');
  assert.equal(r.status, 200);
  assert.equal(Array.from(r.body.items, x => x.book.id).join(','), '1,4');
  assert.equal(r.body.unknown, 1);
  assert.equal((await request('GET', '/reading/tonight?minutes=4')).status, 400);
  assert.equal((await request('GET', '/reading/tonight?speed=NaN')).status, 400);
  assert.equal((await request('GET', '/reading/tonight?minutes=30&kind=audio&speed=2')).body.items[0].book.id, 5);
  q('UPDATE progress SET finished=1,percent=1 WHERE user_id=1 AND book_id=1').run();
  assert.ok((await request('GET', '/reading/tonight?minutes=10')).body.items.some(x => x.book.id === 2));
});
test('journal reflections and highlights stay private, validate dates, and hide revoked books', async t => {
  const { q, request, user } = setup(t);
  const body = { day: '2026-11-04', bookId: 1, body: '<script>plain text</script>', mood: 'moved' };
  const id = (await request('POST', '/journal', body)).body.id;
  assert.ok(id);
  assert.equal((await request('POST', '/journal', { ...body, day: '2026-02-31' })).status, 400);
  assert.equal((await request('POST', '/journal', { ...body, bookId: 3 })).status, 404);
  assert.equal((await request('POST', '/journal', { ...body, bookId: 7 })).status, 404);
  assert.equal((await request('POST', '/journal', { ...body, mood: '__proto__' })).status, 400);
  assert.equal((await request('GET', '/journal?month=2026-13')).status, 400);
  q('INSERT INTO reading_log (user_id,book_id,day,seconds,pages) VALUES (1,1,?,600,10)').run(body.day);
  q("INSERT INTO annotations (user_id,book_id,kind,locator,text,created_at,updated_at) VALUES (1,1,'highlight','2','Keep this',?,?)").run(Date.parse('2026-11-04T12:00:00Z'), Date.now());
  const data = (await request('GET', '/journal?month=2026-11')).body;
  assert.equal(data.entries[0].body, body.body);
  assert.equal(data.reading[0].seconds, 600);
  assert.equal(data.highlights[0].text, 'Keep this');
  const other = { ...user, id: 2 };
  assert.equal((await request('GET', '/journal?month=2026-11', null, other)).body.entries.length, 0);
  assert.equal((await request('PUT', `/journal/${id}`, body, other)).status, 404);
  assert.equal((await request('DELETE', `/journal/${id}`, null, other)).status, 404);
  const revoked = (await request('GET', '/journal?month=2026-11', null, { ...user, visibleLibraryIds: [] })).body;
  assert.equal(revoked.entries.length + revoked.highlights.length + revoked.reading.length, 0);
  assert.equal((await request('PUT', `/journal/${id}`, { ...body, body: 'Updated' })).status, 200);
  q('DELETE FROM books WHERE id=1').run();
  assert.equal((await request('GET', '/journal?month=2026-11')).body.entries[0].body, 'Updated', 'deleting a file must preserve the reflection');
});
test('position history captures device-style SQL writes and protects restores with owner, version and concurrency checks', async t => {
  const { q, request, user, positions } = setup(t);
  const call = (method, url, body, acting = user) => request(method, url, body, acting, positions);
  q('INSERT INTO progress (user_id,book_id,page,percent,finished,started_at,updated_at) VALUES (1,1,2,.15,0,1,100)').run();
  q('UPDATE progress SET page=15,percent=.8,updated_at=200 WHERE user_id=1 AND book_id=1').run();
  q('UPDATE progress SET updated_at=300 WHERE user_id=1 AND book_id=1').run();
  const history = (await call('GET', '/books/1/positions')).body;
  assert.equal(history.items.length, 2, 'heartbeats without location changes must not fill history');
  assert.equal(history.items[0].current, true);
  const old = history.items[1].id;
  assert.equal((await call('POST', `/books/1/positions/${old}/restore`, { expectedUpdatedAt: 300 }, { ...user, id: 2 })).status, 404);
  assert.equal((await call('POST', `/books/1/positions/${old}/restore`, { expectedUpdatedAt: 200 })).status, 409);
  assert.equal((await call('POST', `/books/1/positions/${old}/restore`, { expectedUpdatedAt: 300 })).status, 200);
  assert.equal(q('SELECT page FROM progress WHERE user_id=1 AND book_id=1').get().page, 2);
  assert.ok((await call('GET', '/books/1/positions')).body.items.some(item => item.page === 15), 'the replaced current position stays recoverable');
  q('UPDATE books SET mtime=2 WHERE id=1').run();
  assert.equal((await call('POST', `/books/1/positions/${old}/restore`, { expectedUpdatedAt: q('SELECT updated_at FROM progress WHERE user_id=1 AND book_id=1').get().updated_at })).status, 409);
  for (let i=0; i<110; i++) q('UPDATE progress SET page=?,updated_at=? WHERE user_id=1 AND book_id=1').run(i, 1000+i);
  assert.equal(q('SELECT COUNT(*) AS n FROM position_history WHERE user_id=1 AND book_id=1').get().n, 100);
});

test('offline progress replays respect account scope and the newer device position', async t => {
  const { q, request, user, progress } = setup(t);
  const save = (body, acting = user) => request('PUT', '/books/1/progress', body, acting, progress);
  const read = () => q('SELECT page, updated_at FROM progress WHERE user_id=1 AND book_id=1').get();
  const now = Date.now() - 1000;
  assert.equal((await save({ page: 7, syncUserId: 1, recordedAt: now })).status, 200);
  assert.equal(read().updated_at, now);
  assert.equal((await save({ page: 4, syncUserId: 1, recordedAt: now - 100, seconds: 30, day: '2026-11-23' })).status, 200);
  assert.equal(read().page, 7);
  assert.equal(q("SELECT seconds FROM reading_log WHERE user_id=1 AND book_id=1 AND day='2026-11-23'").get().seconds, 30);
  assert.equal((await save({ page: 9, syncUserId: 1, recordedAt: now + 100 }, { ...user, id: 2 })).status, 403);
  assert.equal((await save({ seconds: 5, syncUserId: 1 })).status, 200);
  assert.equal(read().updated_at, now, 'a heartbeat without a position leaves the sync timestamp alone');
  assert.equal((await save({ page: 5, syncUserId: 1, recordedAt: now + 100 })).status, 200);
  assert.equal(read().page, 5, 'a later position can be earlier in the book');
  assert.equal((await save({ page: 11 }, { ...user, id: 2 })).status, 200);
  assert.equal(read().page, 5);
});
