'use strict';

const css = require('css-tree');
const { readZipFile } = require('./archive');
const { decodeMarkup } = require('./epub-text');
const { localResource } = require('./kepub-css');
const { specificity, compare } = require('./publisher-selectors');
const { parse: parseMarkup } = require('node-html-parser');
const localName = node => node.rawTagName?.split(':').pop().toLowerCase();
const STATES = /^(hover|active|focus|focus-within|focus-visible|visited|link|target|checked|disabled|enabled|open|fullscreen)$/i;

function mediaState(value) {
  if (!value?.trim()) return true;
  const states = value.toLowerCase().split(',').map(v => {
    v = v.trim().replace(/^only\s+/, '');
    if (/^(all|screen)$/.test(v)) return true;
    if (/^print(?:\s|$)/.test(v)) return false;
    return null; // viewport, color scheme and device settings are not known
  });
  return states.includes(true) ? true : states.includes(null) ? null : false;
}

// CREngine parses all pre-like modes (including pre-line) as PRE text. Its
// renderer can collapse spaces later; XPointer offsets refer to the parsed DOM.
function mode(value, inherited) {
  value = value.toLowerCase().trim();
  if (['inherit', 'unset'].includes(value)) return inherited;
  if (['normal', 'nowrap', 'initial'].includes(value)) return 'collapse';
  if (['pre', 'pre-wrap', 'pre-line', 'break-spaces'].includes(value)) return 'preserve';
  return null;
}

