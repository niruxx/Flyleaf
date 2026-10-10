'use strict';

const express = require('express');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { q, tx } = require('../db');
const { requireAdmin } = require('../auth');
const archive = require('../archive');
const scanner = require('../scanner');
const covers = require('../covers');

const router = express.Router();

const KINDS = ['books', 'manga', 'comics'];
const FILE_MIME = { epub: 'application/epub+zip', pdf: 'application/pdf' };

// ---------------------------------------------------------------------------
// Serialisation

function toBook(row, detail = false) {
  const b = {
    id: row.id,
    libraryId: row.library_id,
    kind: row.kind,
    format: row.format,
    title: row.title,
    author: row.author,
    series: row.series,
    seriesIndex: row.series_index,
    pageCount: row.page_count,
    addedAt: row.added_at,
    coverUrl: row.cover ? `/api/books/${row.id}/cover?v=${row.updated_at}` : null,
    version: row.mtime,
    progress:
      row.p_updated_at != null
        ? { percent: row.p_percent, page: row.p_page, finished: Boolean(row.p_finished), updatedAt: row.p_updated_at }
        : null,
  };
  if (detail) {
    Object.assign(b, {
      description: row.description,
      size: row.size,
      relPath: row.rel_path,
      metaLocked: Boolean(row.meta_locked),
      missing: Boolean(row.missing),
    });
    if (b.progress) {
      b.progress.position = row.p_position;
      b.progress.settings = row.p_settings ? JSON.parse(row.p_settings) : null;
    }
  }
  return b;
}

const BOOK_SELECT = `
  SELECT b.*, l.kind,
    p.percent AS p_percent, p.page AS p_page, p.finished AS p_finished, p.updated_at AS p_updated_at,
    p.position AS p_position, p.settings AS p_settings
  FROM books b
  JOIN libraries l ON l.id = b.library_id
  LEFT JOIN progress p ON p.book_id = b.id AND p.user_id = ?`;

function getBook(id, userId) {
  return q(`${BOOK_SELECT} WHERE b.id = ?`).get(userId, Number(id));
}

function libraryRow(l) {
  return {
    id: l.id,
    name: l.name,
    path: l.path,
    kind: l.kind,
    lastScanAt: l.last_scan_at,
    bookCount: l.book_count,
    seriesCount: l.series_count,
  };
}

const LIB_SELECT = `
  SELECT l.*,
    (SELECT COUNT(*) FROM books b WHERE b.library_id = l.id AND b.missing = 0) AS book_count,
    (SELECT COUNT(DISTINCT series) FROM books b WHERE b.library_id = l.id AND b.missing = 0 AND series IS NOT NULL) AS series_count
  FROM libraries l`;

// ---------------------------------------------------------------------------
// Home

router.get('/home', (req, res) => {
  const uid = req.user.id;
  const cont = q(`${BOOK_SELECT} WHERE b.missing = 0 AND p.finished = 0 AND p.updated_at IS NOT NULL
                  ORDER BY p.updated_at DESC LIMIT 20`).all(uid);
  const recent = q(`${BOOK_SELECT} WHERE b.missing = 0 ORDER BY b.added_at DESC, b.id DESC LIMIT 24`).all(uid);
  const libraries = q(`${LIB_SELECT} ORDER BY l.name COLLATE NOCASE`).all();
  res.json({
    continueReading: cont.map((r) => toBook(r)),
    recentlyAdded: recent.map((r) => toBook(r)),
    libraries: libraries.map(libraryRow),
  });
});

// ---------------------------------------------------------------------------
// Libraries

router.get('/libraries', (req, res) => {
  res.json(q(`${LIB_SELECT} ORDER BY l.name COLLATE NOCASE`).all().map(libraryRow));
});

