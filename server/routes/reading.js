'use strict';

const express = require('express');
const { q, tx } = require('../db');
const { toBook, getBook } = require('../serialize');

const events = require('../events');
const router = express.Router();

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Pages read: comics and PDFs count real pages; ebooks have no fixed pages, so their length is
// estimated from the indexed text (about 1,800 characters a page) or, before indexing, the file
// size. Each save counts at most MAX_PAGES_PER_SAVE, so jumping to the end with the slider
// doesn't count as reading the whole book.
const CHARS_PER_PAGE = 1800;
const MAX_PAGES_PER_SAVE = 40;
const IMAGE_FORMATS = new Set(['cbz', 'cbr', 'cb7', 'cbt', 'folder', 'pdf']);

/** How many pages a book has, for counting pages read (0 for audiobooks). */
function bookPages(row) {
  if (row.format === 'audio') return 0;
  if (IMAGE_FORMATS.has(row.format)) return row.page_count || 0;
  const chars = q('SELECT chars FROM book_text_state WHERE book_id = ?').get(row.id)?.chars;
  if (chars) return Math.max(1, Math.round(chars / CHARS_PER_PAGE));
  return Math.max(1, Math.round((row.size || 0) / 4000));
}

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

  const before = q('SELECT finished, page, percent FROM progress WHERE user_id = ? AND book_id = ?').get(req.user.id, bookId);
  const wasFinished = Boolean(before?.finished);
  // Pages read since the last save (forwards only).
  const row = getBook(bookId, req.user);
  const total = bookPages(row);
  let pages = 0;
  if (total) {
    if (IMAGE_FORMATS.has(row.format) && page != null) pages = page - (before?.page ?? -1);
    else if (percent != null) pages = Math.round((percent - (before?.percent ?? 0)) * total);
    pages = Math.max(0, Math.min(pages, MAX_PAGES_PER_SAVE));
  }
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
    if (seconds > 0 || pages > 0) {
      q(`INSERT INTO reading_log (user_id, book_id, day, seconds, pages) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, book_id, day) DO UPDATE SET seconds = seconds + excluded.seconds, pages = pages + excluded.pages`).run(req.user.id, bookId, day, seconds, pages);
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

  const allDays = readingDays(uid);
  const year = Number(today.slice(0, 4));
  const goal = q('SELECT books, pages FROM reading_goals WHERE user_id = ? AND year = ?').get(uid, year);
  const todaySeconds = q('SELECT COALESCE(SUM(seconds), 0) AS s FROM reading_log WHERE user_id = ? AND day = ?').get(uid, today).s;

  // A year of days for the heat map, starting on a Sunday so the columns line up as weeks.
  const heatStart = new Date(`${today}T00:00:00Z`);
  heatStart.setUTCDate(heatStart.getUTCDate() - 364);
  heatStart.setUTCDate(heatStart.getUTCDate() - heatStart.getUTCDay());
  const heatStartDay = heatStart.toISOString().slice(0, 10);
  const heatmap = q(`SELECT day, SUM(seconds) AS seconds FROM reading_log WHERE user_id = ? AND day >= ? AND day <= ?
                     GROUP BY day ORDER BY day`).all(uid, heatStartDay, today);

  res.json({
    longestStreak: longestStreak(allDays),
    goal: { year, books: goal?.books ?? null, finished: finishedInYear(uid, year), pages: goal?.pages ?? null, pagesRead: pagesInYear(uid, year) },
    dailyGoalMinutes: Number(req.user.prefs.dailyGoalMinutes) || 0,
    todaySeconds,
    heatmap,
    heatStartDay,
    totalSeconds: totals.seconds,
    activeDays: totals.days,
    booksTouched: totals.books,
    finished,
    inProgress,
    streak: currentStreak(allDays, today),
    daily,
    startDay,
    today,
    byKind,
    topBooks,
  });
});

// ---------------------------------------------------------------------------
// Streaks and goals

