'use strict';

const express = require('express');
const { q, tx } = require('../db');
const { toBook, getBook } = require('../serialize');

const events = require('../events');
const router = express.Router();

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function serverDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Save reading position. Also the reader's heartbeat: `seconds` of active
 * reading since the last call are added to today's log. `day` is the client's
 * local date so stats line up with the reader's own calendar.
 */
router.put('/books/:id/progress', (req, res) => {
  const bookId = Number(req.params.id);
  if (!getBook(bookId, req.user)) return res.status(404).json({ error: 'Book not found.' });

  const body = req.body || {};
  const now = Date.now();
  const percent = Number.isFinite(Number(body.percent)) ? Math.min(Math.max(Number(body.percent), 0), 1) : null;
  const page = Number.isInteger(body.page) && body.page >= 0 ? body.page : null;
  const position = typeof body.position === 'string' ? body.position.slice(0, 2000) : null;
  const seconds = Math.min(Math.max(Math.round(Number(body.seconds) || 0), 0), 600);
  const day = typeof body.day === 'string' && DAY_RE.test(body.day) ? body.day : serverDay();
  const finished = body.finished === true || (percent != null && percent >= 0.999) ? 1 : null;

  const wasFinished = Boolean(q('SELECT finished FROM progress WHERE user_id = ? AND book_id = ?').get(req.user.id, bookId)?.finished);
  tx(() => {
    q(`INSERT INTO progress (user_id, book_id, position, page, percent, finished, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, book_id) DO UPDATE SET
         position   = COALESCE(excluded.position, position),
         page       = COALESCE(excluded.page, page),
         percent    = COALESCE(?, percent),
         finished   = MAX(finished, excluded.finished),
         updated_at = excluded.updated_at`).run(
      req.user.id,
      bookId,
      position,
      page,
      percent ?? 0,
      finished ?? 0,
      now,
      now,
      percent,
    );
    if (seconds > 0) {
      q(`INSERT INTO reading_log (user_id, book_id, day, seconds) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, book_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`).run(req.user.id, bookId, day, seconds);
    }
  });
  const p = q('SELECT page, percent, finished FROM progress WHERE user_id = ? AND book_id = ?').get(req.user.id, bookId);
  events.emit('progress.updated', { userId: req.user.id, username: req.user.username, bookId, page: p.page, percent: p.percent, finished: Boolean(p.finished) });
  if (p.finished && !wasFinished) events.emit('book.finished', { userId: req.user.id, username: req.user.username, bookId });
  res.json({ ok: true, finished: Boolean(finished) });
});

// Mark as read / unread.
router.post('/books/:id/finished', (req, res) => {
  const bookId = Number(req.params.id);
  if (!getBook(bookId, req.user)) return res.status(404).json({ error: 'Book not found.' });
  const now = Date.now();
  if (req.body?.finished) {
    q(`INSERT INTO progress (user_id, book_id, percent, finished, started_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)
       ON CONFLICT (user_id, book_id) DO UPDATE SET finished = 1, percent = 1, updated_at = excluded.updated_at`).run(req.user.id, bookId, now, now);
    events.emit('book.finished', { userId: req.user.id, username: req.user.username, bookId });
  } else {
    q('DELETE FROM progress WHERE user_id = ? AND book_id = ?').run(req.user.id, bookId);
  }
  res.json({ ok: true });
});

router.get('/stats', (req, res) => {
  const uid = req.user.id;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 365);
  const today = typeof req.query.today === 'string' && DAY_RE.test(req.query.today) ? req.query.today : serverDay();

  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startDay = start.toISOString().slice(0, 10);

  const daily = q(`SELECT day, SUM(seconds) AS seconds FROM reading_log WHERE user_id = ? AND day >= ? AND day <= ?
                   GROUP BY day ORDER BY day`).all(uid, startDay, today);
  const totals = q(`SELECT COALESCE(SUM(seconds), 0) AS seconds, COUNT(DISTINCT day) AS days, COUNT(DISTINCT book_id) AS books
                    FROM reading_log WHERE user_id = ?`).get(uid);
  const finished = q('SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND finished = 1').get(uid).n;
  const inProgress = q('SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND finished = 0').get(uid).n;

  const byKind = q(`SELECT l.kind, SUM(r.seconds) AS seconds FROM reading_log r
                    JOIN books b ON b.id = r.book_id JOIN libraries l ON l.id = b.library_id
                    WHERE r.user_id = ? GROUP BY l.kind`).all(uid);

  const top = q(`SELECT book_id, SUM(seconds) AS seconds FROM reading_log WHERE user_id = ?
                 GROUP BY book_id ORDER BY seconds DESC LIMIT 8`).all(uid);
  const topBooks = top
    .map((t) => {
      const row = getBook(t.book_id, req.user);
      return row ? { book: toBook(row, false, req.user), seconds: t.seconds } : null;
    })
    .filter(Boolean);

  // Streak: consecutive days with reading, ending today (or yesterday, so a streak isn't "lost" before you've read today).
  const allDays = new Set(q('SELECT DISTINCT day FROM reading_log WHERE user_id = ? AND seconds > 0').all(uid).map((r) => r.day));
  let streak = 0;
  const cursor = new Date(`${today}T00:00:00Z`);
  if (!allDays.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (allDays.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  res.json({
    totalSeconds: totals.seconds,
    activeDays: totals.days,
    booksTouched: totals.books,
    finished,
    inProgress,
    streak,
    daily,
    startDay,
    today,
    byKind,
    topBooks,
  });
});

module.exports = { router };
