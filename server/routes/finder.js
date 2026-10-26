'use strict';

// Content Finder: search plugin sources and download books into libraries.
//   /api/finder/…          users with the "Content Finder" permission
//   /api/admin/plugins/…   admin: install, update, configure and remove plugins

const express = require('express');
const { q } = require('../db');
const { requirePermission, requireAdmin } = require('../auth');
const { canWriteLibrary, json } = require('../util');
const manager = require('../plugins/manager');
const downloads = require('../plugins/downloads');

const router = express.Router();
router.use(requirePermission('contentFinder', 'Content Finder isn’t enabled for your account. Ask the admin.'));

const str = (v, max = 500) => (v == null || v === '' ? null : String(v).slice(0, max));
const httpUrl = (v) => (typeof v === 'string' && /^(https?:\/\/|data:image\/)/i.test(v) ? v.slice(0, 4000) : null);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** Plugins return free-form tables; keep only well-formed fields. `img` rewrites image URLs. */
function cleanItem(i, img = (u) => u) {
  if (!i || i.id == null) return null;
  return {
    id: String(i.id).slice(0, 2000),
    title: str(i.title, 300) || 'Untitled',
    author: str(i.author, 200),
    cover: img(httpUrl(i.cover)),
    summary: str(i.summary, 1000),
    folder: Boolean(i.folder),
  };
}

function cleanResults(r, img) {
  const items = (Array.isArray(r?.items) ? r.items : []).slice(0, 200).map((i) => cleanItem(i, img)).filter(Boolean);
  return { items, hasMore: Boolean(r?.hasMore) && items.length > 0 };
}

function cleanDetails(d, id, img = (u) => u) {
  const files = (Array.isArray(d?.files) ? d.files : []).slice(0, 2000).map((f) => f && f.id != null && {
    id: String(f.id).slice(0, 2000),
    title: str(f.title, 200),
    format: str(f.format, 20)?.toLowerCase() || null,
    size: num(f.size),
    volume: num(f.volume),
    chapter: num(f.chapter),
    language: str(f.language, 10),
    date: str(f.date, 40),
  }).filter(Boolean);
  return {
    id,
    title: str(d?.title, 300) || 'Untitled',
    author: str(d?.author, 200),
    series: str(d?.series, 300),
    cover: img(httpUrl(d?.cover)),
    summary: str(d?.summary, 5000),
    genres: [...new Map((Array.isArray(d?.genres) ? d.genres : []).map((g) => str(g, 60)).filter(Boolean).map((g) => [g.toLowerCase(), g])).values()].slice(0, 20),
    status: str(d?.status, 120),
    // 0 Everyone · 1 Teen (13+) · 2 Mature (17+) · 3 Adults (18+); applied to the series after download.
    ageRating: [0, 1, 2, 3].includes(d?.ageRating) ? d.ageRating : null,
    // How to read it ("webtoon" for vertical strips); becomes the downloader's reader setting for the series.
    layout: ['single', 'double', 'webtoon'].includes(d?.layout) ? d.layout : null,
    url: httpUrl(d?.url),
    files,
  };
}

const page = (req) => Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 500);

/** Image URL rewriter for a source: plugins that ask for it get their images proxied. */
async function imager(id) {
  const { manifest } = await manager.describe(id);
  return manifest.proxyImages ? (u) => (u && /^https?:/i.test(u) ? manager.proxied(id, u) : u) : (u) => u;
}

router.get('/sources', async (req, res) => {
  res.json(await manager.list());
});

// Suggestions from your sources, based on what you read (see discover.js).
router.get('/recommendations', async (req, res) => {
  res.json(await require('../discover').forUser(req.user, { refresh: req.query.refresh === '1', imager }));
});

// ---------------------------------------------------------------------------
// Following series for new chapters (see follows.js)

const follows = require('../follows');

