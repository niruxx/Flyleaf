'use strict';

// EPUB CFI steps count all elements; CREngine paths count siblings of the same
// name. Work from the original chapter, never a percentage or rendered page.
// CREngine reference: crengine/src/{epubfmt,lvtinydom}.cpp (normalized V2 paths).
const { parse } = require('node-html-parser');
const CFI = require('foliate-js/epubcfi.js');
const path = require('node:path');
const { readMarkup } = require('./epub-text');
const { cfiPath } = require('./epub-cfi-path');
const tag = node => node.rawTagName?.split(':').pop().toLowerCase();
const elements = node => node.childNodes.filter(n => n.nodeType === 1);
const find = (root, local) => root.querySelectorAll('*').find(n => tag(n) === local);

function resolve(root, steps) {
  let node = root;
  for (const [i, step] of steps.entries()) {
    if (!Number.isSafeInteger(step.index) || step.index < 1 || step.temporal != null || step.spatial) return null;
    if (step.index % 2 === 0) {
      const children = elements(node);
      node = children[step.index / 2 - 1];
      if (!node || (step.id && node.getAttribute('id') !== step.id)) return null;
    } else {
      if (i !== steps.length - 1) return null;
      // CFI text chunks include adjacent text nodes separated by comments/PIs.
      let before = 0;
      const chunk = [];
      for (const child of node.childNodes) {
        if (child.nodeType === 1) before++;
        else if (child.nodeType === 3 && before === (step.index - 1) / 2) chunk.push(child);
      }
      let offset = step.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) return null;
      for (const text of chunk) {
        if (offset <= text.text.length) return { node: text, offset };
        offset -= text.text.length;
      }
      return null;
    }
  }
  return { node, offset: null };
}

// CREngine stores UTF-32 text with collapsed HTML whitespace; CFI uses UTF-16.
// Be conservative for publisher whitespace overrides: those need the device's
// rendered DOM, so retain the observed-anchor fallback instead of guessing.
function nativeOffset(node, offset) {
  let pre = false;
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (/white-space\s*:/i.test(parent.getAttribute?.('style') || '')) return null;
    if (['pre', 'textarea'].includes(tag(parent))) pre = true;
  }
  const normalize = text => pre ? text.replace(/\r\n?/g, '\n') : text.replace(/[\t\n\r ]+/g, ' ');
  // A CFI may not bisect a UTF-16 surrogate pair.
  if (offset > 0 && /[\uD800-\uDBFF]/.test(node.text[offset - 1]) && /[\uDC00-\uDFFF]/.test(node.text[offset] || '')) return null;
  let prefix = node.text.slice(0, offset);
  if (['pre', 'textarea'].includes(tag(node.parentNode)) && node === node.parentNode.firstChild && prefix.startsWith('\n')) prefix = prefix.slice(1);
  return Array.from(normalize(prefix)).length;
}

const BLOCKS = new Set(['body', 'div', 'section', 'article', 'aside', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'table', 'tr', 'td', 'th', 'dl', 'dt', 'dd']);
function nativeTextNodes(parent) {
  const children = parent.childNodes.filter(n => n.nodeType === 1 || n.nodeType === 3);
  return children.filter((n, i) => n.nodeType === 3 && n.text.length &&
    !(i === 0 && BLOCKS.has(tag(parent)) && /^[\t\n\r ]*$/.test(n.text)));
}

function xpointer(body, target, fragment) {
  const parts = [];
  let node = target.node;
  if (node.nodeType === 3) {
    const peers = nativeTextNodes(node.parentNode);
    if (!peers.includes(node)) return null;
    const offset = nativeOffset(node, target.offset);
    if (offset == null) return null;
    parts.unshift(`text()[${peers.indexOf(node) + 1}].${offset}`);
    node = node.parentNode;
  }
  while (node && node !== body) {
    if (!/^[a-z][a-z0-9_-]*$/.test(tag(node) || '')) return null;
    const peers = elements(node.parentNode).filter(n => tag(n) === tag(node));
    parts.unshift(`${tag(node)}[${peers.indexOf(node) + 1}]`);
    node = node.parentNode;
  }
  return node === body ? `/body/DocFragment[${fragment}]/body${parts.length ? '/' + parts.join('/') : '.0'}` : null;
}

