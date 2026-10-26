'use strict';

const express = require('express');
const path = require('node:path');
const { q, tx } = require('../db');
const { requireAdmin, requirePermission } = require('../auth');
const covers = require('../covers');
const providers = require('../providers');
const metaService = require('../metadata-service');
const scanner = require('../scanner');
const { json, likeArg, uniqBy, mergeLinks } = require('../util');
const { listSeries, getSeries, seriesBooks } = require('../serialize');

const router = express.Router();

const PUB_STATUS = ['ongoing', 'completed', 'hiatus', 'cancelled', 'upcoming'];
const USER_STATUS = ['reading', 'completed', 'on_hold', 'dropped', 'plan'];
const RELATION_KINDS = ['sequel', 'prequel', 'spin_off', 'side_story', 'adaptation', 'alternative', 'other'];

function visibleSeries(req, res) {
  const s = getSeries(req.params.id, req.user);
  if (!s) res.status(404).json({ error: 'Series not found.' });
  return s;
}

// ---------------------------------------------------------------------------
// Listing

router.get('/series', (req, res) => {
  const where = [];
  const args = [];
  const having = [];
  const p = req.query;
  if (p.library) {
    where.push('s.library_id = ?');
    args.push(Number(p.library));
  }
  if (p.kind) {
    where.push('l.kind = ?');
    args.push(String(p.kind));
  }
  let rankIds;
  if (p.q) {
    // Ranked word-start matching across titles, alternative titles, book titles and creators.
    rankIds = require('../search').rankSeries(req.user, String(p.q));
  }
  // A–Z jump: first letter of the sort title ("#" = digits and symbols).
  if (p.letter) {
    const { TITLE_KEY } = require('../serialize');
    const letter = String(p.letter).toUpperCase();
    if (letter === '#') where.push(`upper(substr(${TITLE_KEY}, 1, 1)) NOT BETWEEN 'A' AND 'Z'`);
    else if (/^[A-Z]$/.test(letter)) {
      where.push(`upper(substr(${TITLE_KEY}, 1, 1)) = ?`);
      args.push(letter);
    }
  }
  for (const g of [].concat(p.genre || [])) {
    where.push('EXISTS (SELECT 1 FROM json_each(s.genres) j WHERE lower(j.value) = lower(?))');
    args.push(String(g));
  }
  if (p.tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(s.tags) j WHERE lower(j.value) = lower(?))');
    args.push(String(p.tag));
  }
  if (p.userTag) {
    where.push('EXISTS (SELECT 1 FROM json_each(us.user_tags) j WHERE lower(j.value) = lower(?))');
    args.push(String(p.userTag));
  }
  if (p.person) {
    where.push("EXISTS (SELECT 1 FROM json_each(s.people) j WHERE lower(json_extract(j.value, '$.name')) = lower(?))");
    args.push(String(p.person));
  }
  if (p.status && PUB_STATUS.includes(p.status)) {
    where.push('s.status = ?');
    args.push(p.status);
  }
  if (p.userStatus && USER_STATUS.includes(p.userStatus)) {
    where.push('us.status = ?');
    args.push(p.userStatus);
  }
  if (p.want) where.push('us.want_to_read = 1');
  if (p.collection) {
    where.push('s.id IN (SELECT series_id FROM collection_items ci JOIN collections c ON c.id = ci.collection_id WHERE c.id = ? AND (c.user_id = ? OR c.promoted = 1))');
    args.push(Number(p.collection), req.user.id);
  }
  if (p.read === 'unread') having.push('MAX(p.updated_at) IS NULL');
  if (p.read === 'reading') having.push('MAX(p.updated_at) IS NOT NULL AND SUM(CASE WHEN p.finished = 1 THEN 1 ELSE 0 END) < COUNT(b.id)');
  if (p.read === 'completed') having.push('SUM(CASE WHEN p.finished = 1 THEN 1 ELSE 0 END) = COUNT(b.id)');
  // Opening one library by id is a direct request (lets the admin view a user's library from the admin panel).
  res.json(listSeries(req.user, { where, args, having, sort: p.sort || (rankIds ? 'relevance' : undefined), rankIds, limit: p.limit, offset: p.offset, direct: Boolean(p.library) }));
});

// ---------------------------------------------------------------------------
// Detail

