const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const fixture = require('./mobi-fixture.cjs');
const { mobiXPointer, mobiFromXPointer, textPositionFromXPointer } = require('../server/fb2-position');

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

test('malformed MOBI anchors, malformed tables and unsupported pure KF8 use native fallback', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-mobi-guard-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [id, version, markup] of [
    ['anchors', 6, '<p><a filepos="100">Link</a> text</p>'],
    ['tables', 6, '<table>Invalid text<tr><td>Cell</td></tr></table>'],
    ['kf8', 8, '<p>KF8</p>'],
  ]) {
    const book = { format: id === 'kf8' ? 'azw3' : 'mobi', path: path.join(dir, id + '.mobi') };
    await fs.writeFile(book.path, fixture('<html><head><title>Test</title></head><body>' + markup + '</body></html>', { version }));
    assert.equal(await mobiXPointer(book, 'epubcfi(/6/2!/4/2/1:1)'), null);
  }
});

test('explicit table structures and preformatted Unicode map both ways without prior anchors', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-mobi-layout-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const book = { format: 'mobi', path: path.join(dir, 'layout.mobi') };
  await fs.writeFile(book.path, fixture('<html><head><title>Layout</title></head><body><table><tbody><tr><td>Cell 😀 text</td><td><b>Nested</b> text</td></tr></tbody></table><pre>\n  A\t😀\r\n B <i>  C</i></pre></body></html>'));
  for (const pointer of ['/body/table[1]/tbody[1]/tr[1]/td[1]/text()[1].7', '/body/table[1]/tbody[1]/tr[1]/td[2]/b[1]/text()[1].3',
    '/body/pre[1]/text()[1].5', '/body/pre[1]/i[1]/text()[1].2']) {
    const cfi = await mobiFromXPointer(book, pointer);
    assert.ok(cfi, pointer);
    assert.equal(await mobiXPointer(book, cfi), pointer);
  }
  assert.equal(await mobiFromXPointer(book, '/body/pre[1]/text()[1].5'), 'epubcfi(/6/2!/4/4/1:7)', 'pre keeps spaces and tabs and strips the leading newline');
  assert.equal(await mobiFromXPointer(book, '/body/pre[1]/text()[1].6'), 'epubcfi(/6/2!/4/4/1:9)', 'CRLF is one native character and cannot be bisected');
  assert.equal(await mobiXPointer(book, 'epubcfi(/6/2!/4/4/1:8)'), null);
  assert.equal(await mobiXPointer(book, 'epubcfi(/6/2!/4/4/1:6)'), null, 'a surrogate pair cannot be bisected');
});

test('mid-text anchors map legacy and modern DOMs without guessing an ambiguous profile', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-mobi-split-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let source = '<html><head><title>Split</title></head><body><p><a filepos="00000">Next</a></p><p>Before 😀 target follows.</p></body></html>';
  const offset = Buffer.byteLength(source.slice(0, source.indexOf('target')));
  source = source.replace('00000', String(offset).padStart(5, '0'));
  const book = { format: 'mobi', path: path.join(dir, 'split.mobi') };
  await fs.writeFile(book.path, fixture(source, { compression: 2 }));
  const modern = '/body/p[2]/text()[2].4';
  const legacy = '/body/p[2]/text()[1].13';
  const modernResult = await textPositionFromXPointer(book, modern);
  const legacyResult = await textPositionFromXPointer(book, legacy);
  assert.equal(modernResult?.profile, 'modern');
  assert.equal(legacyResult?.profile, 'legacy');
  assert.equal(modernResult.position, legacyResult.position);
  assert.equal(await mobiXPointer(book, modernResult.position), null, 'unknown DOM cannot receive a guessed native pointer');
  assert.equal(await mobiXPointer({ ...book, mobiDomProfile: 'modern' }, modernResult.position), modern);
  assert.equal(await mobiXPointer({ ...book, mobiDomProfile: 'legacy' }, legacyResult.position), legacy);
  assert.equal(await mobiFromXPointer(book, '/body/p[2]/text()[1].3'), 'epubcfi(/6/2!/4/4/1:3)', 'both profiles agree before the split');
});