async function epubTarget(book, position) {
  if (book.format !== 'epub' || typeof position !== 'string' || position.length > 2000 || !CFI.isCFI.test(position)) return null;
  try {
    const parts = CFI.parse(CFI.collapse(position));
    if (parts.length !== 2 || !parts[0].length || !parts[1].length) return null;
    const container = parse(await readMarkup(book.path, 'META-INF/container.xml'));
    const opfPath = find(container, 'rootfile')?.getAttribute('full-path');
    if (!opfPath) return null;
    const opf = parse(await readMarkup(book.path, opfPath));
    const pkg = find(opf, 'package');
    if (!pkg) return null;
    const ref = resolve(pkg, parts[0])?.node;
    const spine = elements(pkg).find(n => tag(n) === 'spine');
    if (!ref || tag(ref) !== 'itemref' || ref.parentNode !== spine) return null;
    const manifest = elements(pkg).find(n => tag(n) === 'manifest');
    const items = elements(manifest);
    const item = items.find(n => n.getAttribute('id') === ref.getAttribute('idref'));
    if (item?.getAttribute('media-type') !== 'application/xhtml+xml') return null;
    const href = decodeURIComponent(item.getAttribute('href').split('#')[0]);
    if (!href || /^[a-z]+:|^\/|\\/i.test(href)) return null;
    const chapterPath = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), href));
    if (chapterPath.startsWith('../')) return null;
    const doc = parse(await readMarkup(book.path, chapterPath), { comment: true, blockTextElements: { script: true, style: true } });
    const html = find(doc, 'html');
    const body = html && elements(html).find(n => tag(n) === 'body');
    if (!body) return null;
    const target = resolve(html, parts[1]);
    if (!target) return null;
    // Ignore unresolved itemrefs just as CREngine does. Retain non-linear and
    // non-XHTML items: current CREngine gives every valid spine item a fragment.
    const refs = elements(spine).filter(n => tag(n) === 'itemref' && items.some(item => item.getAttribute('id') === n.getAttribute('idref')));
    return { body, target, chapterPath, base: cfiPath(ref, pkg), html, fragment: refs.indexOf(ref) + 1 };
  } catch {
    // Unreadable/malformed EPUBs and unsupported locators use native anchors.
    return null;
  }
}

async function epubXPointer(book, position) {
  const resolved = await epubTarget(book, position);
  return resolved ? xpointer(resolved.body, resolved.target, resolved.fragment) : null;
}

async function epubFromXPointer(book, pointer) {
  if (book.format !== 'epub' || typeof pointer !== 'string' || pointer.length > 4000) return null;
  const match = pointer.match(/^\/body(?:\[1\])?\/DocFragment(?:\[(\d+)\])?\/body(?:\[1\])?(\/.*)?$/);
  if (!match) return null;
  try {
    const container = parse(await readMarkup(book.path, 'META-INF/container.xml'));
    const opfPath = find(container, 'rootfile')?.getAttribute('full-path');
    const opf = parse(await readMarkup(book.path, opfPath));
    const pkg = find(opf, 'package');
    const manifest = elements(pkg).find(n => tag(n) === 'manifest');
    const spine = elements(pkg).find(n => tag(n) === 'spine');
    const items = elements(manifest);
    const refs = elements(spine).filter(n => tag(n) === 'itemref' && items.some(item => item.getAttribute('id') === n.getAttribute('idref')));
    const ref = refs[Number(match[1] || 1) - 1];
    if (!ref) return null;
    const item = items.find(n => n.getAttribute('id') === ref.getAttribute('idref'));
    if (item.getAttribute('media-type') !== 'application/xhtml+xml') return null;
    const href = decodeURIComponent(item.getAttribute('href').split('#')[0]);
    if (!href || /^[a-z]+:|^\/|\\/i.test(href)) return null;
    const full = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), href));
    if (full.startsWith('../')) return null;
    const doc = parse(await readMarkup(book.path, full), { comment: true, blockTextElements: { script: true, style: true } });
    const html = find(doc, 'html');
    let node = elements(html).find(n => tag(n) === 'body'), offset = 0;
    for (const part of (match[2] || '').split('/').filter(Boolean)) {
      const step = part.match(/^([\w-]+|text\(\))(?:\[(\d+)\])?(?:\.(\d+))?$/);
      if (!step || !node || node.nodeType !== 1) return null;
      const index = Number(step[2] || 1) - 1;
      node = step[1] === 'text()' ? nativeTextNodes(node)[index] : elements(node).filter(n => tag(n) === step[1].toLowerCase())[index];
      if (!node) return null;
      if (step[3] !== undefined) {
        if (node.nodeType !== 3) return null;
        const native = Number(step[3]);
        // Invert normalized UTF-32 offsets into the original UTF-16 text.
        const boundaries = [0];
        let raw = 0;
        for (const char of node.text) { raw += char.length; boundaries.push(raw); }
        let low = 0, high = boundaries.length - 1;
        while (low < high) {
          const mid = Math.floor((low + high) / 2);
          const count = nativeOffset(node, boundaries[mid]);
          if (count === null) return null;
          if (count < native) low = mid + 1; else high = mid;
        }
        if (nativeOffset(node, boundaries[low]) !== native) return null;
        offset = boundaries[low];
      }
    }
    const local = cfiPath(node, html, offset), base = cfiPath(ref, pkg);
    return local && base ? `epubcfi(${base}!${local})` : null;
  } catch { return null; }
}

module.exports = { epubXPointer, epubTarget, epubFromXPointer };
