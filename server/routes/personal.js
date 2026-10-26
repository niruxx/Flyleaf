'use strict';

// Per-user data: collections, annotations/bookmarks, reading profiles,
// API keys (OPDS), Send-to devices, EPUB fonts and imports.

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { q, tx } = require('../db');
const config = require('../config');
const { requireAdmin, requirePermission } = require('../auth');
const profiles = require('../profiles');
const mailer = require('../mailer');
const { getBook, getSeries, listSeries, seriesBooks } = require('../serialize');
const { annotationRow, readable } = require('./books');
const { json, similarity } = require('../util');
const { normalizeKey } = require('../parser');

const router = express.Router();

// ---------------------------------------------------------------------------
// Collections ("categories")

function collectionRow(c, userId) {
  const items = q('SELECT series_id FROM collection_items WHERE collection_id = ? ORDER BY added_at').all(c.id);
  return {
    id: c.id,
    name: c.name,
    summary: c.summary,
    promoted: Boolean(c.promoted),
    owned: c.user_id === userId,
    count: items.length,
    seriesIds: items.map((i) => i.series_id),
    updatedAt: c.updated_at,
  };
}

function ownCollection(req, res) {
  const c = q('SELECT * FROM collections WHERE id = ?').get(Number(req.params.id));
  if (!c || (c.user_id !== req.user.id && !c.promoted)) {
    res.status(404).json({ error: 'Collection not found.' });
    return null;
  }
  if (c.user_id !== req.user.id && req.method !== 'GET') {
    res.status(403).json({ error: 'Only the owner can change this collection.' });
    return null;
  }
  return c;
}

router.get('/collections', (req, res) => {
  const rows = q('SELECT * FROM collections WHERE user_id = ? OR promoted = 1 ORDER BY name COLLATE NOCASE').all(req.user.id);
  res.json(
    rows.map((c) => {
      const row = collectionRow(c, req.user.id);
      // Cover: first visible series in the collection.
      const first = row.seriesIds.map((id) => getSeries(id, req.user)).find(Boolean);
      return { ...row, coverUrl: first?.coverUrl || null, blur: first?.blur || false };
    }),
  );
});

router.post('/collections', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Give the collection a name.' });
  const promoted = req.user.role === 'admin' && req.body?.promoted ? 1 : 0;
  const now = Date.now();
  const id = Number(q('INSERT INTO collections (user_id, name, summary, promoted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    req.user.id, name, String(req.body?.summary || '').trim() || null, promoted, now, now,
  ).lastInsertRowid);
  for (const sid of [].concat(req.body?.seriesIds || [])) addToCollection(id, Number(sid));
  res.status(201).json({ id });
});

router.get('/collections/:id', (req, res) => {
  const c = ownCollection(req, res);
  if (!c) return;
  res.json(collectionRow(c, req.user.id));
});

router.patch('/collections/:id', (req, res) => {
  const c = ownCollection(req, res);
  if (!c) return;
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 80) : c.name;
  if (!name) return res.status(400).json({ error: 'Give the collection a name.' });
  const summary = req.body?.summary !== undefined ? String(req.body.summary).trim() || null : c.summary;
  const promoted = req.body?.promoted !== undefined && req.user.role === 'admin' ? (req.body.promoted ? 1 : 0) : c.promoted;
  q('UPDATE collections SET name = ?, summary = ?, promoted = ?, updated_at = ? WHERE id = ?').run(name, summary, promoted, Date.now(), c.id);
  res.json({ ok: true });
});

