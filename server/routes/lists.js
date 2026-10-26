'use strict';

// Reading lists: books from any series in a set order (a comic event, a reading order across
// spin-offs). Lists can be made by hand or imported from ComicRack .cbl files, and exported
// back to .cbl. The admin can share a list with everyone, like a collection.

const express = require('express');
const { q, tx } = require('../db');
const { getBook, toBook } = require('../serialize');
const { accessFilter } = require('../util');
const { elements } = require('../metadata');
const { normalizeKey } = require('../parser');

const router = express.Router();
const MAX_ITEMS = 2000;

function visibleList(req, res, { write = false } = {}) {
  const l = q('SELECT * FROM reading_lists WHERE id = ?').get(Number(req.params.id));
  if (!l || (l.user_id !== req.user.id && !l.promoted)) {
    res.status(404).json({ error: 'Reading list not found.' });
    return null;
  }
  if (write && l.user_id !== req.user.id) {
    res.status(403).json({ error: 'Only the owner can change this reading list.' });
    return null;
  }
  return l;
}

/** The list's books you can see, in order, with your progress. */
function listBooks(listId, user) {
  return q('SELECT book_id FROM reading_list_items WHERE list_id = ? ORDER BY position').all(listId)
    .map((r) => getBook(r.book_id, user))
    .filter(Boolean)
    .map((row) => toBook(row, false, user));
}

function summaryRow(l, user) {
  const books = listBooks(l.id, user);
  const read = books.filter((b) => b.progress?.finished).length;
  const next = books.find((b) => !b.progress?.finished) || null;
  const art = books.find((b) => b.coverUrl && !b.blur);
  return {
    id: l.id,
    name: l.name,
    summary: l.summary,
    promoted: Boolean(l.promoted),
    owned: l.user_id === user.id,
    source: l.source,
    count: books.length,
    read,
    nextBookId: next?.id ?? null,
    coverUrl: art?.coverUrl || null,
    covers: books.filter((b) => b.coverUrl && !b.blur).slice(0, 4).map((b) => b.coverUrl),
    updatedAt: l.updated_at,
  };
}

const cleanName = (v) => String(v || '').trim().slice(0, 120);

router.get('/reading-lists', (req, res) => {
  const rows = q('SELECT * FROM reading_lists WHERE user_id = ? OR promoted = 1 ORDER BY name COLLATE NOCASE').all(req.user.id);
  res.json(rows.map((l) => summaryRow(l, req.user)));
});

function addBooks(listId, bookIds, user) {
  let pos = q('SELECT COALESCE(MAX(position), -1) AS p FROM reading_list_items WHERE list_id = ?').get(listId).p;
  let added = 0;
  for (const id of bookIds) {
    if (!getBook(id, user)) continue;
    const r = q('INSERT OR IGNORE INTO reading_list_items (list_id, book_id, position) VALUES (?, ?, ?)').run(listId, id, pos + 1);
    if (r.changes) {
      pos++;
      added++;
    }
  }
  return added;
}

/** Books of a series in reading order (to add a whole series at once). */
const seriesBookIds = (seriesId, user) => require('../serialize').seriesBooks(seriesId, user).map((b) => b.id);

router.post('/reading-lists', (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Give the reading list a name.' });
  const now = Date.now();
  const id = Number(q('INSERT INTO reading_lists (user_id, name, summary, promoted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    req.user.id, name, String(req.body?.summary || '').trim() || null, req.user.role === 'admin' && req.body?.promoted ? 1 : 0, now, now,
  ).lastInsertRowid);
  const ids = [...[].concat(req.body?.bookIds || []).map(Number), ...(req.body?.seriesId ? seriesBookIds(Number(req.body.seriesId), req.user) : [])];
  tx(() => addBooks(id, ids.slice(0, MAX_ITEMS), req.user));
  res.status(201).json({ id });
});

router.get('/reading-lists/:id', (req, res) => {
  const l = visibleList(req, res);
  if (!l) return;
  const books = listBooks(l.id, req.user);
  res.json({ ...summaryRow(l, req.user), books, unmatched: JSON.parse(l.unmatched || '[]') });
});