router.post('/libraries', requireAdmin, async (req, res) => {
  const { name, kind } = req.body || {};
  let dir = String(req.body?.path || '').trim();
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Give the library a name.' });
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Choose a library type.' });
  if (!path.isAbsolute(dir)) return res.status(400).json({ error: 'Use an absolute folder path.' });
  dir = path.resolve(dir);
  const st = await fsp.stat(dir).catch(() => null);
  if (!st?.isDirectory()) return res.status(400).json({ error: "That folder doesn't exist or isn't readable." });
  if (q('SELECT 1 FROM libraries WHERE path = ?').get(dir)) {
    return res.status(409).json({ error: 'That folder is already a library.' });
  }
  const { lastInsertRowid } = q('INSERT INTO libraries (name, path, kind, created_at) VALUES (?, ?, ?, ?)').run(
    String(name).trim().slice(0, 80),
    dir,
    kind,
    Date.now(),
  );
  scanner.requestScan(Number(lastInsertRowid));
  res.status(201).json({ id: Number(lastInsertRowid) });
});

router.patch('/libraries/:id', requireAdmin, (req, res) => {
  const lib = q('SELECT * FROM libraries WHERE id = ?').get(Number(req.params.id));
  if (!lib) return res.status(404).json({ error: 'Library not found.' });
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 80) : lib.name;
  const kind = req.body?.kind !== undefined ? req.body.kind : lib.kind;
  if (!name) return res.status(400).json({ error: 'Give the library a name.' });
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Choose a library type.' });
  q('UPDATE libraries SET name = ?, kind = ? WHERE id = ?').run(name, kind, lib.id);
  res.json({ ok: true });
});

router.delete('/libraries/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const ids = q('SELECT id FROM books WHERE library_id = ?').all(id).map((r) => r.id);
  q('DELETE FROM libraries WHERE id = ?').run(id);
  for (const bookId of ids) await covers.removeCovers(bookId);
  res.json({ ok: true });
});

router.post('/libraries/:id/scan', requireAdmin, (req, res) => {
  scanner.requestScan(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/scan', requireAdmin, (req, res) => {
  scanner.requestScan(null);
  res.json({ ok: true });
});

router.get('/scan/status', (req, res) => {
  res.json(scanner.state);
});

// Remove books whose files have disappeared (they're kept until then so progress survives a drive being unplugged).
router.post('/libraries/:id/cleanup', requireAdmin, async (req, res) => {
  const ids = q('SELECT id FROM books WHERE library_id = ? AND missing = 1').all(Number(req.params.id)).map((r) => r.id);
  tx(() => {
    for (const id of ids) q('DELETE FROM books WHERE id = ?').run(id);
  });
  for (const id of ids) await covers.removeCovers(id);
  res.json({ removed: ids.length });
});

// Folder picker for adding libraries.
router.get('/fs', requireAdmin, async (req, res) => {
  const dir = path.resolve(String(req.query.path || os.homedir()));
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: `Can't open ${dir}: ${err.code || err.message}` });
  }
  const dirs = [];
  let bookFiles = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) isDir = (await fsp.stat(path.join(dir, e.name)).catch(() => null))?.isDirectory();
    if (isDir) dirs.push({ name: e.name, path: path.join(dir, e.name) });
    else if (scanner.FILE_FORMATS[path.extname(e.name).toLowerCase()]) bookFiles++;
  }
  dirs.sort((a, b) => archive.naturalSort(a.name, b.name));
  const parent = path.dirname(dir);
  res.json({ path: dir, parent: parent !== dir ? parent : null, dirs, bookFiles, sep: path.sep });
});

// ---------------------------------------------------------------------------
// Books & series

const SORTS = {
  title: 'b.title COLLATE NOCASE ASC',
  added: 'b.added_at DESC, b.id DESC',
  recent: 'p.updated_at IS NULL, p.updated_at DESC',
  author: 'b.author IS NULL, b.author COLLATE NOCASE, b.title COLLATE NOCASE',
  series: 'b.series IS NULL, b.series COLLATE NOCASE, b.series_index, b.title COLLATE NOCASE',
};