test('implicit table row groups use CREngine native paths while keeping original Foliate CFIs', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-mobi-table-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const book = { format: 'mobi', path: path.join(dir, 'table.mobi') };
  await fs.writeFile(book.path, fixture('<html><head><title>Table</title></head><body><table><tr><td>Outer<table><tr><td>Nested</td></tr></table></td></tr><tr><td colspan="2">Next</td></tr></table></body></html>'));
  const native = '/body/table[1]/tbody[1]/tr[1]/td[1]/table[1]/tbody[1]/tr[1]/td[1]/text()[1].3';
  const cfi = await mobiFromXPointer(book, native);
  assert.equal(cfi, 'epubcfi(/6/2!/4/2/2/2/2/2/2/1:3)');
  assert.equal(await mobiXPointer(book, cfi), native);
  assert.equal(await mobiFromXPointer(book, '/body/table/tr/td/text().3'), null);
});

test('MOBI tag-boundary filepos targets preserve precise mapping', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-mobi-anchors-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let source = '<html><head><title>Anchors</title></head><body><p><a filepos="00000">Next</a></p><p>Target 😀 paragraph.</p></body></html>';
  const offset = Buffer.byteLength(source.slice(0, source.indexOf('<p>Target')));
  source = source.replace('00000', String(offset).padStart(5, '0'));
  const book = { format: 'mobi', path: path.join(dir, 'anchors.mobi') };
  await fs.writeFile(book.path, fixture(source));
  const pointer = '/body/p[2]/text()[1].8';
  const cfi = await mobiFromXPointer(book, pointer);
  assert.ok(cfi);
  assert.equal(await mobiXPointer(book, cfi), pointer);
});

test('native MOBI anchor guards account for byte offsets, NCX targets and DOM-version differences', () => {
  const { stableAnchorTargets } = require('../server/mobi-native-anchors');
  const bytes = Buffer.from('<body><p>😀 text.</p>\n<p id="a">Target</p></body>');
  const offset = bytes.indexOf(Buffer.from('<p id'));
  assert.equal(stableAnchorTargets(bytes, [offset, offset + 3]), true);
  assert.equal(stableAnchorTargets(bytes, [bytes.indexOf(Buffer.from('text')) + 2]), false);
  assert.equal(stableAnchorTargets(bytes, [bytes.length + 1]), false);
});

test('real NCX index targets split native text independently of Foliate sections', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-mobi-ncx-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = '<html><head><title>NCX</title></head><body><p>First.</p><mbp:pagebreak/><p>Before 😀 target follows.</p></body></html>';
  const ncxOffset = Buffer.byteLength(source.slice(0, source.indexOf('target')));
  const book = { format: 'mobi', path: path.join(dir, 'ncx.mobi') };
  await fs.writeFile(book.path, fixture(source, { compression: 2, ncxOffset }));
  const modern = await textPositionFromXPointer(book, '/body/p[2]/text()[2].4');
  assert.equal(modern?.profile, 'modern');
  assert.equal(modern.position, 'epubcfi(/6/4!/4/2/1:14)');
  assert.equal(await mobiXPointer({ ...book, mobiDomProfile: 'modern' }, modern.position), '/body/p[2]/text()[2].4');
  assert.equal(await mobiFromXPointer(book, '/body/p[2]/text()[1].13'), modern.position);
});

test('comments and multiple mid-text targets retain ordered offsets across split runs', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-mobi-comments-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let source = '<html><head><title>Comments</title></head><body><p><a filepos="00000">One</a><a filepos="11111">Two</a></p><p>Alpha<!-- ignored --> beta 😀 gamma delta.</p></body></html>';
  const first = Buffer.byteLength(source.slice(0, source.indexOf('beta')));
  const second = Buffer.byteLength(source.slice(0, source.indexOf('gamma')));
  source = source.replace('00000', String(first).padStart(5, '0')).replace('11111', String(second).padStart(5, '0'));
  const book = { format: 'mobi', path: path.join(dir, 'comments.mobi') };
  await fs.writeFile(book.path, fixture(source));
  const native = '/body/p[2]/text()[3].3';
  const result = await textPositionFromXPointer(book, native);
  assert.equal(result?.profile, 'modern');
  assert.equal(result.position, 'epubcfi(/6/2!/4/4/5:3)');
  assert.equal(await mobiXPointer({ ...book, mobiDomProfile: result.profile }, result.position), native);
  const legacy = '/body/p[2]/text()[1].16';
  assert.equal(await mobiFromXPointer({ ...book, mobiDomProfile: 'legacy' }, legacy), result.position);
});
