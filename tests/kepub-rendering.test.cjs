const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');
const config = require('../server/config');
const { rendition } = require('../server/kepub');
const { epubTarget, epubXPointer, epubFromXPointer } = require('../server/kosync-position');
const XHTML = 'http://www.w3.org/1999/xhtml';

function xml(source) {
  const errors = [];
  const doc = new DOMParser({ errorHandler: { warning: msg => errors.push(msg), error: msg => errors.push(msg), fatalError: msg => errors.push(msg) } }).parseFromString(source, 'application/xml');
  assert.deepEqual(errors, [], 'converted content must remain well-formed XML');
  return doc;
}

test('Kobo rendering corpus preserves preformatted markup, multilingual content and embedded media', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-rendering-'));
  const previous = config.cacheDir;
  config.cacheDir = path.join(dir, 'cache');
  t.after(async () => { config.cacheDir = previous; await fs.rm(dir, { recursive: true, force: true }); });
  const content = `<html xmlns="${XHTML}" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Corpus</title><link rel="stylesheet" href="../style.css"/></head><body dir="rtl" lang="ar" class="chapter">
<pre id="code">  first\n<code>\n  &lt;tag&gt; &amp; value</code>\n  last  </pre>
<p dir="rtl">مرحبا بالعالم. <bdi dir="ltr">English 123</bdi> שלום!</p>
<p lang="ja"><ruby>漢<rt>かん</rt></ruby>字。次の文！ 😀 &amp; &#160;</p>
<table><tbody><tr><th scope="row">Header</th><td rowspan="2">Cell</td></tr><tr><td>Next</td></tr></tbody></table>
<p><a epub:type="noteref" href="#note">1</a></p><aside epub:type="footnote" id="note"><p>A footnote.</p></aside>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><text x="0" y="20">SVG text</text><rect width="10" height="10" fill="url(#g)"/></svg>
<math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mi>x</mi><mn>2</mn></mfrac></math>
<p><img src="../images/cover.png" alt="Cover"/></p></body></html>`;
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>');
  zip.file('OPS/package.opf', '<package><metadata><meta name="cover" content="cover"/></metadata><manifest><item id="c" href="Text/c.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="images/cover.png" media-type="image/png"/></manifest><spine page-progression-direction="rtl"><itemref idref="c"/></spine></package>');
  zip.file('OPS/Text/c.xhtml', content);
  const css = 'pre { white-space: pre-wrap; } ruby { ruby-position: over; } body { direction: rtl; } .chapter > table { margin: 1em; }';
  zip.file('OPS/style.css', css);
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  zip.file('OPS/images/cover.png', image);
  const book = { format: 'epub', path: path.join(dir, 'corpus.epub') };
  const original = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(book.path, original);
  const generated = await rendition(book);
  const output = await JSZip.loadAsync(await fs.readFile(generated.file));
  const before = xml(content), after = xml(await output.file('OPS/Text/c.xhtml').async('string'));
  assert.equal(after.getElementsByTagNameNS(XHTML, 'body')[0].textContent, before.getElementsByTagNameNS(XHTML, 'body')[0].textContent);
  assert.equal(after.getElementsByTagNameNS(XHTML, 'pre')[0].textContent, before.getElementsByTagNameNS(XHTML, 'pre')[0].textContent);
  assert.equal(after.getElementsByTagNameNS(XHTML, 'code').length, 1, 'nested pre markup remains markup');
  assert.equal(after.getElementsByTagNameNS(XHTML, 'body')[0].getAttribute('dir'), 'rtl');
  assert.equal(after.getElementsByTagNameNS(XHTML, 'a')[0].getAttribute('href'), '#note');
  assert.equal(after.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'linearGradient').length, 1);
  assert.equal(after.getElementsByTagNameNS('http://www.w3.org/1998/Math/MathML', 'mfrac').length, 1);
  assert.equal(after.getElementsByTagNameNS(XHTML, 'td')[0].getAttribute('rowspan'), '2');
  assert.equal(await output.file('OPS/style.css').async('string'), css);
  const styleHref = after.getElementsByTagNameNS(XHTML, 'link')[0].getAttribute('href');
  assert.notEqual(styleHref, '../style.css');
  const derivedStyle = path.posix.normalize(path.posix.join('OPS/Text', styleHref));
  assert.match(await output.file(derivedStyle).async('string'), /\.chapter>\*>\*>table/);
  const packageDoc = xml(await output.file('OPS/package.opf').async('string'));
  const items = Array.from(packageDoc.getElementsByTagName('item'));
  assert.ok(items.some(item => item.getAttribute('media-type') === 'text/css' && path.posix.join('OPS', item.getAttribute('href')) === derivedStyle), 'generated stylesheet is declared in the EPUB manifest');
  assert.equal(items.find(item => item.getAttribute('id') === 'cover').getAttribute('properties'), 'cover-image');
  assert.deepEqual(await output.file('OPS/images/cover.png').async('nodebuffer'), image);
  assert.deepEqual(await fs.readFile(book.path), original);
  for (const span of generated.spans) {
    assert.ok(await epubTarget(book, span.cfi), `original CFI resolves: ${span.cfi}`);
    const pointer = await epubXPointer(book, span.cfi);
    if (pointer) {
      const returned = await epubFromXPointer(book, pointer);
      assert.ok(returned, `native pointer resolves: ${pointer}`);
      assert.equal(await epubXPointer(book, returned), pointer);
    }
  }
});

