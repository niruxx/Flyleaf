'use strict';

// Full-text search of what's inside the books (SQLite FTS5).
//
// Each chapter of an EPUB-type book (EPUB, and TXT/DOCX/RTF through their converted EPUB) and
// each FB2 section or PDF page is one row of book_text. Indexing runs in the background after
// scans, one book at a time; a book is indexed again when its file changes. Comics are images
// and MOBI/AZW3 aren't indexed. Set FULLTEXT=0 to turn it off.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { q, tx } = require('./db');
const { readZipFile } = require('./archive');
const { elements, decodeXml } = require('./metadata');
const { quietly } = require('./log');
const log = require('./log').logger('fulltext');

const ENABLED = process.env.FULLTEXT !== '0';
const FORMATS = ['epub', 'txt', 'docx', 'rtf', 'fb2', 'pdf'];
const MAX_CHARS = 6_000_000; // per book; beyond that the rest isn't indexed
const state = { running: false, done: 0, total: 0, current: null };

/** Markup → plain text, keeping paragraph breaks as spaces. */
function plain(html) {
  return decodeXml(
    String(html)
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|h\d|li|tr|section|blockquote)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** Chapters of an EPUB in reading order: [{ section: href, label, text }]. */
async function epubSections(file) {
  const container = await readZipFile(file, 'META-INF/container.xml');
  const rootfile = container && elements(container.toString('utf8'), 'rootfile')[0]?.attrs['full-path'];
  if (!rootfile) throw new Error('Not a readable EPUB');
  const opf = (await readZipFile(file, rootfile)).toString('utf8');
  const dir = path.posix.dirname(rootfile);
  const items = new Map(elements(opf, 'item').map((i) => [i.attrs.id, i.attrs]));
  const out = [];
  let chars = 0;
  for (const ref of elements(opf, 'itemref')) {
    const item = items.get(ref.attrs.idref);
    if (!item || !/html|xml/.test(item['media-type'] || '')) continue;
    const href = decodeURIComponent(item.href);
    const full = path.posix.normalize(dir === '.' ? href : path.posix.join(dir, href));
    const buf = await readZipFile(file, full).catch(() => null);
    if (!buf) continue;
    const html = buf.toString('utf8');
    const text = plain(html.replace(/^[\s\S]*?<body[^>]*>/i, ''));
    if (!text) continue;
    // A heading makes a better label than the file name.
    const heading = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    // The path inside the EPUB, which is how the reader (foliate) finds a chapter.
    out.push({ section: full, label: heading ? plain(heading).slice(0, 120) : `Section ${out.length + 1}`, text });
    chars += text.length;
    if (chars > MAX_CHARS) break;
  }
  return out;
}

async function fb2Sections(file) {
  const xml = (await fsp.readFile(file)).toString('utf8');
  const body = xml.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1] || '';
  const parts = body.split(/<section\b[^>]*>/).slice(1);
  return (parts.length ? parts : [body]).map((s, i) => {
    const title = s.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    return { section: String(i), label: title ? plain(title).slice(0, 120) : `Section ${i + 1}`, text: plain(s) };
  }).filter((s) => s.text);
}

