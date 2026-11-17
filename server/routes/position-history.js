'use strict';
const express = require('express');
const { q, tx } = require('../db');
const { getBook } = require('../serialize');
const events = require('../events');
const router = express.Router();
router.get('/books/:id/positions', (req, res) => {
  const book = getBook(req.params.id, req.user);
  if (!book || book.missing) return res.status(404).json({ error: 'Book not found.' });
  const items = q('SELECT * FROM position_history WHERE user_id = ? AND book_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id, book.id)
    .map((row, index) => ({ id: row.id, percent: row.percent, page: row.page, position: row.position, finished: Boolean(row.finished), at: row.at,
      compatible: row.version === book.mtime, current: index === 0 && book.p_updated_at != null && row.position === book.p_position && row.page === book.p_page && row.percent === book.p_percent && Boolean(row.finished) === Boolean(book.p_finished) }));
  const devices = q("SELECT client, MAX(updated_at) AS at FROM client_positions WHERE user_id = ? AND book_id = ? AND client IN ('kobo', 'kosync') GROUP BY client").all(req.user.id, book.id)
    .map(row => ({ client: row.client === 'kosync' ? 'KOReader' : 'Kobo', at: row.at }));
  res.json({ items, devices, updatedAt: book.p_updated_at || null });
});
router.post('/books/:id/positions/:position/restore', (req, res) => {
  const book = getBook(req.params.id, req.user);
  if (!book || book.missing) return res.status(404).json({ error: 'Book not found.' });
  const row = q('SELECT * FROM position_history WHERE id = ? AND book_id = ? AND user_id = ?').get(Number(req.params.position), book.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Position not found.' });
  if (row.version !== book.mtime) return res.status(409).json({ error: 'This file has changed since the position was saved. Use a position from the current version.' });
  // Optimistic concurrency protects progress written by a device while this dialog was open.
  if (req.body?.expectedUpdatedAt !== (book.p_updated_at ?? null)) return res.status(409).json({ error: 'Your position changed on another device. Refresh the history before restoring.' });
  const now = Math.max(Date.now(), (book.p_updated_at || 0) + 1);
  tx(() => {
    if (book.p_updated_at != null) q(`INSERT INTO position_history (user_id, book_id, position, page, percent, finished, version, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, book.id, book.p_position, book.p_page, book.p_percent, book.p_finished, book.mtime, book.p_updated_at);
    q(`INSERT INTO progress (user_id, book_id, position, page, percent, finished, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, book_id) DO UPDATE SET
       position = excluded.position, page = excluded.page, percent = excluded.percent, finished = excluded.finished, updated_at = excluded.updated_at`)
      .run(req.user.id, book.id, row.position, row.page, row.percent, row.finished, now, now);
    // A restored location wins over previously observed native positions without losing anchors.
    q("UPDATE client_positions SET updated_at = MIN(updated_at, ?) WHERE user_id = ? AND book_id = ? AND client IN ('kobo', 'kosync')").run(now - 1, req.user.id, book.id);
  });
  events.emit('progress.updated', { userId: req.user.id, username: req.user.username, bookId: book.id, percent: row.percent, page: row.page, finished: Boolean(row.finished) });
  res.json({ ok: true });
});
module.exports = { router };
