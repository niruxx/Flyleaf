const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const node = () => ({ children: [], append(...items) { this.children.push(...items); }, prepend(...items) { this.children.unshift(...items); }, replaceChildren(...items) { this.children = items; } });

test('ALL combines sources, preserves source identities, and paginates independently after errors', async () => {
  const text = fs.readFileSync('public/js/views/finder.js', 'utf8');
  const body = text.slice(text.indexOf('      async function loadAllPages()'), text.indexOf('      await loadAllPages();'));
  const states = ['a', 'b'].map(id => ({ src: { id, name: id }, page: 0, hasMore: true }));
  const grid = node(), notices = node(), more = node();
  let fail = true;
  const requests = [];
  const load = vm.runInNewContext(body + '; loadAllPages', {
    health: { allows: () => true, clear() {}, hideFailed: false }, refreshHealth() {}, renderChips() {}, markFailure() {},
    grid, notices, more, states, seen: new Set(), my: 1, token: 1, stale: () => false,
    sourceQuery: 'Space', loading: () => 'loading', t: s => s,
    h: (...args) => args, button: (...args) => args, tile: (src, item) => `${src.id}:${item.id}`,
    filterPage: async (_, r) => r,
    api: { finderSearch: async (id, q, page) => {
      requests.push(`${id}:${q}:${page}`);
      if (id === 'b' && fail) throw new Error('Offline');
      return { items: [{ id: 'same' }, { id: `page${page}` }], hasMore: page < 2 };
    } },
  });
  await load();
  assert.deepEqual(grid.children, ['a:same', 'a:page1']);
  assert.equal(notices.children.length, 1);
  assert.equal(states[0].page, 1);
  assert.equal(states[1].page, 0);
  fail = false;
  await load();
  assert.equal(grid.children.length, 5);
  assert.ok(grid.children.includes('b:same'));
  assert.ok(requests.includes('a:Space:2'));
  assert.ok(requests.includes('b:Space:1'));
  await load();
  assert.equal(grid.children.length, 6);
  assert.equal(more.children.length, 0);
});
