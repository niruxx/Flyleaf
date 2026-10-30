const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('downloads group by book and preserve source, owner and library boundaries', async () => {
  const mod = new vm.SourceTextModule(fs.readFileSync('public/js/download-groups.js', 'utf8'));
  await mod.link(() => { throw new Error('Unexpected import'); });
  await mod.evaluate();
  const group = mod.namespace.groupDownloads;
  const base = { userId: 1, libraryId: 1, plugin: 'source', bookTitle: 'Book 2', sourceId: 'book2' };
  const rows = [
    { ...base, id: 1, fileTitle: 'Chapter 10' },
    { ...base, id: 2, fileTitle: 'Chapter 2', cover: 'https://example.com/cover.jpg' },
    { ...base, id: 3, userId: 2 },
    { ...base, id: 4, libraryId: 2 },
    { ...base, id: 5, plugin: 'other' },
    { ...base, id: 6, sourceId: 'book10', bookTitle: 'Book 10' },
  ];
  const groups = group(rows);
  assert.equal(groups.length, 5);
  const book = groups.find(g => g.rows.length === 2);
  assert.deepEqual(Array.from(book.rows, r => r.id), [2, 1]);
  assert.equal(book.cover, 'https://example.com/cover.jpg');
  assert.equal(groups.at(-1).title, 'Book 10');
  assert.equal(group(rows, 'desc')[0].title, 'Book 10');
  assert.equal(rows[0].id, 1, 'sorting leaves the API response order unchanged');
  assert.equal(group([{ id: 1, title: 'Legacy book' }])[0].title, 'Legacy book');
  assert.equal(group([]).length, 0);
});