let pdfjsPromise;
async function pdfSections(file) {
  pdfjsPromise ??= quietly(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
  const pdfjs = await pdfjsPromise;
  const data = new Uint8Array(await fsp.readFile(file));
  return quietly(async () => {
    const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
    const doc = await task.promise;
    const out = [];
    try {
      let chars = 0;
      for (let i = 1; i <= doc.numPages && chars < MAX_CHARS; i++) {
        const page = await doc.getPage(i);
        const text = (await page.getTextContent()).items.map((t) => t.str).join(' ').replace(/\s+/g, ' ').trim();
        page.cleanup();
        if (text) out.push({ section: String(i - 1), label: `Page ${i}`, text });
        chars += text.length;
      }
    } finally {
      await task.destroy();
    }
    return out;
  });
}

async function sectionsOf(book) {
  if (book.format === 'epub') return epubSections(book.path);
  if (['txt', 'docx', 'rtf'].includes(book.format)) {
    // The same converted EPUB the reader opens, so hrefs match.
    const epub = await require('./formats').toEpub(book.path, book.format, book.title);
    return epubSections(epub);
  }
  if (book.format === 'fb2') return fb2Sections(book.path);
  if (book.format === 'pdf') return pdfSections(book.path);
  return [];
}

async function indexBook(book) {
  let sections = [];
  let error = null;
  try {
    sections = await sectionsOf(book);
  } catch (e) {
    error = String(e.message || e).slice(0, 300);
  }
  tx(() => {
    q('DELETE FROM book_text WHERE book_id = ?').run(book.id);
    for (const s of sections) q('INSERT INTO book_text (text, book_id, section, label) VALUES (?, ?, ?, ?)').run(s.text, book.id, s.section, s.label);
    q(`INSERT INTO book_text_state (book_id, mtime, sections, chars, error, indexed_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (book_id) DO UPDATE SET mtime = excluded.mtime, sections = excluded.sections, chars = excluded.chars, error = excluded.error, indexed_at = excluded.indexed_at`)
      .run(book.id, book.mtime, sections.length, sections.reduce((a, s) => a + s.text.length, 0), error, Date.now());
  });
}

const PENDING_SQL = `FROM books b LEFT JOIN book_text_state t ON t.book_id = b.id
                     WHERE b.missing = 0 AND b.format IN (${FORMATS.map(() => '?').join(',')}) AND (t.book_id IS NULL OR t.mtime IS NOT b.mtime)`;

/** Index every book that's new or changed. Runs one at a time; safe to call often. */
async function indexPending() {
  if (!ENABLED || state.running) return;
  state.running = true;
  try {
    // Rows of deleted books (FTS tables have no foreign keys).
    q('DELETE FROM book_text WHERE book_id NOT IN (SELECT id FROM books)').run();
    const books = q(`SELECT b.* ${PENDING_SQL} ORDER BY b.id`).all(...FORMATS);
    Object.assign(state, { done: 0, total: books.length });
    const started = Date.now();
    for (const book of books) {
      state.current = book.title;
      await indexBook(book);
      state.done++;
      // Let requests through between books.
      await new Promise((r) => setImmediate(r));
    }
    if (books.length) log.file(`Indexed ${books.length} books in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (e) {
    log.warn(`Indexing stopped: ${e.message}`);
  } finally {
    Object.assign(state, { running: false, current: null });
  }
}

function status() {
  return {
    enabled: ENABLED,
    running: state.running,
    done: state.done,
    total: state.total,
    indexed: q('SELECT COUNT(*) AS n FROM book_text_state WHERE error IS NULL AND sections > 0').get().n,
    pending: ENABLED ? q(`SELECT COUNT(*) AS n ${PENDING_SQL}`).get(...FORMATS).n : 0,
  };
}

/** Turn what someone typed into an FTS5 query: words are prefix-matched, "quoted phrases" kept. */
function ftsQuery(input) {
  const parts = [];
  for (const m of String(input).matchAll(/"([^"]+)"|(\S+)/g)) {
    if (m[1]) parts.push(`"${m[1].replace(/"/g, '')}"`);
    else {
      const word = m[2].replace(/["*^():{}\[\]]/g, '').replace(/^-+/, '');
      if (word && !/^(AND|OR|NOT|NEAR)$/i.test(word)) parts.push(`"${word}"*`);
    }
  }
  return parts.slice(0, 12).join(' ');
}

/**
 * Search inside books the user can see. Returns books (best match first), each with up to
 * three matching sections and a snippet marked with \u0001 … \u0002 around the matches.
 */
function search(user, input, { limit = 20 } = {}) {
  const match = ftsQuery(input);
  if (!match) return [];
  const { getBook, toBook } = require('./serialize');
  let rows;
  try {
    rows = q(`SELECT book_id, section, label, snippet(book_text, 0, char(1), char(2), '…', 14) AS snippet, bm25(book_text) AS rank
              FROM book_text WHERE book_text MATCH ? ORDER BY rank LIMIT 600`).all(match);
  } catch {
    return [];
  }
  const out = new Map();
  for (const r of rows) {
    let entry = out.get(r.book_id);
    if (!entry) {
      if (out.size >= limit) continue;
      const row = getBook(r.book_id, user);
      if (!row) {
        out.set(r.book_id, null);
        continue;
      }
      entry = { book: toBook(row, false, user), hits: [], total: 0 };
      out.set(r.book_id, entry);
    }
    if (!entry) continue;
    entry.total++;
    if (entry.hits.length < 3) entry.hits.push({ section: r.section, label: r.label, snippet: r.snippet });
  }
  return [...out.values()].filter(Boolean);
}

/** Forget a book's text (e.g. before rebuilding everything). */
function reset() {
  tx(() => {
    q('DELETE FROM book_text').run();
    q('DELETE FROM book_text_state').run();
  });
}

module.exports = { indexPending, status, search, reset, FORMATS, ENABLED };