test('fixed-layout and image-only chapters remain byte-identical; prefixed XHTML keeps namespaces', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-layout-'));
  const previous = config.cacheDir;
  config.cacheDir = path.join(dir, 'cache');
  t.after(async () => { config.cacheDir = previous; await fs.rm(dir, { recursive: true, force: true }); });
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<c:container xmlns:c="urn:oasis:names:tc:opendocument:xmlns:container"><c:rootfiles><c:rootfile full-path="package.opf"/></c:rootfiles></c:container>');
  zip.file('package.opf', '<o:package xmlns:o="http://www.idpf.org/2007/opf"><o:metadata><o:meta property="rendition:layout">pre-paginated</o:meta></o:metadata><o:manifest><o:item id="a" href="fixed.xhtml" media-type="application/xhtml+xml"/><o:item id="b" href="prefixed.xhtml" media-type="application/xhtml+xml"/><o:item id="c" href="image.xhtml" media-type="application/xhtml+xml"/></o:manifest><o:spine><o:itemref idref="a"/><o:itemref idref="b" properties="rendition:layout-reflowable"/><o:itemref idref="c" properties="rendition:layout-reflowable"/></o:spine></o:package>');
  const fixed = `<html xmlns="${XHTML}"><head><meta name="viewport" content="width=600,height=800"/></head><body><p style="position:absolute;left:30px;top:20px">Fixed text.</p></body></html>`;
  const image = `<html xmlns="${XHTML}"><head><title>Image</title></head><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800"><image href="cover.png" width="600" height="800"/></svg></body></html>`;
  zip.file('fixed.xhtml', fixed);
  zip.file('prefixed.xhtml', `<h:html xmlns:h="${XHTML}"><h:head><h:title>Prefix</h:title></h:head><h:body><h:p>Namespaced text.</h:p></h:body></h:html>`);
  zip.file('image.xhtml', image);
  const book = { format: 'epub', path: path.join(dir, 'layout.epub') };
  await fs.writeFile(book.path, await zip.generateAsync({ type: 'nodebuffer' }));
  const generated = await rendition(book);
  const output = await JSZip.loadAsync(await fs.readFile(generated.file));
  assert.equal(await output.file('fixed.xhtml').async('string'), fixed);
  assert.equal(await output.file('image.xhtml').async('string'), image);
  assert.deepEqual(generated.preserved.map(p => p.reason), ['fixed-layout', 'non-text']);
  const converted = xml(await output.file('prefixed.xhtml').async('string'));
  assert.equal(converted.getElementsByTagNameNS(XHTML, 'span').length, 1);
  assert.equal(generated.spans.length, 1);
  assert.ok(await epubTarget(book, generated.spans[0].cfi));
});

test('UTF-16 and declared legacy encodings retain text and produce UTF-8 renditions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-encoding-'));
  const previous = config.cacheDir;
  config.cacheDir = path.join(dir, 'cache');
  t.after(async () => { config.cacheDir = previous; await fs.rm(dir, { recursive: true, force: true }); });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`<?xml version="1.0" encoding="utf-16"?><html xmlns="${XHTML}"><head><title>UTF16</title></head><body><p>日本語 😀 text.</p></body></html>`, 'utf16le')]);
  const legacy = Buffer.concat([
    Buffer.from(`<?xml version="1.0" encoding="windows-1251"?><html xmlns="${XHTML}"><head><title>Legacy</title></head><body><p>`),
    Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), Buffer.from('.</p></body></html>'),
  ]);
  for (const [label, content, expected] of [['utf16', utf16, '日本語 😀 text.'], ['legacy', legacy, 'Привет.']]) {
    const zip = new JSZip();
    zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>');
    zip.file('package.opf', '<package><metadata/><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>');
    zip.file('c.xhtml', content);
    const book = { format: 'epub', path: path.join(dir, label + '.epub') };
    await fs.writeFile(book.path, await zip.generateAsync({ type: 'nodebuffer' }));
    const generated = await rendition(book);
    const output = await JSZip.loadAsync(await fs.readFile(generated.file));
    const rendered = await output.file('c.xhtml').async('string');
    assert.match(rendered, /encoding="utf-8"/);
    assert.equal(xml(rendered).getElementsByTagNameNS(XHTML, 'body')[0].textContent, expected);
    const resolved = await epubTarget(book, generated.spans[0].cfi);
    assert.equal(resolved.target.node.text, expected);
    assert.deepEqual(await output.file('package.opf').async('nodebuffer'), await zip.file('package.opf').async('nodebuffer'));
  }
});
