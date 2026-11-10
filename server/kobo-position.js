'use strict';

const { epubTarget } = require('./kosync-position');
const { parse } = require('node-html-parser');
const { readZipFile } = require('./archive');
const path = require('node:path');
const { rendition } = require('./kepub');
const { cfiPath: canonicalPath } = require('./epub-cfi-path');
const elements = node => node.childNodes.filter(n => n.nodeType === 1);
const name = node => node.rawTagName?.toLowerCase();

function cfiPath(node, root) {
  const steps = [];
  while (node && node !== root) {
    const parent = node.parentNode;
    if (!parent) return null;
    if (node.nodeType === 3) {
      const preceding = parent.childNodes.slice(0, parent.childNodes.indexOf(node));
      steps.unshift(`/${2 * preceding.filter(n => n.nodeType === 1).length + 1}:0`);
    } else steps.unshift(`/${2 * (elements(parent).indexOf(node) + 1)}`);
    node = parent;
  }
  return node === root ? steps.join('') : null;
}

async function koboCFI(book, location, { allowGenerated = true } = {}) {
  if (book.format !== 'epub' || location?.Type !== 'KoboSpan' || typeof location.Source !== 'string' ||
      typeof location.Value !== 'string' || !/^kobo\.\d+\.\d+$/.test(location.Value) || location.Source.length > 2000) return null;
  try {
    const generated = allowGenerated ? await rendition(book).catch(() => null) : null;
    const source = path.posix.normalize(decodeURIComponent(location.Source));
    const mapped = generated?.spans.find(span => span.source === source && span.id === location.Value);
    if (mapped) return mapped.cfi;
    const container = parse((await readZipFile(book.path, 'META-INF/container.xml')).toString('utf8'));
    const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
    if (!opfPath) return null;
    const opf = parse((await readZipFile(book.path, opfPath)).toString('utf8'));
    const pkg = opf.querySelector('package');
    const manifest = elements(pkg).find(n => name(n) === 'manifest');
    const spine = elements(pkg).find(n => name(n) === 'spine');
    for (const ref of elements(spine)) {
      const item = elements(manifest).find(n => n.getAttribute('id') === ref.getAttribute('idref'));
      if (item?.getAttribute('media-type') !== 'application/xhtml+xml') continue;
      const href = decodeURIComponent(item.getAttribute('href').split('#')[0]);
      const full = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), href));
      if (full !== source) continue;
      const doc = parse((await readZipFile(book.path, full)).toString('utf8'), { comment: true });
      const html = doc.querySelector('html');
      const span = html.querySelectorAll('[id]').find(n => n.getAttribute('id') === location.Value);
      if (!span) return null;
      const firstText = node => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3 && child.text.length) return child;
          if (child.nodeType === 1) { const found = firstText(child); if (found) return found; }
        }
        return null;
      };
      const local = cfiPath(firstText(span) || span, html);
      const base = cfiPath(ref, pkg);
      return base && local ? `epubcfi(${base}!${local})` : null;
    }
  } catch {}
  return null;
}

// A KoboSpan is an ID in the exact EPUB downloaded by the device. Never invent
// IDs for ordinary EPUBs, or return a web CFI disguised as a native bookmark.
async function koboLocation(book, position) {
  const resolved = await epubTarget(book, position);
  if (!resolved) return null;
  const generated = await rendition(book).catch(() => null);
  if (generated && resolved.target.node.nodeType === 3) {
    const positionPath = canonicalPath(resolved.target.node, resolved.html, resolved.target.offset);
    const nodePath = positionPath.replace(/:\d+$/, '');
    const offset = Number(positionPath.match(/:(\d+)$/)?.[1]);
    const candidates = generated.spans.filter(span => span.source === resolved.chapterPath && span.base === resolved.base && span.nodePath === nodePath);
    const span = candidates.find(span => offset >= span.start && offset < span.end) || candidates.at(-1);
    if (span) return { Source: span.source, Type: 'KoboSpan', Value: span.id };
  }
  let node = resolved.target.node;
  while (node && node !== resolved.body) {
    const id = node.getAttribute?.('id');
    if (typeof id === 'string' && /^kobo\.\d+\.\d+$/.test(id)) {
      return { Source: resolved.chapterPath, Type: 'KoboSpan', Value: id };
    }
    node = node.parentNode;
  }
  return null;
}

module.exports = { koboLocation, koboCFI };
