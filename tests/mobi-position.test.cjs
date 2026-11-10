const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const fixture = require('./mobi-fixture.cjs');
const { mobiXPointer, mobiFromXPointer } = require('../server/fb2-position');

test('legacy MOBI maps UTF-8 and PalmDOC text through actual Foliate section documents', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-mobi-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = '<html><head><title>Test</title></head><body><p>Hello 😀 world.</p><p>Nested <i>emphasis</i> text.</p></body></html>';
  for (const compression of [1, 2]) {
    const book = { format: 'mobi', path: path.join(dir, `book-${compression}.mobi`) };
    await fs.writeFile(book.path, fixture(source, { compression }));
    for (const pointer of ['/body/p[1]/text()[1].8', '/body/p[2]/i[1]/text()[1].3']) {
      const cfi = await mobiFromXPointer(book, pointer);
      assert.ok(cfi, `native pointer should map for compression ${compression}`);
      assert.equal(await mobiXPointer(book, cfi), pointer);
    }
    assert.equal(await mobiFromXPointer(book, '/body/p[999]/text()[1].0'), null);
  }
  const split = { format: 'mobi', path: path.join(dir, 'split.mobi') };
  await fs.writeFile(split.path, fixture('<html><head><title>Split</title></head><body><p>First.</p><mbp:pagebreak/><p>Second.</p></body></html>'));
  const second = await mobiFromXPointer(split, '/body/p[2]/text()[1].3');
  assert.ok(second);
  assert.ok(second.startsWith('epubcfi(/6/4!'), 'second source paragraph is in Foliate section two');
  assert.equal(await mobiXPointer(split, second), '/body/p[2]/text()[1].3');
});

test('ambiguous MOBI anchor layouts and unsupported pure KF8 use native fallback', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-mobi-guard-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [id, version, markup] of [
    ['anchors', 6, '<p><a filepos="100">Link</a> text</p>'],
    ['tables', 6, '<table><tr><td>Cell</td></tr></table>'],
    ['kf8', 8, '<p>KF8</p>'],
  ]) {
    const book = { format: id === 'kf8' ? 'azw3' : 'mobi', path: path.join(dir, id + '.mobi') };
    await fs.writeFile(book.path, fixture('<html><head><title>Test</title></head><body>' + markup + '</body></html>', { version }));
    assert.equal(await mobiXPointer(book, 'epubcfi(/6/2!/4/2/1:1)'), null);
  }
});
