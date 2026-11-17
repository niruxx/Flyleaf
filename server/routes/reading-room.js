'use strict';
const express = require('express');
const { q } = require('../db');
const { BOOK_SELECT, toBook, getBook, bookSort } = require('../serialize');
const { accessFilter } = require('../util');
const { readingKind, estimateRemaining, validDay } = require('../reading-room');
const router = express.Router();
const MOODS = ['reflective', 'delighted', 'curious', 'moved', 'challenged', 'disappointed'];
const bad = (res, message) => res.status(400).json({ error: message });

router.get('/reading/tonight', (req, res) => {
  const minutes = Number(req.query.minutes ?? 30), speed = Number(req.query.speed ?? 1);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240 || !Number.isFinite(speed) || speed < .5 || speed > 3) return bad(res, 'Choose 5–240 minutes and a listening speed between 0.5 and 3.');
  const kind = ['text', 'comic', 'pdf', 'audio'].includes(req.query.kind) ? req.query.kind : null;
  const scope = accessFilter(req.user, 's');
  const rows = q(`${BOOK_SELECT.replace('SELECT b.*', 'SELECT b.*, bt.chars AS text_chars, us.want_to_read AS wants_read')}
    LEFT JOIN book_text_state bt ON bt.book_id = b.id AND bt.mtime = b.mtime AND bt.error IS NULL
    WHERE b.missing = 0 AND ${scope.sql}`).all(req.user.id, req.user.id, ...scope.args);
  const totals = q(`SELECT b.format, SUM(r.seconds) AS seconds, SUM(r.pages) AS pages FROM reading_log r
    JOIN books b ON b.id = r.book_id JOIN series s ON s.id = b.series_id
    WHERE r.user_id = ? AND r.seconds > 0 AND ${scope.sql} GROUP BY b.format`).all(req.user.id, ...scope.args);
  const pace = {};
  for (const row of totals) {
    const key = readingKind(row);
    pace[key] ||= { seconds: 0, pages: 0 };
    pace[key].seconds += row.seconds; pace[key].pages += row.pages;
  }
  // Only offer the next unread volume in a series, preserving reading order.
  const groups = new Map();
  for (const row of rows) {
    const key = row.series_id == null ? `book-${row.id}` : `series-${row.series_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  let unknown = 0;
  const candidates = [];
  for (const group of groups.values()) {
    group.sort(bookSort);
    const row = group.find(book => !book.p_finished && (book.p_percent || 0) < .999);
    if (!row || (kind && readingKind(row) !== kind)) continue;
    const estimate = estimateRemaining(row, pace, speed);
    if (!estimate) { unknown++; continue; }
    if (estimate.seconds > minutes * 60) continue;
    candidates.push({ row, estimate });
  }
  candidates.sort((a, b) => Number(Boolean(b.row.p_percent)) - Number(Boolean(a.row.p_percent)) ||
    Number(Boolean(b.row.wants_read)) - Number(Boolean(a.row.wants_read)) || b.estimate.seconds - a.estimate.seconds || a.row.id - b.row.id);
  res.json({ minutes, speed, unknown, total: candidates.length, items: candidates.slice(0, 36).map(({ row, estimate }) => ({ book: toBook(row, false, req.user), ...estimate })) });
});

router.get('/journal', (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || (Number(month.slice(0, 4)) < 1970 || Number(month.slice(0, 4)) > 9998)) return bad(res, 'Choose a valid month.');
  const start = `${month}-01`;
  const end = new Date(Date.parse(`${start}T00:00:00Z`)); end.setUTCMonth(end.getUTCMonth() + 1);
  const until = end.toISOString().slice(0, 10), utcFrom = Date.parse(`${start}T00:00:00Z`), utcUntil = end.getTime();
  const fromMs = req.query.from == null ? utcFrom : Number(req.query.from);
  const untilMs = req.query.until == null ? utcUntil : Number(req.query.until);
  if (!Number.isFinite(fromMs) || !Number.isFinite(untilMs) || Math.abs(fromMs - utcFrom) > 14 * 3600000 || Math.abs(untilMs - utcUntil) > 14 * 3600000) return bad(res, 'Invalid month boundaries.');
  const books = new Map();
  const book = id => {
    if (!books.has(id)) { const row = getBook(id, req.user); books.set(id, row && !row.missing ? toBook(row, false, req.user) : null); }
    return books.get(id);
  };
  const reading = q('SELECT * FROM reading_log WHERE user_id = ? AND day >= ? AND day < ? ORDER BY day DESC, book_id').all(req.user.id, start, until)
    .map(row => ({ day: row.day, seconds: row.seconds, pages: row.pages, book: book(row.book_id) })).filter(row => row.book);
  const entries = q('SELECT * FROM journal_entries WHERE user_id = ? AND day >= ? AND day < ? ORDER BY day DESC, id DESC').all(req.user.id, start, until)
    .filter(row => row.book_id == null || book(row.book_id)).map(row => ({ id: row.id, day: row.day, body: row.body, mood: row.mood, book: row.book_id == null ? null : book(row.book_id), createdAt: row.created_at, updatedAt: row.updated_at }));
  const highlights = q("SELECT * FROM annotations WHERE user_id = ? AND kind = 'highlight' AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 500").all(req.user.id, fromMs, untilMs)
    .map(row => ({ id: row.id, text: row.text, note: row.note, locator: row.locator, createdAt: row.created_at, book: book(row.book_id) })).filter(row => row.book);
  res.json({ month, reading, entries, highlights });
});

function entryBody(req, res) {
  const body = req.body || {};
  if (!validDay(body.day)) { bad(res, 'Choose a valid date.'); return null; }
  if (typeof body.body !== 'string' || !body.body.trim() || body.body.length > 10000) { bad(res, 'Write a reflection of up to 10,000 characters.'); return null; }
  if (body.mood != null && !MOODS.includes(body.mood)) { bad(res, 'Choose a valid mood.'); return null; }
  const bookId = body.bookId == null || body.bookId === '' ? null : Number(body.bookId);
  if (bookId != null && (!Number.isSafeInteger(bookId) || !getBook(bookId, req.user))) { res.status(404).json({ error: 'Book not found.' }); return null; }
  return { day: body.day, body: body.body.trim(), mood: body.mood || null, bookId };
}
router.post('/journal', (req, res) => {
  const entry = entryBody(req, res); if (!entry) return;
  const now = Date.now();
  const id = Number(q('INSERT INTO journal_entries (user_id, book_id, day, body, mood, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, entry.bookId, entry.day, entry.body, entry.mood, now, now).lastInsertRowid);
  res.status(201).json({ id });
});
router.put('/journal/:id', (req, res) => {
  const row = q('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!row || (row.book_id != null && !getBook(row.book_id, req.user))) return res.status(404).json({ error: 'Reflection not found.' });
  const entry = entryBody(req, res); if (!entry) return;
  q('UPDATE journal_entries SET book_id = ?, day = ?, body = ?, mood = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(entry.bookId, entry.day, entry.body, entry.mood, Date.now(), row.id, req.user.id);
  res.json({ ok: true });
});
router.delete('/journal/:id', (req, res) => {
  const result = q('DELETE FROM journal_entries WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Reflection not found.' });
  res.json({ ok: true });
});
module.exports = { router };