router.get('/books', (req, res) => {
  const where = ['b.missing = 0'];
  const args = [req.user.id];
  const { library, series, q: search, status, kind } = req.query;
  if (library) {
    where.push('b.library_id = ?');
    args.push(Number(library));
  }
  if (kind && KINDS.includes(kind)) {
    where.push('l.kind = ?');
    args.push(kind);
  }
  if (series !== undefined) {
    where.push('b.series = ?');
    args.push(String(series));
  } else if (req.query.standalone) {
    where.push('b.series IS NULL');
  }
  if (search) {
    where.push("(b.title LIKE ? ESCAPE '\\' OR b.author LIKE ? ESCAPE '\\' OR b.series LIKE ? ESCAPE '\\')");
    const like = `%${String(search).replace(/[\\%_]/g, '\\$&')}%`;
    args.push(like, like, like);
  }
  if (status === 'unread') where.push('p.updated_at IS NULL');
  if (status === 'reading') where.push('p.updated_at IS NOT NULL AND p.finished = 0');
  if (status === 'finished') where.push('p.finished = 1');

  const sort = SORTS[req.query.sort] || SORTS.title;
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const rows = q(`${BOOK_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
  let books = rows.slice(0, limit).map((r) => toBook(r));
  if (series !== undefined) {
    books = books.sort((a, b) => (a.seriesIndex ?? Infinity) - (b.seriesIndex ?? Infinity) || archive.naturalSort(a.title, b.title));
  }
  res.json({ books, hasMore: rows.length > limit });
});

router.get('/series', (req, res) => {
  const where = ['b.missing = 0', 'b.series IS NOT NULL'];
  const args = [req.user.id];
  if (req.query.library) {
    where.push('b.library_id = ?');
    args.push(Number(req.query.library));
  }
  if (req.query.q) {
    where.push("b.series LIKE ? ESCAPE '\\'");
    args.push(`%${String(req.query.q).replace(/[\\%_]/g, '\\$&')}%`);
  }
  const rows = q(`
    SELECT b.library_id, b.series, COUNT(*) AS count,
      SUM(CASE WHEN p.finished = 1 THEN 1 ELSE 0 END) AS finished,
      MAX(b.added_at) AS latest,
      MAX(p.updated_at) AS last_read
    FROM books b LEFT JOIN progress p ON p.book_id = b.id AND p.user_id = ?
    WHERE ${where.join(' AND ')}
    GROUP BY b.library_id, b.series
    ORDER BY b.series COLLATE NOCASE`).all(...args);

  // Cover: the lowest-numbered book in each series that has one.
  const coverRows = q(`
    SELECT library_id, series, id, updated_at, series_index, title FROM books
    WHERE missing = 0 AND series IS NOT NULL AND cover IS NOT NULL`).all();
  const coverMap = new Map();
  for (const c of coverRows) {
    const key = `${c.library_id}\u0000${c.series}`;
    const cur = coverMap.get(key);
    if (!cur || (c.series_index ?? Infinity) < (cur.series_index ?? Infinity) ||
        ((c.series_index ?? Infinity) === (cur.series_index ?? Infinity) && archive.naturalSort(c.title, cur.title) < 0)) {
      coverMap.set(key, c);
    }
  }
  res.json(
    rows.map((r) => {
      const c = coverMap.get(`${r.library_id}\u0000${r.series}`);
      return {
        libraryId: r.library_id,
        name: r.series,
        count: r.count,
        finished: r.finished,
        latest: r.latest,
        lastRead: r.last_read,
        coverUrl: c ? `/api/books/${c.id}/cover?v=${c.updated_at}` : null,
      };
    }),
  );
});

router.get('/books/:id', (req, res) => {
  const row = getBook(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Book not found.' });
  const book = toBook(row, true);
  // Neighbours in the series, for "next volume" buttons.
  if (row.series) {
    const siblings = q(`${BOOK_SELECT} WHERE b.library_id = ? AND b.series = ? AND b.missing = 0`)
      .all(req.user.id, row.library_id, row.series)
      .map((r) => toBook(r))
      .sort((a, b) => (a.seriesIndex ?? Infinity) - (b.seriesIndex ?? Infinity) || archive.naturalSort(a.title, b.title));
    const i = siblings.findIndex((s) => s.id === book.id);
    book.prev = siblings[i - 1] || null;
    book.next = siblings[i + 1] || null;
    book.seriesCount = siblings.length;
  }
  res.json(book);
});

router.patch('/books/:id', requireAdmin, (req, res) => {
  const book = q('SELECT id FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  const fields = { title: 'title', author: 'author', series: 'series', seriesIndex: 'series_index', description: 'description' };
  const sets = [];
  const vals = [];
  for (const [key, col] of Object.entries(fields)) {
    if (req.body?.[key] === undefined) continue;
    let v = req.body[key];
    if (key === 'seriesIndex') v = v === '' || v == null ? null : Number(v);
    else v = v == null ? null : String(v).trim() || null;
    if (key === 'title' && !v) return res.status(400).json({ error: 'Title is required.' });
    if (key === 'seriesIndex' && v != null && !Number.isFinite(v)) return res.status(400).json({ error: 'Number must be numeric.' });
    sets.push(`${col} = ?`);
    vals.push(v);
  }
  if (sets.length) {
    q(`UPDATE books SET ${sets.join(', ')}, meta_locked = 1, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), book.id);
  }
  res.json({ ok: true });
});

