'use strict';

// Content Finder: search plugin sources and download books into libraries.
//   /api/finder/…          users with the "Content Finder" permission
//   /api/admin/plugins/…   admin: install, update, configure and remove plugins

const express = require('express');
const { q } = require('../db');
const { requirePermission, requireAdmin } = require('../auth');
const { canSeeLibrary } = require('../util');
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
    status: str(d?.status, 40),
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
  if (!lib || !canSeeLibrary(req.user, lib.id)) return res.status(400).json({ error: 'Choose a library to download into.' });
  await manager.describe(req.params.plugin);
  if (!Array.isArray(files) || !files.length || files.length > 2000) return res.status(400).json({ error: 'Pick at least one file.' });
  const clean = files.map((f) => f && f.id != null && {
    id: String(f.id).slice(0, 2000), title: str(f.title, 200), format: str(f.format, 20), volume: num(f.volume), chapter: num(f.chapter),
  }).filter(Boolean);
  const ids = downloads.enqueue({
    userId: req.user.id,
    pluginId: req.params.plugin,
    libraryId: lib.id,
    book: { title: str(book?.title, 300) || 'Untitled', author: str(book?.author, 200), series: str(book?.series, 300) },
    files: clean,
  });
  res.status(202).json({ ids });
});

router.get('/downloads/list', (req, res) => {
  const mine = req.user.role === 'admin' ? '' : 'WHERE d.user_id = ?';
  const rows = q(`SELECT d.*, u.username, l.name AS library_name FROM downloads d
                  LEFT JOIN users u ON u.id = d.user_id LEFT JOIN libraries l ON l.id = d.library_id
                  ${mine} ORDER BY d.id DESC LIMIT 100`).all(...(mine ? [req.user.id] : []));
  res.json(rows.map((d) => ({
    id: d.id, plugin: d.plugin_id, title: d.title, status: d.status, received: d.received, total: d.total,
    error: d.error, library: d.library_name, username: d.username, createdAt: d.created_at, finishedAt: d.finished_at,
  })));
});

router.delete('/downloads/:id', (req, res) => {
  const d = q('SELECT * FROM downloads WHERE id = ?').get(Number(req.params.id));
  if (!d || (req.user.role !== 'admin' && d.user_id !== req.user.id)) return res.status(404).json({ error: 'Download not found.' });
  if (['queued', 'downloading'].includes(d.status)) downloads.cancel(d.id);
  else q('DELETE FROM downloads WHERE id = ?').run(d.id);
  res.json({ ok: true });
});

router.delete('/downloads', (req, res) => {
  const mine = req.user.role === 'admin' ? '' : 'AND user_id = ?';
  q(`DELETE FROM downloads WHERE status IN ('done', 'failed') ${mine}`).run(...(mine ? [req.user.id] : []));
  res.json({ ok: true });
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
admin.post('/mihon/extensions/:pkg/:action', async (req, res) => res.json(await suwayomi.extensionAction(req.params.action, req.params.pkg)));

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
  const r = await manager.addRepo(String(req.body?.url || '').trim());
  res.status(201).json(r);
});

admin.delete('/repos/:id', (req, res) => {
  q('DELETE FROM plugin_repos WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = { router, admin };
