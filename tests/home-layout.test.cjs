const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
async function helpers() {
  const mod = new vm.SourceTextModule(fs.readFileSync('public/js/home-layout.js', 'utf8'));
  await mod.link(() => { throw new Error('Unexpected import'); });
  await mod.evaluate();
  return mod.namespace;
}
test('home layout repairs malformed preferences, deduplicates sections and includes future defaults', async () => {
  const { homeLayout, HOME_SECTIONS } = await helpers();
  for (const value of [null, false, 'bad', { order: {}, hidden: 'bad', sort: '__proto__' }]) {
    const layout = homeLayout(value);
    assert.equal(layout.order.length, HOME_SECTIONS.length);
    assert.equal(layout.sort, 'default');
  }
  const layout = homeLayout({ order: ['libraries', 'libraries', 'unknown'], hidden: ['genres', 'unknown'], compact: true, hero: false });
  assert.equal(layout.order[0], 'libraries');
  assert.equal(new Set(layout.order).size, HOME_SECTIONS.length);
  assert.equal(layout.hidden.join(','), 'genres');
  assert.equal(layout.compact, true);
  assert.equal(layout.hero, false);
});
test('home sorting is natural, stable, nonmutating, and supports both book and series progress', async () => {
  const { sortHomeItems } = await helpers();
  const items = [{ title: 'Book 10', author: 'Zed', progress: { percent: .2 } }, { name: 'book 2', authors: ['Alice'], progress: .8 }, { title: 'Alpha' }];
  const names = list => Array.from(list, x => x.title || x.name).join(',');
  assert.equal(names(sortHomeItems(items, 'az', 'en')), 'Alpha,book 2,Book 10');
  assert.equal(names(sortHomeItems(items, 'za', 'en')), 'Book 10,book 2,Alpha');
  assert.equal(names(sortHomeItems(items, 'author', 'en')), 'Alpha,book 2,Book 10');
  assert.equal(names(sortHomeItems(items, 'progress', 'en')), 'book 2,Book 10,Alpha');
  assert.equal(names(sortHomeItems(items, 'default', 'en')), 'Book 10,book 2,Alpha');
  assert.equal(items[0].title, 'Book 10');
  assert.equal(sortHomeItems([{ item: { title: 'Zebra' } }, { item: { title: 'Apple' } }], 'az', 'en')[0].item.title, 'Apple');
});
