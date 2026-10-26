'use strict';

// Calibre libraries: a library folder that holds Calibre's metadata.db gets Calibre's titles,
// authors, series, tags, descriptions, publishers, languages, identifiers, covers and ratings.
// Calibre keeps each book in "<Author>/<Title> (<id>)/", which is how its books are matched to
// the files Flyleaf scanned. Runs after every scan when metadata.db has changed, or on demand.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { q, tx } = require('./db');
const settings = require('./settings');
const { stripHtml } = require('./util');
const log = require('./log').logger('calibre');

const dbPath = (lib) => path.join(lib.path, 'metadata.db');
const hasCalibre = (lib) => fs.existsSync(dbPath(lib));

// Identifier types Calibre stores → links.
const LINKS = {
  goodreads: (v) => `https://www.goodreads.com/book/show/${v}`,
  amazon: (v) => `https://www.amazon.com/dp/${v}`,
  google: (v) => `https://books.google.com/books?id=${v}`,
  openlibrary: (v) => `https://openlibrary.org/works/${v}`,
  isbn: null,
};

/** Read everything we use from Calibre in one go (Calibre may have the file open; read-only is fine). */
function readCalibre(file) {
  const cdb = new DatabaseSync(file, { readOnly: true });
  try {
    const one = (sql) => {
      try {
        return cdb.prepare(sql).all();
      } catch {
        return []; // an older Calibre without that table
      }
    };
    const group = (rows) => {
      const m = new Map();
      for (const r of rows) {
        if (!m.has(r.book)) m.set(r.book, []);
        m.get(r.book).push(r.value);
      }
      return m;
    };
    return {
      books: one('SELECT id, title, path, series_index, pubdate, has_cover FROM books'),
      authors: group(one('SELECT l.book, a.name AS value FROM books_authors_link l JOIN authors a ON a.id = l.author ORDER BY l.id')),
      series: new Map(one('SELECT l.book, s.name FROM books_series_link l JOIN series s ON s.id = l.series').map((r) => [r.book, r.name])),
      tags: group(one('SELECT l.book, t.name AS value FROM books_tags_link l JOIN tags t ON t.id = l.tag')),
      publishers: new Map(one('SELECT l.book, p.name FROM books_publishers_link l JOIN publishers p ON p.id = l.publisher').map((r) => [r.book, r.name])),
      languages: new Map(one('SELECT l.book, g.lang_code FROM books_languages_link l JOIN languages g ON g.id = l.lang_code ORDER BY l.item_order').map((r) => [r.book, r.lang_code])),
      ratings: new Map(one('SELECT l.book, r.rating FROM books_ratings_link l JOIN ratings r ON r.id = l.rating WHERE r.rating > 0').map((r) => [r.book, r.rating])),
      comments: new Map(one('SELECT book, text FROM comments').map((r) => [r.book, r.text])),
      identifiers: group(one("SELECT book, type || ':' || val AS value FROM identifiers")),
    };
  } finally {
    cdb.close();
  }
}

/**
 * Apply a Calibre library's metadata to the books Flyleaf found in the same folder.
 * `userId` gets Calibre's ratings as their own (unless they already rated the series).
 * Returns { books, unmatched, covers, ratings }.
 */
