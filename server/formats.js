'use strict';

// Metadata for MOBI/AZW3, FB2, DOCX and RTF, plus TXT/DOCX/RTF → EPUB conversion
// so those books get the same paginated reader and annotations as EPUBs.

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
      isbn: require('./metadata').findIsbn(str(104)),
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const HEADING = /^\s*(?:chapter|part|book|prologue|epilogue|section|act)\b[^\n]{0,80}$|^\s*(?:[IVXLC]+|\d{1,3})\.?\s*$/i;

/** Group paragraphs into chapters at heading-like lines. `paras` are { text, html }. */
function chaptersFromParagraphs(paras) {
  const chapters = [];
  let cur = { title: null, html: [] };
  for (const p of paras) {
    if (HEADING.test(p.text) && p.text.trim().length < 90) {
      if (cur.html.length || cur.title) chapters.push(cur);
      cur = { title: p.text.trim(), html: [] };
    } else {
      cur.html.push(`<p>${p.html}</p>`);
    }
  }
  if (cur.html.length || cur.title) chapters.push(cur);
  // Fall back to fixed-size chunks when there are no recognisable headings.
  if (chapters.length <= 1) {
    const all = chapters[0]?.html || [];
    const out = [];
    for (let i = 0; i < all.length; i += 60) out.push({ title: `Part ${out.length + 1}`, html: all.slice(i, i + 60) });
    return out.length ? out.map((c) => ({ title: c.title, body: c.html.join('\n') })) : [{ title: 'Text', body: '' }];
  }
  return chapters.map((c, i) => {
    const title = c.title || `Part ${i + 1}`;
    return { title, body: `<h2>${esc(title)}</h2>\n${c.html.join('\n')}` };
  });
}

function splitTxt(text) {
  const paras = [];
  let buf = [];
  const flush = () => {
    if (buf.length) paras.push({ text: buf.join(' '), html: esc(buf.join(' ')) });
    buf = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (HEADING.test(line) && line.trim().length < 90) {
      flush();
      paras.push({ text: line.trim(), html: esc(line.trim()) });
    } else if (!line.trim()) flush();
    else buf.push(line.trim());
  }
  flush();
  return chaptersFromParagraphs(paras);
}

/**
 * Build an EPUB 3 from chapters [{ title, body (XHTML fragment) }] and
 * resources [{ name, data, mime }] (images referenced as "images/<name>").
 */
async function buildEpub({ id, title, author, language = 'en', chapters, resources = [] }) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  chapters.forEach((c, i) => {
    zip.file(`OEBPS/c${i}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(c.title)}</title><style>img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #8884;padding:4px}</style></head><body>${c.body}</body></html>`);
  });
  for (const r of resources) zip.file(`OEBPS/images/${r.name}`, r.data);
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map((c, i) => `<li><a href="c${i}.xhtml">${esc(c.title)}</a></li>`).join('')}</ol></nav></body></html>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">flyleaf-${id}</dc:identifier><dc:title>${esc(title)}</dc:title>${author ? `<dc:creator>${esc(author)}</dc:creator>` : ''}<dc:language>${esc(language)}</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}${resources.map((r, i) => `<item id="img${i}" href="images/${esc(r.name)}" media-type="${esc(r.mime)}"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
}

// ---------------------------------------------------------------------------
// DOCX → EPUB (mammoth keeps headings, lists, tables, emphasis and images)

async function docxChapters(file) {
  const mammoth = require('mammoth');
  const resources = [];
  const { value: html } = await mammoth.convertToHtml({ path: file }, {
    convertImage: mammoth.images.imgElement(async (image) => {
      const ext = (image.contentType.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '');
      const name = `img${resources.length}.${ext}`;
      resources.push({ name, data: await image.read(), mime: image.contentType });
      return { src: `images/${name}` };
    }),
  });
  // mammoth emits HTML; make it XHTML-safe (void elements must self-close).
  const xhtml = html.replace(/<(img|br|hr)([^>]*?)\s*\/?>/g, '<$1$2/>');
  // Split at top-level headings; fall back to one chapter.
  const parts = xhtml.split(/(?=<h[12][ >])/);
  const chapters = parts.filter((p) => p.trim()).map((body, i) => {
    const title = stripHtml(/^<h[12][^>]*>([\s\S]*?)<\/h[12]>/.exec(body)?.[1] || '') || `Part ${i + 1}`;
    return { title, body };
  });
  return { chapters: chapters.length ? chapters : [{ title: 'Document', body: xhtml }], resources };
}

