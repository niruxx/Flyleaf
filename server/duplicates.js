'use strict';

// Duplicate books: the same file twice, the same book in two formats, or the same volume or
// chapter in two places. Admins review them in Settings → Libraries → Duplicates, keep one copy
// and merge everyone's reading data into it, or mark a group as "not duplicates".

const crypto = require('node:crypto');
const fs = require('node:fs');
const { q, tx } = require('./db');
const settings = require('./settings');

const IGNORED = 'duplicatesIgnored';
const norm = (s) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** First and last 64 KB plus the size: tells identical files apart cheaply. */
function fingerprint(file, size) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const n = Math.min(65536, size);
      const head = Buffer.alloc(n);
      const tail = Buffer.alloc(n);
      fs.readSync(fd, head, 0, n, 0);
      fs.readSync(fd, tail, 0, n, Math.max(0, size - n));
      return crypto.createHash('sha1').update(head).update(tail).update(String(size)).digest('hex');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

const groupKey = (ids) => crypto.createHash('sha1').update([...ids].sort((a, b) => a - b).join(',')).digest('hex').slice(0, 16);

/**
 * Groups of likely duplicates: [{ key, reason, books: [...] }]. Three kinds, strongest first:
 *   same file       – identical size and content fingerprint
 *   same book       – the same title and author (ebooks), any format or library
 *   same volume     – the same series name and volume/chapter number (comics, manga)
 */
function findGroups() {
  const rows = q(`SELECT b.id, b.title, b.author, b.format, b.size, b.path, b.rel_path, b.added_at, b.volume, b.chapter, b.special,
                         b.series_id, s.name AS series_name, l.id AS library_id, l.name AS library_name, l.kind, l.owner_id
                  FROM books b JOIN libraries l ON l.id = b.library_id LEFT JOIN series s ON s.id = b.series_id
                  WHERE b.missing = 0`).all();
  const ignored = new Set(settings.get(IGNORED) || []);
  const seen = new Set();
  const groups = [];
  const add = (reason, list) => {
    if (list.length < 2) return;
    const ids = list.map((b) => b.id);
    const key = groupKey(ids);
    if (ignored.has(key) || seen.has(key)) return;
    // A weaker reason for exactly the books of a stronger group adds nothing.
    seen.add(key);
    groups.push({ key, reason, ids });
  };
  const bucket = (fn) => {
    const m = new Map();
    for (const r of rows) {
      const k = fn(r);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return [...m.values()];
  };

  // Same file: compare fingerprints only among books of the same size and format.
  for (const sameSize of bucket((r) => (r.format !== 'folder' && r.size > 0 ? `${r.format}:${r.size}` : null))) {
    if (sameSize.length < 2) continue;
    const byPrint = new Map();
    for (const r of sameSize) {
      const fp = fingerprint(r.path, r.size);
      if (!fp) continue;
      if (!byPrint.has(fp)) byPrint.set(fp, []);
      byPrint.get(fp).push(r);
    }
    for (const list of byPrint.values()) add('same-file', list);
  }
  // Same book in other formats or libraries (ebooks).
  for (const list of bucket((r) => (r.kind === 'books' && norm(r.title) ? `${norm(r.title)}|${norm(r.author)}` : null))) add('same-book', list);
  // Same volume or chapter of a series (comics and manga), across libraries too.
  for (const list of bucket((r) => {
    if (r.kind === 'books' || r.special || !r.series_name) return null;
    const n = r.chapter != null ? `c${r.chapter}` : r.volume != null ? `v${r.volume}` : null;
    return n ? `${norm(r.series_name)}|${n}` : null;
  })) add('same-volume', list);

  const byId = new Map(rows.map((r) => [r.id, r]));
  const stats = (id) => q(`SELECT (SELECT COUNT(*) FROM progress WHERE book_id = ?) AS readers,
                                  (SELECT COUNT(*) FROM annotations WHERE book_id = ?) AS notes`).get(id, id);
  return groups.map((g) => ({
    key: g.key,
    reason: g.reason,
    books: g.ids.map((id) => {
      const r = byId.get(id);
      const s = stats(id);
      return {
        id: r.id, title: r.title, author: r.author, format: r.format, size: r.size, path: r.rel_path, addedAt: r.added_at,
        volume: r.volume, chapter: r.chapter, series: r.series_name, seriesId: r.series_id,
        libraryId: r.library_id, library: r.library_name, personal: r.owner_id != null,
        readers: s.readers, notes: s.notes,
      };
    }),
  }));
}

/** Hide a group from the list ("these aren't duplicates"). */
function ignore(key) {
  const list = new Set(settings.get(IGNORED) || []);
  list.add(String(key).slice(0, 32));
  settings.set(IGNORED, [...list].slice(-2000));
}

/**
 * Keep one book and remove the others: everyone's progress, reading time, bookmarks and notes
 * move to the kept book first, then the other files are deleted from disk.
 */
async function merge(keepId, removeIds, admin) {
  const keep = q('SELECT * FROM books WHERE id = ?').get(keepId);
  if (!keep) throw Object.assign(new Error('The book to keep is gone.'), { status: 404, expose: true });
  const removes = removeIds.filter((id) => id !== keepId).map((id) => q('SELECT * FROM books WHERE id = ?').get(id)).filter(Boolean);
  tx(() => {
    for (const r of removes) {
      // Progress: the kept book keeps its own position; whoever only read the other copy gets theirs
      // (as a percentage when the formats differ), and "finished" carries over either way.
      for (const p of q('SELECT * FROM progress WHERE book_id = ?').all(r.id)) {
        const mine = q('SELECT * FROM progress WHERE user_id = ? AND book_id = ?').get(p.user_id, keep.id);
        const sameFormat = r.format === keep.format;
        if (!mine) {
          q(`INSERT INTO progress (user_id, book_id, position, page, percent, finished, finished_at, started_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.user_id, keep.id, sameFormat ? p.position : null, sameFormat ? p.page : null,
            p.percent, p.finished, p.finished_at, p.started_at, p.updated_at);
        } else if (p.finished && !mine.finished) {
          q('UPDATE progress SET finished = 1, finished_at = ?, percent = 1 WHERE user_id = ? AND book_id = ?').run(p.finished_at ?? p.updated_at, p.user_id, keep.id);
        }
      }
      q(`INSERT INTO reading_log (user_id, book_id, day, seconds) SELECT user_id, ?, day, seconds FROM reading_log WHERE book_id = ? AND true
         ON CONFLICT (user_id, book_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`).run(keep.id, r.id);
      q('UPDATE annotations SET book_id = ? WHERE book_id = ?').run(keep.id, r.id);
    }
  });
  const { deleteBook } = require('./routes/books');
  for (const r of removes) await deleteBook(r, admin);
  return { kept: keep.id, removed: removes.length };
}

module.exports = { findGroups, ignore, merge };
