'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

async function setup(request = async () => {}) {
  const storage = new Map(), cached = new Map(), opened = [];
  const session = { user: { id: 1 } };
  const navigator = { onLine: true, serviceWorker: {}, connection: {}, storage: {} };
  const context = vm.createContext({ navigator, window: { caches: {}, isSecureContext: true },
    localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    caches: { open: async () => ({ put: async (url, res) => cached.set(url, res), delete: async (url) => cached.delete(url) }) },
    fetch: async () => new Response('book data'), addEventListener() {}, AbortSignal, Response, console, Date });
  const api = { series: async () => ({ books: [{ id: 1 }, { id: 2, progress: { finished: true } }, { id: 3 }] }),
    reader: async (id) => { opened.push(id); return { book: { id, title: 'Chapter '+id, seriesId: 1, engine: 'text', format: 'epub' } }; } };
  const module = new vm.SourceTextModule(fs.readFileSync('public/js/offline.js', 'utf8'), { context });
  await module.link((name) => {
    const values = name.includes('i18n') ? { t: (s) => s }
      : name.includes('router') ? { session }
      : { api, fileUrl: (b) => `/api/books/${b.id}/file`, pageUrl() {}, localDay: () => '2026-11-23', request };
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
  });
  await module.evaluate();
  return { offline: module.namespace, cached, opened, navigator, session };
}

test('automatic offline saving skips read and already cached chapters and respects opt-out/data saver', async () => {
  const { offline, cached, opened, navigator } = await setup();
  // The support test checks window membership, just as a secure browser does.
  await offline.autoSaveNext({ id: 1, seriesId: 1 });
  assert.deepEqual(opened, [3]);
  assert.ok(cached.has('/api/books/3/file'));
  await offline.autoSaveNext({ id: 1, seriesId: 1 });
  assert.deepEqual(opened, [3]);
  offline.setAutoSaveNext(false);
  await offline.autoSaveNext({ id: 4, next: { id: 5 } });
  offline.setAutoSaveNext(true); navigator.connection.saveData = true;
  await offline.autoSaveNext({ id: 4, next: { id: 5 } });
  navigator.connection.saveData = false; navigator.onLine = false;
  await offline.autoSaveNext({ id: 4, next: { id: 5 } });
  assert.deepEqual(opened, [3]);
});

test('offline progress follows the account and keeps the most recently recorded position', async () => {
  const sent = [];
  const { offline, session } = await setup(async (method, url, body) => sent.push({ method, url, body }));
  offline.queueProgress(1, 3, { position: 'current', recordedAt: 200, seconds: 25 });
  offline.queueProgress(1, 3, { position: 'older', recordedAt: 100, seconds: 10 });
  assert.equal(offline.pendingPosition(1, { id: 3, progress: { updatedAt: 150 } }).position, 'current');
  assert.equal(offline.pendingPosition(1, { id: 3, progress: { updatedAt: 250 } }), null);
  session.user = { id: 2 };
  assert.equal(offline.pendingPosition(2, { id: 3 }), null);
  await offline.flushProgress();
  assert.equal(sent.length, 0);
  session.user = { id: 1 };
  await offline.flushProgress();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.syncUserId, 1);
  assert.equal(sent[0].body.position, 'current');
  assert.equal(sent[0].body.seconds, 35);
  assert.equal(offline.pendingPosition(1, { id: 3 }), null);
});