/** Title and author from docProps/core.xml. */
async function docxMetadata(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(await fsp.readFile(file));
  const core = (await zip.file('docProps/core.xml')?.async('string')) || '';
  const tag = (t) => stripHtml(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(core)?.[1] || '') || null;
  return { title: tag('dc:title'), author: tag('dc:creator'), description: tag('dc:description'), language: tag('dc:language') };
}

// ---------------------------------------------------------------------------
// RTF → EPUB: a small RTF reader for paragraphs, bold/italic/underline,
// Unicode and code-page escapes, and the \info title/author.

const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'listtable', 'listoverridetable', 'revtbl', 'rsidtbl', 'generator',
  'pict', 'object', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'footnote', 'xmlnstbl',
  'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'mmathPr', 'pgdsctbl', 'fldinst', 'filetbl', 'nonshppict', 'shp']);

function parseRtf(src) {
  const paras = [];
  const info = {};
  let html = '';
  let text = '';
  let codepage = 1252;
  const stack = [];
  // Group-scoped state; `field` collects \info text such as {\title …}.
  let st = { b: false, i: false, u: false, skip: false, uc: 1, field: null };
  let pendingSkip = 0; // characters to drop after a \u escape
  const open = { b: false, i: false, u: false };
  const decoder = () => {
    try {
      return new TextDecoder(`windows-${codepage}`);
    } catch {
      return new TextDecoder('windows-1252');
    }
  };
  let bytes = [];
  const flushBytes = () => {
    if (!bytes.length) return;
    emit(decoder().decode(Uint8Array.from(bytes)));
    bytes = [];
  };
  const syncFormat = () => {
    let out = '';
    for (const k of ['u', 'i', 'b']) if (open[k] && !st[k]) { out += `</${k}>`; open[k] = false; }
    for (const k of ['b', 'i', 'u']) if (!open[k] && st[k]) { out += `<${k}>`; open[k] = true; }
    html += out;
  };
  function emit(s) {
    if (pendingSkip > 0) {
      const drop = Math.min(pendingSkip, s.length);
      s = s.slice(drop);
      pendingSkip -= drop;
    }
    if (!s) return;
    if (st.field) {
      info[st.field] = (info[st.field] || '') + s;
      return;
    }
    if (st.skip) return;
    syncFormat();
    html += esc(s);
    text += s;
  }
  const endPara = () => {
    flushBytes();
    for (const k of ['u', 'i', 'b']) if (open[k]) { html += `</${k}>`; open[k] = false; }
    if (text.trim()) paras.push({ text: text.trim(), html: html.trim() });
    html = '';
    text = '';
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') {
      flushBytes();
      stack.push(st);
      st = { ...st };
      i++;
      // {\*\destination ...} groups are optional extensions we don't understand.
      if (src.startsWith('\\*', i)) st.skip = true;
    } else if (c === '}') {
      flushBytes();
      st = stack.pop() || st;
      i++;
    } else if (c === '\\') {
      const next = src[i + 1];
      if (next === "'") {
        bytes.push(parseInt(src.substr(i + 2, 2), 16));
        i += 4;
        continue;
      }
      flushBytes();
      if (next === '\\' || next === '{' || next === '}') {
        emit(next);
        i += 2;
        continue;
      }
      if (next === '~') { emit('\u00a0'); i += 2; continue; }
      if (next === '-' || next === '_') { i += 2; continue; }
      if (next === '\n' || next === '\r') { endPara(); i += 2; continue; }
      const m = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(src.slice(i + 1, i + 50));
      if (!m) { i += 2; continue; }
      i += 1 + m[0].length;
      const word = m[1];
      const arg = m[2] != null ? Number(m[2]) : null;
      if (RTF_SKIP.has(word) || word === 'info') st.skip = true;
      else if (word === 'title' || word === 'author' || word === 'subject') st.field = word;
      switch (word) {
        case 'par': case 'sect': case 'page': endPara(); break;
        case 'line': if (!st.skip) { syncFormat(); html += '<br/>'; text += ' '; } break;
        case 'tab': emit(' '); break;
        case 'emdash': emit('—'); break;
        case 'endash': emit('–'); break;
        case 'lquote': emit('‘'); break;
        case 'rquote': emit('’'); break;
        case 'ldblquote': emit('“'); break;
        case 'rdblquote': emit('”'); break;
        case 'bullet': emit('•'); break;
        case 'b': st.b = arg !== 0; break;
        case 'i': st.i = arg !== 0; break;
        case 'ul': st.u = arg !== 0; break;
        case 'ulnone': st.u = false; break;
        case 'plain': st.b = st.i = st.u = false; break;
        case 'ansicpg': codepage = arg || 1252; break;
        case 'uc': st.uc = arg ?? 1; break;
        case 'u': emit(String.fromCodePoint(arg < 0 ? arg + 65536 : arg)); pendingSkip = st.uc; break;
        default: break;
      }
    } else if (c === '\r' || c === '\n') {
      i++;
    } else {
      // Plain run of text up to the next control character.
      let j = i;
      while (j < src.length && !'\\{}\r\n'.includes(src[j])) j++;
      flushBytes();
      emit(src.slice(i, j));
      i = j;
    }
  }
  endPara();
  const field = (k) => info[k]?.trim() || null;
  return { paras, title: field('title'), author: field('author'), description: field('subject') };
}