router.delete('/collections/:id', (req, res) => {
  const c = ownCollection(req, res);
  if (!c) return;
  q('DELETE FROM collections WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

function addToCollection(collectionId, seriesId) {
  if (!q('SELECT 1 FROM series WHERE id = ?').get(seriesId)) return false;
  q('INSERT OR IGNORE INTO collection_items (collection_id, series_id, added_at) VALUES (?, ?, ?)').run(collectionId, seriesId, Date.now());
  q('UPDATE collections SET updated_at = ? WHERE id = ?').run(Date.now(), collectionId);
  return true;
}

router.post('/collections/:id/items', (req, res) => {
  const c = ownCollection(req, res);
  if (!c) return;
  const ids = [].concat(req.body?.seriesIds || []).map(Number);
  let added = 0;
  tx(() => {
    for (const sid of ids) if (addToCollection(c.id, sid)) added++;
  });
  res.json({ added });
});

router.delete('/collections/:id/items/:seriesId', (req, res) => {
  const c = ownCollection(req, res);
  if (!c) return;
  q('DELETE FROM collection_items WHERE collection_id = ? AND series_id = ?').run(c.id, Number(req.params.seriesId));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Smart filters: a saved series-list query (genres + status + unread…) shown as a shelf on
// Home and/or in the drawer. The query is the same one GET /series takes.

const FILTER_KEYS = {
  library: 'id', kind: 'str', genre: 'list', tag: 'str', userTag: 'str', person: 'str', status: 'str', userStatus: 'str',
  want: 'flag', collection: 'id', read: 'str', sort: 'str', q: 'str',
};
function cleanFilter(f) {
  const out = {};
  for (const [k, type] of Object.entries(FILTER_KEYS)) {
    const v = f?.[k];
    if (v == null || v === '' || v === false || (Array.isArray(v) && !v.length)) continue;
    if (type === 'id') out[k] = Number(v) || undefined;
    else if (type === 'flag') out[k] = 1;
    else if (type === 'list') out[k] = [].concat(v).map((x) => String(x).slice(0, 100)).slice(0, 20);
    else out[k] = String(v).slice(0, 200);
  }
  return JSON.parse(JSON.stringify(out));
}
const filterRow = (f) => ({ id: f.id, name: f.name, filter: JSON.parse(f.filter), onHome: Boolean(f.on_home), inDrawer: Boolean(f.in_drawer), position: f.position });
const ownFilter = (req) => {
  const f = q('SELECT * FROM smart_filters WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!f) throw Object.assign(new Error('Shelf not found.'), { status: 404, expose: true });
  return f;
};

router.get('/filters', (req, res) => {
  res.json(q('SELECT * FROM smart_filters WHERE user_id = ? ORDER BY position, id').all(req.user.id).map(filterRow));
});

router.post('/filters', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Give the shelf a name.' });
  const filter = cleanFilter(req.body?.filter);
  if (!Object.keys(filter).some((k) => k !== 'sort')) return res.status(400).json({ error: 'Pick at least one filter first.' });
  const pos = q('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM smart_filters WHERE user_id = ?').get(req.user.id).p;
  const id = Number(q('INSERT INTO smart_filters (user_id, name, filter, on_home, in_drawer, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    req.user.id, name, JSON.stringify(filter), req.body?.onHome === false ? 0 : 1, req.body?.inDrawer === false ? 0 : 1, pos, Date.now(),
  ).lastInsertRowid);
  res.status(201).json(filterRow(q('SELECT * FROM smart_filters WHERE id = ?').get(id)));
});

router.patch('/filters/:id', (req, res) => {
  const f = ownFilter(req);
  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim().slice(0, 80) : f.name;
  if (!name) return res.status(400).json({ error: 'Give the shelf a name.' });
  q('UPDATE smart_filters SET name = ?, filter = ?, on_home = ?, in_drawer = ?, position = ? WHERE id = ?').run(
    name,
    b.filter !== undefined ? JSON.stringify(cleanFilter(b.filter)) : f.filter,
    b.onHome !== undefined ? (b.onHome ? 1 : 0) : f.on_home,
    b.inDrawer !== undefined ? (b.inDrawer ? 1 : 0) : f.in_drawer,
    Number.isInteger(b.position) ? b.position : f.position,
    f.id,
  );
  res.json(filterRow(q('SELECT * FROM smart_filters WHERE id = ?').get(f.id)));
});

router.delete('/filters/:id', (req, res) => {
  const f = ownFilter(req);
  q('DELETE FROM smart_filters WHERE id = ?').run(f.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Annotations: highlights (with optional notes) and bookmarks

const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'underline'];

router.get('/annotations', (req, res) => {
  const kind = ['highlight', 'bookmark'].includes(req.query.kind) ? req.query.kind : null;
  const rows = q(`SELECT a.* FROM annotations a WHERE a.user_id = ? ${kind ? 'AND a.kind = ?' : ''} ORDER BY a.updated_at DESC LIMIT 1000`)
    .all(req.user.id, ...(kind ? [kind] : []));
  const bookCache = new Map();
  const out = [];
  for (const a of rows) {
    if (!bookCache.has(a.book_id)) {
      const b = getBook(a.book_id, req.user);
      bookCache.set(a.book_id, b ? { id: b.id, title: b.title, series: b.series_name, seriesId: b.series_id, format: b.format, coverUrl: b.cover ? `/api/books/${b.id}/cover?v=${encodeURIComponent(b.cover)}` : null, version: b.mtime } : null);
    }
    const book = bookCache.get(a.book_id);
    if (book) out.push({ ...annotationRow(a), book });
  }
  res.json(out);
});

router.post('/books/:id/annotations', (req, res) => {
  const book = getBook(req.params.id, req.user);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  const b = req.body || {};
  if (!['highlight', 'bookmark'].includes(b.kind)) return res.status(400).json({ error: 'Unknown annotation type.' });
  if (typeof b.locator !== 'string' || !b.locator || b.locator.length > 2000) return res.status(400).json({ error: 'Missing position.' });
  const now = Date.now();
  const id = Number(q(`INSERT INTO annotations (user_id, book_id, kind, locator, page, percent, text, note, color, chapter, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.user.id, book.id, b.kind, b.locator,
    Number.isInteger(b.page) ? b.page : null,
    Number.isFinite(b.percent) ? b.percent : null,
    b.text ? String(b.text).slice(0, 5000) : null,
    b.note ? String(b.note).slice(0, 10000) : null,
    COLORS.includes(b.color) ? b.color : b.kind === 'highlight' ? 'yellow' : null,
    b.chapter ? String(b.chapter).slice(0, 300) : null,
    now, now,
  ).lastInsertRowid);
  res.status(201).json(annotationRow(q('SELECT * FROM annotations WHERE id = ?').get(id)));
});

router.patch('/annotations/:id', (req, res) => {
  const a = q('SELECT * FROM annotations WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!a) return res.status(404).json({ error: 'Annotation not found.' });
  const note = req.body?.note !== undefined ? (req.body.note ? String(req.body.note).slice(0, 10000) : null) : a.note;
  const color = req.body?.color !== undefined && COLORS.includes(req.body.color) ? req.body.color : a.color;
  q('UPDATE annotations SET note = ?, color = ?, updated_at = ? WHERE id = ?').run(note, color, Date.now(), a.id);
  res.json(annotationRow(q('SELECT * FROM annotations WHERE id = ?').get(a.id)));
});

router.delete('/annotations/:id', (req, res) => {
  q('DELETE FROM annotations WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Reading profiles

router.get('/profiles', (req, res) => res.json({ profiles: profiles.list(req.user.id), defaults: profiles.DEFAULT_SETTINGS }));

router.post('/profiles', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Name the profile.' });
  const id = Number(q('INSERT INTO reading_profiles (user_id, name, settings, is_default, created_at) VALUES (?, ?, ?, 0, ?)').run(
    req.user.id, name, JSON.stringify(profiles.clean(req.body?.settings || {})), Date.now(),
  ).lastInsertRowid);
  res.status(201).json({ id });
});

router.patch('/profiles/:id', (req, res) => {
  const p = q('SELECT * FROM reading_profiles WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'Profile not found.' });
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 60) || p.name : p.name;
  const settings = req.body?.settings ? JSON.stringify({ ...json(p.settings, {}), ...profiles.clean(req.body.settings) }) : p.settings;
  q('UPDATE reading_profiles SET name = ?, settings = ? WHERE id = ?').run(name, settings, p.id);
  if (Array.isArray(req.body?.libraries)) {
    tx(() => {
      q("DELETE FROM profile_bindings WHERE user_id = ? AND profile_id = ? AND target = 'library'").run(req.user.id, p.id);
      for (const libId of req.body.libraries) {
        q(`INSERT INTO profile_bindings (user_id, target, target_id, profile_id) VALUES (?, 'library', ?, ?)
           ON CONFLICT (user_id, target, target_id) DO UPDATE SET profile_id = excluded.profile_id`).run(req.user.id, Number(libId), p.id);
      }
    });
  }
  res.json({ ok: true });
});

router.delete('/profiles/:id', (req, res) => {
  const p = q('SELECT * FROM reading_profiles WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!p) return res.status(404).json({ error: 'Profile not found.' });
  if (p.is_default) return res.status(400).json({ error: 'The default profile can’t be deleted.' });
  q('DELETE FROM reading_profiles WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// Bind a profile to one series (null unbinds).
router.put('/series/:id/profile', (req, res) => {
  const seriesId = Number(req.params.id);
  const pid = req.body?.profileId;
  if (pid == null) {
    q("DELETE FROM profile_bindings WHERE user_id = ? AND target = 'series' AND target_id = ?").run(req.user.id, seriesId);
    return res.json({ ok: true });
  }
  if (!q('SELECT 1 FROM reading_profiles WHERE id = ? AND user_id = ?').get(Number(pid), req.user.id)) return res.status(404).json({ error: 'Profile not found.' });
  q(`INSERT INTO profile_bindings (user_id, target, target_id, profile_id) VALUES (?, 'series', ?, ?)
     ON CONFLICT (user_id, target, target_id) DO UPDATE SET profile_id = excluded.profile_id`).run(req.user.id, seriesId, Number(pid));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API keys (OPDS & third-party clients)

// Keys are managed from a signed-in browser session only, never with another key.
const keyAdmin = [
  requirePermission('apiAccess', 'API access isn’t enabled for your account.'),
  (req, res, next) => (req.user.apiKey ? res.status(403).json({ error: 'API keys can’t manage API keys.' }) : next()),
];

router.get('/api-keys', keyAdmin, (req, res) => {
  res.json(q('SELECT id, name, key, scope, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at').all(req.user.id).map((k) => ({
    id: k.id, name: k.name, key: k.key, scope: k.scope, createdAt: k.created_at, lastUsedAt: k.last_used_at,
  })));
});

router.post('/api-keys', keyAdmin, (req, res) => {
  const name = String(req.body?.name || 'OPDS').trim().slice(0, 60) || 'OPDS';
  const scope = req.body?.scope === 'full' ? 'full' : 'read';
  const key = crypto.randomBytes(24).toString('base64url');
  q('INSERT INTO api_keys (user_id, name, key, scope, created_at) VALUES (?, ?, ?, ?, ?)').run(req.user.id, name, key, scope, Date.now());
  res.status(201).json({ key });
});

router.post('/api-keys/:id/regenerate', keyAdmin, (req, res) => {
  const key = crypto.randomBytes(24).toString('base64url');
  const r = q('UPDATE api_keys SET key = ?, created_at = ?, last_used_at = NULL WHERE id = ? AND user_id = ?').run(key, Date.now(), Number(req.params.id), req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Key not found.' });
  res.json({ key });
});

router.delete('/api-keys/:id', keyAdmin, (req, res) => {
  q('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Send-to devices (Kindle, Kobo, PocketBook… via email)

const PLATFORMS = ['kindle', 'kobo', 'pocketbook', 'other'];

router.get('/devices', (req, res) => {
  res.json({
    devices: q('SELECT id, name, email, platform FROM devices WHERE user_id = ? ORDER BY name').all(req.user.id),
    emailConfigured: mailer.configured(),
  });
});

router.post('/devices', (req, res) => {
  const { name, email, platform } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Name the device.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return res.status(400).json({ error: 'Enter the device’s email address.' });
  const id = Number(q('INSERT INTO devices (user_id, name, email, platform, created_at) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id, String(name).trim().slice(0, 60), email.trim(), PLATFORMS.includes(platform) ? platform : 'other', Date.now(),
  ).lastInsertRowid);
  res.status(201).json({ id });
});

router.delete('/devices/:id', (req, res) => {
  q('DELETE FROM devices WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

async function sendBooks(req, res, books) {
  const device = q('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(Number(req.body?.deviceId), req.user.id);
  if (!device) return res.status(404).json({ error: 'Pick a device.' });
  try {
    const sent = await mailer.sendBooks(device, books);
    res.json({ sent });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}

const canDownload = requirePermission('download', 'Downloading isn’t enabled for your account.');

router.post('/books/:id/send', canDownload, async (req, res) => {
  const book = readable(req, res);
  if (!book) return;
  await sendBooks(req, res, [book]);
});

router.post('/series/:id/send', canDownload, async (req, res) => {
  if (!getSeries(req.params.id, req.user)) return res.status(404).json({ error: 'Series not found.' });
  const ids = seriesBooks(req.params.id, req.user).map((b) => b.id);
  await sendBooks(req, res, ids.map((id) => q('SELECT * FROM books WHERE id = ?').get(id)).filter((b) => b && !b.missing));
});

// ---------------------------------------------------------------------------
// EPUB fonts

const FONT_DIR = path.join(config.dataDir, 'fonts');
fs.mkdirSync(FONT_DIR, { recursive: true });

const BUILTIN_FONTS = [
  { id: 'publisher', name: 'Publisher default', family: null },
  { id: 'literata', name: 'Literata', family: 'Literata', css: '/vendor/fonts/literata/index.css' },
  { id: 'merriweather', name: 'Merriweather', family: 'Merriweather', css: '/vendor/fonts/merriweather/index.css' },
  { id: 'atkinson', name: 'Atkinson Hyperlegible', family: 'Atkinson Hyperlegible', css: '/vendor/fonts/atkinson-hyperlegible/index.css' },
  { id: 'opendyslexic', name: 'OpenDyslexic', family: 'OpenDyslexic', css: '/vendor/fonts/opendyslexic/index.css' },
  { id: 'roboto-flex', name: 'Roboto Flex', family: 'Roboto Flex Variable', css: '/vendor/roboto-flex/index.css' },
  { id: 'serif', name: 'System serif', family: 'Georgia, "Iowan Old Style", "Palatino Linotype", serif' },
  { id: 'sans', name: 'System sans-serif', family: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: 'mono', name: 'Monospace', family: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
];

router.get('/fonts', (req, res) => {
  const custom = q('SELECT id, name, file FROM fonts ORDER BY name').all().map((f) => ({
    id: `custom-${f.id}`,
    name: f.name,
    family: `Flyleaf Custom ${f.id}`,
    url: `/api/fonts/${f.id}/file`,
    custom: true,
  }));
  res.json([...BUILTIN_FONTS, ...custom]);
});

router.get('/fonts/:id/file', (req, res) => {
  const f = q('SELECT file FROM fonts WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path.join(FONT_DIR, path.basename(f.file)));
});

const FONT_EXT = { 'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf' };
router.post('/fonts', requireAdmin, express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
  const name = String(req.get('X-Font-Name') || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Name the font.' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 100) return res.status(400).json({ error: 'Upload a font file.' });
  // Identify by signature: wOF2, wOFF, OTTO, or TrueType 0x00010000.
  const sig = buf.toString('latin1', 0, 4);
  const ext = sig === 'wOF2' ? '.woff2' : sig === 'wOFF' ? '.woff' : sig === 'OTTO' ? '.otf' : buf.readUInt32BE(0) === 0x00010000 ? '.ttf' : FONT_EXT[req.get('content-type')];
  if (!ext) return res.status(400).json({ error: 'Use a .woff2, .woff, .ttf or .otf file.' });
  const file = `${crypto.randomBytes(8).toString('hex')}${ext}`;
  await fsp.writeFile(path.join(FONT_DIR, file), buf);
  const id = Number(q('INSERT INTO fonts (name, file, created_at) VALUES (?, ?, ?)').run(name, file, Date.now()).lastInsertRowid);
  res.status(201).json({ id });
});

router.delete('/fonts/:id', requireAdmin, async (req, res) => {
  const f = q('SELECT * FROM fonts WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'Font not found.' });
  await fsp.rm(path.join(FONT_DIR, path.basename(f.file)), { force: true });
  q('DELETE FROM fonts WHERE id = ?').run(f.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Imports from MyAnimeList

function findSeriesForTitle(user, title, malId) {
  const all = listSeries(user, { limit: 5000 }).items;
  if (malId) {
    const byId = q(`SELECT id FROM series WHERE json_extract(provider_ids, '$.mal') = ? OR links LIKE ?`).all(String(malId), `%myanimelist.net/manga/${malId}%`);
    const hit = byId.map((r) => all.find((s) => s.id === r.id)).find(Boolean);
    if (hit) return hit;
  }
  const key = normalizeKey(title);
  let best = all.find((s) => normalizeKey(s.name) === key || normalizeKey(s.localizedName) === key);
  if (!best) {
    const scored = all.map((s) => ({ s, score: similarity(title, s.name) })).sort((a, b) => b.score - a.score)[0];
    if (scored && scored.score >= 0.88) best = scored.s;
  }
  return best || null;
}

// MAL interest stack → a collection of the matching series in your library.
router.post('/import/mal-stack', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const m = url.match(/myanimelist\.net\/stacks\/(\d+)/i);
  if (!m) return res.status(400).json({ error: 'Paste a MyAnimeList stack URL, e.g. https://myanimelist.net/stacks/12345' });
  let html;
  try {
    const r = await fetch(`https://myanimelist.net/stacks/${m[1]}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Flyleaf importer)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`MyAnimeList returned ${r.status}`);
    html = await r.text();
  } catch (e) {
    return res.status(502).json({ error: `Couldn't load the stack: ${e.message}` });
  }
  const stackName = (html.match(/<title>\s*([^<]+?)\s*(?:-\s*MyAnimeList\.net)?\s*<\/title>/i)?.[1] || `MAL stack ${m[1]}`)
    .replace(/\s*-\s*Interest Stacks.*$/i, '').trim();
  const entries = new Map();
  for (const a of html.matchAll(/href="https:\/\/myanimelist\.net\/(manga|anime)\/(\d+)\/[^"]*"[^>]*>([^<]{2,200})</g)) {
    if (a[1] !== 'manga') continue;
    const title = a[3].replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').trim();
    if (title && !entries.has(a[2])) entries.set(a[2], title);
  }
  if (!entries.size) return res.status(422).json({ error: 'No manga were found in that stack.' });
  const matched = [];
  const unmatched = [];
  for (const [malId, title] of entries) {
    const s = findSeriesForTitle(req.user, title, malId);
    if (s) matched.push(s.id);
    else unmatched.push(title);
  }
  const now = Date.now();
  const id = Number(q('INSERT INTO collections (user_id, name, summary, promoted, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').run(
    req.user.id, stackName.slice(0, 80), `Imported from ${url}`, now, now,
  ).lastInsertRowid);
  tx(() => {
    for (const sid of new Set(matched)) addToCollection(id, sid);
  });
  res.json({ collectionId: id, name: stackName, total: entries.size, matched: new Set(matched).size, unmatched });
});

// MAL list export (XML or .xml.gz) → reading status + Want to Read.
const MAL_STATUS = { 'plan to read': 'plan', reading: 'reading', completed: 'completed', 'on-hold': 'on_hold', dropped: 'dropped' };
router.post('/import/mal-list', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
  let buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Upload your MyAnimeList export file.' });
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const xml = buf.toString('utf8');
  const entries = [...xml.matchAll(/<manga>([\s\S]*?)<\/manga>/g)].map((m) => {
    const tag = (n) => m[1].match(new RegExp(`<${n}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${n}>`))?.[1]?.trim();
    return { title: tag('series_title'), malId: tag('manga_mangadb_id'), status: (tag('my_status') || '').toLowerCase() };
  });
  if (!entries.length) return res.status(422).json({ error: 'That doesn’t look like a MyAnimeList manga list export.' });
  let matched = 0;
  const unmatched = [];
  const now = Date.now();
  tx(() => {
    for (const e of entries) {
      const s = findSeriesForTitle(req.user, e.title, e.malId);
      if (!s) {
        unmatched.push(e.title);
        continue;
      }
      matched++;
      const status = MAL_STATUS[e.status] || null;
      const want = status === 'plan' ? 1 : 0;
      q(`INSERT INTO user_series (user_id, series_id, want_to_read, want_added_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, series_id) DO UPDATE SET status = excluded.status,
           want_to_read = MAX(want_to_read, excluded.want_to_read), want_added_at = COALESCE(want_added_at, excluded.want_added_at),
           updated_at = excluded.updated_at`).run(req.user.id, s.id, want, want ? now : null, status, now);
    }
  });
  res.json({ total: entries.length, matched, unmatched: unmatched.slice(0, 200) });
});

module.exports = { router, BUILTIN_FONTS, addToCollection };
