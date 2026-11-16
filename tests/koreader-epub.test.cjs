const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const config = require('../server/config');
const { toEpub, existingRendition } = require('../server/koreader-epub');
const { epubXPointer, epubFromXPointer } = require('../server/kosync-position');
const fixture = require('./mobi-fixture.cjs');

test('EPUB export preserves Foliate CFI paths and invalidates replaced source revisions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-export-'));
  const previousCache = config.cacheDir;
  config.cacheDir = path.join(dir, 'cache');
  t.after(async () => { config.cacheDir = previousCache; await fs.rm(dir, { recursive: true, force: true }); });
  const book = { path: path.join(dir, 'book.mobi'), format: 'mobi' };
  const original = fixture('<html><head><title>Export</title></head><body><p>Hello 😀 world.</p><mbp:pagebreak/><p>Second <i>chapter</i>.</p></body></html>');
  await fs.writeFile(book.path, original);
  const file = await toEpub(book);
  assert.equal(await existingRendition(book), file);
  assert.equal(await toEpub(book), file);
  assert.deepEqual(await fs.readFile(book.path), original);
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  assert.equal(await zip.file('mimetype').async('string'), 'application/epub+zip');
  const { DOMParser } = require('@xmldom/xmldom');
  for (const entry of Object.values(zip.files).filter(e => /\.(opf|xhtml|xml)$/.test(e.name))) {
    const errors = [];
    const parsed = new DOMParser({ errorHandler: { warning: m => errors.push(m), error: m => errors.push(m), fatalError: m => errors.push(m) } }).parseFromString(await entry.async('string'), 'application/xml');
    assert.deepEqual(errors, [], entry.name);
    if (entry.name.endsWith('.xhtml')) assert.equal(parsed.documentElement.localName, 'html');
  }
  const epub = { format: 'epub', path: file };
  const cfi = 'epubcfi(/6/4!/4/2/2/1:3)';
  const pointer = await epubXPointer(epub, cfi);
  assert.ok(pointer);
  assert.equal(await epubFromXPointer(epub, pointer), cfi);
  await fs.writeFile(book.path, fixture('<html><head><title>Replacement</title></head><body><p>Different.</p></body></html>'));
  assert.equal(await existingRendition(book), null);
  const kf8 = { format: 'azw3', path: path.join(dir, 'kindle.azw3') };
  await fs.writeFile(kf8.path, require('./kf8-fixture.cjs')('Hello KF8 😀 text.<img src="kindle:embed:0002?mime=image/png"/>', {
    head: '<link rel="stylesheet" href="kindle:embed:0001?mime=text/css"/>',
    resources: [Buffer.from('p { background: url("kindle:embed:0002?mime=image/png"); }'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=', 'base64')],
  }));
  const kf8File = await toEpub(kf8);
  const kf8Epub = { format: 'epub', path: kf8File };
  const native = await epubXPointer(kf8Epub, 'epubcfi(/6/2!/4/2/1:8)');
  assert.ok(native);
  assert.equal(await epubFromXPointer(kf8Epub, native), 'epubcfi(/6/2!/4/2/1:8)');
  const kf8Zip = await JSZip.loadAsync(await fs.readFile(kf8File));
  const packageXml = await kf8Zip.file('OPS/package.opf').async('string');
  assert.match(packageXml, /media-type="text\/css"/);
  assert.match(packageXml, /media-type="image\/png"/);
  for (const entry of Object.values(kf8Zip.files).filter(e => !e.dir && e.name.startsWith('OPS/'))) {
    const data = await entry.async('string');
    assert.doesNotMatch(data, /blob:nodedata:|kindle:embed:/, 'all nested resources must be packaged');
  }
});