async function rtfDocument(file) {
  // RTF is 7-bit; latin1 keeps every byte as-is for the parser.
  return parseRtf((await fsp.readFile(file)).toString('latin1'));
}

async function rtfMetadata(file) {
  const { title, author, description } = await rtfDocument(file);
  return { title, author, description };
}

// ---------------------------------------------------------------------------
// Cached conversion to EPUB for TXT / DOCX / RTF

const convertJobs = new Map();
const CONVERTIBLE = new Set(['txt', 'docx', 'rtf']);

/** Returns the path of a cached EPUB generated from a TXT, DOCX or RTF file. */
async function toEpub(file, format, title) {
  if (!CONVERTIBLE.has(format)) throw new Error(`Can't convert ${format} to EPUB`);
  const stat = await fsp.stat(file);
  const hash = crypto.createHash('sha1').update(`v2:${file}:${stat.mtimeMs}`).digest('hex').slice(0, 20);
  const out = path.join(config.cacheDir, 'converted', `${hash}.epub`);
  if (fs.existsSync(out)) return out;
  if (convertJobs.has(out)) return convertJobs.get(out);
  const job = (async () => {
    const fallbackTitle = title || path.basename(file, path.extname(file));
    let doc;
    if (format === 'txt') {
      doc = { chapters: splitTxt(decodeText(await fsp.readFile(file))), title: fallbackTitle };
    } else if (format === 'docx') {
      const [{ chapters, resources }, m] = await Promise.all([docxChapters(file), docxMetadata(file).catch(() => ({}))]);
      doc = { chapters, resources, title: title || m.title || fallbackTitle, author: m.author, language: m.language || 'en' };
    } else {
      const r = await rtfDocument(file);
      doc = { chapters: chaptersFromParagraphs(r.paras), title: title || r.title || fallbackTitle, author: r.author };
    }
    const buffer = await buildEpub({ id: hash, ...doc });
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.tmp`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, out);
    return out;
  })();
  convertJobs.set(out, job);
  try {
    return await job;
  } finally {
    convertJobs.delete(out);
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

module.exports = { mobiMetadata, fb2Metadata, toEpub, CONVERTIBLE, txtMetadata, docxMetadata, rtfMetadata, parseRtf };