const followRow = (f) => {
  const counts = q(`SELECT COUNT(*) AS n, SUM(found_at > ?) AS recent FROM follow_updates WHERE follow_id = ?`).get(Date.now() - 7 * 86400_000, f.id);
  return {
    id: f.id,
    plugin: f.plugin_id,
    sourceId: f.source_id,
    title: f.title,
    cover: f.cover,
    libraryId: f.library_id,
    library: f.library_id ? q('SELECT name FROM libraries WHERE id = ?').get(f.library_id)?.name ?? null : null,
    autoDownload: Boolean(f.auto_download),
    known: json(f.known, []).length,
    updates: counts.n || 0,
    recentUpdates: counts.recent || 0,
    createdAt: f.created_at,
    lastCheckedAt: f.last_checked_at,
    lastNewAt: f.last_new_at,
    lastError: f.last_error,
  };
};
const ownFollow = (req) => {
  const f = q('SELECT * FROM follows WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!f) throw Object.assign(new Error('You’re not following that.'), { status: 404, expose: true });
  return f;
};

router.get('/follows', (req, res) => {
  const list = q('SELECT * FROM follows WHERE user_id = ? ORDER BY COALESCE(last_new_at, created_at) DESC').all(req.user.id).map(followRow);
  res.json({ follows: list, checkHours: follows.CHECK_HOURS, checking: follows.isRunning() });
});

// Is this item followed? (for the Follow button in an item's details)
router.get('/follows/status', (req, res) => {
  const f = q('SELECT * FROM follows WHERE user_id = ? AND plugin_id = ? AND source_id = ?').get(req.user.id, String(req.query.plugin || ''), String(req.query.id || ''));
  res.json(f ? followRow(f) : null);
});

/** Follow { plugin, sourceId, libraryId, autoDownload, book: { title, author, series, cover, ageRating, layout }, files: [ids now] } */
router.post('/follows', async (req, res) => {
  const b = req.body || {};
  const plugin = String(b.plugin || '');
  const sourceId = str(b.sourceId, 2000);
  if (!plugin || !sourceId) return res.status(400).json({ error: 'Missing the item to follow.' });
  await manager.describe(plugin);
  const lib = b.libraryId ? q('SELECT id FROM libraries WHERE id = ?').get(Number(b.libraryId)) : null;
  if (!lib || !canWriteLibrary(req.user, lib.id)) return res.status(400).json({ error: 'Choose a library for new chapters to go into.' });
  const book = {
    title: str(b.book?.title, 300) || 'Untitled', author: str(b.book?.author, 200), series: str(b.book?.series, 300),
    ageRating: [0, 1, 2, 3].includes(b.book?.ageRating) ? b.book.ageRating : null,
    layout: ['single', 'double', 'webtoon'].includes(b.book?.layout) ? b.book.layout : null,
  };
  // Everything there now counts as seen; only files that appear later are "new".
  const known = (Array.isArray(b.files) ? b.files : []).slice(0, 5000).map((x) => String(x).slice(0, 2000));
  q(`INSERT INTO follows (user_id, plugin_id, source_id, library_id, title, cover, book, known, auto_download, created_at, last_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, plugin_id, source_id) DO UPDATE SET library_id = excluded.library_id, auto_download = excluded.auto_download`)
    .run(req.user.id, plugin, sourceId, lib.id, book.series || book.title, httpUrl(b.book?.cover), JSON.stringify(book), JSON.stringify(known),
      b.autoDownload === false ? 0 : 1, Date.now(), Date.now());
  res.status(201).json(followRow(q('SELECT * FROM follows WHERE user_id = ? AND plugin_id = ? AND source_id = ?').get(req.user.id, plugin, sourceId)));
});

router.patch('/follows/:id', (req, res) => {
  const f = ownFollow(req);
  const b = req.body || {};
  if (b.libraryId !== undefined) {
    if (!q('SELECT 1 FROM libraries WHERE id = ?').get(Number(b.libraryId)) || !canWriteLibrary(req.user, Number(b.libraryId))) {
      return res.status(400).json({ error: 'Choose a library you can download into.' });
    }
    q('UPDATE follows SET library_id = ? WHERE id = ?').run(Number(b.libraryId), f.id);
  }
  if (b.autoDownload !== undefined) q('UPDATE follows SET auto_download = ? WHERE id = ?').run(b.autoDownload ? 1 : 0, f.id);
  res.json(followRow(q('SELECT * FROM follows WHERE id = ?').get(f.id)));
});

router.delete('/follows/:id', (req, res) => {
  const f = ownFollow(req);
  q('DELETE FROM follows WHERE id = ?').run(f.id);
  res.json({ ok: true });
});

router.post('/follows/check', async (req, res) => {
  res.json(await follows.checkAll(req.user.id));
});

/** Match everything you downloaded to its source and follow it: { autoDownload } */
router.post('/follows/sync', async (req, res) => {
  const { created, ...result } = await follows.syncDownloads(req.user.id, { autoDownload: Boolean(req.body?.autoDownload) });
  res.json(result);
});

router.post('/follows/:id/check', async (req, res) => {
  const f = ownFollow(req);
  const fresh = await follows.check(f);
  res.json({ found: fresh.length, follow: followRow(q('SELECT * FROM follows WHERE id = ?').get(f.id)) });
});

/** The Updates feed: new chapters found for your follows, newest first. */
router.get('/updates', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const rows = q(`SELECT u.*, f.title AS follow_title, f.cover, f.plugin_id, f.library_id, d.status AS download_status, d.error AS download_error
                  FROM follow_updates u JOIN follows f ON f.id = u.follow_id LEFT JOIN downloads d ON d.id = u.download_id
                  WHERE u.user_id = ? ORDER BY u.found_at DESC, u.id DESC LIMIT ?`).all(req.user.id, limit);
  res.json(rows.map((u) => {
    const file = json(u.file, {});
    return {
      id: u.id,
      followId: u.follow_id,
      title: u.follow_title,
      cover: u.cover,
      plugin: u.plugin_id,
      file: { ...file, label: follows.fileLabel(file) },
      foundAt: u.found_at,
      // new: not downloaded · queued / downloading / done / failed: its download · downloaded: done and cleared from the list
      status: u.download_status || (u.queued ? 'downloaded' : 'new'),
      error: u.download_error,
    };
  }));
});

