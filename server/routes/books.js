'use strict';

const express = require('express');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { q, tx } = require('../db');
const { requireAdmin, requirePermission } = require('../auth');
const archive = require('../archive');
const scanner = require('../scanner');
const covers = require('../covers');
const formats = require('../formats');
const profiles = require('../profiles');
const { BOOK_SELECT, getBook, getSeries, toBook, seriesBooks, canDeleteBook, canMoveBook, canMoveSeries } = require('../serialize');
const events = require('../events');
const log = require('../log').logger('books');
const { json, likePrefix } = require('../util');

const router = express.Router();

const FILE_MIME = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  fb2: 'application/x-fictionbook+xml',
  txt: 'application/epub+zip', // TXT/DOCX/RTF are served converted to EPUB
  docx: 'application/epub+zip',
  rtf: 'application/epub+zip',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  cb7: 'application/x-cb7',
  cbt: 'application/x-cbt',
};
const EXT = { epub: 'epub', pdf: 'pdf', mobi: 'mobi', azw3: 'azw3', fb2: 'fb2', txt: 'txt', docx: 'docx', rtf: 'rtf', cbz: 'cbz', cbr: 'cbr', cb7: 'cb7', cbt: 'cbt' };
/** What the original file is, for downloads (FILE_MIME describes what the reader gets). */
const ORIGINAL_MIME = { ...FILE_MIME, txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rtf: 'application/rtf' };

/** Load a book the user may read; sends 404/410 itself. */
function readable(req, res) {
  const row = getBook(req.params.id, req.user);
  if (!row) {
    res.status(404).json({ error: 'Book not found.' });
    return null;
  }
  if (row.missing) {
    res.status(410).json({ error: 'This file is no longer in the library folder.' });
    return null;
  }
  return row;
}

router.get('/books/:id', (req, res) => {
  const row = getBook(req.params.id, req.user);
  if (!row) return res.status(404).json({ error: 'Book not found.' });
  const book = toBook(row, true, req.user);
  if (row.series_id) {
    const siblings = seriesBooks(row.series_id, req.user);
    const i = siblings.findIndex((s) => s.id === book.id);
    book.prev = siblings[i - 1] || null;
    book.next = siblings[i + 1] || null;
    book.seriesCount = siblings.length;
  }
  res.json(book);
});

/** Everything the reader needs in one call: book, neighbours, resolved settings, annotations. */
/** Everything known about one file: metadata, file details and your reading history. */
router.get('/books/:id/info', (req, res) => {
  const row = getBook(req.params.id, req.user);
  if (!row) return res.status(404).json({ error: 'Book not found.' });
  const book = toBook(row, true, req.user);
  const emb = json(row.embedded, {});
  const user = req.user;
  const progress = q('SELECT started_at, updated_at, percent, page, finished FROM progress WHERE user_id = ? AND book_id = ?').get(user.id, row.id);
  const log = q(`SELECT COALESCE(SUM(seconds), 0) AS seconds, COUNT(*) AS days, MIN(day) AS first_day, MAX(day) AS last_day
                 FROM reading_log WHERE user_id = ? AND book_id = ?`).get(user.id, row.id);
  const notes = q('SELECT kind, COUNT(*) AS n FROM annotations WHERE user_id = ? AND book_id = ? GROUP BY kind').all(user.id, row.id);
  const lib = q('SELECT id, name, kind FROM libraries WHERE id = ?').get(row.library_id);
  const percent = progress?.percent || 0;
  // Time left, from your own pace on this book once there's enough to go on.
  const remaining = log.seconds >= 120 && percent >= 0.03 && percent < 1 ? Math.round((log.seconds / percent) * (1 - percent)) : null;
  res.json({
    ...book,
    library: lib ? { id: lib.id, name: lib.name, kind: lib.kind } : null,
    file: {
      name: path.basename(row.path),
      relPath: row.rel_path,
      path: user.role === 'admin' ? row.path : undefined,
      format: row.format,
      size: row.size,
      modifiedAt: row.mtime,
      addedAt: row.added_at,
      updatedAt: row.updated_at,
    },
    meta: {
      isbn: emb.isbn || null,
      publisher: emb.publisher || null,
      year: emb.year || null,
      language: emb.language || null,
      genres: emb.genres || [],
      tags: emb.tags || [],
      people: emb.people || [],
      series: emb.series || null,
      ageRating: emb.ageRating || null,
      links: emb.links || [],
    },
    reading: {
      startedAt: progress?.started_at || null,
      lastReadAt: progress?.updated_at || null,
      percent,
      page: progress?.page ?? null,
      finished: Boolean(progress?.finished),
      seconds: log.seconds,
      days: log.days,
      firstDay: log.first_day,
      lastDay: log.last_day,
      remainingSeconds: remaining,
      highlights: notes.find((n) => n.kind === 'highlight')?.n || 0,
      bookmarks: notes.find((n) => n.kind === 'bookmark')?.n || 0,
    },
  });
});