async function whiteSpaceResolver(file, root, chapter) {
  const rules = [];
  let order = 0, total = 0, unknown = false, namespacedCss = false;
  const active = new Set();
  const originalNodes = root.querySelectorAll('*');
  let queryRoot = root;
  const originalFor = new WeakMap();
  if (originalNodes.some(n => n.rawTagName?.includes(':'))) {
    queryRoot = parseMarkup(root.toString(), { comment: true, blockTextElements: { script: true, style: true } });
    const cloned = queryRoot.querySelectorAll('*');
    if (cloned.length !== originalNodes.length) unknown = true;
    cloned.forEach((node, i) => { originalFor.set(node, originalNodes[i]); node.rawTagName = localName(node); });
  }
  const parse = source => css.parse(source, { positions: false });
  const selectors = prelude => {
    if (prelude?.type !== 'SelectorList') return [{ matches: () => true, uncertain: true, weight: [0, 0, 0] }];
    return prelude.children.toArray().filter(selector => {
      let pseudoElement = false;
      css.walk(selector, node => { if (node.type === 'PseudoElementSelector') pseudoElement = true; });
      return !pseudoElement;
    }).map(selector => {
      const weight = specificity(selector);
      const clone = css.clone(selector);
      let uncertain = false;
      css.walk(clone, { visit: 'PseudoClassSelector', enter(node, item, list) {
        if (STATES.test(node.name)) { uncertain = true; list.remove(item); }
      } });
      let matches;
      return { uncertain, weight, matches(node) {
        if (!matches) {
          try { matches = new Set(queryRoot.querySelectorAll(css.generate(clone)).map(n => originalFor.get(n) || n)); }
          catch { uncertain = true; matches = null; }
        }
        return matches ? matches.has(node) : true;
      }, get unknown() { return uncertain; } };
    });
  };
  const declarations = block => block.children.toArray().filter(n => n.type === 'Declaration' &&
    ['white-space', 'white-space-collapse', 'all'].includes(n.property.toLowerCase()));
  const add = (prelude, block, conditional) => {
    if (namespacedCss && declarations(block).length) unknown = true;
    const selected = selectors(prelude);
    for (const declaration of declarations(block)) {
      if (rules.length >= 4000) { unknown = true; return; }
      rules.push({ selectors: selected, value: declaration.property.toLowerCase() === 'white-space-collapse' ? 'unknown'
        : css.generate(declaration.value), important: declaration.important ? 1 : 0, order: order++, conditional });
    }
  };
  const load = async (source, conditional, depth) => {
    if (depth > 16) { unknown = true; return; }
    if (active.has(source)) return;
    active.add(source);
    try {
      const bytes = await readZipFile(file, source);
      if (!bytes || (total += bytes.length) > 2 * 1024 * 1024) { unknown = true; return; }
      const charset = bytes.subarray(0, 128).toString('ascii').match(/^@charset\s+["']([^"']+)["']/i)?.[1];
      const text = charset ? new TextDecoder(charset, { fatal: true }).decode(bytes) : decodeMarkup(bytes);
      await walk(parse(text).children, source, conditional, depth);
    } catch { unknown = true; }
    finally { active.delete(source); }
  };
  const walk = async (children, source, conditional, depth) => {
    for (const node of children) {
      if (node.type === 'Rule') {
        add(node.prelude, node.block, conditional);
        // CSS nesting depends on a parent selector; don't silently ignore a
        // nested whitespace declaration whose selector cannot be evaluated.
        css.walk(node.block, n => { if (n !== node.block && n.type === 'Rule' && declarations(n.block).length) unknown = true; });
      } else if (node.type === 'Atrule') {
        const name = node.name.toLowerCase();
        if (name === 'namespace') namespacedCss = true;
        if (name === 'import') {
          const tokens = node.prelude?.children.toArray() || [];
          const href = tokens.find(n => ['Url', 'String'].includes(n.type));
          const rest = tokens.filter(n => n !== href).map(n => css.generate(n)).join(' ');
          if (/\blayer\b/i.test(rest)) unknown = true;
          const state = mediaState(rest);
          if (state === false) continue;
          const target = href && localResource(source, href.value);
          if (!target) unknown = true;
          else await load(target, conditional || state === null, depth + 1);
        } else if (node.block && !['font-face', 'page', 'keyframes', '-webkit-keyframes'].includes(name)) {
          if (['layer', 'scope'].includes(name)) css.walk(node.block, n => {
            if (n.type === 'Declaration' && ['white-space', 'white-space-collapse', 'all'].includes(n.property.toLowerCase())) unknown = true;
          });
          const state = name === 'media' ? mediaState(node.prelude && css.generate(node.prelude)) : null;
          if (state !== false) await walk(node.block.children, source, conditional || state === null, depth);
        }
      }
    }
  };
  for (const node of root.querySelectorAll('*')) {
    const tag = localName(node);
    const state = mediaState(node.getAttribute('media'));
    if (state === false || node.hasAttribute?.('disabled')) continue;
    if (tag === 'link' && /(?:^|\s)stylesheet(?:\s|$)/i.test(node.getAttribute('rel') || '')) {
      const source = localResource(chapter, node.getAttribute('href'));
      if (!source) unknown = true;
      else await load(source, state === null || /alternate/i.test(node.getAttribute('rel')), 0);
    } else if (tag === 'style') {
      try { await walk(parse(node.innerHTML.replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, '$1')).children, chapter, state === null, 0); }
      catch { unknown = true; }
    }
  }
  const cache = new WeakMap();
  const resolve = node => {
    if (!node || node.nodeType !== 1) return 'collapse';
    if (cache.has(node)) return cache.get(node);
    if (unknown) return null;
    let best = null;
    const consider = (rank, value, uncertain) => {
      if (!best || compare(rank, best.rank) > 0) best = { rank, value, uncertain };
    };
    for (const rule of rules) for (const selector of rule.selectors) {
      if (selector.matches(node)) consider([rule.important, 0, ...selector.weight, rule.order], rule.value, rule.conditional || selector.unknown);
    }
    try {
      const inline = css.parse(node.getAttribute('style') || '', { context: 'declarationList' });
      for (const [i, declaration] of declarations(inline).entries()) consider([declaration.important ? 1 : 0, 1, 0, 0, 0, i],
        declaration.property.toLowerCase() === 'white-space-collapse' ? 'unknown' : css.generate(declaration.value), false);
    } catch { return null; }
    const inherited = resolve(node.parentNode);
    const result = best ? best.uncertain ? null : mode(best.value, inherited)
      : ['pre', 'textarea'].includes(localName(node)) ? 'preserve' : inherited;
    cache.set(node, result);
    return result;
  };
  return resolve;
}

module.exports = { whiteSpaceResolver };
