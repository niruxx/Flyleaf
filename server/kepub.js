'use strict';

// Generate a separate Kobo rendition. Originals (and their web CFIs/checksums)
// never change. The sidecar maps each native sentence span to its original CFI.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { parse, TextNode } = require('node-html-parser');
const config = require('./config');
const { cfiPath } = require('./epub-cfi-path');
const { decodeMarkup } = require('./epub-text');
const { prepareStyles, rewriteCss, localResource, relativeResource } = require('./kepub-css');
const jobs = new Map();
const elements = n => n.childNodes.filter(c => c.nodeType === 1);
const name = n => n.rawTagName?.split(':').pop().toLowerCase();
const find = (root, tag) => root.querySelectorAll('*').find(n => name(n) === tag);
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// pre is parsed as markup, not a raw-text element: <pre><code>…</code></pre>
// must retain its nested markup and exact whitespace.
const options = { comment: true, voidTag: { closingSlash: true }, blockTextElements: { script: true, style: true, textarea: true } };
const VERSION = 8;

async function rendition(book) {
  if (book.format !== 'epub') return null;
  const stat = await fs.stat(book.path);
  const key = crypto.createHash('sha256').update(JSON.stringify([VERSION, book.path, stat.size, stat.mtimeMs])).digest('hex');
  const root = path.join(config.cacheDir || path.join(config.dataDir, 'cache'), 'kepub');
  const file = path.join(root, key + '.kepub.epub');
  const sidecar = path.join(root, key + '.json');
  try {
    const data = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    const st = await fs.stat(file);
    return { ...data, file, size: st.size };
  } catch {}
  if (jobs.has(key)) return jobs.get(key);
  const job = (async () => {
    const zip = await JSZip.loadAsync(await fs.readFile(book.path));
    const styleSources = Object.keys(zip.files).filter(f => /\.css$/i.test(f) && !zip.files[f].dir);
    const xml = async p => {
      const entry = zip.file(p);
      if (!entry || entry._data.uncompressedSize > 16 * 1024 * 1024) throw new Error('Unreadable or oversized EPUB chapter');
      return parse(decodeMarkup(await entry.async('nodebuffer')), options);
    };
    const container = await xml('META-INF/container.xml');
    const opfPath = find(container, 'rootfile')?.getAttribute('full-path');
    if (!opfPath) throw new Error('EPUB has no package');
    const opf = await xml(opfPath), pkg = find(opf, 'package');
    const manifest = elements(pkg).find(n => name(n) === 'manifest');
    const spine = elements(pkg).find(n => name(n) === 'spine');
    let packageChanged = false;
    const declaredStyles = new Set();
    const itemIds = new Set(elements(manifest).map(n => n.getAttribute('id')));
    const coverId = find(pkg, 'metadata')?.querySelectorAll('*').find(n => name(n) === 'meta' && n.getAttribute('name') === 'cover')?.getAttribute('content') || 'cover';
    const cover = elements(manifest).find(n => n.getAttribute('id') === coverId && /^image\//.test(n.getAttribute('media-type') || ''));
    if (cover) {
      const properties = new Set((cover.getAttribute('properties') || '').split(/\s+/).filter(Boolean));
      if (!properties.has('cover-image')) { properties.add('cover-image'); cover.setAttribute('properties', [...properties].join(' ')); packageChanged = true; }
    }
    const fixedLayout = elements(pkg).find(n => name(n) === 'metadata')?.querySelectorAll('*').some(n =>
      name(n) === 'meta' && ((n.getAttribute('property') === 'rendition:layout' && n.text.trim() === 'pre-paginated') ||
        (n.getAttribute('name') === 'fixed-layout' && n.getAttribute('content') === 'true')));
    const spans = [], preserved = [], processed = new Set();
    for (const ref of elements(spine)) {
      const item = elements(manifest).find(i => i.getAttribute('id') === ref.getAttribute('idref'));
      if (item?.getAttribute('media-type') !== 'application/xhtml+xml') continue;
      const href = decodeURIComponent(item.getAttribute('href').split('#')[0]);
      const source = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), href));
      if (source.startsWith('../') || /^[a-z]+:|^\/|\\/i.test(href)) throw new Error('Invalid EPUB chapter path');
      if (processed.has(source)) continue;
      processed.add(source);
      const properties = (ref.getAttribute('properties') || '').split(/\s+/);
      if ((fixedLayout && !properties.includes('rendition:layout-reflowable')) || properties.includes('rendition:layout-pre-paginated')) {
        preserved.push({ source, reason: 'fixed-layout' });
        continue;
      }
      const doc = await xml(source), html = find(doc, 'html'), body = html && find(html, 'body');
      if (!body) throw new Error('EPUB chapter has no body');
      const prefix = html.rawTagName.includes(':') ? html.rawTagName.split(':')[0] + ':' : '';
      // Preserve existing span IDs and links in books already prepared for Kobo.
      const nativeIds = body.querySelectorAll('[id]').map(n => n.getAttribute('id')).filter(id => /^kobo\.\d+\.\d+$/.test(id));
      const texts = [];
      const visit = n => {
        if (['script', 'style', 'svg', 'math', 'textarea'].includes(name(n))) return;
        for (const child of n.childNodes) {
          if (child.nodeType === 3 && child.text.trim()) texts.push(child);
          else if (child.nodeType === 1) visit(child);
        }
      };
      visit(body);
      if (!texts.length) { preserved.push({ source, reason: 'non-text' }); continue; }
      const context = { root: html, body, key: source };
      const styles = await prepareStyles(zip, context, styleSources);
      for (const alias of styles.values()) {
        if (declaredStyles.has(alias)) continue;
        declaredStyles.add(alias);
        let id = 'flyleaf-css-' + crypto.createHash('sha256').update(alias).digest('hex').slice(0, 16);
        while (itemIds.has(id)) id += '-copy';
        itemIds.add(id);
        const itemPrefix = manifest.rawTagName.includes(':') ? manifest.rawTagName.split(':')[0] + ':' : '';
        const href = relativeResource(opfPath, alias);
        const item = parse(`<${itemPrefix}item id="${id}" href="${href}" media-type="text/css"/>`).firstChild;
        manifest.appendChild(item);
        packageChanged = true;
      }
      for (const link of html.querySelectorAll('*').filter(n => name(n) === 'link' && /(?:^|\s)stylesheet(?:\s|$)/i.test(n.getAttribute('rel') || ''))) {
        const alias = styles.get(localResource(source, link.getAttribute('href')));
        if (alias) link.setAttribute('href', relativeResource(source, alias));
      }
      for (const style of html.querySelectorAll('*').filter(n => name(n) === 'style')) {
        const css = style.innerHTML.replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, '$1');
        const rewritten = rewriteCss(css, source, styles, context).replace(/\]\]>/g, ']]]]><![CDATA[>');
        style.set_content(new TextNode(`<![CDATA[${rewritten}]]>`, style));
      }
      const base = cfiPath(ref, pkg);
      let index = nativeIds.reduce((max, id) => Math.max(max, Number(id.split('.')[1])), 0);
      // Gather paths before changing any child nodes.
      const replacements = texts.map(node => {
        const nodePath = cfiPath(node, html).replace(/:\d+$/, '');
        const chunkStart = Number(cfiPath(node, html).match(/:(\d+)$/)?.[1] || 0);
        let parent = node.parentNode, nativeId;
        while (parent && parent !== body) {
          const id = parent.getAttribute?.('id');
          if (/^kobo\.\d+\.\d+$/.test(id || '')) { nativeId = id; break; }
          parent = parent.parentNode;
        }
        if (nativeId) {
          spans.push({ source, id: nativeId, nodePath, base, start: chunkStart, end: chunkStart + node.text.length, cfi: `epubcfi(${base}!${cfiPath(node, html)})` });
          return null;
        }
        const segments = node.text.match(/[^.!?。！？]+[.!?。！？]*\s*|[.!?。！？]+\s*/gu) || [node.text];
        let offset = 0;
        const markup = segments.map(segment => {
          const id = `kobo.${++index}.1`;
          spans.push({ source, id, nodePath, base, start: chunkStart + offset, end: chunkStart + offset + segment.length,
            cfi: `epubcfi(${base}!${cfiPath(node, html, offset)})` });
          offset += segment.length;
          return `<${prefix}span class="koboSpan" id="${id}">${escape(segment)}</${prefix}span>`;
        }).join('');
        return { node, markup };
      });
      for (const { node, markup } of replacements.filter(Boolean)) {
        const parent = node.parentNode;
        const nodes = parse(markup).childNodes;
        for (const child of nodes) child.parentNode = parent;
        parent.childNodes.splice(parent.childNodes.indexOf(node), 1, ...nodes);
      }
      // Kobo's flow containers are only in the rendition; mapped CFIs continue
      // to address the original, unwrapped chapter.
      const content = body.innerHTML;
      if (!body.querySelector('#book-columns')) body.set_content(`<${prefix}div id="book-columns"><${prefix}div id="book-inner">${content}</${prefix}div></${prefix}div>`);
      zip.file(source, doc.toString().replace(/^(\s*<\?xml\b[^>]*\bencoding\s*=\s*)["'][^"']+["']/i, '$1"utf-8"'));
    }
    if (packageChanged) zip.file(opfPath, opf.toString().replace(/^(\s*<\?xml\b[^>]*\bencoding\s*=\s*)["'][^"']+["']/i, '$1"utf-8"'));
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    const mimetype = zip.files.mimetype;
    delete zip.files.mimetype;
    zip.files = { mimetype, ...zip.files };
    const data = { key, version: VERSION, spans, preserved };
    await fs.mkdir(root, { recursive: true });
    const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.part';
    try {
      await fs.writeFile(tmp, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
      await fs.rename(tmp, file);
      await fs.writeFile(sidecar, JSON.stringify(data));
    } finally { await fs.rm(tmp, { force: true }); }
    return { ...data, file, size: (await fs.stat(file)).size };
  })();
  jobs.set(key, job);
  try { return await job; } finally { jobs.delete(key); }
}

module.exports = { rendition, VERSION };
