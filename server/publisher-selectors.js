'use strict';

const css = require('css-tree');
const STATES = /^(hover|active|focus|focus-within|focus-visible|visited|link|target|checked|disabled|enabled|open|fullscreen)$/i;
const list = nodes => new css.List().fromArray(nodes);
const generate = nodes => css.generate({ type: 'Selector', children: list(nodes) });

function specificity(selector) {
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const max = values => values.reduce((best, v) => compare(v, best) > 0 ? v : best, [0, 0, 0]);
  const score = node => {
    if (node.type === 'IdSelector') return [1, 0, 0];
    if (['ClassSelector', 'AttributeSelector'].includes(node.type)) return [0, 1, 0];
    if (node.type === 'TypeSelector') return /(?:^|\|)\*$/.test(node.name) ? [0, 0, 0] : [0, 0, 1];
    if (node.type === 'PseudoElementSelector') return [0, 0, 1];
    if (node.type === 'PseudoClassSelector') {
      if (node.name.toLowerCase() === 'where') return [0, 0, 0];
      const inner = node.children?.toArray().find(n => n.type === 'SelectorList');
      if (/^(is|not|has)$/i.test(node.name) && inner) return max(inner.children.toArray().map(score));
      const nth = node.children?.toArray().find(n => n.type === 'Nth');
      return add([0, 1, 0], nth?.selector ? max(nth.selector.children.toArray().map(score)) : [0, 0, 0]);
    }
    return node.children ? node.children.toArray().reduce((sum, n) => add(sum, score(n)), [0, 0, 0]) : [0, 0, 0];
  };
  return score(typeof selector === 'string' ? css.parse(selector, { context: 'selector' }) : selector);
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function rewriteSelector(selector, context, depth = 0, relativeBody = false) {
  if (depth > 12) throw new Error('Publisher selector nesting is too deep');
  const compounds = [[]], combinators = [];
  for (const node of selector.children) {
    if (node.type === 'Combinator') { combinators.push(node.name); compounds.push([]); }
    else compounds.at(-1).push(node);
  }
  if (compounds.length > 64) throw new Error('Publisher selector is too complex');
  const classify = nodes => {
    const type = nodes.find(n => n.type === 'TypeSelector' && !/(?:^|\|)\*$/.test(n.name));
    if (type) return /(?:^|\|)body$/i.test(type.name) ? 'body' : 'other';
    if (nodes.some(n => n.type === 'PseudoClassSelector' && n.name.toLowerCase() === 'scope') && relativeBody) return 'body';
    if (nodes.some(n => n.type === 'PseudoClassSelector' && n.name.toLowerCase() === 'root')) return 'other';
    if (context) {
      let dynamic = false;
      for (const node of nodes) css.walk(node, n => { if (n.type === 'PseudoClassSelector' && (STATES.test(n.name) || n.name.toLowerCase() === 'has')) dynamic = true; });
      if (!dynamic) try {
        const matches = context.root.querySelectorAll(generate(nodes));
        if (!matches.includes(context.body)) return 'other';
        if (matches.length === 1) return 'body';
      } catch { /* Preserve alternatives for selectors the DOM shim cannot evaluate. */ }
    }
    return nodes.length ? 'maybe' : 'other';
  };
  const kinds = compounds.map(classify);
  const candidates = kinds.map((kind, i) => kind !== 'other' &&
    (['>', ' '].includes(combinators[i]) || compounds[i].some(n => n.type === 'PseudoClassSelector' && n.name.toLowerCase() === 'has')) ? i : -1).filter(i => i >= 0);
  const certain = candidates.filter(i => kinds[i] === 'body');
  const variants = certain.length ? [certain[0]] : [-1, ...candidates];
  const functional = (nodes, bodyHere) => nodes.map(original => {
    const node = css.clone(original);
    if (node.type !== 'PseudoClassSelector' || !node.children) return node;
    css.walk(node, { visit: 'SelectorList', enter(inner) {
      const rewritten = inner.children.toArray().flatMap(s => rewriteSelector(s, context, depth + 1, node.name.toLowerCase() === 'has' && bodyHere));
      inner.children.fromArray(rewritten.map(s => css.parse(s, { context: 'selector' })));
      return css.walk.skip;
    } });
    return node;
  });
  return [...new Set(variants.map(bodyIndex => {
    const parts = [];
    for (let i = 0; i < compounds.length; i++) {
      const nodes = functional(compounds[i], i === bodyIndex || kinds[i] === 'body');
      if (candidates.includes(i) && kinds[i] === 'maybe') {
        const gate = css.parse(i === bodyIndex ? ':where(body)' : ':where(:not(body))', { context: 'selector' }).children.first;
        const pseudo = nodes.findIndex(n => n.type === 'PseudoElementSelector');
        nodes.splice(pseudo < 0 ? nodes.length : pseudo, 0, gate);
      }
      parts.push(generate(nodes));
      if (i < combinators.length) {
        if (i === bodyIndex && ['>', ' '].includes(combinators[i])) parts.push('>*>*');
        parts.push(combinators[i]);
      }
    }
    let result = parts.join('');
    if (relativeBody && !compounds[0].some(n => n.type === 'PseudoClassSelector' && n.name.toLowerCase() === 'scope')) {
      if (compounds[0].length) result = '>*>* ' + result;
      else if (combinators[0] === '>') result = '>*>*' + result;
    }
    return result;
  }))];
}

function rewriteSelectorList(prelude, context) {
  const selectors = prelude.children.toArray().flatMap(selector => rewriteSelector(selector, context));
  return css.parse(selectors.join(','), { context: 'selectorList' });
}

module.exports = { rewriteSelectorList, specificity, compare };
