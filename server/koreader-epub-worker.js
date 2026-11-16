'use strict';

// Export Foliate's section DOMs without adding body elements. The resulting
// EPUB uses the same /6/<section> CFI bases as the web MOBI/KF8 reader.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { DOMParser: Parser, parseHTML } = require('linkedom');
const JSZip = require('jszip');
const { cfiPath } = require('./epub-cfi-path');
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class DOMParser extends Parser {
  parseFromString(source, type) {
    if (type === 'text/html') {
      source = source.replace(/<mbp:pagebreak\b[^>]*>/gi, '<mbp:pagebreak></mbp:pagebreak>');
      if (!/<html\b/i.test(source)) source = '<html><head></head><body>' + source + '</body></html>';
    }
    return super.parseFromString(source, type);
  }
}

function xml(node) {
  if (node.nodeType === 3 || node.nodeType === 4) return escape(node.textContent);
  if (node.nodeType !== 1) return '';
  const attrs = Array.from(node.attributes).map(a => ` ${a.name}="${escape(a.value)}"`).join('');
  return `<${node.localName}${attrs}>${Array.from(node.childNodes).map(xml).join('')}</${node.localName}>`;
}

function textPaths(doc) {
  const paths = [];
  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) paths.push([cfiPath(child, doc.documentElement), child.textContent]);
      else if (child.nodeType === 1) walk(child);
    }
  };
  walk(doc.documentElement);
  return JSON.stringify(paths);
}

async function build() {
  const NativeBlob = global.Blob;
  global.Blob = class extends NativeBlob {
    constructor(parts, options = {}) { super(parts, { ...options, type: options.type || options.newType }); }
  };
  global.DOMParser = DOMParser;
  global.CSS = { escape: require('css-tree').ident.encode };
  global.XMLSerializer = class { serializeToString(node) { return node.toString(); } };
  global.document = parseHTML('<html><head></head><body></body></html>').document;
  const { MOBI } = await import('foliate-js/mobi.js');
  const reader = new MOBI({ unzlib: data => require('node:zlib').inflateSync(data) });
  const book = await reader.open(new Blob([await fs.readFile(workerData.file)]));
  if (reader.headers.palmdoc.encryption) throw new Error('Encrypted books cannot be converted');
  if (book.rendition?.layout === 'pre-paginated') throw new Error('Fixed-layout KF8 export is not supported');
  const blobs = new Map();
  const originalCreate = URL.createObjectURL;
  URL.createObjectURL = blob => { const url = originalCreate(blob); blobs.set(url, blob); return url; };
  try {
    if (!book.sections.length || book.sections.length > 5000) throw new Error('Unsupported section count');
    const docs = [];
    const originals = [];
    for (const section of book.sections) {
      const doc = await section.createDocument();
      if (!doc.querySelector('body') || doc.querySelector('parsererror, script')) throw new Error('Unsupported chapter markup');
      originals.push(textPaths(doc));
      if (reader.headers.mobi.version >= 8) {
        // KF8 resources include nested CSS and fonts; use Foliate's resolver.
        const replaced = await book.replaceResources(doc.toString());
        docs.push(new DOMParser().parseFromString(replaced, 'application/xhtml+xml'));
      } else {
        await book.replaceResources(doc);
        docs.push(doc);
      }
    }
    // Rewrite native links to chapter fragments without inserting body nodes.
    let serial = 0;
    for (const doc of docs) for (const a of doc.querySelectorAll('a[href], a[filepos]')) {
      const href = a.getAttribute('filepos') ? `filepos:${a.getAttribute('filepos')}` : a.getAttribute('href');
      if (!/^(filepos:|kindle:pos:)/i.test(href || '')) continue;
      const target = await book.resolveHref(href);
      if (!target || !docs[target.index]) throw new Error('Unresolvable internal link');
      const node = target.anchor(docs[target.index]);
      if (!node || node.nodeType !== 1) throw new Error('Unresolvable link target');
      if (!node.id) node.id = `flyleaf-target-${serial++}`;
      a.setAttribute('href', `section-${target.index}.xhtml#${encodeURIComponent(node.id)}`);
    }
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    const resources = [...blobs].map(([url, blob], i) => ({ url, blob, name: `resource-${i}` }));
    const replace = value => resources.reduce((s, r) => s.replaceAll(r.url, r.name), value);
    const manifest = [];
    let total = 0;
    for (const resource of resources) {
      let data = Buffer.from(await resource.blob.arrayBuffer());
      let type = resource.blob.type;
      if (!type) {
        if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) type = 'image/png';
        else if (data[0] === 255 && data[1] === 216) type = 'image/jpeg';
        else if (data.subarray(0, 3).toString() === 'GIF') type = 'image/gif';
        else if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') type = 'image/webp';
        else if (/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(data.toString('utf8'))) type = 'image/svg+xml';
        else throw new Error('Unsupported resource media type');
      }
      if (/text\/|xml|svg/.test(type)) data = Buffer.from(replace(data.toString('utf8')));
      total += data.length;
      if (total > 128 * 1024 * 1024) throw new Error('Converted resources too large');
      zip.file(`OPS/${resource.name}`, data);
      manifest.push(`<item id="${resource.name}" href="${resource.name}" media-type="${escape(type)}"/>`);
    }
    for (const [i, doc] of docs.entries()) {
      if (!doc.documentElement.getAttribute('xmlns')) doc.documentElement.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      const chapter = replace(xml(doc.documentElement));
      const parsed = new DOMParser().parseFromString(chapter, 'application/xhtml+xml');
      if (textPaths(parsed) !== originals[i]) throw new Error('Conversion would change reading-position paths');
      zip.file(`OPS/section-${i}.xhtml`, chapter);
      manifest.push(`<item id="s${i}" href="section-${i}.xhtml" media-type="application/xhtml+xml"/>`);
    }
    const title = escape(book.metadata?.title || 'Book');
    const nav = docs.map((_, i) => `<li><a href="section-${i}.xhtml">${i + 1}</a></li>`).join('');
    zip.file('OPS/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body><nav epub:type="toc"><ol>${nav}</ol></nav></body></html>`);
    zip.file('OPS/package.opf', `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">${escape(workerData.revision)}</dc:identifier><dc:title>${title}</dc:title><dc:language>${escape(book.metadata?.language || 'en')}</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata><manifest>${manifest.join('')}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine>${docs.map((_, i) => `<itemref idref="s${i}"/>`).join('')}</spine></package>`);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  } finally {
    URL.createObjectURL = originalCreate;
    book.destroy?.();
    for (const url of blobs.keys()) URL.revokeObjectURL(url);
  }
}

build().then(buffer => parentPort.postMessage({ buffer }), error => parentPort.postMessage({ error: error.message }));
