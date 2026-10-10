'use strict';

// Metadata for MOBI/AZW3 and FB2, plus TXT → EPUB conversion so plain text
// books get the same paginated reader and annotations as EPUBs.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { stripHtml } = require('./util');

// ---------------------------------------------------------------------------
// MOBI / AZW / AZW3 (KF8 shares the same PDB + EXTH headers)

async function mobiMetadata(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const read = async (pos, len) => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return buf.subarray(0, bytesRead);
    };
    const head = await read(0, 78);
    if (head.toString('latin1', 60, 68) !== 'BOOKMOBI') throw new Error('Not a MOBI file');
    const count = head.readUInt16BE(76);
    const table = await read(78, count * 8);
    const offsets = [];
    for (let i = 0; i < count; i++) offsets.push(table.readUInt32BE(i * 8));
    const { size } = await fh.stat();
    const recordBytes = (i) => read(offsets[i], (offsets[i + 1] ?? size) - offsets[i]);

    const r0 = await recordBytes(0);
    if (r0.toString('latin1', 16, 20) !== 'MOBI') throw new Error('Missing MOBI header');
    const headerLen = r0.readUInt32BE(20);
    const encoding = r0.readUInt32BE(28) === 65001 ? 'utf8' : 'latin1';
    const fullName = r0.toString(encoding, r0.readUInt32BE(84), r0.readUInt32BE(84) + r0.readUInt32BE(88));
    const firstImage = r0.readUInt32BE(108);
    const hasExth = (r0.readUInt32BE(128) & 0x40) !== 0;

    const exth = {};
    if (hasExth) {
      let p = 16 + headerLen;
      if (r0.toString('latin1', p, p + 4) === 'EXTH') {
        const n = r0.readUInt32BE(p + 8);
        p += 12;
        for (let i = 0; i < n && p + 8 <= r0.length; i++) {
          const type = r0.readUInt32BE(p);
          const len = r0.readUInt32BE(p + 4);
          const data = r0.subarray(p + 8, p + len);
          (exth[type] ||= []).push(data);
          p += len;
        }
      }
    }
    const str = (t) => exth[t]?.map((d) => d.toString(encoding).trim()).filter(Boolean) || [];

    let cover = null;
    const coverOffset = exth[201]?.[0]?.readUInt32BE(0);
    if (coverOffset != null && coverOffset !== 0xffffffff && firstImage + coverOffset < count) {
      cover = await recordBytes(firstImage + coverOffset);
    }
    const date = str(106)[0];
    return {
      title: str(503)[0] || fullName || null,
      author: str(100).join(', ') || null,
      authors: str(100),
      publisher: str(101)[0] || null,
      description: stripHtml(str(103)[0]),
      subjects: str(105),
      year: date ? Number(date.slice(0, 4)) || null : null,
      language: str(524)[0] || null,
      cover,
    };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// FB2 (FictionBook XML)

async function fb2Metadata(file) {
  const xml = (await fsp.readFile(file)).toString('utf8');
  const info = xml.match(/<title-info>([\s\S]*?)<\/title-info>/)?.[1] || '';
  const tag = (src, name) => src.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1];
  const authors = [...info.matchAll(/<author>([\s\S]*?)<\/author>/g)].map((m) =>
    [tag(m[1], 'first-name'), tag(m[1], 'middle-name'), tag(m[1], 'last-name')].filter(Boolean).join(' ').trim(),
  ).filter(Boolean);
  const seq = info.match(/<sequence\s+name="([^"]+)"(?:\s+number="([^"]+)")?/);
  let cover = null;
  const coverHref = info.match(/<coverpage>[\s\S]*?href="#([^"]+)"/)?.[1];
  if (coverHref) {
    const bin = xml.match(new RegExp(`<binary[^>]*id="${coverHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([\\s\\S]*?)</binary>`));
    if (bin) cover = Buffer.from(bin[1].replace(/\s+/g, ''), 'base64');
  }
  return {
    title: stripHtml(tag(info, 'book-title')),
    author: authors.join(', ') || null,
    authors,
    description: stripHtml(tag(info, 'annotation')),
    subjects: [...info.matchAll(/<genre>([^<]+)<\/genre>/g)].map((m) => m[1]),
    series: seq?.[1] || null,
    seriesIndex: seq?.[2] ? Number(seq[2]) : null,
    language: stripHtml(tag(info, 'lang')),
    cover,
  };
}