/** Download an update that wasn't downloaded automatically. */
router.post('/updates/:id/download', (req, res) => {
  const u = q(`SELECT u.*, f.plugin_id, f.library_id, f.book, f.source_id FROM follow_updates u JOIN follows f ON f.id = u.follow_id
               WHERE u.id = ? AND u.user_id = ?`).get(Number(req.params.id), req.user.id);
  if (!u) return res.status(404).json({ error: 'Update not found.' });
  if (!u.library_id || !canWriteLibrary(req.user, u.library_id)) return res.status(400).json({ error: 'Pick a library for this series first (Following → Library).' });
  const [id] = downloads.enqueue({
    userId: req.user.id,
    pluginId: u.plugin_id,
    libraryId: u.library_id,
    book: { ...json(u.book, {}), sourceId: u.source_id },
    files: [json(u.file, {})],
  });
  q('UPDATE follow_updates SET download_id = ?, queued = 1 WHERE id = ?').run(id, u.id);
  res.json({ ok: true, downloadId: id });
});

// ---------------------------------------------------------------------------
// The series page's "New chapters" panel: where a series came from, whether you follow it, and
// what's downloading for it right now.

/** The Content Finder source of a series (from downloads of its files), with those downloads' items. */
function seriesSource(seriesId, userId) {
  const paths = new Set(q('SELECT path FROM books WHERE series_id = ?').all(seriesId).map((b) => b.path));
  const rows = q("SELECT user_id, plugin_id, library_id, item, file FROM downloads WHERE status = 'done' AND file IS NOT NULL ORDER BY id").all()
    .filter((d) => paths.has(d.file));
  // Prefer the user's own downloads, and ones that remember the item's id at the source.
  const withSource = rows.filter((d) => json(d.item, {}).sourceId);
  const pick = withSource.find((d) => d.user_id === userId) || withSource[0] || rows.find((d) => d.user_id === userId) || rows[0];
  if (!pick) return null;
  const item = json(pick.item, {});
  const same = rows.filter((d) => d.plugin_id === pick.plugin_id && (json(d.item, {}).sourceId || null) === (item.sourceId || null));
  return { pluginId: pick.plugin_id, sourceId: item.sourceId || null, title: item.series || item.bookTitle || item.title, items: same.map((d) => json(d.item, {})), libraryId: pick.library_id };
}