// Re-read metadata and artwork from the file, discarding manual edits.
router.post('/books/:id/refresh', requireAdmin, async (req, res) => {
  q('UPDATE books SET meta_locked = 0, cover_custom = 0, needs_meta = 1 WHERE id = ?').run(Number(req.params.id));
  const book = q('SELECT b.*, l.kind FROM books b JOIN libraries l ON l.id = b.library_id WHERE b.id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  try {
    await scanner.processBook(book);
  } catch (err) {
    return res.status(500).json({ error: `Couldn't read the file: ${err.message}` });
  }
  res.json({ ok: true });
});

const rawImage = express.raw({ type: ['image/*', 'application/octet-stream'], limit: '25mb' });

router.put('/books/:id/cover', requireAdmin, rawImage, async (req, res) => {
  const id = Number(req.params.id);
  if (!q('SELECT 1 FROM books WHERE id = ?').get(id)) return res.status(404).json({ error: 'Book not found.' });
  const name = await covers.saveCover(id, req.body);
  if (!name) return res.status(400).json({ error: 'That file is not a supported image.' });
  q('UPDATE books SET cover = ?, cover_custom = 1, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
  res.json({ ok: true });
});

// PDF thumbnails are rendered in the browser; any reader may fill in a missing one.
router.post('/books/:id/cover/generated', rawImage, async (req, res) => {
  const id = Number(req.params.id);
  const book = q('SELECT cover FROM books WHERE id = ?').get(id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  if (book.cover) return res.json({ ok: true, skipped: true });
  const name = await covers.saveCover(id, req.body);
  if (!name) return res.status(400).json({ error: 'Unsupported image.' });
  q('UPDATE books SET cover = ?, updated_at = ? WHERE id = ? AND cover IS NULL').run(name, Date.now(), id);
  res.json({ ok: true });
});

router.get('/books/:id/cover', (req, res) => {
  const book = q('SELECT cover FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book?.cover) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(covers.coverPath(book.cover), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

function readableBook(req, res) {
  const book = q('SELECT * FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) {
    res.status(404).json({ error: 'Book not found.' });
    return null;
  }
  if (book.missing) {
    res.status(410).json({ error: 'This file is no longer in the library folder.' });
    return null;
  }
  return book;
}

// Raw file for the EPUB/PDF readers (supports range requests).
router.get('/books/:id/file', (req, res) => {
  const book = readableBook(req, res);
  if (!book) return;
  if (book.format === 'folder') return res.status(400).json({ error: 'Not a single file.' });
  res.set('Cache-Control', 'private, max-age=86400');
  if (FILE_MIME[book.format]) res.type(FILE_MIME[book.format]);
  res.sendFile(book.path, { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

router.get('/books/:id/pages', async (req, res) => {
  const book = readableBook(req, res);
  if (!book) return;
  if (!['cbz', 'cbr', 'folder'].includes(book.format)) return res.status(400).json({ error: 'Not an image book.' });
  const pages = await archive.listPages(book);
  if (pages.length !== book.page_count) q('UPDATE books SET page_count = ? WHERE id = ?').run(pages.length, book.id);
  res.json({ count: pages.length });
});

router.get('/books/:id/pages/:n', async (req, res) => {
  const book = readableBook(req, res);
  if (!book) return;
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 0) return res.status(400).end();
  const page = await archive.openPage(book, n);
  if (!page) return res.status(404).end();
  res.set({
    'Content-Type': page.mime,
    'Content-Length': String(page.size),
    'Cache-Control': 'private, max-age=604800',
  });
  await pipeline(page.stream, res).catch(() => {});
});

module.exports = { router, toBook, BOOK_SELECT };