// ---------------------------------------------------------------------------
// TXT → EPUB

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HEADING = /^\s*(?:chapter|part|book|prologue|epilogue|section|act)\b[^\n]{0,80}$|^\s*(?:[IVXLC]+|\d{1,3})\.?\s*$/i;

function splitChapters(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let cur = { title: null, paras: [], buf: [] };
  const flush = () => {
    if (cur.buf.length) cur.paras.push(cur.buf.join(' '));
    cur.buf = [];
  };
  for (const line of lines) {
    if (HEADING.test(line) && line.trim().length < 90) {
      flush();
      if (cur.paras.length || cur.title) chapters.push(cur);
      cur = { title: line.trim(), paras: [], buf: [] };
    } else if (!line.trim()) {
      flush();
    } else {
      cur.buf.push(line.trim());
    }
  }
  flush();
  if (cur.paras.length || cur.title) chapters.push(cur);
  // Fall back to fixed-size chunks when there are no recognisable headings.
  if (chapters.length <= 1) {
    const paras = chapters[0]?.paras || [];
    const out = [];
    for (let i = 0; i < paras.length; i += 60) out.push({ title: `Part ${out.length + 1}`, paras: paras.slice(i, i + 60) });
    return out.length ? out : [{ title: 'Text', paras: [] }];
  }
  return chapters.map((c, i) => ({ ...c, title: c.title || `Part ${i + 1}` }));
}

const txtJobs = new Map();

/** Returns the path of a cached EPUB generated from a .txt file. */
async function txtToEpub(file, title) {
  const stat = await fsp.stat(file);
  const hash = crypto.createHash('sha1').update(`${file}:${stat.mtimeMs}`).digest('hex').slice(0, 20);
  const out = path.join(config.cacheDir, 'txt', `${hash}.epub`);
  if (fs.existsSync(out)) return out;
  if (txtJobs.has(out)) return txtJobs.get(out);
  const job = (async () => {
    const JSZip = require('jszip');
    const text = decodeText(await fsp.readFile(file));
    const chapters = splitChapters(text);
    const zip = new JSZip();
    const t = esc(title || path.basename(file, path.extname(file)));
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    chapters.forEach((c, i) => {
      zip.file(`OEBPS/c${i}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(c.title)}</title></head><body><h2>${esc(c.title)}</h2>${c.paras.map((p) => `<p>${esc(p)}</p>`).join('\n')}</body></html>`);
    });
    zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map((c, i) => `<li><a href="c${i}.xhtml">${esc(c.title)}</a></li>`).join('')}</ol></nav></body></html>`);
    zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">flyleaf-${hash}</dc:identifier><dc:title>${t}</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.tmp`;
    await fsp.writeFile(tmp, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' }));
    await fsp.rename(tmp, out);
    return out;
  })();
  txtJobs.set(out, job);
  try {
    return await job;
  } finally {
    txtJobs.delete(out);
  }
}

async function txtMetadata(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, 4096, 0);
    const head = decodeText(buf.subarray(0, bytesRead));
    // Project Gutenberg style headers.
    const title = head.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    const author = head.match(/^Author:\s*(.+)$/m)?.[1]?.trim();
    return { title: title || null, author: author || null };
  } finally {
    await fh.close();
  }
}

module.exports = { mobiMetadata, fb2Metadata, txtToEpub, txtMetadata };