router.get('/series/:id/follow', (req, res) => {
  const s = q('SELECT id, library_id FROM series WHERE id = ?').get(Number(req.params.id));
  if (!s || !require('../serialize').getSeries(s.id, req.user)) return res.status(404).json({ error: 'Series not found.' });
  const src = seriesSource(s.id, req.user.id);
  const f = src?.sourceId ? q('SELECT * FROM follows WHERE user_id = ? AND plugin_id = ? AND source_id = ?').get(req.user.id, src.pluginId, src.sourceId) : null;
  // Downloads in progress for this series, from anyone (so you can see it's on its way).
  const active = src
    ? q("SELECT d.id, d.title, d.status, d.received, d.total, d.item, d.created_at, COALESCE(u.display_name, u.username) AS who FROM downloads d LEFT JOIN users u ON u.id = d.user_id WHERE d.plugin_id = ? AND d.status IN ('queued', 'downloading') ORDER BY d.id").all(src.pluginId)
      .filter((d) => {
        const it = json(d.item, {});
        return src.sourceId ? it.sourceId === src.sourceId : (it.series || it.bookTitle || it.title) === src.title;
      })
      .map((d) => {
        const it = json(d.item, {});
        return { id: d.id, title: d.title, label: follows.fileLabel({ title: it.fileTitle, chapter: it.chapter, volume: it.volume }), status: d.status, received: d.received, total: d.total, by: d.who, mine: d.who === (req.user.displayName || req.user.username) };
      })
    : [];
  const updates = f ? q('SELECT * FROM follow_updates WHERE follow_id = ? ORDER BY found_at DESC LIMIT 5').all(f.id).map((u) => ({ id: u.id, label: follows.fileLabel(json(u.file, {})), foundAt: u.found_at, queued: Boolean(u.queued) })) : [];
  res.json({
    source: src ? { plugin: src.pluginId, sourceId: src.sourceId, name: src.pluginId.split('~').pop() } : null,
    follow: f ? followRow(f) : null,
    active,
    updates,
  });
});

/** Follow from the series page: { autoDownload } */
router.post('/series/:id/follow', async (req, res) => {
  const s = q('SELECT id, library_id FROM series WHERE id = ?').get(Number(req.params.id));
  if (!s || !require('../serialize').getSeries(s.id, req.user)) return res.status(404).json({ error: 'Series not found.' });
  const src = seriesSource(s.id, req.user.id);
  if (!src) return res.status(400).json({ error: 'This series didn’t come from Content Finder, so there’s no source to check for new chapters.' });
  if (!src.sourceId) {
    // Older downloads didn't keep the item's id: find it by title (as "Watch my downloads" does).
    const r = await manager.run(src.pluginId, 'search', [src.title, 1]);
    const { similarity } = require('../util');
    const best = (r?.items || []).filter((i) => i && i.id != null).map((i) => ({ id: String(i.id), score: similarity(i.title, src.title) })).sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < 0.85) return res.status(400).json({ error: `Couldn’t find “${src.title}” on its source any more.` });
    src.sourceId = best.id;
  }
  // New chapters go into the series' own library when you may write there.
  const libraryId = canWriteLibrary(req.user, s.library_id) ? s.library_id : canWriteLibrary(req.user, src.libraryId) ? src.libraryId : null;
  const r = await follows.followGroup(req.user.id, { ...src, libraryId }, { autoDownload: req.body?.autoDownload !== false });
  res.status(201).json({ follow: followRow(q('SELECT * FROM follows WHERE id = ?').get(r.id)), found: r.found });
});

router.get('/:plugin/search', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 200);
  if (!query) return res.json({ items: [], hasMore: false });
  res.json(cleanResults(await manager.run(req.params.plugin, 'search', [query, page(req)]), await imager(req.params.plugin)));
});

router.get('/:plugin/latest', async (req, res) => {
  res.json(cleanResults(await manager.run(req.params.plugin, 'latest', [page(req)]), await imager(req.params.plugin)));
});

router.get('/:plugin/browse', async (req, res) => {
  res.json(cleanResults(await manager.run(req.params.plugin, 'browse', [String(req.query.id || ''), page(req)]), await imager(req.params.plugin)));
});

router.get('/:plugin/details', async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing id.' });
  res.json(cleanDetails(await manager.run(req.params.plugin, 'details', [id]), id, await imager(req.params.plugin)));
});

/**
 * Image proxy for plugins with proxy_images / image(): the plugin can add headers
 * (a login, a Referer) and the browser never needs to reach the source itself.
 */