router.get('/series/:id', (req, res) => {
  const s = visibleSeries(req, res);
  if (!s) return;
  const books = seriesBooks(s.id, req.user);
  const relations = q(`SELECT r.kind, r.related_id FROM series_relations r WHERE r.series_id = ?`).all(s.id)
    .map((r) => {
      const rel = getSeries(r.related_id, req.user);
      return rel ? { kind: r.kind, series: rel } : null;
    })
    .filter(Boolean);
  const collections = q(`SELECT c.id, c.name FROM collections c JOIN collection_items ci ON ci.collection_id = c.id
                         WHERE ci.series_id = ? AND (c.user_id = ? OR c.promoted = 1)`).all(s.id, req.user.id);
  const next = books.find((b) => b.progress && !b.progress.finished) || books.find((b) => !b.progress?.finished) || books[0] || null;
  res.json({ ...s, books, relations, collections, nextBookId: next?.id ?? null, stats: seriesStats(s.id, req.user) });
});

// ---------------------------------------------------------------------------
// Ratings & reviews: everyone who can see a series sees its reviews.

function reviewSummary(seriesId, user) {
  const rows = q(`SELECT r.*, COALESCE(u.display_name, u.username) AS name, u.avatar FROM series_reviews r
                  JOIN users u ON u.id = r.user_id WHERE r.series_id = ? ORDER BY r.updated_at DESC`).all(seriesId);
  const rated = rows.filter((r) => r.rating);
  const toReview = (r) => ({
    user: { id: r.user_id, displayName: r.name, avatarUrl: r.avatar ? `/api/users/${r.user_id}/avatar?v=${r.avatar}` : null },
    rating: r.rating,
    body: r.body,
    spoiler: Boolean(r.spoiler),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    mine: r.user_id === user.id,
  });
  return {
    average: rated.length ? rated.reduce((a, r) => a + r.rating, 0) / rated.length : null,
    count: rated.length,
    mine: rows.find((r) => r.user_id === user.id) ? toReview(rows.find((r) => r.user_id === user.id)) : null,
    reviews: rows.filter((r) => r.body || r.rating).map(toReview),
  };
}

router.get('/series/:id/reviews', (req, res) => {
  const s = visibleSeries(req, res);
  if (s) res.json(reviewSummary(s.id, req.user));
});

router.put('/series/:id/review', (req, res) => {
  const s = visibleSeries(req, res);
  if (!s) return;
  const b = req.body || {};
  const rating = b.rating == null || b.rating === '' ? null : Math.round(Number(b.rating));
  if (rating != null && !(rating >= 1 && rating <= 10)) return res.status(400).json({ error: 'Ratings go from ½ to 5 stars.' });
  const body = String(b.body ?? '').trim().slice(0, 5000) || null;
  if (rating == null && !body) {
    q('DELETE FROM series_reviews WHERE user_id = ? AND series_id = ?').run(req.user.id, s.id);
  } else {
    const now = Date.now();
    q(`INSERT INTO series_reviews (user_id, series_id, rating, body, spoiler, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, series_id) DO UPDATE SET rating = excluded.rating, body = excluded.body, spoiler = excluded.spoiler, updated_at = excluded.updated_at`)
      .run(req.user.id, s.id, rating, body, b.spoiler ? 1 : 0, now, now);
  }
  res.json(reviewSummary(s.id, req.user));
});

router.delete('/series/:id/review', (req, res) => {
  const s = visibleSeries(req, res);
  if (!s) return;
  q('DELETE FROM series_reviews WHERE user_id = ? AND series_id = ?').run(req.user.id, s.id);
  res.json(reviewSummary(s.id, req.user));
});

// The admin can remove anyone's review (moderation).
router.delete('/series/:id/reviews/:userId', requireAdmin, (req, res) => {
  const s = visibleSeries(req, res);
  if (!s) return;
  q('DELETE FROM series_reviews WHERE user_id = ? AND series_id = ?').run(Number(req.params.userId), s.id);
  res.json(reviewSummary(s.id, req.user));
});

