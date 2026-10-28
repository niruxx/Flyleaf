'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('automatic offline saving skips read and already cached chapters and respects opt-out/data saver', async () => {
  const storage = new Map(), cached = new Map(), opened = [];
  const navigator = { onLine: true, serviceWorker: {}, connection: {}, storage: {} };
  const context = vm.createContext({ navigator, window: { caches: {}, isSecureContext: true },
    localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    caches: { open: async () => ({ put: async (url, res) => cached.set(url, res), delete: async (url) => cached.delete(url) }) },
    fetch: async () => new Response('book data'), addEventListener() {}, Response, console, Date });
  const api = { series: async () => ({ books: [{ id: 1 }, { id: 2, progress: { finished: true } }, { id: 3 }] }),
    reader: async (id) => { opened.push(id); return { book: { id, title: 'Chapter '+id, seriesId: 1, engine: 'text', format: 'epub' } }; } };
  const module = new vm.SourceTextModule(fs.readFileSync('public/js/offline.js', 'utf8'), { context });
  await module.link((name) => {
    const values = name.includes('i18n') ? { t: (s) => s } : { api, fileUrl: (b) => `/api/books/${b.id}/file`, pageUrl() {}, localDay() {}, request() {} };
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
  });
  await module.evaluate();
  const offline = module.namespace;
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
