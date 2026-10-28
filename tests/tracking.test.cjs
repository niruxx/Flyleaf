'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const providers = require('../server/tracking-providers');
const { createTracking } = require('../server/tracking-service');

function database() {
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync('server/db.js', 'utf8'), { module: mod, exports: mod.exports,
    require: (name) => name === './config' ? { dataDir: '<memory>' }
      : name === 'node:sqlite' ? { DatabaseSync: function () { return new DatabaseSync(':memory:'); } }
      : name === 'node:fs' ? { mkdirSync() {} } : require(name),
  }, { filename: 'server/db.js' });
  return mod.exports;
}
function setup(t, overrides = {}) {
  const db = database();
  t.after(() => db.db.close());
  const { q } = db;
  for (const id of [1, 2]) q('INSERT INTO users (id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)').run(id, 'user' + id, 'unused', 'guest', 1);
  q('INSERT INTO libraries (id,name,path,kind,created_at) VALUES (1,?,?,?,1)').run('Manga', '/manga', 'manga');
  q(`INSERT INTO series (id,library_id,key,name,provider_ids,created_at,updated_at) VALUES (1,1,'series','Series',?,1,1)`)
    .run(JSON.stringify({ anilist: '101', mal: '202', mangaupdates: '303000000000', kitsu: '404' }));
  q(`INSERT INTO books (id,library_id,path,rel_path,format,title,series_id,chapter,added_at,updated_at) VALUES (1,1,'/manga/1.cbz','1.cbz','cbz','Chapter 1',1,1,1,1)`).run();
  const hooks = new Map(), writes = [];
  const api = { ...providers, configured: () => true, authorizationUrl: (p, state) => `https://example.test/${p}?state=${state}`,
    login: async () => ({ accessToken: 'secret-token', refreshToken: 'secret-refresh', expiresAt: Date.now() + 3600_000 }),
    redeem: async () => ({ accessToken: 'secret-token', refreshToken: null, expiresAt: null }),
    identity: async () => ({ id: '999', name: 'Remote reader' }),
    readEntry: async () => ({ chapters: 10, volumes: 0, progress: 0, progressVolumes: 0, status: 'CURRENT', score: 8.6 }),
    writeEntry: async (...args) => writes.push(args), ...overrides };
  const events = { on: (name, fn) => { hooks.set(name, fn); return () => hooks.delete(name); } };
  const deps = { ...db, providers: api, events, getUser: (id) => ({ id }), canRead: (sid, user) => user.id === 1 };
  const tracking = createTracking(deps);
  t.after(() => tracking.stop());
  return { ...db, tracking, deps, api, hooks, writes };
}
const finishBook = (q, uid = 1) => q('INSERT INTO progress (user_id,book_id,finished,percent,started_at,updated_at) VALUES (?,1,1,1,1,1)').run(uid);

test('all migrations succeed and tokens are excluded from account responses', async (t) => {
  const { tracking, q } = setup(t);
  for (const provider of Object.keys(providers.DEFINITIONS)) await tracking.login(1, provider, 'name', 'password');
  const accounts = tracking.accounts(1);
  assert.equal(accounts.length, 4);
  assert.ok(accounts.every((a) => a.connected));
  assert.ok(!JSON.stringify(accounts).includes('secret'));
  assert.ok(tracking.accounts(2).every((a) => !a.connected));
  assert.equal(q('PRAGMA foreign_key_check').all().length, 0);
});

test('OAuth state is single-use and bound to user and provider', async (t) => {
  const { tracking } = setup(t);
  const state = new URL(tracking.begin(1, 'anilist')).searchParams.get('state');
  await assert.rejects(tracking.finish(2, 'anilist', state, 'code'));
  await assert.rejects(tracking.finish(1, 'mal', state, 'code'));
  await tracking.finish(1, 'anilist', state, 'code');
  await assert.rejects(tracking.finish(1, 'anilist', state, 'code'));
  assert.equal(tracking.accounts(1)[0].connected, true);
});