/** Totals for the series page: files, formats, pages, and your reading time. */
function seriesStats(id, user) {
  const files = q(`SELECT COUNT(*) AS n, SUM(size) AS size, SUM(page_count) AS pages, MIN(added_at) AS first_added,
                          MAX(added_at) AS last_added, MAX(mtime) AS modified
                   FROM books WHERE series_id = ? AND missing = 0`).get(id);
  const formats = q('SELECT format, COUNT(*) AS n FROM books WHERE series_id = ? AND missing = 0 GROUP BY format ORDER BY n DESC').all(id);
  const reading = q(`SELECT COALESCE(SUM(r.seconds), 0) AS seconds, COUNT(DISTINCT r.day) AS days, MIN(r.day) AS first_day, MAX(r.day) AS last_day
                     FROM reading_log r JOIN books b ON b.id = r.book_id WHERE r.user_id = ? AND b.series_id = ?`).get(user.id, id);
  const notes = q(`SELECT a.kind, COUNT(*) AS n FROM annotations a JOIN books b ON b.id = a.book_id
                   WHERE a.user_id = ? AND b.series_id = ? GROUP BY a.kind`).all(user.id, id);
  const out = {
    files: files.n,
    size: files.size || 0,
    pages: files.pages || null,
    formats: formats.map((f) => ({ format: f.format, count: f.n })),
    firstAdded: files.first_added,
    lastAdded: files.last_added,
    secondsRead: reading.seconds,
    daysRead: reading.days,
    firstReadDay: reading.first_day,
    lastReadDay: reading.last_day,
    highlights: notes.find((n) => n.kind === 'highlight')?.n || 0,
    bookmarks: notes.find((n) => n.kind === 'bookmark')?.n || 0,
  };
  if (user.role === 'admin') {
    // The folder the series lives in (common prefix of its files), relative to the library.
    const paths = q('SELECT rel_path FROM books WHERE series_id = ? AND missing = 0').all(id).map((r) => r.rel_path.split(/[\\/]/).slice(0, -1));
    let common = paths[0] || [];
    for (const p of paths) {
      let i = 0;
      while (i < common.length && common[i] === p[i]) i++;
      common = common.slice(0, i);
    }
    out.folder = common.join('/') || '.';
  }
  return out;
}

// "More like this" for one series, and personal recommendations (see recommend.js).
router.get('/series/:id/similar', (req, res) => {
  const s = visibleSeries(req, res);
  if (!s) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 40);
  const ids = require('../recommend').similar(req.user, s.id, limit);
  res.json(ids.length ? listSeries(req.user, { rankIds: ids, sort: 'relevance', limit }).items : []);
});

router.get('/recommendations', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 60);
  const picks = require('../recommend').forYou(req.user, limit);
  if (!picks.length) return res.json([]);
  const why = new Map(picks.map((p) => [p.id, p]));
  const items = listSeries(req.user, { rankIds: picks.map((p) => p.id), sort: 'relevance', limit }).items;
  res.json(items.map((it) => ({ ...it, reason: why.get(it.id)?.reason || null, becauseId: why.get(it.id)?.becauseId || null })));
});

// Per-user state: want to read, reading status, personal tags, blurred artwork.
router.put('/series/:id/user', (req, res) => {
  const s = visibleSeries(req, res);
  if (!s) return;
  const b = req.body || {};
  const cur = q('SELECT * FROM user_series WHERE user_id = ? AND series_id = ?').get(req.user.id, s.id) || {};
  const want = b.wantToRead !== undefined ? (b.wantToRead ? 1 : 0) : cur.want_to_read ?? 0;
  const status = b.status !== undefined ? (USER_STATUS.includes(b.status) ? b.status : null) : cur.status ?? null;
  const blur = b.blur !== undefined ? (b.blur ? 1 : 0) : cur.blur ?? 0;
  let tags = json(cur.user_tags, []);
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags)) return res.status(400).json({ error: 'Tags must be a list.' });
    tags = uniqBy(b.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean), (t) => t.toLowerCase()).slice(0, 30);
  }
  const wantAt = want ? (cur.want_to_read ? cur.want_added_at : Date.now()) : null;
  q(`INSERT INTO user_series (user_id, series_id, want_to_read, want_added_at, status, blur, user_tags, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, series_id) DO UPDATE SET want_to_read = excluded.want_to_read, want_added_at = excluded.want_added_at,
       status = excluded.status, blur = excluded.blur, user_tags = excluded.user_tags, updated_at = excluded.updated_at`).run(
    req.user.id, s.id, want, wantAt, status, blur, JSON.stringify(tags), Date.now(),
  );
  res.json({ wantToRead: Boolean(want), status, blur: Boolean(blur), tags });
});

// All personal tags the user has used, for autocomplete and the nav drawer.
router.get('/user-tags', (req, res) => {
  const rows = q(`SELECT j.value AS name, COUNT(*) AS count FROM user_series us, json_each(us.user_tags) j
                  WHERE us.user_id = ? GROUP BY lower(j.value) ORDER BY name COLLATE NOCASE`).all(req.user.id);
  res.json(rows);
});

function setSeriesFinished(userId, seriesId, finished) {
  const ids = q('SELECT id FROM books WHERE series_id = ?').all(seriesId).map((r) => r.id);
  const now = Date.now();
  tx(() => {
    for (const id of ids) {
      if (finished) {
        q(`INSERT INTO progress (user_id, book_id, percent, finished, started_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)
           ON CONFLICT (user_id, book_id) DO UPDATE SET finished = 1, percent = 1, updated_at = excluded.updated_at`).run(userId, id, now, now);
      } else {
        q('DELETE FROM progress WHERE user_id = ? AND book_id = ?').run(userId, id);
      }
    }
  });
  return ids.length;
}

