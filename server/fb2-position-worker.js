'use strict';

// Isolate Foliate's browser globals in a worker. Its pinned FB2 converter is
// exactly the converter used by the web reader; comments do not affect CFIs.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { DOMParser, parseHTML } = require('linkedom');
const { decodeMarkup } = require('./epub-text');
const { cfiPath } = require('./epub-cfi-path');
const markerPrefix = 'flyleaf-position-' + require('node:crypto').randomUUID() + '-';

async function build() {
  global.DOMParser = DOMParser;
  global.document = parseHTML('<html><head></head><body></body></html>').document;
  document.implementation = { createDocument: (ns, root) => new DOMParser().parseFromString(`<${root} xmlns="${ns}"/>`, 'application/xml') };
  const source = new DOMParser().parseFromString(decodeMarkup(await fs.readFile(workerData.file)), 'application/xml');
  const root = source.documentElement;
  if (root.localName !== 'FictionBook') throw new Error('Not an FB2 document');
  const originals = new Map();
  const originalNodes = new Map();
  let serial = 0;
  const nativePath = node => {
    const parts = [];
    while (node !== root) {
      const parent = node.parentNode;
      const siblings = Array.from(parent.childNodes);
      if (node.nodeType === 3) {
        const texts = siblings.filter(n => n.nodeType === 3 && !(n === siblings[0] && /^[\t\r\n ]*$/.test(n.textContent)));
        parts.unshift(`text()[${texts.indexOf(node) + 1}]`);
      } else {
        const peers = siblings.filter(n => n.nodeType === 1 && n.localName === node.localName);
        parts.unshift(`${node.localName}[${peers.indexOf(node) + 1}]`);
      }
      node = parent;
    }
    return '/FictionBook/' + parts.join('/');
  };
  const mark = node => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 && child.textContent.trim()) {
        const id = markerPrefix + serial++;
        const original = { native: nativePath(child), text: child.textContent };
        originals.set(id, original);
        originalNodes.set(child, original);
        node.insertBefore(source.createComment(id), child);
      } else if (child.nodeType === 1) mark(child);
    }
  };
  for (const body of source.querySelectorAll('body')) mark(body);
  const { makeFB2 } = await import('foliate-js/fb2.js');
  const normalized = source.toString().replace(/^(\s*<\?xml\b[^>]*\bencoding\s*=\s*)["'][^"']+["']/i, '$1"utf-8"');
  const book = await makeFB2(new Blob([normalized], { type: 'application/x-fictionbook+xml' }));
  const mappings = [];
  const stanzas = Array.from(source.querySelectorAll('body stanza'));
  let stanzaIndex = 0;
  try {
    for (let i = 0; i < book.sections.length; i++) {
      const doc = book.sections[i].createDocument();
      const visit = node => {
        const children = Array.from(node.childNodes);
        for (let j = 0; j < children.length; j++) {
          const child = children[j];
          if (child.nodeType === 3) {
            const marker = children[j - 1];
            const original = marker?.nodeType === 8 && originals.get(marker.data);
            if (original && original.text === child.textContent) {
              const local = cfiPath(child, doc.documentElement);
              const chunkStart = Number(local.match(/:(\d+)$/)?.[1] || 0);
              mappings.push({ ...original, path: `/6/${(i + 1) * 2}!${local.replace(/:\d+$/, '')}`, chunkStart });
            }
          } else if (child.nodeType === 1) visit(child);
        }
      };
      visit(doc.querySelector('body'));
      // Foliate's stanza converter deliberately flattens each <v> to a single
      // text node plus <br>. Map each original inline text run into that chunk.
      for (const stanza of doc.querySelectorAll('.stanza')) {
        const original = stanzas[stanzaIndex++];
        if (!original) continue;
        const verses = Array.from(original.children).filter(n => n.localName === 'v');
        const appended = Array.from(stanza.childNodes).slice(-2 * verses.length);
        if (!verses.length || appended.length !== verses.length * 2) continue;
        for (let v = 0; v < verses.length; v++) {
          const text = appended[v * 2];
          if (text?.nodeType !== 3 || appended[v * 2 + 1]?.localName !== 'br' || text.textContent !== verses[v].textContent) continue;
          const local = cfiPath(text, doc.documentElement);
          const chunkStart = Number(local.match(/:(\d+)$/)?.[1] || 0);
          let offset = 0;
          const leaves = node => {
            for (const child of Array.from(node.childNodes)) {
              if (child.nodeType === 3) {
                const mapped = originalNodes.get(child);
                if (mapped) mappings.push({ ...mapped, path: `/6/${(i + 1) * 2}!${local.replace(/:\d+$/, '')}`, chunkStart: chunkStart + offset });
                offset += child.textContent.length;
              } else if (child.nodeType === 1) leaves(child);
            }
          };
          leaves(verses[v]);
        }
      }
    }
  } finally { book.destroy?.(); }
  return mappings;
}
build().then(mappings => parentPort.postMessage({ mappings }), error => parentPort.postMessage({ error: error.message }));