test('OAuth cancellation, expiry and disconnect invalidate pending connections', async (t) => {
  let release;
  const { tracking, q } = setup(t, { redeem: () => new Promise((resolve) => { release = resolve; }) });
  let state = new URL(tracking.begin(1, 'anilist')).searchParams.get('state');
  q('UPDATE tracking_oauth SET expires_at=0').run();
  await assert.rejects(tracking.finish(1, 'anilist', state, 'code'));
  state = new URL(tracking.begin(1, 'anilist')).searchParams.get('state');
  await assert.rejects(tracking.finish(1, 'anilist', state, null, true));
  state = new URL(tracking.begin(1, 'anilist')).searchParams.get('state');
  const pending = tracking.finish(1, 'anilist', state, 'code');
  tracking.disconnect(1, 'anilist');
  release({ accessToken: 'secret', refreshToken: null, expiresAt: null });
  await assert.rejects(pending);
  assert.equal(tracking.accounts(1)[0].connected, false);
});

test('local progress excludes extras and chapter files do not finish a volume', () => {
  assert.deepEqual(providers.localProgress([
    { chapter: 12.5, volume: 3, finished: 1 }, { volume: 2, finished: 1 },
    { chapter: 99, finished: 0 }, { chapter: 100, finished: 1, special: 1 }, { volume: 10, finished: 1, missing: 1 },
  ]), { chapters: 12, volumes: 2 });
  const ongoing = providers.progressUpdate('anilist', { chapters: 10, volumes: 0 }, { progress: 20, progressVolumes: 2, chapters: 0, volumes: 0 });
  assert.deepEqual(ongoing, { progress: 20, progressVolumes: 2, status: 'CURRENT' });
  assert.equal(providers.progressUpdate('mal', { chapters: 10, volumes: 0 }, { chapters: 10, progress: 0 }).status, 'completed');
  assert.equal(providers.progressUpdate('kitsu', { chapters: 0, volumes: 3 }, { chapters: 10, volumes: 0 }).status, 'current');
  assert.equal(providers.progressUpdate('mangaupdates', { chapters: 1, volumes: 0 }, { status: 'complete' }).status, 'complete');
});

test('completion events queue all connected trackers and keep user progress isolated', async (t) => {
  const { tracking, q, hooks, writes } = setup(t);
  for (const p of Object.keys(providers.DEFINITIONS)) await tracking.login(1, p, 'name', 'password');
  finishBook(q);
  tracking.start();
  hooks.get('book.finished')({ userId: 1, bookId: 1 });
  assert.equal(q('SELECT COUNT(*) AS n FROM tracking_queue').get().n, 4);
  for (let i = 0; i < 4; i++) await tracking.tick();
  assert.equal(writes.length, 4);
  assert.ok(writes.every((w) => w[3].progress === 1));
  assert.equal(q('SELECT COUNT(*) AS n FROM tracking_queue').get().n, 0);
  assert.equal(tracking.enqueue(2, 1), 0);
});

test('pull is optional and updates rating/status without changing reviews or book progress', async (t) => {
  const { tracking, q } = setup(t);
  await tracking.login(1, 'anilist', 'name', 'password');
  q(`INSERT INTO series_reviews (user_id,series_id,rating,body,spoiler,created_at,updated_at) VALUES (1,1,3,'My review',1,1,1)`).run();
  finishBook(q);
  tracking.enqueue(1, 1);
  await tracking.tick();
  assert.equal(q('SELECT rating FROM series_reviews').get().rating, 3);
  tracking.setPull(1, 'anilist', true);
  tracking.enqueue(1, 1);
  await tracking.tick();
  const review = q('SELECT * FROM series_reviews').get();
  assert.equal(review.rating, 9);
  assert.equal(review.body, 'My review');
  assert.equal(review.spoiler, 1);
  assert.equal(q('SELECT status FROM user_series').get().status, 'reading');
  assert.equal(q('SELECT finished FROM progress').get().finished, 1);
  assert.equal(tracking.pull(1, 'anilist'), 1);
  await tracking.tick();
  tracking.disconnect(1, 'anilist');
  assert.equal(q('SELECT COUNT(*) AS n FROM tracking_queue').get().n, 0);
});

