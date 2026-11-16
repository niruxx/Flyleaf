'use strict';

const cssTree = require('css-tree');
const path = require('node:path');
const crypto = require('node:crypto');
const { decodeMarkup } = require('./epub-text');

// Universal steps have zero specificity. They traverse Kobo's two flow divs
// without giving publisher rules extra ID/class specificity.
function rewriteSelectors(ast, context) {
  cssTree.walk(ast, { visit: 'Selector', enter(selector) {
    const output = [];
    let body = false;
    let compound = [];
    for (const node of selector.children.toArray()) {
      if (node.type === 'Combinator') {
        if (!body && context && compound.length) {
          try {
            const text = cssTree.generate({ type: 'Selector', children: new cssTree.List().fromArray(compound) });
            const matches = context.root.querySelectorAll(text);
            body = matches.length === 1 && matches[0] === context.body;
          } catch { /* Dynamic/unsupported selectors retain the publisher rule. */ }
        }
        if (body && ['>', ' '].includes(node.name)) output.push(
          { type: 'Combinator', name: '>' }, { type: 'TypeSelector', name: '*' },
          { type: 'Combinator', name: '>' }, { type: 'TypeSelector', name: '*' });
        body = false;
        compound = [];
      } else {
        compound.push(node);
      }
      if (node.type === 'TypeSelector' && /^(?:[^|]*\|)?body$/i.test(node.name)) body = true;
      output.push(node);
    }
    selector.children.fromArray(output);
  } });
}

function localResource(base, href) {
  if (!href || /^(?:[a-z][\w+.-]*:|\/\/|\/|#)/i.test(href)) return null;
  try {
    const full = path.posix.normalize(path.posix.join(path.posix.dirname(base), decodeURIComponent(href.split(/[?#]/)[0])));
    return full.startsWith('../') ? null : full;
  } catch { return null; }
}

const relativeResource = (base, target) => path.posix.relative(path.posix.dirname(base), target).split('/').map(encodeURIComponent).join('/');

function rewriteCss(css, source, aliases = new Map(), context = null) {
  const ast = cssTree.parse(css);
  rewriteSelectors(ast, context);
  cssTree.walk(ast, { visit: 'Atrule', enter(rule) {
    if (rule.name.toLowerCase() !== 'import' || !rule.prelude) return;
    const target = rule.prelude.children?.toArray().find(n => ['Url', 'String'].includes(n.type));
    if (!target) return;
    const alias = aliases.get(localResource(source, target.value));
    if (alias) target.value = relativeResource(source, alias);
  } });
  return cssTree.generate(ast);
}

async function prepareStyles(zip, context = null, sources = null) {
  const aliases = new Map();
  for (const source of sources || Object.keys(zip.files).filter(f => /\.css$/i.test(f) && !zip.files[f].dir)) {
    const suffix = crypto.createHash('sha256').update(source + '\0' + (context?.key || '')).digest('hex').slice(0, 12);
    let alias = path.posix.join(path.posix.dirname(source), `flyleaf-kobo-${suffix}.css`);
    while (zip.files[alias]) alias = alias.replace(/\.css$/, '-copy.css');
    aliases.set(source, alias);
  }
  for (const [source, alias] of aliases) {
    // CSS defaults to UTF-8. @charset, where present, declares another encoding.
    const bytes = await zip.file(source).async('nodebuffer');
    const charset = bytes.subarray(0, 128).toString('ascii').match(/^@charset\s+["']([^"']+)["']/i)?.[1];
    const css = charset ? new (require('node:util').TextDecoder)(charset, { fatal: true }).decode(bytes) : decodeMarkup(bytes);
    const rewritten = rewriteCss(css, source, aliases, context).replace(/^@charset\s+[^;]+;/i, '@charset "UTF-8";');
    zip.file(alias, rewritten);
  }
  return aliases;
}

module.exports = { rewriteCss, prepareStyles, localResource, relativeResource };