router.post('/series/:id/finished', (req, res) => {
  const s = visibleSeries(req, res);
  if (!s) return;
  res.json({ ok: true, count: setSeriesFinished(req.user.id, s.id, Boolean(req.body?.finished)) });
});

// ---------------------------------------------------------------------------
// Editing (admin). Edited fields are locked so scans and auto-matching leave them alone.

const EDITABLE = {
  name: 'name',
  localizedName: 'localized_name',
  sortName: 'sort_name',
  summary: 'summary',
  status: 'status',
  publisher: 'publisher',
  year: 'year',
  ageRating: 'age_rating',
  language: 'language',
  genres: 'genres',
  tags: 'tags',
  people: 'people',
  links: 'links',
};

router.patch('/series/:id', requireAdmin, (req, res) => {
  const s = q('SELECT * FROM series WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Series not found.' });
  const body = req.body || {};
  const sets = [];
  const vals = [];
  const locked = new Set(json(s.locked, []));
  for (const [key, col] of Object.entries(EDITABLE)) {
    if (body[key] === undefined) continue;
    let v = body[key];
    switch (key) {
      case 'name':
        v = String(v || '').trim();
        if (!v) return res.status(400).json({ error: 'Series name is required.' });
        break;
      case 'year':
        v = v === '' || v == null ? null : Number(v);
        if (v != null && (!Number.isInteger(v) || v < 0 || v > 3000)) return res.status(400).json({ error: 'Year must be a number.' });
        break;
      case 'ageRating':
        v = v === '' || v == null ? null : Number(v);
        if (v != null && ![0, 1, 2, 3].includes(v)) return res.status(400).json({ error: 'Invalid age rating.' });
        break;
      case 'status':
        v = v || null;
        if (v && !PUB_STATUS.includes(v)) return res.status(400).json({ error: 'Invalid publication status.' });
        break;
      case 'genres':
      case 'tags':
        if (!Array.isArray(v)) return res.status(400).json({ error: `${key} must be a list.` });
        v = JSON.stringify(uniqBy(v.map((x) => String(x).trim()).filter(Boolean), (x) => x.toLowerCase()).slice(0, 60));
        break;
      case 'people':
        if (!Array.isArray(v)) return res.status(400).json({ error: 'People must be a list.' });
        v = JSON.stringify(v.filter((p) => p?.name).map((p) => ({ name: String(p.name).trim(), role: String(p.role || 'Writer').trim() })).slice(0, 60));
        break;
      case 'links':
        if (!Array.isArray(v)) return res.status(400).json({ error: 'Links must be a list.' });
        if (v.some((l) => !/^https?:\/\//i.test(l?.url || ''))) return res.status(400).json({ error: 'Links must start with http:// or https://' });
        v = JSON.stringify(mergeLinks(v.map((l) => ({ source: l.source ? String(l.source).trim() : undefined, url: String(l.url).trim() }))));
        break;
      default:
        v = v == null ? null : String(v).trim() || null;
    }
    sets.push(`${col} = ?`);
    vals.push(v);
    locked.add(col);
  }
  if (sets.length) {
    q(`UPDATE series SET ${sets.join(', ')}, locked = ?, updated_at = ? WHERE id = ?`).run(...vals, JSON.stringify([...locked]), Date.now(), s.id);
  }
  res.json({ ok: true });
});

router.post('/series/:id/unlock', requireAdmin, (req, res) => {
  q("UPDATE series SET locked = '[]', updated_at = ? WHERE id = ?").run(Date.now(), Number(req.params.id));
  res.json({ ok: true });
});

// Re-derive metadata from the files (discarding provider data and edits).
router.post('/series/:id/refresh', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const s = q('SELECT library_id FROM series WHERE id = ?').get(id);
  if (!s) return res.status(404).json({ error: 'Series not found.' });
  q(`UPDATE series SET locked = '[]', metadata_source = NULL, metadata_at = NULL, summary = NULL, genres = '[]', tags = '[]',
     people = '[]', status = NULL, age_rating = NULL, provider_ids = '{}' WHERE id = ?`).run(id);
  const books = q('SELECT b.*, l.kind FROM books b JOIN libraries l ON l.id = b.library_id WHERE b.series_id = ? AND b.missing = 0').all(id);
  for (const b of books) await scanner.processBook({ ...b, meta_locked: 0 }).catch(() => {});
  scanner.seedSeriesFromFiles(id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Artwork

router.get('/series/:id/cover', (req, res) => {
  const s = q('SELECT cover FROM series WHERE id = ?').get(Number(req.params.id));
  if (!s?.cover) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(covers.coverPath(s.cover), (err) => err && !res.headersSent && res.status(404).end());
});

const rawImage = express.raw({ type: ['image/*', 'application/octet-stream'], limit: '25mb' });

async function setSeriesCover(id, buffer, res) {
  const name = await covers.saveSeriesCover(id, buffer);
  if (!name) return res.status(400).json({ error: 'That file is not a supported image.' });
  q('UPDATE series SET cover = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
  res.json({ ok: true });
}

router.put('/series/:id/cover', requireAdmin, rawImage, async (req, res) => {
  const id = Number(req.params.id);
  if (!q('SELECT 1 FROM series WHERE id = ?').get(id)) return res.status(404).json({ error: 'Series not found.' });
  await setSeriesCover(id, req.body, res);
});

router.post('/series/:id/cover/url', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!q('SELECT 1 FROM series WHERE id = ?').get(id)) return res.status(404).json({ error: 'Series not found.' });
  try {
    await setSeriesCover(id, await covers.fetchImage(String(req.body?.url || '')), res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Use a volume's cover as the series artwork.
router.post('/series/:id/cover/book', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const book = q('SELECT cover FROM books WHERE id = ? AND series_id = ?').get(Number(req.body?.bookId), id);
  if (!book?.cover) return res.status(400).json({ error: 'That volume has no cover.' });
  const fsp = require('node:fs/promises');
  await setSeriesCover(id, await fsp.readFile(covers.coverPath(book.cover)), res);
});

router.delete('/series/:id/cover', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await covers.removeSeriesCover(id);
  q('UPDATE series SET cover = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Relations

router.post('/series/:id/relations', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const relatedId = Number(req.body?.relatedId);
  const kind = req.body?.kind;
  if (!RELATION_KINDS.includes(kind)) return res.status(400).json({ error: 'Choose a relationship type.' });
  if (id === relatedId || !q('SELECT 1 FROM series WHERE id = ?').get(relatedId)) return res.status(400).json({ error: 'Pick another series.' });
  q('INSERT INTO series_relations (series_id, related_id, kind) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET kind = excluded.kind').run(id, relatedId, kind);
  res.json({ ok: true });
});

router.delete('/series/:id/relations/:relatedId', requireAdmin, (req, res) => {
  q('DELETE FROM series_relations WHERE series_id = ? AND related_id = ?').run(Number(req.params.id), Number(req.params.relatedId));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Metadata providers

router.get('/metadata/providers', (req, res) => res.json(providers.list()));

router.get('/metadata/search', requireAdmin, async (req, res) => {
  try {
    const p = providers.get(String(req.query.provider));
    res.json(await p.search(String(req.query.q || '').trim()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/series/:id/metadata', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!q('SELECT 1 FROM series WHERE id = ?').get(id)) return res.status(404).json({ error: 'Series not found.' });
  const { provider, providerId, fields, cover } = req.body || {};
  try {
    const p = providers.get(String(provider));
    const result = await p.details(String(providerId));
    const chosen = (Array.isArray(fields) ? fields : metaService.FIELDS).filter((f) => metaService.FIELDS.includes(f) && f !== 'cover');
    if (cover) chosen.push('cover');
    // A manual match overrides locks for the fields the admin ticked.
    await metaService.applyToSeries(id, result, { fields: chosen, force: true, coverPolicy: 'always' });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Download a whole series as a zip

router.get('/series/:id/download', requirePermission('download', 'Downloading isn’t enabled for your account.'), async (req, res) => {
  const s = visibleSeries(req, res);
  if (!s) return;
  const books = q('SELECT path, format, rel_path FROM books WHERE series_id = ? AND missing = 0').all(s.id);
  const { ZipArchive } = require('archiver');
  const zip = new ZipArchive({ store: true });
  const safe = s.name.replace(/[\\/:*?"<>|]+/g, '_');
  res.attachment(`${safe}.zip`);
  zip.on('error', () => res.destroy());
  zip.pipe(res);
  for (const b of books) {
    if (b.format === 'folder' || (b.format === 'audio' && require('../audio').isDirSync(b.path))) zip.directory(b.path, path.basename(b.path));
    else zip.file(b.path, { name: path.basename(b.path) });
  }
  await zip.finalize();
});

module.exports = { router, setSeriesFinished, USER_STATUS, PUB_STATUS, RELATION_KINDS };