router.get('/:plugin/image', async (req, res) => {
  const { manifest } = await manager.describe(req.params.plugin);
  if (!manifest.proxyImages) return res.status(404).end();
  if (!manager.validImage(req.params.plugin, String(req.query.u || ''), req.query.s)) return res.status(403).end();
  const runtime = require('../plugins/runtime');
  let spec = { url: String(req.query.u || '') };
  if (manifest.functions.image) spec = (await manager.run(req.params.plugin, 'image', [spec.url])) || spec;
  runtime.checkUrl(spec.url);
  const r = await fetch(spec.url, { headers: { 'User-Agent': runtime.USER_AGENT, ...(spec.headers || {}) }, signal: AbortSignal.timeout(20_000) });
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.startsWith('image/')) return res.status(502).end();
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) return res.status(502).end();
  res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': "default-src 'none'" }).end(buf);
});

/** Queue downloads: { libraryId, book: { title, author, series }, files: [{ id, title, format }] } */
router.post('/:plugin/download', async (req, res) => {
  const { libraryId, book, files } = req.body || {};
  const lib = q('SELECT id FROM libraries WHERE id = ?').get(Number(libraryId));
  if (!lib || !canWriteLibrary(req.user, lib.id)) return res.status(400).json({ error: 'Choose a library you can download into.' });
  await manager.describe(req.params.plugin);
  if (!Array.isArray(files) || !files.length || files.length > 2000) return res.status(400).json({ error: 'Pick at least one file.' });
  const clean = files.map((f) => f && f.id != null && {
    id: String(f.id).slice(0, 2000), title: str(f.title, 200), format: str(f.format, 20), volume: num(f.volume), chapter: num(f.chapter),
  }).filter(Boolean);
  // Tell them now if their storage is already full, rather than failing every file later.
  await require('../storage').check(req.user.id, lib.id, 0);
  const ids = downloads.enqueue({
    userId: req.user.id,
    pluginId: req.params.plugin,
    libraryId: lib.id,
    book: {
      title: str(book?.title, 300) || 'Untitled', author: str(book?.author, 200), series: str(book?.series, 300),
      ageRating: [0, 1, 2, 3].includes(book?.ageRating) ? book.ageRating : null,
      layout: ['single', 'double', 'webtoon'].includes(book?.layout) ? book.layout : null,
      sourceId: str(book?.sourceId, 2000),
    },
    files: clean,
  });
  res.status(202).json({ ids });
});

// A download "needs attention" when it failed on its own (not when you cancelled it).
const NEEDS_ATTENTION = "(d.status = 'failed' AND COALESCE(d.error, '') != 'Cancelled')";

/**
 * Which downloads a request may act on: everyone else only ever sees their own. The admin sees
 * everyone's, or one person's with ?user=<id> (the per-user tabs on the Downloads page).
 */
function scope(req, alias = '') {
  const col = `${alias}user_id`;
  if (req.user.role !== 'admin') return { sql: `AND ${col} = ?`, args: [req.user.id] };
  if (req.query.user) return { sql: `AND ${col} = ?`, args: [Number(req.query.user)] };
  return { sql: '', args: [] };
}

router.get('/downloads/list', (req, res) => {
  const { sql: mine, args } = scope(req, 'd.');
  const select = `SELECT d.*, u.username, COALESCE(u.display_name, u.username) AS user_name, l.name AS library_name FROM downloads d
                  LEFT JOIN users u ON u.id = d.user_id LEFT JOIN libraries l ON l.id = d.library_id`;
  // Everything in progress or failed, however old, so nothing that needs a retry drops off;
  // finished and cancelled ones (the history) only the latest 100 per person.
  const current = q(`${select} WHERE (d.status IN ('queued', 'downloading') OR ${NEEDS_ATTENTION}) ${mine} ORDER BY d.id DESC LIMIT 1000`).all(...args);
  const history = q(`SELECT * FROM (
                       SELECT x.*, ROW_NUMBER() OVER (PARTITION BY x.user_id ORDER BY x.id DESC) AS n FROM (${select}
                       WHERE (d.status = 'done' OR (d.status = 'failed' AND d.error = 'Cancelled')) ${mine}) x
                     ) WHERE n <= 100 ORDER BY id DESC`).all(...args);
  res.json([...current, ...history].map((d) => {
    // Which chapter/volume this was, so a failed one can be told apart from its siblings.
    const item = json(d.item, {});
    return {
      id: d.id, plugin: d.plugin_id, title: d.title, status: d.status, received: d.received, total: d.total,
      error: d.error, library: d.library_name, userId: d.user_id, username: d.username, userName: d.user_name, createdAt: d.created_at, finishedAt: d.finished_at,
      fileTitle: item.fileTitle || null, volume: item.volume ?? null, chapter: item.chapter ?? null,
    };
  }));
});