async function importLibrary(lib, userId = null) {
  if (!hasCalibre(lib)) throw Object.assign(new Error('There’s no Calibre metadata.db in this library’s folder.'), { status: 400, expose: true });
  const c = readCalibre(dbPath(lib));
  const flyleaf = q('SELECT id, path, cover_custom FROM books WHERE library_id = ? AND missing = 0').all(lib.id);
  const root = path.resolve(lib.path);
  const result = { books: 0, unmatched: 0, covers: 0, ratings: 0 };
  const ratings = []; // [bookId, rating] applied once series exist
  const coverJobs = [];

  tx(() => {
    for (const cb of c.books) {
      const dir = path.join(root, ...String(cb.path).split('/')) + path.sep;
      const matches = flyleaf.filter((b) => b.path.startsWith(dir));
      if (!matches.length) {
        result.unmatched++;
        continue;
      }
      const authors = c.authors.get(cb.id) || [];
      const ids = Object.fromEntries((c.identifiers.get(cb.id) || []).map((v) => {
        const i = v.indexOf(':');
        return [v.slice(0, i).toLowerCase(), v.slice(i + 1)];
      }));
      const links = Object.entries(ids).map(([type, v]) => LINKS[type]?.(v)).filter(Boolean);
      const series = c.series.get(cb.id) || null;
      const year = cb.pubdate && !String(cb.pubdate).startsWith('0101') ? Number(String(cb.pubdate).slice(0, 4)) || null : null;
      const description = stripHtml(c.comments.get(cb.id) || '') || null;
      for (const b of matches) {
        const row = q('SELECT embedded FROM books WHERE id = ?').get(b.id);
        let emb = {};
        try {
          emb = JSON.parse(row?.embedded || '{}') || {};
        } catch {}
        Object.assign(emb, {
          series,
          volume: series ? cb.series_index ?? null : null,
          people: authors.map((name) => ({ name, role: 'Writer' })),
          tags: c.tags.get(cb.id) || [],
          genres: emb.genres?.length ? emb.genres : c.tags.get(cb.id) || [],
          publisher: c.publishers.get(cb.id) || emb.publisher || null,
          language: c.languages.get(cb.id) || emb.language || null,
          year: year || emb.year || null,
          isbn: ids.isbn || emb.isbn || null,
          links: [...new Set([...(emb.links || []), ...links])],
          description: description || emb.description || null,
          calibreId: cb.id,
        });
        // meta_locked: a later rescan of the file doesn't overwrite Calibre's title and author.
        q(`UPDATE books SET title = ?, author = ?, description = COALESCE(?, description), embedded = ?, meta_locked = 1, updated_at = ? WHERE id = ?`)
          .run(cb.title, authors.join(' & ') || null, description, JSON.stringify(emb), Date.now(), b.id);
        result.books++;
        if (cb.has_cover && !b.cover_custom) coverJobs.push([b.id, path.join(dir, 'cover.jpg')]);
        const rating = c.ratings.get(cb.id);
        if (rating && userId) ratings.push([b.id, Math.max(1, Math.min(10, Math.round(rating)))]);
      }
    }
  });

  // Covers: Calibre's cover.jpg next to the book.
  const { saveCover } = require('./covers');
  for (const [bookId, file] of coverJobs) {
    try {
      const name = await saveCover(bookId, await fsp.readFile(file));
      if (name) {
        q('UPDATE books SET cover = ? WHERE id = ?').run(name, bookId);
        result.covers++;
      }
    } catch {}
  }

  // Calibre series → Flyleaf series (in "Regular books" mode a book joins a series from its metadata).
  const scanner = require('./scanner');
  scanner.assignSeries(q('SELECT * FROM libraries WHERE id = ?').get(lib.id));

  // Ratings become the importing user's ratings of each series.
  if (userId) {
    const now = Date.now();
    for (const [bookId, rating] of ratings) {
      const sid = q('SELECT series_id FROM books WHERE id = ?').get(bookId)?.series_id;
      if (!sid) continue;
      const r = q(`INSERT OR IGNORE INTO series_reviews (user_id, series_id, rating, body, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`)
        .run(userId, sid, rating, now, now);
      result.ratings += Number(r.changes);
    }
  }
  settings.set(`calibre:${lib.id}`, { mtime: fs.statSync(dbPath(lib)).mtimeMs, importedAt: Date.now() });
  log.info(`"${lib.name}": imported ${result.books} books from Calibre (${result.unmatched} not in the folder, ${result.covers} covers, ${result.ratings} ratings)`);
  return result;
}

/**
 * After a scan: import again when metadata.db changed since the last import, or when files were
 * added or changed (re-reading a file replaces its metadata with what's embedded in it).
 */
async function syncIfChanged(lib, filesChanged = false) {
  if (!hasCalibre(lib)) return null;
  const last = settings.get(`calibre:${lib.id}`);
  const mtime = fs.statSync(dbPath(lib)).mtimeMs;
  if (last && last.mtime === mtime && !filesChanged) return null;
  const admin = q("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  return importLibrary(lib, admin?.id ?? null);
}

module.exports = { importLibrary, syncIfChanged, hasCalibre };