router.patch('/reading-lists/:id', (req, res) => {
  const l = visibleList(req, res, { write: true });
  if (!l) return;
  const b = req.body || {};
  const name = b.name !== undefined ? cleanName(b.name) : l.name;
  if (!name) return res.status(400).json({ error: 'Give the reading list a name.' });
  tx(() => {
    q('UPDATE reading_lists SET name = ?, summary = ?, promoted = ?, unmatched = ?, updated_at = ? WHERE id = ?').run(
      name,
      b.summary !== undefined ? String(b.summary).trim() || null : l.summary,
      b.promoted !== undefined && req.user.role === 'admin' ? (b.promoted ? 1 : 0) : l.promoted,
      b.clearUnmatched ? null : l.unmatched,
      Date.now(),
      l.id,
    );
    // A new order: the listed books first in that order, anything not mentioned keeps its place after.
    if (Array.isArray(b.order)) {
      const order = b.order.map(Number);
      const rest = q('SELECT book_id FROM reading_list_items WHERE list_id = ? ORDER BY position').all(l.id).map((r) => r.book_id).filter((id) => !order.includes(id));
      [...order, ...rest].forEach((id, i) => q('UPDATE reading_list_items SET position = ? WHERE list_id = ? AND book_id = ?').run(i, l.id, id));
    }
  });
  res.json(summaryRow(q('SELECT * FROM reading_lists WHERE id = ?').get(l.id), req.user));
});

router.delete('/reading-lists/:id', (req, res) => {
  const l = visibleList(req, res, { write: true });
  if (!l) return;
  q('DELETE FROM reading_lists WHERE id = ?').run(l.id);
  res.json({ ok: true });
});

/** Add books (or a whole series) to the end of a list: { bookIds?, seriesId? } */
router.post('/reading-lists/:id/items', (req, res) => {
  const l = visibleList(req, res, { write: true });
  if (!l) return;
  const ids = [...[].concat(req.body?.bookIds || []).map(Number), ...(req.body?.seriesId ? seriesBookIds(Number(req.body.seriesId), req.user) : [])];
  const count = q('SELECT COUNT(*) AS n FROM reading_list_items WHERE list_id = ?').get(l.id).n;
  const added = tx(() => addBooks(l.id, ids.slice(0, Math.max(0, MAX_ITEMS - count)), req.user));
  q('UPDATE reading_lists SET updated_at = ? WHERE id = ?').run(Date.now(), l.id);
  res.json({ added });
});

