const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { bestMatch, creditRoles } = require('../server/metadata-match');
const { parseComicInfo, epubMetadata } = require('../server/metadata');

test('automatic matching rejects sequels, ambiguous titles and conflicting writers', () => {
  const result = { id: '1', title: 'Example Adventure', people: [{ name: 'Alice', role: 'Writer' }] };
  assert.equal(bestMatch('Example Adventure', [{ ...result, title: 'Example Adventure 2' }]), null);
  assert.equal(bestMatch('Example Adventure', [result, { ...result, id: '2' }]), null);
  assert.equal(bestMatch('Example Adventure', [result], [{ name: 'Bob', role: 'Writer' }]), null);
  assert.equal(bestMatch('Example Adventure', [result], [{ name: 'Alice', role: 'Writer' }]), result);
});

test('alternate titles and combined credits retain meaning', () => {
  const result = { id: '1', title: 'English title', altTitles: ['別名'] };
  assert.equal(bestMatch('別名', [result]), result);
  assert.deepEqual(creditRoles('Story & Art'), ['Writer', 'Artist']);
  assert.deepEqual(creditRoles('Art'), ['Artist']);
  assert.deepEqual(creditRoles('Translator'), ['Translator']);
});

test('ComicInfo keeps all writers and does not promote artists to authors', () => {
  assert.equal(parseComicInfo('<ComicInfo><Writer>Alice, Bob</Writer><Penciller>Carol</Penciller></ComicInfo>').author, 'Alice, Bob');
  assert.equal(parseComicInfo('<ComicInfo><Penciller>Carol</Penciller></ComicInfo>').author, null);
});

test('EPUB 3 refinements and contributors preserve writer, artist and translator credits', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-metadata-'));
  try {
    const zip = new JSZip();
    zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>');
    zip.file('content.opf', `<package><metadata>
      <dc:title>Example</dc:title><dc:creator id="a">Alice</dc:creator>
      <dc:creator id="b">Bob</dc:creator><dc:contributor id="c">Carol</dc:contributor>
      <meta refines="#a" property="role">aut</meta>
      <meta refines="#b" property="role">ill</meta>
      <meta refines="#c" property="role">trl</meta>
      </metadata></package>`);
    const file = path.join(dir, 'example.epub');
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const meta = await epubMetadata(file);
    assert.equal(meta.author, 'Alice');
    assert.deepEqual(meta.people, [{ name: 'Alice', role: 'Writer' }, { name: 'Bob', role: 'Artist' }, { name: 'Carol', role: 'Translator' }]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
