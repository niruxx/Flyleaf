const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fb2XPointer, fb2FromXPointer } = require('../server/fb2-position');

test('FB2 maps web positions through the pinned Foliate converter to native source positions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-fb2-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const book = { format: 'fb2', path: path.join(dir, 'book.fb2') };
  await fs.writeFile(book.path, '<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>Test</book-title><lang>en</lang></title-info></description><body><section><p>Hello 😀 world <emphasis>nested text</emphasis> tail.</p></section><section><p>Second section.</p><poem><stanza><v>A <emphasis>poetic</emphasis> line.</v><v>Another verse.</v></stanza></poem></section></body><body name="notes"><section><p>Footnote.</p></section></body></FictionBook>');
  const native = '/FictionBook/body[1]/section[1]/p[1]/text()[1].8';
  const cfi = await fb2FromXPointer(book, native);
  assert.ok(cfi, 'native FB2 text must map into Foliate section DOM');
  assert.equal(await fb2XPointer(book, cfi), native);
  const nested = '/FictionBook/body[1]/section[1]/p[1]/emphasis[1]/text()[1].3';
  const nestedCFI = await fb2FromXPointer(book, nested);
  assert.ok(nestedCFI);
  assert.equal(await fb2XPointer(book, nestedCFI), nested);
  for (const pointer of ['/FictionBook/body[1]/section[2]/p[1]/text()[1].4', '/FictionBook/body[2]/section[1]/p[1]/text()[1].2', '/FictionBook/body[1]/section[2]/poem[1]/stanza[1]/v[1]/emphasis[1]/text()[1].2', '/FictionBook/body[1]/section[2]/poem[1]/stanza[1]/v[2]/text()[1].3']) {
    const mapped = await fb2FromXPointer(book, pointer);
    assert.ok(mapped);
    assert.equal(await fb2XPointer(book, mapped), pointer);
  }
  assert.equal(await fb2FromXPointer(book, '/FictionBook/body[99]/section/p/text().0'), null);
  assert.equal(await fb2XPointer(book, 'epubcfi(/6/999!/4/2/1:0)'), null);
  const legacy = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="windows-1251"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>Test</book-title><lang>ru</lang></title-info></description><body><section><p>'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), Buffer.from('</p></section></body></FictionBook>')]);
  const legacyBook = { format: 'fb2', path: path.join(dir, 'legacy.fb2') };
  await fs.writeFile(legacyBook.path, legacy);
  const mapped = await fb2FromXPointer(legacyBook, '/FictionBook/body[1]/section[1]/p[1]/text()[1].3');
  assert.ok(mapped);
  assert.equal(await fb2XPointer(legacyBook, mapped), '/FictionBook/body[1]/section[1]/p[1]/text()[1].3');
});