router.delete('/reading-lists/:id/items/:bookId', (req, res) => {
  const l = visibleList(req, res, { write: true });
  if (!l) return;
  q('DELETE FROM reading_list_items WHERE list_id = ? AND book_id = ?').run(l.id, Number(req.params.bookId));
  q('UPDATE reading_lists SET updated_at = ? WHERE id = ?').run(Date.now(), l.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// ComicRack reading lists (.cbl)
//
//   <ReadingList><Name>Civil War</Name><Books>
//     <Book Series="Civil War" Number="1" Volume="2006" Year="2006"/> …
//   </Books></ReadingList>
//
// Series are matched by name (ignoring case, punctuation and a "(2006)" at the end), issues by
// number against a book's chapter or volume. When several series share a name, the one whose
// year (in its name or metadata) matches the CBL's Volume or Year wins.

const YEAR_SUFFIX = /\s*\((\d{4})\)\s*$/;
const num = (v) => {
  const n = Number(String(v ?? '').trim().replace(/^#/, '').replace('½', '.5'));
  return Number.isFinite(n) ? n : null;
};

/** Every book the user can see, by normalised series name. */
function bookIndex(user) {
  const age = accessFilter(user, 's');
  const rows = q(`SELECT b.id, b.volume, b.chapter, b.title, s.id AS series_id, s.name, s.year, b.series AS file_series
                  FROM books b JOIN series s ON s.id = b.series_id
                  WHERE b.missing = 0 AND ${age.sql}`).all(...age.args);
  const index = new Map();
  const put = (key, row) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  };
  for (const r of rows) {
    const yearInName = r.name.match(YEAR_SUFFIX)?.[1];
    r.seriesYear = yearInName ? Number(yearInName) : r.year;
    const names = new Set([r.name, r.name.replace(YEAR_SUFFIX, ''), r.file_series, r.file_series?.replace(YEAR_SUFFIX, '')].filter(Boolean));
    for (const n of names) put(normalizeKey(n), r);
  }
  return index;
}

function matchEntry(index, e) {
  const series = String(e.series || '').trim();
  const number = num(e.number);
  const years = [num(e.volume), num(e.year)].filter((y) => y && y > 1900);
  const candidates = [...new Set([...(index.get(normalizeKey(series)) || []), ...(index.get(normalizeKey(series.replace(YEAR_SUFFIX, ''))) || [])])];
  if (!candidates.length) return null;
  const hits = candidates.filter((b) => (number == null
    ? candidates.length === 1 // a one-shot: the series' only book
    : (b.chapter ?? b.volume) === number || (b.chapter == null && b.volume == null && num(String(b.title).match(/(\d+(?:\.\d+)?)\s*$/)?.[1]) === number)));
  if (!hits.length) return null;
  if (hits.length === 1 || !years.length) return hits[0];
  return hits.find((b) => years.includes(b.seriesYear)) || hits[0];
}

/** Import a .cbl (the raw XML as the body). ?name= overrides the list's own name. */
router.post('/reading-lists/import', express.text({ type: () => true, limit: '5mb' }), (req, res) => {
  const xml = String(req.body || '');
  if (!/<ReadingList\b/i.test(xml)) return res.status(400).json({ error: 'That isn’t a ComicRack reading list (.cbl).' });
  const name = cleanName(req.query.name) || cleanName(elements(xml, 'Name')[0]?.text) || 'Imported reading list';
  const entries = elements(xml, 'Book').map((b) => b.attrs).slice(0, MAX_ITEMS);
  if (!entries.length) return res.status(400).json({ error: 'The reading list has no books in it.' });

  const index = bookIndex(req.user);
  const matched = [];
  const unmatched = [];
  for (const e of entries) {
    const hit = matchEntry(index, e);
    if (hit && !matched.includes(hit.id)) matched.push(hit.id);
    else if (!hit) unmatched.push({ series: e.series || null, number: e.number || null, volume: e.volume || null, year: e.year || null });
  }
  const now = Date.now();
  const id = tx(() => {
    const listId = Number(q(`INSERT INTO reading_lists (user_id, name, summary, promoted, source, unmatched, created_at, updated_at)
                             VALUES (?, ?, NULL, 0, 'cbl', ?, ?, ?)`).run(req.user.id, name, unmatched.length ? JSON.stringify(unmatched) : null, now, now).lastInsertRowid);
    matched.forEach((bookId, i) => q('INSERT INTO reading_list_items (list_id, book_id, position) VALUES (?, ?, ?)').run(listId, bookId, i));
    return listId;
  });
  res.status(201).json({ id, name, total: entries.length, matched: matched.length, unmatched: unmatched.length });
});

/** Try the unmatched entries again (after new files arrived). */
router.post('/reading-lists/:id/rematch', (req, res) => {
  const l = visibleList(req, res, { write: true });
  if (!l) return;
  const pending = JSON.parse(l.unmatched || '[]');
  if (!pending.length) return res.json({ matched: 0, unmatched: 0 });
  const index = bookIndex(req.user);
  const still = [];
  const found = [];
  for (const e of pending) {
    const hit = matchEntry(index, e);
    if (hit) found.push(hit.id);
    else still.push(e);
  }
  tx(() => {
    addBooks(l.id, found, req.user);
    q('UPDATE reading_lists SET unmatched = ?, updated_at = ? WHERE id = ?').run(still.length ? JSON.stringify(still) : null, Date.now(), l.id);
  });
  res.json({ matched: found.length, unmatched: still.length });
});

/** Export as .cbl, for ComicRack, Kavita, Komga and friends. */
router.get('/reading-lists/:id/export.cbl', (req, res) => {
  const l = visibleList(req, res);
  if (!l) return;
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const books = listBooks(l.id, req.user);
  const lines = books.map((b) => {
    const s = q('SELECT name, year FROM series WHERE id = ?').get(b.seriesId) || {};
    const series = (s.name || b.series || b.title).replace(YEAR_SUFFIX, '');
    const year = s.name?.match(YEAR_SUFFIX)?.[1] || s.year || '';
    const number = b.chapter ?? b.volume ?? '';
    return `    <Book Series="${esc(series)}" Number="${esc(number)}" Volume="${esc(year)}" Year="${esc(year)}" />`;
  });
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<ReadingList xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  <Name>${esc(l.name)}</Name>\n  <Books>\n${lines.join('\n')}\n  </Books>\n</ReadingList>\n`;
  const file = `${l.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'reading list'}.cbl`;
  res.attachment(file).type('application/xml').send(xml);
});

/** Previous and next book in a list, for the reader (when opened from the list). */
function neighbours(listId, bookId, user) {
  const l = q('SELECT * FROM reading_lists WHERE id = ?').get(Number(listId));
  if (!l || (l.user_id !== user.id && !l.promoted)) return null;
  const books = listBooks(l.id, user);
  const i = books.findIndex((b) => b.id === Number(bookId));
  if (i < 0) return null;
  return { list: { id: l.id, name: l.name, position: i + 1, count: books.length }, prev: books[i - 1] || null, next: books[i + 1] || null };
}

module.exports = { router, neighbours };