/** Counts for the Downloads badge in the menu. */
router.get('/downloads/summary', (req, res) => {
  const mine = req.user.role === 'admin' ? '' : 'AND d.user_id = ?';
  const r = q(`SELECT SUM(d.status IN ('queued', 'downloading')) AS active, SUM(${NEEDS_ATTENTION}) AS failed
               FROM downloads d WHERE 1 = 1 ${mine}`).get(...(mine ? [req.user.id] : []));
  res.json({ active: r.active || 0, failed: r.failed || 0 });
});

router.post('/downloads/:id/retry', (req, res) => {
  const d = q('SELECT * FROM downloads WHERE id = ?').get(Number(req.params.id));
  if (!d || (req.user.role !== 'admin' && d.user_id !== req.user.id)) return res.status(404).json({ error: 'Download not found.' });
  if (d.status !== 'failed') return res.status(409).json({ error: 'Only failed downloads can be retried.' });
  res.json({ retried: downloads.retry([d.id]) });
});

/** Retry every failed download (yours; the admin's covers everyone's), except ones you cancelled. */
router.post('/downloads/retry', (req, res) => {
  const { sql: mine, args } = scope(req);
  const ids = q(`SELECT id FROM downloads WHERE status = 'failed' AND COALESCE(error, '') != 'Cancelled' ${mine} ORDER BY id`)
    .all(...args).map((r) => r.id);
  res.json({ retried: downloads.retry(ids) });
});

router.delete('/downloads/:id', (req, res) => {
  const d = q('SELECT * FROM downloads WHERE id = ?').get(Number(req.params.id));
  if (!d || (req.user.role !== 'admin' && d.user_id !== req.user.id)) return res.status(404).json({ error: 'Download not found.' });
  if (['queued', 'downloading'].includes(d.status)) downloads.cancel(d.id);
  else q('DELETE FROM downloads WHERE id = ?').run(d.id);
  res.json({ ok: true });
});

// ?what=history (default): finished and cancelled; ?what=failed: failed ones you've given up on.
router.delete('/downloads', (req, res) => {
  const { sql: mine, args } = scope(req);
  const which = req.query.what === 'failed'
    ? "status = 'failed' AND COALESCE(error, '') != 'Cancelled'"
    : "(status = 'done' OR (status = 'failed' AND error = 'Cancelled'))";
  const { changes } = q(`DELETE FROM downloads WHERE ${which} ${mine}`).run(...args);
  res.json({ removed: Number(changes) });
});

// ---------------------------------------------------------------------------
// Admin: plugin management

const admin = express.Router();
admin.use(requireAdmin);

admin.get('/', async (req, res) => {
  res.json({ installed: await manager.list({ includeDisabled: true }), repos: manager.repos() });
});

admin.get('/catalog', async (req, res) => {
  res.json(await manager.catalog());
});

/** Install: { id, repo } from a repository, { url } of a .lua file, or { source } text. */
admin.post('/', async (req, res) => {
  const { id, repo, url, source } = req.body || {};
  let m;
  if (source) m = await manager.install(String(source));
  else if (url) m = await manager.install(await fetchSource(String(url)), String(url));
  else if (id) m = await manager.installFromCatalog(String(id), repo ?? manager.BUILTIN_REPO);
  else return res.status(400).json({ error: 'Nothing to install.' });
  res.status(201).json({ id: m.id, name: m.name, version: m.version, updated: m.updated });
});

