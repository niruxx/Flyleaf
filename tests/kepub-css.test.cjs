const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('node-html-parser');
const cssTree = require('css-tree');
const JSZip = require('jszip');
const { rewriteCss, prepareStyles } = require('../server/kepub-css');
const { specificity } = require('../server/publisher-selectors');

test('body child and descendant selectors still select original content with unchanged specificity', () => {
  const before = parse('<html><body class="chapter"><p id="first">One</p><section id="section"><p id="nested">Two</p></section><p id="last">Three</p></body></html>');
  const after = parse('<html><body class="chapter"><div id="book-columns"><div id="book-inner"><p id="first">One</p><section id="section"><p id="nested">Two</p></section><p id="last">Three</p></div></div></body></html>');
  for (const selector of ['body > p', 'body.chapter > :first-child', 'html > body > section > p', 'body p', 'body *', 'body > p + section', 'body > p:last-child']) {
    const output = rewriteCss(selector + '{color:red}', 'style.css');
    const rewritten = cssTree.generate(cssTree.parse(output).children.first.prelude);
    assert.deepEqual(after.querySelectorAll(rewritten).map(n => n.id), before.querySelectorAll(selector).map(n => n.id), selector);
    const specificity = input => {
      let value = 0;
      cssTree.walk(cssTree.parse(input, { context: 'selectorList' }), n => {
        if (n.type === 'IdSelector') value += 100;
        if (['ClassSelector', 'AttributeSelector', 'PseudoClassSelector'].includes(n.type)) value += 10;
        if (n.type === 'TypeSelector' && n.name !== '*') value++;
      });
      return value;
    };
    assert.equal(specificity(rewritten), specificity(selector), 'wrapper steps must not increase publisher specificity');
  }
});

test('ambiguous state and functional selectors preserve body and non-body matches and specificity', () => {
  const make = wrapped => parse(`<html><body class="shared" data-hover="yes">${wrapped ? '<div id="book-columns"><div id="book-inner">' : ''}<p id="top">Top</p><section class="shared" data-hover="yes"><p id="nested">Nested</p><a id="link">Link</a></section>${wrapped ? '</div></div>' : ''}</body></html>`);
  const before = make(false), after = make(true);
  const context = { root: before, body: before.querySelector('body'), key: 'states.xhtml' };
  for (const selector of ['.shared:hover > p', '.shared:has(>p) > p', ':is(body,.shared):hover >p',
    ':where(body,.shared)>p', 'p:not(body>p)', 'body:has(>p) > section', 'html>body:hover>p::before']) {
    const output = rewriteCss(selector + '{color:red}', 'styles.css', new Map(), context);
    const rewritten = cssTree.parse(output).children.first.prelude;
    for (const branch of rewritten.children) assert.deepEqual(specificity(branch), specificity(selector), selector);
    if (selector.includes('::')) continue;
    const state = text => text.replace(/:hover/g, '[data-hover="yes"]');
    const select = (root, s) => root.querySelectorAll(s).map(n => n.id).filter(Boolean);
    assert.deepEqual(select(after, state(cssTree.generate(rewritten))), select(before, state(selector)), selector);
    before.querySelector('body').removeAttribute('data-hover');
    after.querySelector('body').removeAttribute('data-hover');
    assert.deepEqual(select(after, state(cssTree.generate(rewritten))), select(before, state(selector)), selector + ' with body state off');
    before.querySelector('body').setAttribute('data-hover', 'yes');
    after.querySelector('body').setAttribute('data-hover', 'yes');
  }
});

test('CSS derivatives preserve import conditions and original resources for fixed-layout chapters', async () => {
  const zip = new JSZip();
  const original = '@charset "UTF-8";@import "../theme/colors.css" screen;@media print{body > p{color:red!important}}@font-face{font-family:Example;src:url(../fonts/example.woff2)}';
  zip.file('styles/main.css', original);
  zip.file('theme/colors.css', 'body p { color: blue }');
  const aliases = await prepareStyles(zip);
  assert.equal(await zip.file('styles/main.css').async('string'), original);
  const rewritten = await zip.file(aliases.get('styles/main.css')).async('string');
  assert.match(rewritten, /@import[^;]+flyleaf-kobo-[^;]+screen;/);
  assert.match(rewritten, /@media print\{body>\*>\*>p\{color:red!important\}\}/);
  assert.match(rewritten, /url\(\.\.\/fonts\/example\.woff2\)/);
});

test('stylesheet imports with arbitrary extensions and cycles all receive derivatives', async () => {
  const zip = new JSZip();
  zip.file('styles/main.css', '@import "../theme/publisher" screen;body>p{color:red}');
  zip.file('theme/publisher', '@import "../styles/main.css";body:hover>p{color:blue}');
  const aliases = await prepareStyles(zip, null, ['styles/main.css']);
  assert.equal(aliases.size, 2);
  assert.match(await zip.file(aliases.get('styles/main.css')).async('string'), /@import[^;]+flyleaf-kobo-[^;]+screen/);
  assert.match(await zip.file(aliases.get('theme/publisher')).async('string'), /body:hover>\*>\*>p/);
  assert.equal(await zip.file('theme/publisher').async('string'), '@import "../styles/main.css";body:hover>p{color:blue}');
});

test('chapter-specific styles adapt body classes and IDs without rewriting matching non-body elements', async () => {
  const first = parse('<html><body id="page" class="chapter" lang="ar"><p id="one">One</p></body></html>');
  const second = parse('<html><body class="other"><section class="chapter"><p id="two">Two</p></section></body></html>');
  const context = (root, key) => ({ root, body: root.querySelector('body'), key });
  const css = '.chapter > p { color: red } #page > p { margin: 1em } [lang="ar"] p { direction: rtl }';
  const zip = new JSZip();
  zip.file('shared.css', css);
  const a = await prepareStyles(zip, context(first, 'one.xhtml'), ['shared.css']);
  const b = await prepareStyles(zip, context(second, 'two.xhtml'), ['shared.css']);
  assert.notEqual(a.get('shared.css'), b.get('shared.css'));
  const adapted = await zip.file(a.get('shared.css')).async('string');
  const retained = await zip.file(b.get('shared.css')).async('string');
  assert.match(adapted, /\.chapter>\*>\*>p/);
  assert.match(adapted, /#page>\*>\*>p/);
  assert.match(adapted, /\[lang="ar"\]>\*>\* p/);
  assert.match(retained, /\.chapter>p/);
  assert.doesNotMatch(retained, /\.chapter>\*>\*>p/);
  assert.equal(await zip.file('shared.css').async('string'), css);
  const ambiguous = parse('<html><body class="chapter"><section class="chapter"><p>Text</p></section></body></html>');
  const wrapped = parse('<html><body class="chapter"><div id="book-columns"><div id="book-inner"><section class="chapter"><p id="nested">Text</p></section><p id="top">Top</p></div></div></body></html>');
  const original = parse('<html><body class="chapter"><section class="chapter"><p id="nested">Text</p></section><p id="top">Top</p></body></html>');
  const output = rewriteCss('.chapter>p{color:red}', 'style.css', new Map(), context(ambiguous, 'ambiguous.xhtml'));
  const selector = cssTree.generate(cssTree.parse(output).children.first.prelude);
  assert.deepEqual(wrapped.querySelectorAll(selector).map(n => n.id), original.querySelectorAll('.chapter>p').map(n => n.id), 'both body and non-body matches retain publisher behavior');
});
