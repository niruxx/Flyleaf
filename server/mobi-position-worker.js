'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { DOMParser: Parser, parseHTML } = require('linkedom');
const { cfiPath } = require('./epub-cfi-path');
const { modernAnchorSource } = require('./mobi-native-anchors');
const { alignRuns } = require('./mobi-text-map');

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
    // CREngine renders legacy MOBI, not KF8. Reconstruct both saved-DOM anchor
    // layouts; the caller only exports differing paths after a native observation.
    const { mobi, palmdoc } = reader.headers;
    if (mobi.version >= 8 || palmdoc.encryption) return [];
    const buffers = [];
    let length = 0;
    for (let i = 0; i < palmdoc.numTextRecords; i++) {
      const bytes = await reader.loadText(i);
      length += bytes.length;
      if (length > 32 * 1024 * 1024) return [];
      buffers.push(Buffer.from(bytes));
    }
    const raw = Buffer.concat(buffers);
    const source = reader.decode(raw);
    const offsets = [...raw.toString('latin1').matchAll(/\bfilepos\s*=\s*["']?(\d+)/gi)].map(m => Number(m[1]));
    const collect = entries => {
      for (const entry of entries || []) {
        offsets.push(entry.offset);
        collect(entry.children);
      }
    };
    if (mobi.indx < 0xffffffff) collect(await reader.getNCX());
    const validOffsets = [...new Set(offsets.filter(n => Number.isSafeInteger(n) && n > 0 && n < raw.length))];
    if (validOffsets.length > 2048) return [];
    const modernSource = modernAnchorSource(raw, validOffsets, value => reader.decode(value));
    if (modernSource == null) return [];
    const isPre = node => {
      for (let parent = node.parentNode; parent; parent = parent.parentNode) {
        if (['pre', 'textarea'].includes(parent.localName)) return true;
      }
      return false;
    };
    const textRuns = root => {
      const out = [];
      const visit = n => {
        for (const child of Array.from(n.childNodes)) {
          if (child.nodeType === 3 && child.textContent.length) {
            const formatting = /^(body|div|section|article|table|thead|tbody|tfoot|tr|ul|ol)$/.test(n.localName);
            const leadingBlockSpace = child === n.firstChild && /^(p|td|th|li|blockquote|h[1-6])$/.test(n.localName);
            if (child.textContent.trim() || isPre(child) || (!formatting && !leadingBlockSpace)) out.push(child);
          }
          else if (child.nodeType === 1) visit(child);
        }
      };
      visit(root);
      return out;
    };
    const nativePath = (text, body) => {
      const steps = [];
      let node = text;
      while (node !== body) {
        const parent = node.parentNode;
        const children = Array.from(parent.childNodes);
        if (node.nodeType === 3) {
          const block = /^(body|div|p|section|article|td|th|tr|table|tbody|thead|tfoot|li|ul|ol|blockquote|h[1-6])$/.test(parent.localName);
          const peers = children.filter(n => n.nodeType === 3 && !(block && n === children[0] && /^[\t\r\n ]*$/.test(n.textContent)));
          steps.unshift(`text()[${peers.indexOf(node) + 1}]`);
        } else {
          const peers = children.filter(n => n.nodeType === 1 && n.localName === node.localName);
          steps.unshift(`${node.localName}[${peers.indexOf(node) + 1}]`);
        }
        node = parent;
      }
      return '/body/' + steps.join('/');
    };
    const webRuns = [];
    for (let i = 0; i < book.sections.length; i++) {
      const doc = await book.sections[i].createDocument();
      const sectionBody = doc.querySelector('body');
      if (!sectionBody) return [];
      for (const node of textRuns(sectionBody)) {
        const local = cfiPath(node, doc.documentElement);
        webRuns.push({ text: node.textContent,
          path: `/6/${(i + 1) * 2}!${local.replace(/:\d+$/, '')}`,
          chunkStart: Number(local.match(/:(\d+)$/)?.[1] || 0) });
      }
    }
    const mappings = [];
    for (const [profile, markup] of [['legacy', source], ['modern', modernSource]]) {
      const original = new DOMParser().parseFromString(markup.replace(/<!--[\s\S]*?-->/g, ''), 'text/html');
      const body = original.querySelector('body');
      if (!body || original.querySelector('style, link[rel="stylesheet"]') || body.querySelector('script, svg, math, form, [style*="white-space"]')) return [];
      for (const node of body.querySelectorAll('td, th, tr, thead, tbody, tfoot')) {
        const parents = ['td', 'th'].includes(node.localName) ? ['tr']
          : node.localName === 'tr' ? ['table', 'thead', 'tbody', 'tfoot'] : ['table'];
        if (!parents.includes(node.parentNode.localName)) return [];
      }
      // Malformed tables trigger CREngine foster-parenting and implied cells.
      // Explicit rows/cells and row groups have stable normalized paths.
      for (const table of body.querySelectorAll('table, thead, tbody, tfoot, tr')) {
        const allowed = table.localName === 'tr' ? ['td', 'th'] : table.localName === 'table'
          ? ['caption', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr'] : ['tr'];
        if (Array.from(table.childNodes).some(n => n.nodeType === 3 ? n.textContent.trim() : n.nodeType === 1 && !allowed.includes(n.localName))) return [];
      }
      // CREngine's HTML5 table handling (DOM >= 20200824) supplies a TBODY
      // around direct TR children. Foliate's HTML shim retains the source tree.
      for (const table of body.querySelectorAll('table')) {
        let group = null;
        for (const child of Array.from(table.childNodes)) {
          if (child.nodeType === 1 && child.localName === 'tr') {
            if (!group) {
              group = original.createElement('tbody');
              table.insertBefore(group, child);
            }
            group.appendChild(child);
          } else if (child.nodeType === 1) group = null;
        }
      }
      const nativeRuns = textRuns(body).map(node => ({ text: node.textContent, path: nativePath(node, body), pre: isPre(node),
        stripLeadingNewline: ['pre', 'textarea'].includes(node.parentNode.localName) && node === node.parentNode.firstChild }));
      const aligned = alignRuns(nativeRuns, webRuns, profile);
      if (!aligned.length) return [];
      mappings.push(...aligned);
    }
    return mappings;
  } finally { book.destroy?.(); }
}

build().then(mappings => parentPort.postMessage({ mappings }), error => parentPort.postMessage({ error: error.message }));
