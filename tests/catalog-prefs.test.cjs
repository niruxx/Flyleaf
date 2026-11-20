'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

function load(file, dependencies) {
  const filename = path.resolve(file);
  const resolve = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: key => dependencies[key] ?? resolve(key),
  }, { filename });
  return module.exports;
}

test('catalog preferences default for existing accounts and merge validated changes per user', async () => {
  const stored = new Map();
  const q = sql => sql.startsWith('SELECT id, owner_id')
    ? { all: () => [] }
    : { run: (json, id) => stored.set(id, json) };
  const auth = load('server/auth.js', { './db': { q }, './config': {} });
  const router = load('server/routes/auth.js', { '../db': { q }, '../auth': auth, '../config': {}, '../settings': {} }).me;
  const defaults = { startPage: 'home', cardSize: 'standard', sort: 'default', showCovers: true };
  const user = id => auth.toUser({ id, username: 'reader', role: 'guest', prefs: stored.get(id) });
  const put = (id, body) => new Promise((resolve, reject) =>
    router.handle({ user: user(id), method: 'PUT', url: '/prefs', body, headers: {} },
      { json: data => resolve(data) }, error => reject(error || new Error('Route not found'))));
  assert.deepEqual({ ...user(1).prefs.catalog }, defaults);
  await put(1, { catalog: { startPage: 'library', cardSize: 'compact' } });
  const result = await put(1, { catalog: { sort: 'read', showCovers: false, cardSize: 140, elsewhere: true } });
  assert.deepEqual({ ...result.catalog }, { startPage: 'library', cardSize: 'compact', sort: 'read', showCovers: false });
  assert.deepEqual({ ...user(2).prefs.catalog }, defaults);
});

test('catalog startup resolves supported pages with a safe default', async () => {
  const module = new vm.SourceTextModule(readFileSync('public/js/catalog-prefs.js', 'utf8'));
  await module.link(() => assert.fail('Unexpected import'));
  await module.evaluate();
  const { startPage, catalogPrefs } = module.namespace;
  const user = startPage => ({ prefs: { catalog: { startPage } } });
  assert.equal(startPage(user('library')), '/library');
  assert.equal(startPage(user('want')), '/want-to-read');
  assert.equal(startPage(user('//another-site.example')), '/');
  assert.equal(catalogPrefs(undefined).showCovers, true);
});