router.get('/books/:id/reader', (req, res) => {
  const row = readable(req, res);
  if (!row) return;
  const book = toBook(row, true, req.user);
  if (row.series_id) {
    const siblings = seriesBooks(row.series_id, req.user);
    const i = siblings.findIndex((s) => s.id === book.id);
    book.prev = siblings[i - 1] || null;
    book.next = siblings[i + 1] || null;
  }
  const resolved = profiles.resolve(req.user.id, row);
  const annotations = q('SELECT * FROM annotations WHERE user_id = ? AND book_id = ? ORDER BY COALESCE(page, 0), created_at').all(req.user.id, row.id);
  res.json({
    book,
    ...resolved,
    annotations: annotations.map(annotationRow),
    keybinds: req.user.prefs.keybinds,
    dataSaver: Boolean(req.user.prefs.dataSaver),
    enabledFonts: req.user.prefs.enabledFonts,
  });
});

function annotationRow(a) {
  return {
    id: a.id,
    bookId: a.book_id,
    kind: a.kind,
    locator: a.locator,
    page: a.page,
    percent: a.percent,
    text: a.text,
    note: a.note,
    color: a.color,
    chapter: a.chapter,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

// Reader tweaks are remembered per series (null resets to the profile).
router.put('/series/:id/reader-settings', (req, res) => {
  const seriesId = Number(req.params.id);
  if (!q('SELECT 1 FROM series WHERE id = ?').get(seriesId)) return res.status(404).json({ error: 'Series not found.' });
  const value = req.body?.settings ? JSON.stringify(profiles.clean(req.body.settings)) : null;
  q(`INSERT INTO user_series (user_id, series_id, reader_settings, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, series_id) DO UPDATE SET reader_settings = excluded.reader_settings, updated_at = excluded.updated_at`).run(
    req.user.id, seriesId, value, Date.now(),
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Editing (admin)

router.patch('/books/:id', requireAdmin, (req, res) => {
  const book = q('SELECT id FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  const fields = { title: 'title', author: 'author', description: 'description', volume: 'volume', chapter: 'chapter' };
  const sets = [];
  const vals = [];
  for (const [key, col] of Object.entries(fields)) {
    if (req.body?.[key] === undefined) continue;
    let v = req.body[key];
    if (key === 'volume' || key === 'chapter') {
      v = v === '' || v == null ? null : Number(v);
      if (v != null && !Number.isFinite(v)) return res.status(400).json({ error: `${key} must be a number.` });
    } else v = v == null ? null : String(v).trim() || null;
    if (key === 'title' && !v) return res.status(400).json({ error: 'Title is required.' });
    sets.push(`${col} = ?`);
    vals.push(v);
  }
  if (sets.length) {
    q(`UPDATE books SET ${sets.join(', ')}, series_index = COALESCE(volume, chapter), meta_locked = 1, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), book.id);
    // Keep explicit numbers through rescans by recording them as embedded metadata.
    const row = q('SELECT embedded, volume, chapter FROM books WHERE id = ?').get(book.id);
    const emb = { ...json(row.embedded, {}), volume: row.volume, number: row.chapter };
    q('UPDATE books SET embedded = ? WHERE id = ?').run(JSON.stringify(emb), book.id);
  }
  res.json({ ok: true });
});

router.post('/books/:id/refresh', requireAdmin, async (req, res) => {
  q('UPDATE books SET meta_locked = 0, cover_custom = 0, needs_meta = 1 WHERE id = ?').run(Number(req.params.id));
  const book = q('SELECT b.*, l.kind FROM books b JOIN libraries l ON l.id = b.library_id WHERE b.id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  try {
    await scanner.processBook(book);
    if (book.series_id) scanner.seedSeriesFromFiles(book.series_id);
  } catch (err) {
    return res.status(500).json({ error: `Couldn't read the file: ${err.message}` });
  }
  res.json({ ok: true });
});

/** Remove a book's file from disk, then everything Flyleaf knew about it. Returns whether its series went too. */
async function deleteBook(row, user) {
  const lib = q('SELECT path FROM libraries WHERE id = ?').get(row.library_id);
  const root = path.resolve(lib.path);
  const file = path.resolve(row.path);
  if (!file.startsWith(root + path.sep)) throw Object.assign(new Error('That file is outside its library folder.'), { status: 400, expose: true });
  try {
    await fsp.rm(file, { recursive: row.format === 'folder', force: true });
  } catch (e) {
    throw Object.assign(new Error(require('../plugins/downloads').friendlyFsError(e, path.dirname(file))), { status: 500, expose: true });
  }
  // Tidy up folders the deletion left empty, never the library folder itself.
  for (let dir = path.dirname(file); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    try {
      await fsp.rmdir(dir);
    } catch {
      break;
    }
  }
  const seriesRemoved = tx(() => {
    q('DELETE FROM books WHERE id = ?').run(row.id);
    // So a different file later saved at this path doesn't count as the old downloader's.
    q('UPDATE downloads SET file = NULL WHERE file = ?').run(row.path);
    q("DELETE FROM uploads WHERE file = ? OR file LIKE ? ESCAPE '\\'").run(row.path, `${likePrefix(row.path)}%`);
    if (!row.series_id || q('SELECT 1 FROM books WHERE series_id = ?').get(row.series_id)) return false;
    q('DELETE FROM series WHERE id = ?').run(row.series_id);
    return true;
  });
  await covers.removeCovers(row.id);
  if (seriesRemoved) await covers.removeSeriesCover(row.series_id);
  log.info(`${user.username} deleted "${row.title}" (${row.path})`);
  events.emit('book.deleted', { bookId: row.id, libraryId: row.library_id, title: row.title, file: row.rel_path, userId: user.id });
  return seriesRemoved;
}

const DELETE_DENIED = 'You can only delete books in your own libraries or ones you downloaded.';

// Users may only delete books in their own libraries or ones they downloaded (see canDeleteBook).
router.delete('/books/:id', async (req, res) => {
  const row = getBook(req.params.id, req.user);
  if (!row) return res.status(404).json({ error: 'Book not found.' });
  if (!canDeleteBook(req.user, row)) return res.status(403).json({ error: DELETE_DENIED });
  res.json({ ok: true, seriesRemoved: await deleteBook(row, req.user) });
});

/** Delete every book in a series; refused unless all of them are the user's to delete. */
router.delete('/series/:id', async (req, res) => {
  const s = getSeries(req.params.id, req.user);
  if (!s) return res.status(404).json({ error: 'Series not found.' });
  const rows = q(`${BOOK_SELECT} WHERE b.series_id = ?`).all(req.user.id, req.user.id, s.id);
  if (!rows.length || !rows.every((r) => canDeleteBook(req.user, r))) return res.status(403).json({ error: DELETE_DENIED });
  for (const row of rows) await deleteBook(row, req.user);
  res.json({ ok: true, deleted: rows.length });
});

// ---------------------------------------------------------------------------
// Moving books between libraries (the files move on disk)

/** Libraries the user may move things into: their own, or any library for the admin. */
function moveTargets(user) {
  if (user.role === 'admin') return q('SELECT id, name, kind, mode, path, owner_id FROM libraries WHERE owner_id IS NULL OR owner_id = ? ORDER BY name COLLATE NOCASE').all(user.id);
  return q('SELECT id, name, kind, mode, path, owner_id FROM libraries WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(user.id);
}

/** `p`, or "name (2).ext", "name (3).ext"… if something is already there. */
async function freePath(p, isDir) {
  const lower = p.toLowerCase();
  const ext = isDir ? '' : lower.endsWith('.kepub.epub') ? '.kepub.epub' : path.extname(p);
  const base = ext ? p.slice(0, -ext.length) : p;
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? p : `${base} (${i})${ext}`;
    if (!(await fsp.stat(candidate).catch(() => null))) return candidate;
  }
  throw Object.assign(new Error('Too many files with that name in the target library.'), { status: 409, expose: true });
}

const fsErr = (e, dir) => Object.assign(new Error(require('../plugins/downloads').friendlyFsError(e, dir)), { status: 500, expose: true });

/**
 * Move one book's file into `target` and point its row there. Progress, bookmarks and notes
 * stay (they belong to the book). `keepSeries` leaves series_id alone (a whole series moving).
 */
async function moveBook(row, target, user, { keepSeries = false } = {}) {
  const src = q('SELECT path, kind FROM libraries WHERE id = ?').get(row.library_id);
  const srcRoot = path.resolve(src.path);
  const file = path.resolve(row.path);
  if (!file.startsWith(srcRoot + path.sep)) throw Object.assign(new Error('That file is outside its library folder.'), { status: 400, expose: true });
  const isDir = row.format === 'folder';
  let rel = path.relative(srcRoot, file);
  // Folder-per-series libraries need the file inside a series folder, not loose at the top.
  if (target.mode === 'komga' && !rel.includes(path.sep)) {
    const { segment } = require('../plugins/downloads');
    rel = path.join(segment(row.series_name || row.series || row.title), rel);
  }
  const root = path.resolve(target.path);
  const dest = await freePath(path.join(root, rel), isDir);
  if (!dest.startsWith(root + path.sep)) throw Object.assign(new Error('Refusing to write outside the target library.'), { status: 400, expose: true });
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
  } catch (e) {
    throw fsErr(e, path.dirname(dest));
  }
  try {
    await fsp.rename(file, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw fsErr(e, path.dirname(dest));
    // Another disk: copy (keeping timestamps, so the scanner sees the same file), then remove.
    try {
      await fsp.cp(file, dest, { recursive: isDir, errorOnExist: true, force: false, preserveTimestamps: true });
    } catch (e2) {
      await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
      throw fsErr(e2, path.dirname(dest));
    }
    await fsp.rm(file, { recursive: isDir, force: true });
  }
  // Tidy up folders the move left empty, never the library folder itself.
  for (let dir = path.dirname(file); dir.startsWith(srcRoot + path.sep); dir = path.dirname(dir)) {
    try {
      await fsp.rmdir(dir);
    } catch {
      break;
    }
  }
  const seriesRemoved = tx(() => {
    q(`UPDATE books SET library_id = ?, path = ?, rel_path = ?, missing = 0, updated_at = ?,
       needs_meta = CASE WHEN ? THEN 1 ELSE needs_meta END ${keepSeries ? '' : ', series_id = NULL'} WHERE id = ?`).run(
      target.id, dest, path.relative(root, dest), Date.now(), src.kind !== target.kind ? 1 : 0, row.id,
    );
    // Whoever downloaded it can still delete it in its new place.
    q('UPDATE downloads SET file = ? WHERE file = ?').run(dest, row.path);
    q('UPDATE uploads SET file = ?, library_id = ? WHERE file = ?').run(dest, target.id, row.path);
    for (const u of q("SELECT id, file FROM uploads WHERE file LIKE ? ESCAPE '\\'").all(`${likePrefix(row.path)}%`)) {
      q('UPDATE uploads SET file = ?, library_id = ? WHERE id = ?').run(dest + u.file.slice(row.path.length), target.id, u.id);
    }
    if (keepSeries || !row.series_id || q('SELECT 1 FROM books WHERE series_id = ?').get(row.series_id)) return false;
    q('DELETE FROM series WHERE id = ?').run(row.series_id);
    return true;
  });
  if (seriesRemoved) await covers.removeSeriesCover(row.series_id);
  log.info(`${user.username} moved "${row.title}" to ${target.name} (${dest})`);
  return seriesRemoved;
}

function pickTarget(req, currentLibraryId) {
  const target = moveTargets(req.user).find((l) => l.id === Number(req.body?.libraryId));
  if (!target) throw Object.assign(new Error('Choose one of your libraries to move it to.'), { status: 400, expose: true });
  if (target.id === currentLibraryId) throw Object.assign(new Error('It’s already in that library.'), { status: 400, expose: true });
  return target;
}

/** Where a book or series can go: ?book=<id> or ?series=<id>. */
router.get('/move-targets', (req, res) => {
  const current = req.query.book
    ? getBook(req.query.book, req.user)?.library_id
    : req.query.series ? getSeries(req.query.series, req.user)?.libraryId : null;
  res.json(moveTargets(req.user).filter((l) => l.id !== current).map((l) => ({ id: l.id, name: l.name, kind: l.kind, own: l.owner_id === req.user.id })));
});

router.post('/books/:id/move', async (req, res) => {
  const row = getBook(req.params.id, req.user);
  if (!row) return res.status(404).json({ error: 'Book not found.' });
  if (!canMoveBook(req.user, row)) return res.status(403).json({ error: 'You can only move books in your own libraries or ones you downloaded.' });
  const target = pickTarget(req, row.library_id);
  const seriesRemoved = await moveBook(row, target, req.user);
  scanner.requestScan(target.id);
  scanner.requestScan(row.library_id);
  res.json({ ok: true, library: { id: target.id, name: target.name }, seriesRemoved });
});

/** Move a whole series. Its metadata, collections and Want to read come along when it can keep its identity. */
router.post('/series/:id/move', async (req, res) => {
  const s = getSeries(req.params.id, req.user);
  if (!s) return res.status(404).json({ error: 'Series not found.' });
  const srow = q('SELECT * FROM series WHERE id = ?').get(s.id);
  if (!canMoveSeries(req.user, srow)) return res.status(403).json({ error: 'You can only move series in your own libraries or ones you downloaded.' });
  const target = pickTarget(req, srow.library_id);
  const rows = q(`${BOOK_SELECT} WHERE b.series_id = ?`).all(req.user.id, req.user.id, s.id);
  // Take the series row along, unless the target already has a series with that key (then the
  // books join that one; the scanner hands this series' reader data over to it).
  const clash = q('SELECT 1 FROM series WHERE library_id = ? AND key = ?').get(target.id, srow.key);
  let moved = 0;
  try {
    for (const row of rows) {
      await moveBook(row, target, req.user, { keepSeries: true });
      moved++;
    }
  } finally {
    if (!clash && moved === rows.length) q('UPDATE series SET library_id = ?, updated_at = ? WHERE id = ?').run(target.id, Date.now(), s.id);
    scanner.requestScan(target.id);
    scanner.requestScan(srow.library_id);
  }
  res.json({ ok: true, moved, library: { id: target.id, name: target.name }, seriesId: clash ? null : s.id });
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
  res.sendFile(covers.coverPath(book.cover), (err) => err && !res.headersSent && res.status(404).end());
});

// ---------------------------------------------------------------------------
// Files & pages

/** The file the in-browser reader opens (TXT, DOCX and RTF are converted to EPUB). */
router.get('/books/:id/file', async (req, res) => {
  const book = readable(req, res);
  if (!book) return;
  if (book.format === 'folder') return res.status(400).json({ error: 'Not a single file.' });
  let file = book.path;
  if (formats.CONVERTIBLE.has(book.format)) file = await formats.toEpub(book.path, book.format, book.title);
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(FILE_MIME[book.format] || 'application/octet-stream');
  res.sendFile(file, { dotfiles: 'allow' }, (err) => err && !res.headersSent && res.status(404).end());
});

/** Original file as an attachment (image folders are zipped on the fly). */
router.get('/books/:id/download', requirePermission('download', 'Downloading isn’t enabled for your account.'), async (req, res) => {
  const book = readable(req, res);
  if (!book) return;
  if (book.format === 'folder') {
    const { ZipArchive } = require('archiver');
    const zip = new ZipArchive({ store: true });
    res.attachment(`${path.basename(book.path)}.cbz`);
    zip.on('error', () => res.destroy());
    zip.pipe(res);
    zip.directory(book.path, false);
    await zip.finalize();
    return;
  }
  res.download(book.path, path.basename(book.path), { dotfiles: 'allow' }, (err) => err && !res.headersSent && res.status(404).end());
});

router.get('/books/:id/pages', async (req, res) => {
  const book = readable(req, res);
  if (!book) return;
  if (!archive.IMAGE_FORMATS.has(book.format)) return res.status(400).json({ error: 'Not an image book.' });
  const pages = await archive.listPages(book);
  if (pages.length !== book.page_count) q('UPDATE books SET page_count = ? WHERE id = ?').run(pages.length, book.id);
  res.json({ count: pages.length });
});

router.get('/books/:id/pages/:n', async (req, res) => {
  const book = readable(req, res);
  if (!book) return;
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 0) return res.status(400).end();
  const width = Number(req.query.w) || null;
  const page = await archive.openPage(book, n, { width: width && width >= 100 && width <= 4000 ? width : null });
  if (!page) return res.status(404).end();
  res.set({ 'Content-Type': page.mime, 'Content-Length': String(page.size), 'Cache-Control': 'private, max-age=604800' });
  if (page.buffer) return res.end(page.buffer);
  await pipeline(page.stream, res).catch(() => {});
});

module.exports = { router, readable, deleteBook, FILE_MIME, ORIGINAL_MIME, EXT, annotationRow };