const nextDay = (day, by = 1) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};

/** Days (YYYY-MM-DD) with any reading, as a Set. */
const readingDays = (uid, from = '0000', to = '9999') =>
  new Set(q('SELECT DISTINCT day FROM reading_log WHERE user_id = ? AND seconds > 0 AND day >= ? AND day <= ?').all(uid, from, to).map((r) => r.day));

/** Consecutive days with reading ending today (or yesterday, so a streak isn't "lost" before you've read today). */
function currentStreak(days, today) {
  let streak = 0;
  let cursor = days.has(today) ? today : nextDay(today, -1);
  while (days.has(cursor)) {
    streak++;
    cursor = nextDay(cursor, -1);
  }
  return streak;
}

/** The longest run of consecutive reading days, with when it started. */
function longestStreak(days) {
  let best = { days: 0, start: null, end: null };
  for (const day of days) {
    if (days.has(nextDay(day, -1))) continue; // not the start of a run
    let end = day;
    let n = 1;
    while (days.has(nextDay(end))) {
      end = nextDay(end);
      n++;
    }
    if (n > best.days) best = { days: n, start: day, end };
  }
  return best;
}

const yearRange = (year) => [Date.UTC(year, 0, 1) - 14 * 3600_000, Date.UTC(year + 1, 0, 1) + 14 * 3600_000];

/** Books finished during a calendar year (finish times are stored in ms; widened for time zones). */
function finishedInYear(uid, year) {
  const [from, to] = yearRange(year);
  return q('SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND finished = 1 AND finished_at >= ? AND finished_at < ?').get(uid, from, to).n;
}

/** Pages read during a calendar year (counted as you read; see bookPages). */
function pagesInYear(uid, year) {
  return q('SELECT COALESCE(SUM(pages), 0) AS n FROM reading_log WHERE user_id = ? AND day BETWEEN ? AND ?').get(uid, `${year}-01-01`, `${year}-12-31`).n;
}

/** Set this year's goals: { year, books?, pages? } – a field left out stays as it is, null or 0 removes it. */
router.put('/stats/goal', (req, res) => {
  const b = req.body || {};
  const year = Number(b.year) || new Date().getFullYear();
  if (year < 2000 || year > 2200) return res.status(400).json({ error: 'Pick a year.' });
  const cur = q('SELECT books, pages FROM reading_goals WHERE user_id = ? AND year = ?').get(req.user.id, year) || {};
  const read = (v, max, what) => {
    if (v === undefined) return undefined;
    if (v == null || v === '' || Number(v) <= 0) return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n > max) throw Object.assign(new Error(`Pick a goal between 1 and ${max.toLocaleString('en-US')} ${what}.`), { status: 400, expose: true });
    return n;
  };
  const books = read(b.books, 10_000, 'books') ?? (b.books === undefined ? cur.books ?? null : null);
  const pages = read(b.pages, 1_000_000, 'pages') ?? (b.pages === undefined ? cur.pages ?? null : null);
  if (books == null && pages == null) q('DELETE FROM reading_goals WHERE user_id = ? AND year = ?').run(req.user.id, year);
  else {
    q(`INSERT INTO reading_goals (user_id, year, books, pages) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, year) DO UPDATE SET books = excluded.books, pages = excluded.pages`).run(req.user.id, year, books, pages);
  }
  res.json({ year, books, pages, finished: finishedInYear(req.user.id, year), pagesRead: pagesInYear(req.user.id, year) });
});

// ---------------------------------------------------------------------------
// Year in review