async function fetchSource(url) {
  const runtime = require('../plugins/runtime');
  runtime.checkUrl(url);
  const r = await fetch(url, { headers: { 'User-Agent': runtime.USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw Object.assign(new Error(`${url} returned HTTP ${r.status}`), { status: 502, expose: true });
  return r.text();
}

// Mihon extensions on the connected Suwayomi-Server.
const suwayomi = require('../plugins/suwayomi');
admin.get('/mihon/status', async (req, res) => res.json(await suwayomi.status()));
admin.get('/mihon/extensions', async (req, res) => res.json(await suwayomi.extensions()));
admin.get('/mihon/repos', async (req, res) => res.json(await suwayomi.repos()));
admin.put('/mihon/repos', async (req, res) => res.json(await suwayomi.setRepos(req.body?.repos)));
admin.get('/mihon/suggested-repos', async (req, res) => res.json(await suwayomi.suggestedRepos()));
// An extension .apk (e.g. an old Tachiyomi extension): raw body, ?name=<file name>.
admin.post('/mihon/extensions/apk', express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
  res.status(201).json(await suwayomi.installApk(req.body, req.query.name));
});
// Install/update many extensions at once: { action: 'install' | 'update', pkgNames: [...] }.
admin.get('/mihon/bulk', (req, res) => res.json(suwayomi.bulkStatus()));
admin.post('/mihon/bulk', (req, res) => res.status(202).json(suwayomi.bulkAction(req.body?.action, req.body?.pkgNames)));
admin.delete('/mihon/bulk', (req, res) => res.json(suwayomi.cancelBulk()));
admin.post('/mihon/extensions/:pkg/:action', async (req, res) => res.json(await suwayomi.extensionAction(req.params.action, req.params.pkg)));

// The built-in extension runtime (Suwayomi-Server run and managed by Flyleaf).
const host = require('../plugins/suwayomi-host');
admin.get('/mihon/runtime', (req, res) => res.json(host.status()));
admin.post('/mihon/runtime/install', (req, res) => {
  host.install();
  res.status(202).json(host.status());
});
admin.get('/mihon/runtime/update', async (req, res) => res.json(await host.checkUpdate({ force: req.query.force === '1' })));
admin.post('/mihon/runtime/start', async (req, res) => {
  await host.configure({ enabled: true });
  res.json(host.status());
});
admin.post('/mihon/runtime/stop', async (req, res) => {
  await host.configure({ enabled: false });
  res.json(host.status());
});
admin.post('/mihon/runtime/restart', async (req, res) => {
  await host.restart();
  res.json(host.status());
});
admin.patch('/mihon/runtime', async (req, res) => res.json(await host.configure({ heapMb: req.body?.heapMb })));
admin.get('/mihon/runtime/log', async (req, res) => res.type('text/plain').send(await host.logTail()));
admin.delete('/mihon/runtime', async (req, res) => {
  await host.uninstall({ keepData: req.query.keepData !== '0' });
  res.json(host.status());
});

admin.post('/:id/update', async (req, res) => {
  const m = await manager.update(req.params.id);
  res.json({ id: m.id, version: m.version });
});

admin.patch('/:id', (req, res) => {
  manager.row(req.params.id);
  if (req.body?.enabled !== undefined) q('UPDATE plugins SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, req.params.id);
  if (req.body?.settings) manager.saveSettings(req.params.id, req.body.settings);
  res.json({ ok: true });
});

admin.get('/:id/source', (req, res) => {
  res.type('text/plain').send(manager.row(req.params.id).source);
});

admin.delete('/:id', (req, res) => {
  q('DELETE FROM plugins WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

admin.post('/repos', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  // Mihon/Tachiyomi repositories (index.pb, index.min.json, mihon:// links) belong to Suwayomi, not here.
  if (suwayomi.isMihonRepo(url)) {
    const mihon = q('SELECT settings FROM plugins WHERE id = ?').get(suwayomi.PLUGIN_ID);
    if (!mihon) {
      throw Object.assign(new Error('That’s a Mihon extension repository, not a Flyleaf plugin repository. Install the “Mihon extensions” plugin (it needs Suwayomi-Server), then add it under Extensions.'), { status: 400, expose: true });
    }
    const list = await suwayomi.repos();
    const target = suwayomi.normalizeRepo(url);
    if (list.some((u) => suwayomi.sameRepo(u, target))) return res.status(200).json({ mihon: true, already: true });
    await suwayomi.setRepos([...list, target]);
    return res.status(201).json({ mihon: true });
  }
  const r = await manager.addRepo(url);
  res.status(201).json(r);
});

admin.delete('/repos/:id', (req, res) => {
  q('DELETE FROM plugin_repos WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = { router, admin };
