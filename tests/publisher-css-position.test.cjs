const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { epubXPointer, epubFromXPointer } = require('../server/kosync-position');
const config = require('../server/config');

async function fixture(t, styles, body, extras = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-publisher-css-'));
  const cache = config.cacheDir;
  config.cacheDir = path.join(dir, 'cache');
  t.after(async () => { config.cacheDir = cache; await fs.rm(dir, { recursive: true, force: true }); });
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>');
  zip.file('OPS/package.opf', '<package><metadata/><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="css" href="styles/main.css" media-type="text/css"/></manifest><spine><itemref idref="c"/></spine></package>');
  zip.file('OPS/chapter.xhtml', `<html><head><title>CSS</title><link rel="stylesheet" href="styles/main.css"/></head><body>${body}</body></html>`);
  zip.file('OPS/styles/main.css', styles);
  for (const [name, text] of Object.entries(extras)) zip.file(name, text);
  const file = path.join(dir, 'book.epub');
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  return { format: 'epub', path: file };
}

test('publisher imports, inheritance, inline rules, importance and functional specificity determine native text offsets', async t => {
  const book = await fixture(t, '@import "../theme/modes.css" screen; .priority{white-space:normal!important} :is(.x,#never).specific{white-space:pre} .specific{white-space:normal} @media print{.keep{white-space:normal!important}}',
    '<p class="keep">A  😀\r\nB</p><p style="white-space:normal">A  B</p><p class="priority" style="white-space:pre-wrap">A  B</p><p class="specific x">A  B</p><div class="keep"><span>A  B</span></div>',
    { 'OPS/theme/modes.css': '.keep{white-space:pre-wrap}' });
  const pointer = (name, offset) => `/body/DocFragment[1]/body/${name}/text()[1].${offset}`;
  const convert = local => epubXPointer(book, `epubcfi(/6/2!${local})`);
  assert.equal(await convert('/4/2/1:5'), pointer('p[1]', 4));
  assert.equal(await convert('/4/2/1:7'), pointer('p[1]', 5));
  assert.equal(await epubFromXPointer(book, pointer('p[1]', 5)), 'epubcfi(/6/2!/4/2/1:7)');
  assert.equal(await convert('/4/4/1:4'), pointer('p[2]', 3));
  assert.equal(await convert('/4/6/1:4'), pointer('p[3]', 3));
  assert.equal(await convert('/4/8/1:4'), pointer('p[4]', 4));
  assert.equal(await convert('/4/10/2/1:4'), pointer('div[1]/span[1]', 4));
  assert.equal(await convert('/4/2/1:4'), null, 'surrogate pairs cannot be bisected');
  assert.equal(await convert('/4/2/1:6'), null, 'CRLF cannot be bisected in pre-like modes');
});

test('device-dependent whitespace uses fallback while static overriding rules remain convertible', async t => {
  const book = await fixture(t, '.dynamic:hover{white-space:pre} @media (max-width:600px){.conditional{white-space:pre}} .variables{white-space:var(--mode)} .preline{white-space:pre-line}',
    '<p class="dynamic">A  B</p><p class="conditional">A  B</p><p class="variables">A  B</p><p class="dynamic" style="white-space:normal!important">A  B</p><p class="preline">A  B</p>');
  for (const i of [1, 2, 3]) {
    assert.equal(await epubXPointer(book, `epubcfi(/6/2!/4/${i * 2}/1:4)`), null);
    assert.equal(await epubFromXPointer(book, `/body/DocFragment[1]/body/p[${i}]/text()[1].3`), null);
  }
  assert.equal(await epubXPointer(book, 'epubcfi(/6/2!/4/8/1:4)'), '/body/DocFragment[1]/body/p[4]/text()[1].3');
  assert.equal(await epubXPointer(book, 'epubcfi(/6/2!/4/10/1:4)'), '/body/DocFragment[1]/body/p[5]/text()[1].4', 'CREngine parses pre-line as PRE even when rendered spaces collapse');
});

test('unreadable imports never silently assume collapsed text', async t => {
  const book = await fixture(t, '@import "missing.css"; p{color:red}', '<p>A  B</p>');
  assert.equal(await epubXPointer(book, 'epubcfi(/6/2!/4/2/1:4)'), null);
});

test('unknown cascade-layer precedence uses fallback', async t => {
  const book = await fixture(t, '@layer publisher{p{white-space:pre!important}} p{white-space:normal!important}', '<p>A  B</p>');
  assert.equal(await epubXPointer(book, 'epubcfi(/6/2!/4/2/1:4)'), null, 'unknown layer precedence cannot pick a falsely stronger unlayered rule');
});

test('static child overrides can resolve inherited uncertainty and pseudo-element rules do not change source text offsets', async t => {
  const book = await fixture(t, 'body:hover{white-space:pre} p{white-space:normal} p::before{white-space:pre!important}', '<p>A  B</p><section>A  B</section>');
  assert.equal(await epubXPointer(book, 'epubcfi(/6/2!/4/2/1:4)'), '/body/DocFragment[1]/body/p[1]/text()[1].3');
  assert.equal(await epubXPointer(book, 'epubcfi(/6/2!/4/4/1:4)'), null);
});

test('prefixed XHTML still matches ordinary publisher type selectors', async t => {
  const book = await fixture(t, 'p{white-space:pre-wrap}', '<h:p xmlns:h="http://www.w3.org/1999/xhtml">A  B</h:p>');
  assert.equal(await epubXPointer(book, 'epubcfi(/6/2!/4/2/1:4)'), '/body/DocFragment[1]/body/p[1]/text()[1].4');
});
