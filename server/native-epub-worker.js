'use strict';
// Serialize the pinned web reader's own virtual sections, preserving DOM/CFI paths.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { resolveObjectURL } = require('node:buffer');
const { DOMParser: Parser, parseHTML } = require('linkedom');
const JSZip = require('jszip');
const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  if (node.nodeType === 3 || node.nodeType === 4) return esc(node.textContent);
  if (node.nodeType === 8) return '<!--' + node.data.replace(/--/g, ' ') + '-->';
  if (node.nodeType !== 1) return Array.from(node.childNodes || [], xml).join('');
  const name = node.localName;
  return '<' + name + Array.from(node.attributes, a => ' ' + a.name + '="' + esc(a.value) + '"').join('') + '>' + Array.from(node.childNodes, xml).join('') + '</' + name + '>';
}
async function build() {
  global.DOMParser = DOMParser;
  global.XMLSerializer = class { serializeToString(node) { return xml(node); } };
  global.document = parseHTML('<html><head></head><body></body></html>').document;
  document.implementation = { createDocument: (ns, root) => new DOMParser().parseFromString(`<${root} xmlns="${ns}"/>`, 'application/xml') };
  const raw = await fs.readFile(workerData.file);
  if (raw.length > 64 * 1024 * 1024) throw new Error('Native conversion exceeds the 64 MiB input limit.');
  let book;
  if (workerData.format === 'fb2') {
    const { makeFB2 } = await import('foliate-js/fb2.js');
    book = await makeFB2(new Blob([raw]));
  } else {
    const { MOBI } = await import('foliate-js/mobi.js');
    book = await new MOBI({ unzlib: data => require('node:zlib').inflateSync(data) }).open(new Blob([raw]));
  }
  try {
    if (!book.sections.length || book.sections.length > 20000) throw new Error('Invalid native rendition spine.');
    const zip = new JSZip();
    const resources = [], urls = new Map();
    const anchors = [];
    let expanded = 0;
    const add = (name, data) => {
      expanded += Buffer.byteLength(data);
      if (expanded > 256 * 1024 * 1024) throw new Error('Native rendition expansion limit exceeded.');
      zip.file(name, data);
    };
    const rewrite = async source => {
      for (const url of new Set(source.match(/blob:nodedata:[a-zA-Z0-9-]+/g) || [])) {
        if (!urls.has(url)) {
          const blob = resolveObjectURL(url);
          if (!blob) throw new Error('A native rendition resource could not be resolved.');
          let data = Buffer.from(await blob.arrayBuffer());
          let mime = blob.type || 'application/octet-stream';
          if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
          else if (data[0] === 255 && data[1] === 216) mime = 'image/jpeg';
          else if (data.subarray(0, 3).toString() === 'GIF') mime = 'image/gif';
          const name = `r${resources.length}.${mime === 'text/css' ? 'css' : mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'bin'}`;
          urls.set(url, name); resources.push({ name, mime });
          if (mime === 'text/css' || mime === 'image/svg+xml') data = Buffer.from(await rewrite(data.toString()));
          add('OEBPS/' + name, data);
        }
        source = source.split(url).join(urls.get(url));
      }
      return source;
    };
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    add('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
    for (let i = 0; i < book.sections.length; i++) {
      const section = book.sections[i];
      if (workerData.verify && anchors.length < 200) {
        const doc = await section.createDocument();
        const { cfiPath } = require('./epub-cfi-path');
        const visit = node => {
          if (node.nodeType === 3 && node.textContent.trim() && anchors.length < 200) anchors.push({ cfi: `epubcfi(/6/${(i+1)*2}!${cfiPath(node, doc.documentElement)})`, text: node.textContent });
          else for (const child of Array.from(node.childNodes || [])) visit(child);
        };
        if (doc.querySelector('body')) visit(doc.querySelector('body'));
      }
      const url = await section.load();
      const blob = resolveObjectURL(url);
      const text = blob ? await blob.text() : xml(await section.createDocument());
      const doc = new DOMParser().parseFromString(text, 'text/html');
      doc.documentElement.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      add(`OEBPS/c${i}.xhtml`, await rewrite(xml(doc.documentElement)));
    }
    const sections = book.sections.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('');
    add('OEBPS/content.opf', `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">flyleaf-native</dc:identifier><dc:title>${esc(workerData.title || book.metadata?.title || 'Book')}</dc:title><dc:language>en</dc:language></metadata><manifest>${sections}${resources.map((r,i) => `<item id="r${i}" href="${r.name}" media-type="${r.mime}"/>`).join('')}</manifest><spine>${book.sections.map((_,i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`);
    return { data: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), anchors };
  } finally { book.destroy?.(); }
}
build().then(result => parentPort.postMessage(result), error => parentPort.postMessage({ error: error.message }));