router.get('/stats/year', (req, res) => {
  const uid = req.user.id;
  const year = Number(req.query.year) || new Date().getFullYear();
  if (year < 2000 || year > 2200) return res.status(400).json({ error: 'Pick a year.' });
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const [fromMs, toMs] = yearRange(year);

  const totals = q(`SELECT COALESCE(SUM(seconds), 0) AS seconds, COUNT(DISTINCT day) AS days, COUNT(DISTINCT book_id) AS books
                    FROM reading_log WHERE user_id = ? AND day BETWEEN ? AND ?`).get(uid, from, to);
  const days = readingDays(uid, from, to);

  const byMonth = Array(12).fill(0);
  const byWeekday = Array(7).fill(0);
  let busiest = null;
  for (const r of q('SELECT day, SUM(seconds) AS seconds FROM reading_log WHERE user_id = ? AND day BETWEEN ? AND ? GROUP BY day').all(uid, from, to)) {
    byMonth[Number(r.day.slice(5, 7)) - 1] += r.seconds;
    byWeekday[new Date(`${r.day}T00:00:00Z`).getUTCDay()] += r.seconds;
    if (!busiest || r.seconds > busiest.seconds) busiest = r;
  }

  const finishedRows = q(`SELECT book_id, finished_at FROM progress WHERE user_id = ? AND finished = 1 AND finished_at >= ? AND finished_at < ?
                          ORDER BY finished_at`).all(uid, fromMs, toMs);
  const finishedBooks = finishedRows
    .map((r) => {
      const row = getBook(r.book_id, req.user);
      return row ? { ...toBook(row, false, req.user), finishedAt: r.finished_at } : null;
    })
    .filter(Boolean);
  const pages = pagesInYear(uid, year) || finishedBooks.reduce((a, b) => a + (b.pageCount || 0), 0);

  // Series, genres and creators, weighted by time spent reading them this year.
  const perSeries = q(`SELECT b.series_id AS id, SUM(r.seconds) AS seconds FROM reading_log r JOIN books b ON b.id = r.book_id
                       WHERE r.user_id = ? AND r.day BETWEEN ? AND ? AND b.series_id IS NOT NULL
                       GROUP BY b.series_id ORDER BY seconds DESC`).all(uid, from, to);
  const { getSeries } = require('../serialize');
  const genres = new Map();
  const people = new Map();
  const topSeries = [];
  for (const row of perSeries) {
    const s = getSeries(row.id, req.user);
    if (!s) continue;
    if (topSeries.length < 6) topSeries.push({ series: s, seconds: row.seconds });
    for (const g of s.genres || []) genres.set(g, (genres.get(g) || 0) + row.seconds);
    for (const p of (s.people || []).filter((x) => /writer|author|story|creator/i.test(x.role))) people.set(p.name, (people.get(p.name) || 0) + row.seconds);
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, seconds]) => ({ name, seconds }));

  const byKind = q(`SELECT l.kind, SUM(r.seconds) AS seconds FROM reading_log r
                    JOIN books b ON b.id = r.book_id JOIN libraries l ON l.id = b.library_id
                    WHERE r.user_id = ? AND r.day BETWEEN ? AND ? GROUP BY l.kind ORDER BY seconds DESC`).all(uid, from, to);
  const highlights = q("SELECT COUNT(*) AS n FROM annotations WHERE user_id = ? AND kind = 'highlight' AND created_at >= ? AND created_at < ?").get(uid, fromMs, toMs).n;
  const goal = q('SELECT books, pages FROM reading_goals WHERE user_id = ? AND year = ?').get(uid, year);
  const years = q("SELECT DISTINCT substr(day, 1, 4) AS y FROM reading_log WHERE user_id = ? ORDER BY y DESC").all(uid).map((r) => Number(r.y));

  res.json({
    year,
    years,
    totalSeconds: totals.seconds,
    activeDays: totals.days,
    booksOpened: totals.books,
    finished: finishedBooks.length,
    finishedBooks,
    pages,
    longestStreak: longestStreak(days),
    busiestDay: busiest,
    byMonth,
    byWeekday,
    byKind,
    topSeries,
    topGenres: top(genres, 5),
    topCreators: top(people, 5),
    highlights,
    goal: goal?.books ?? null,
    pagesGoal: goal?.pages ?? null,
  });
});

module.exports = { router };
