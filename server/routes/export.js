'use strict';

// Exporting highlights, notes and bookmarks: Markdown (one file), CSV, a Readwise CSV
// (readwise.io/import_bulk), an Obsidian vault folder (one note per book, zipped), or sent
// straight to Readwise with the user's access token (readwise.io/access_token).

const express = require('express');
const { q } = require('../db');
const { getBook } = require('../serialize');

const router = express.Router();
const READWISE_URL = 'https://readwise.io/api/v2/highlights/';

/** Your annotations grouped by book, each book's in reading order. */
function collect(user, { bookId, kinds = ['highlight', 'bookmark'] } = {}) {
  const rows = q(`SELECT * FROM annotations WHERE user_id = ? AND kind IN (${kinds.map(() => '?').join(',')}) ${bookId ? 'AND book_id = ?' : ''}
                  ORDER BY book_id, COALESCE(percent, page / 1e6, 0), created_at`).all(user.id, ...kinds, ...(bookId ? [Number(bookId)] : []));
  const books = new Map();
  for (const a of rows) {
    if (!books.has(a.book_id)) {
      const b = getBook(a.book_id, user);
      if (!b) continue;
      books.set(a.book_id, {
        id: b.id,
        title: b.title,
        author: b.author || null,
        series: b.series_name && b.series_name !== b.title ? b.series_name : null,
        format: b.format,
        items: [],
      });
    }
    books.get(a.book_id)?.items.push(a);
  }
  return [...books.values()].sort((x, y) => (x.series || x.title).localeCompare(y.series || y.title, undefined, { numeric: true, sensitivity: 'base' }));
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const where = (a) => [a.chapter, a.page != null ? `page ${a.page + 1}` : null, a.percent != null && a.page == null ? `${Math.round(a.percent * 100)}%` : null].filter(Boolean).join(' · ');
const displayTitle = (b) => (b.series ? `${b.series} – ${b.title}` : b.title);
const quote = (text) => String(text || '').trim().split(/\r?\n/).map((l) => `> ${l}`).join('\n');
const fileName = (s) => String(s).replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';

function markdown(books) {
  const out = [`# Highlights & notes`, '', `Exported from Flyleaf on ${day(Date.now())}.`, ''];
  for (const b of books) {
    out.push(`## ${displayTitle(b)}${b.author ? ` — ${b.author}` : ''}`, '');
    for (const a of b.items) {
      if (a.kind === 'bookmark') {
        out.push(`- 🔖 Bookmark${where(a) ? ` · ${where(a)}` : ''}${a.note ? ` — ${a.note}` : ''}`, '');
        continue;
      }
      out.push(quote(a.text), '');
      if (a.note) out.push(`**Note:** ${a.note.trim()}`, '');
      out.push(`<sub>${[where(a), a.color && a.color !== 'yellow' ? a.color : null, day(a.created_at)].filter(Boolean).join(' · ')}</sub>`, '');
    }
  }
  return out.join('\n');
}

const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvLine = (values) => values.map(cell).join(',');

function csv(books) {
  const lines = [csvLine(['Book', 'Series', 'Author', 'Type', 'Chapter', 'Page', 'Percent', 'Colour', 'Text', 'Note', 'Created'])];
  for (const b of books) {
    for (const a of b.items) {
      lines.push(csvLine([b.title, b.series, b.author, a.kind, a.chapter, a.page != null ? a.page + 1 : '', a.percent != null ? Math.round(a.percent * 1000) / 10 : '', a.color, a.text, a.note, new Date(a.created_at).toISOString()]));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Readwise's CSV import: Highlight, Title, Author, URL, Note, Location, Date. */
function readwiseCsv(books) {
  const lines = [csvLine(['Highlight', 'Title', 'Author', 'URL', 'Note', 'Location', 'Date'])];
  for (const b of books) {
    b.items.filter((a) => a.kind === 'highlight' && a.text).forEach((a, i) => {
      lines.push(csvLine([a.text, displayTitle(b), b.author, '', a.note, a.page != null ? a.page + 1 : i + 1, new Date(a.created_at).toISOString().replace('T', ' ').slice(0, 19)]));
    });
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** One Obsidian note: YAML front matter, then the highlights with block ids to link to. */
function obsidianNote(b) {
  const yaml = (s) => JSON.stringify(String(s ?? ''));
  const out = [
    '---',
    `title: ${yaml(b.title)}`,
    b.author ? `author: ${yaml(`[[${b.author}]]`)}` : null,
    b.series ? `series: ${yaml(b.series)}` : null,
    `format: ${b.format}`,
    'source: Flyleaf',
    `exported: ${day(Date.now())}`,
    'tags:',
    '  - book',
    '  - highlights',
    '---',
    '',
    `# ${displayTitle(b)}`,
    '',
  ].filter((l) => l !== null);
  let chapter = null;
  for (const a of b.items) {
    if (a.chapter && a.chapter !== chapter) {
      chapter = a.chapter;
      out.push(`## ${chapter}`, '');
    }
    if (a.kind === 'bookmark') {
      out.push(`- [ ] 🔖 ${where(a) || 'Bookmark'}${a.note ? ` — ${a.note}` : ''}`, '');
      continue;
    }
    out.push(`${quote(a.text)} ^fl-${a.id}`, '');
    if (a.note) out.push(`- **Note:** ${a.note.trim()}`, '');
  }
  return out.join('\n');
}

router.get('/annotations/export', async (req, res) => {
  const format = String(req.query.format || 'markdown');
  const books = collect(req.user, { bookId: req.query.book, kinds: format === 'readwise' ? ['highlight'] : ['highlight', 'bookmark'] });
  if (!books.length) return res.status(404).json({ error: 'You have no highlights or notes to export yet.' });
  const stamp = day(Date.now());
  const base = req.query.book ? fileName(displayTitle(books[0])) : `Flyleaf highlights ${stamp}`;
  if (format === 'markdown') return res.attachment(`${base}.md`).type('text/markdown').send(markdown(books));
  if (format === 'csv') return res.attachment(`${base}.csv`).type('text/csv').send(`﻿${csv(books)}`);
  if (format === 'readwise') return res.attachment(`${base} (Readwise).csv`).type('text/csv').send(`﻿${readwiseCsv(books)}`);
  if (format === 'obsidian') {
    // A folder of notes, one per book, ready to drop into a vault.
    const { ZipArchive } = require('archiver');
    const zip = new ZipArchive({ zlib: { level: 6 } });
    res.attachment(`${base} (Obsidian).zip`).type('application/zip');
    zip.on('error', () => res.destroy());
    zip.pipe(res);
    const used = new Set();
    for (const b of books) {
      let name = fileName(displayTitle(b));
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${fileName(displayTitle(b))} ${n}`;
      used.add(name.toLowerCase());
      zip.append(obsidianNote(b), { name: `Flyleaf/${name}.md` });
    }
    await zip.finalize();
    return;
  }
  res.status(400).json({ error: 'Unknown export format.' });
});

/** Send highlights to Readwise: { token, book? }. Readwise skips ones it already has. */
router.post('/annotations/readwise', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!/^[A-Za-z0-9]{20,100}$/.test(token)) return res.status(400).json({ error: 'Paste your Readwise access token (readwise.io/access_token).' });
  const books = collect(req.user, { bookId: req.body?.book, kinds: ['highlight'] });
  const highlights = books.flatMap((b) => b.items.filter((a) => a.text).map((a, i) => ({
    text: a.text.slice(0, 8191),
    title: displayTitle(b).slice(0, 511),
    author: b.author ? b.author.slice(0, 1024) : undefined,
    source_type: 'flyleaf',
    category: 'books',
    note: a.note ? a.note.slice(0, 8191) : undefined,
    location: a.page != null ? a.page + 1 : i + 1,
    location_type: a.page != null ? 'page' : 'order',
    highlighted_at: new Date(a.created_at).toISOString(),
  })));
  if (!highlights.length) return res.status(404).json({ error: 'You have no highlights to send yet.' });
  let sent = 0;
  for (let i = 0; i < highlights.length; i += 100) {
    let r;
    try {
      r = await fetch(READWISE_URL, {
        method: 'POST',
        headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ highlights: highlights.slice(i, i + 100) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      return res.status(502).json({ error: `Couldn’t reach Readwise: ${e.message}`, sent });
    }
    if (r.status === 401 || r.status === 403) return res.status(400).json({ error: 'Readwise didn’t accept that token. Copy it again from readwise.io/access_token.', sent });
    if (!r.ok) return res.status(502).json({ error: `Readwise said ${r.status}: ${(await r.text()).slice(0, 200)}`, sent });
    sent += Math.min(100, highlights.length - i);
  }
  res.json({ sent, books: books.length });
});

module.exports = { router };