test('failed delivery persists across restart and honours retry-after', async (t) => {
  const { tracking, q, deps, api, writes } = setup(t, { readEntry: async () => { throw new providers.TrackerError(429, 120_000); } });
  await tracking.login(1, 'anilist', 'name', 'password');
  finishBook(q);
  tracking.enqueue(1, 1);
  const now = Date.now();
  await tracking.tick();
  const job = q('SELECT * FROM tracking_queue').get();
  assert.ok(job.next_at >= now + 120_000);
  assert.equal(job.attempts, 1);
  api.readEntry = async () => ({ chapters: 10, progress: 0 });
  q('UPDATE tracking_queue SET next_at=0').run();
  const restarted = createTracking(deps);
  await restarted.tick();
  assert.equal(writes.length, 1);
  assert.equal(q('SELECT COUNT(*) AS n FROM tracking_queue').get().n, 0);
});

test('new progress enqueued during a request is not lost', async (t) => {
  let release;
  const { tracking, q } = setup(t, { readEntry: () => new Promise((resolve) => { release = resolve; }) });
  await tracking.login(1, 'anilist', 'name', 'password');
  finishBook(q);
  tracking.enqueue(1, 1);
  const pending = tracking.tick();
  await Promise.resolve();
  tracking.enqueue(1, 1);
  release({ chapters: 10, progress: 0 });
  await pending;
  assert.equal(q('SELECT revision FROM tracking_queue').get().revision, 2);
});

test('disconnect during an import prevents credential resurrection and local writes', async (t) => {
  let release;
  const { tracking, q } = setup(t, { readEntry: () => new Promise((resolve) => { release = resolve; }) });
  await tracking.login(1, 'anilist', 'name', 'password');
  tracking.pull(1, 'anilist');
  const pending = tracking.tick();
  await Promise.resolve();
  tracking.disconnect(1, 'anilist');
  release({ status: 'COMPLETED', score: 10 });
  await pending;
  assert.equal(q('SELECT COUNT(*) AS n FROM tracking_accounts').get().n, 0);
  assert.equal(q('SELECT COUNT(*) AS n FROM user_series').get().n, 0);
  assert.equal(q('SELECT COUNT(*) AS n FROM series_reviews').get().n, 0);
});

test('expired tokens refresh once and persist rotated tokens before delivery', async (t) => {
  let refreshed = 0;
  const { tracking, q, api, writes } = setup(t, {
    refresh: async () => { refreshed++; return { accessToken: 'rotated', refreshToken: 'rotated-refresh', expiresAt: Date.now() + 3600_000 }; },
    readEntry: async (provider, account) => { assert.equal(account.access_token, 'rotated'); return { chapters: 10, progress: 0 }; },
  });
  await tracking.login(1, 'mal', 'name', 'password');
  q('UPDATE tracking_accounts SET expires_at=1').run();
  finishBook(q);
  tracking.enqueue(1, 1);
  await tracking.tick();
  assert.equal(refreshed, 1);
  assert.equal(writes.length, 1);
  assert.equal(q('SELECT refresh_token FROM tracking_accounts').get().refresh_token, 'rotated-refresh');
});

test('a reconnect during delivery cannot delete the new account queued job', async (t) => {
  let release;
  const { tracking, q } = setup(t, { readEntry: () => new Promise((resolve) => { release = resolve; }) });
  await tracking.login(1, 'anilist', 'name', 'password');
  finishBook(q);
  tracking.enqueue(1, 1);
  const pending = tracking.tick();
  await Promise.resolve();
  await tracking.login(1, 'anilist', 'new-name', 'password');
  tracking.enqueue(1, 1);
  release({ chapters: 10, progress: 0 });
  await pending;
  assert.equal(q('SELECT COUNT(*) AS n FROM tracking_queue').get().n, 1);
});

test('score imports work even when a MangaUpdates rating has no list status', async (t) => {
  const { tracking, q } = setup(t, { readEntry: async () => ({ status: null, score: 7 }) });
  await tracking.login(1, 'mangaupdates', 'name', 'password');
  tracking.pull(1, 'mangaupdates');
  await tracking.tick();
  assert.equal(q('SELECT rating FROM series_reviews').get().rating, 7);
  assert.equal(q('SELECT COUNT(*) AS n FROM user_series').get().n, 0);
});
