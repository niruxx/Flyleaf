'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { DOMParser: Parser, parseHTML } = require('linkedom');
const { cfiPath } = require('./epub-cfi-path');

class DOMParser extends Parser {
  parseFromString(source, type) {
    if (type !== 'text/html') return super.parseFromString(source, type);
    // MOBI's pagebreak is a void marker. HTML DOM shims otherwise treat this
    // namespaced tag as an open container and nest the next chapter inside it.
    source = source.replace(/<mbp:pagebreak\b[^>]*>/gi, '<mbp:pagebreak></mbp:pagebreak>');
    if (!/<html\b/i.test(source)) source = '<html><head></head><body>' + source + '</body></html>';
    return super.parseFromString(source, type);
  }
}

async function build() {
  global.DOMParser = DOMParser;
  global.XMLSerializer = class { serializeToString(node) { return node.toString(); } };
  global.document = parseHTML('<html><head></head><body></body></html>').document;
  const bytes = await fs.readFile(workerData.file);
  if (bytes.length < 94 || bytes.subarray(60, 68).toString() !== 'BOOKMOBI') return [];
  const firstRecord = bytes.readUInt32BE(78);
  if (firstRecord + 40 > bytes.length || bytes.readUInt32BE(firstRecord + 36) >= 8) return [];
  const { MOBI } = await import('foliate-js/mobi.js');
  const reader = new MOBI({ unzlib: data => require('node:zlib').inflateSync(data) });
  const book = await reader.open(new Blob([bytes]));
  try {
    // CREngine renders legacy MOBI, not KF8. Filepos/NCX anchors vary by its
    // requested DOM version and can split text. Do not guess those positions.
    const { mobi, palmdoc } = reader.headers;
    if (mobi.version >= 8 || palmdoc.encryption || mobi.indx < 0xffffffff) return [];
    const buffers = [];
    let length = 0;
    for (let i = 0; i < palmdoc.numTextRecords; i++) {
      const bytes = await reader.loadText(i);
      length += bytes.length;
      if (length > 32 * 1024 * 1024) return [];
      buffers.push(Buffer.from(bytes));
    }
    const source = reader.decode(Buffer.concat(buffers));
    if (/\bfilepos\s*=/i.test(source)) return [];
    const original = new DOMParser().parseFromString(source, 'text/html');
    const body = original.querySelector('body');
    if (!body || original.querySelector('style, link[rel="stylesheet"]') || body.querySelector('table, pre, script, svg, math, [style*="white-space"]')) return [];
    const textRuns = root => {
      const out = [];
      const visit = n => {
        for (const child of Array.from(n.childNodes)) {
          if (child.nodeType === 3 && child.textContent.trim()) out.push(child);
          else if (child.nodeType === 1) visit(child);
        }
      };
      visit(root);
      return out;
    };
    const nativePath = text => {
      const steps = [];
      let node = text;
      while (node !== body) {
        const parent = node.parentNode;
        const children = Array.from(parent.childNodes);
        if (node.nodeType === 3) {
          const peers = children.filter(n => n.nodeType === 3 && !(n === children[0] && /^[\t\r\n ]*$/.test(n.textContent)));
          steps.unshift(`text()[${peers.indexOf(node) + 1}]`);
        } else {
          const peers = children.filter(n => n.nodeType === 1 && n.localName === node.localName);
          steps.unshift(`${node.localName}[${peers.indexOf(node) + 1}]`);
        }
        node = parent;
      }
      return '/body/' + steps.join('/');
    };
    const originals = textRuns(body);
    const mappings = [];
    let index = 0;
    for (let i = 0; i < book.sections.length; i++) {
      const doc = await book.sections[i].createDocument();
      const sectionBody = doc.querySelector('body');
      if (!sectionBody) return [];
      for (const node of textRuns(sectionBody)) {
        const original = originals[index++];
        // Ordered, exact text-run agreement is required across section splits.
        // A mismatch invalidates the map rather than searching for similar text.
        if (!original || node.textContent !== original.textContent) return [];
        const local = cfiPath(node, doc.documentElement);
        mappings.push({ native: nativePath(original), text: original.textContent,
          path: `/6/${(i + 1) * 2}!${local.replace(/:\d+$/, '')}`,
          chunkStart: Number(local.match(/:(\d+)$/)?.[1] || 0) });
      }
    }
    return index === originals.length ? mappings : [];
  } finally { book.destroy?.(); }
}

build().then(mappings => parentPort.postMessage({ mappings }), error => parentPort.postMessage({ error: error.message }));
