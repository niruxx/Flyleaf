'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { readZipFile } = require('./archive');

// ---------------------------------------------------------------------------
// Tiny XML helpers – good enough for OPF and ComicInfo, which are simple.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = decodeXml(m[3] ?? m[4]);
  }
  return out;
}

/** All elements named `name` (namespace prefix optional) as {attrs, text}. */
function elements(xml, name) {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`, 'gi');
  return [...xml.matchAll(re)].map((m) => ({ attrs: attrs(m[1] || ''), text: m[2] != null ? decodeXml(m[2]) : '' }));
}

const first = (xml, name) => elements(xml, name)[0]?.text || null;

function stripHtml(s) {
  if (!s) return null;
  const text = decodeXml(s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

// ---------------------------------------------------------------------------
// Filenames

function titleFromFilename(file, isDir = false) {
  let base = path.basename(file);
  if (!isDir) base = base.replace(/\.[^.]+$/, '');
  return base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || base;
}

/** Guess a volume/chapter/issue number from a title. */
function numberFromTitle(title) {
  const tagged = title.match(/(?:\b(?:vol(?:ume)?|v|ch(?:apter)?|c|issue|book|part)\.?\s*|#)(\d+(?:\.\d+)?)/i);
  if (tagged) return Number(tagged[1]);
  const all = [...title.matchAll(/(\d+(?:\.\d+)?)/g)];
  if (!all.length) return null;
  const n = Number(all[all.length - 1][1]);
  // Ignore things that look like years.
  return n >= 1900 && n <= 2100 && all.length > 1 ? Number(all[all.length - 2][1]) : n;
}

// ---------------------------------------------------------------------------
// EPUB

async function epubMetadata(file) {
  const container = await readZipFile(file, 'META-INF/container.xml');
  if (!container) throw new Error('Missing container.xml');
  const rootfile = elements(container.toString('utf8'), 'rootfile')[0]?.attrs['full-path'];
  if (!rootfile) throw new Error('Missing rootfile');
  const opfBuf = await readZipFile(file, rootfile);
  if (!opfBuf) throw new Error('Missing OPF');
  const opf = opfBuf.toString('utf8');
  const opfDir = path.posix.dirname(rootfile);

  const metas = elements(opf, 'meta');
  const metaByName = (n) => metas.find((m) => m.attrs.name === n)?.attrs.content || null;
  const metaByProp = (p) => metas.find((m) => m.attrs.property === p)?.text || null;

  const creators = elements(opf, 'creator').map((c) => c.text).filter(Boolean);
  const series = metaByName('calibre:series') || metaByProp('belongs-to-collection');
  const seriesIndex = metaByName('calibre:series_index') || metaByProp('group-position');

  // Locate the cover image.
  const items = elements(opf, 'item').map((i) => i.attrs);
  const coverId = metaByName('cover');
  let coverItem =
    items.find((i) => (i.properties || '').split(/\s+/).includes('cover-image')) ||
    (coverId && items.find((i) => i.id === coverId)) ||
    items.find((i) => /image\//.test(i['media-type'] || '') && /cover/i.test(`${i.id} ${i.href}`));
  if (coverItem && !/image\//.test(coverItem['media-type'] || '')) coverItem = null;

  let cover = null;
  if (coverItem) {
    const href = decodeURIComponent(coverItem.href);
    const coverPath = opfDir === '.' ? href : path.posix.join(opfDir, href);
    cover = await readZipFile(file, path.posix.normalize(coverPath)).catch(() => null);
  }

  return {
    title: first(opf, 'title'),
    author: creators.join(', ') || null,
    description: stripHtml(first(opf, 'description')),
    series: series || null,
    seriesIndex: seriesIndex != null && seriesIndex !== '' ? Number(seriesIndex) : null,
    cover,
  };
}

// ---------------------------------------------------------------------------
// PDF (metadata + page count only; covers are rendered client-side)

let pdfjsPromise;
async function pdfMetadata(file) {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await pdfjsPromise;
  const data = new Uint8Array(await fsp.readFile(file));
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  try {
    const { info } = await doc.getMetadata().catch(() => ({ info: {} }));
    return {
      title: info?.Title?.trim() || null,
      author: info?.Author?.trim() || null,
      pageCount: doc.numPages,
    };
  } finally {
    await task.destroy();
  }
}

// ---------------------------------------------------------------------------
// ComicInfo.xml

function parseComicInfo(xml) {
  if (!xml) return {};
  const get = (n) => first(xml, n);
  const number = get('Number');
  const volume = get('Volume');
  const writers = [get('Writer'), get('Penciller')].filter(Boolean);
  return {
    title: get('Title'),
    series: get('Series'),
    seriesIndex: number != null && !Number.isNaN(Number(number)) ? Number(number) : volume ? Number(volume) : null,
    author: writers[0] || null,
    description: stripHtml(get('Summary')),
    manga: /^yes/i.test(get('Manga') || ''),
  };
}

module.exports = {
  titleFromFilename,
  numberFromTitle,
  epubMetadata,
  pdfMetadata,
  parseComicInfo,
};
