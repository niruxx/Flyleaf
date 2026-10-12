'use strict';

const express = require('express');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { q, tx } = require('../db');
const { requireAdmin } = require('../auth');
const archive = require('../archive');
const scanner = require('../scanner');
const covers = require('../covers');
const providers = require('../providers');
const { accessFilter, listsLibrary, canWriteLibrary, likeArg, json } = require('../util');
const { BOOK_SELECT, toBook, listSeries } = require('../serialize');

const router = express.Router();

const KINDS = ['books', 'manga', 'comics'];
const MODES = ['komga', 'kavita', 'books'];
const COVER_POLICIES = ['missing', 'always', 'never'];

/**
 * A library as `user` sees it. The admin gets the full path. A user's own library shows
 * its path inside their personal folder ("~/Manga"). Other users get no path at all.
 */
function libraryRow(l, user) {
  const admin = user?.role === 'admin';
  const own = l.owner_id != null && l.owner_id === user?.id;
  let shownPath;
  if (admin) shownPath = l.path;
  else if (own && user.homeDir) {
    const rel = path.relative(user.homeDir, l.path);
    shownPath = rel && !rel.startsWith('..') ? `~/${rel.split(path.sep).join('/')}` : rel === '' ? '~' : undefined;
  }
  return {
    id: l.id,
    name: l.name,
    path: shownPath,
    ownerId: l.owner_id ?? null,
    ownerName: l.owner_name ?? null,
    personal: l.owner_id != null,
    own,
    writable: user ? canWriteLibrary(user, l.id) : false,
    kind: l.kind,
    mode: l.mode,
    autoMetadata: Boolean(l.auto_metadata),
    coverPolicy: l.cover_policy,
    sources: json(l.sources, null) || providers.DEFAULT_SOURCES[l.kind],
    lastScanAt: l.last_scan_at,
    bookCount: l.book_count,
    seriesCount: l.series_count,
  };
}

const LIB_SELECT = `
  SELECT l.*,
    (SELECT COUNT(*) FROM books b WHERE b.library_id = l.id AND b.missing = 0) AS book_count,
    (SELECT COUNT(*) FROM series s WHERE s.library_id = l.id) AS series_count,
    (SELECT COALESCE(u.display_name, u.username) FROM users u WHERE u.id = l.owner_id) AS owner_name
  FROM libraries l`;

// ---------------------------------------------------------------------------
// Home

router.get('/home', (req, res) => {
  const user = req.user;
  const age = accessFilter(user, 's');
  const onDeck = q(`${BOOK_SELECT} WHERE b.missing = 0 AND p.finished = 0 AND p.updated_at IS NOT NULL AND ${age.sql}
                    ORDER BY p.updated_at DESC LIMIT 20`).all(user.id, user.id, ...age.args);
  res.json({
    continueReading: onDeck.map((r) => toBook(r, false, user)),
    wantToRead: listSeries(user, { where: ['us.want_to_read = 1'], sort: 'want', limit: 20 }).items,
    recentlyAdded: listSeries(user, { sort: 'added', limit: 24 }).items,
    recentlyUpdated: listSeries(user, { where: ['s.metadata_at IS NOT NULL', "s.metadata_source != 'none'"], sort: 'updated', limit: 12 }).items,
    libraries: visibleLibraries(user),
  });
});

// ---------------------------------------------------------------------------
// Libraries

/**
 * Libraries `user` browses: shared ones they're allowed plus their own. `all` (admin
 * only, for the admin panel) also includes every user's personal libraries.
 */
function visibleLibraries(user, { all = false } = {}) {
  return q(`${LIB_SELECT} ORDER BY l.owner_id IS NOT NULL, owner_name COLLATE NOCASE, l.name COLLATE NOCASE`).all()
    .filter((l) => (all && user.role === 'admin') || listsLibrary(user, l.id))
    .map((l) => libraryRow(l, user));
}

/**
 * Who a library belongs to: null = shared, the admin's own id = the admin's private
 * library, or another user's id = that user's personal library.
 */
function ownerField(body, current, admin) {
  if (body.ownerId === undefined) return current ?? null;
  if (body.ownerId === null || body.ownerId === '') return null;
  const u = q('SELECT id, role FROM users WHERE id = ?').get(Number(body.ownerId));
  if (!u || (u.role === 'admin' && u.id !== admin.id)) throw new Error('Choose who this library is for: you, a user, or shared.');
  return u.id;
}

router.get('/libraries', (req, res) => {
  res.json(visibleLibraries(req.user, { all: req.query.scope === 'all' }));
});

function validateLibrary(body, current = {}) {
  const out = {
    name: body.name !== undefined ? String(body.name).trim().slice(0, 80) : current.name,
    kind: body.kind ?? current.kind,
    mode: body.mode ?? current.mode ?? 'komga',
    auto_metadata: body.autoMetadata !== undefined ? (body.autoMetadata ? 1 : 0) : current.auto_metadata ?? 0,
    cover_policy: body.coverPolicy ?? current.cover_policy ?? 'missing',
    sources: body.sources !== undefined ? JSON.stringify(body.sources) : current.sources ?? null,
  };
  if (!out.name) throw new Error('Give the library a name.');
  if (!KINDS.includes(out.kind)) throw new Error('Choose a library type.');
  if (!MODES.includes(out.mode)) throw new Error('Choose a folder structure.');
  if (!COVER_POLICIES.includes(out.cover_policy)) throw new Error('Invalid artwork option.');
  if (body.sources !== undefined) {
    if (!Array.isArray(body.sources) || body.sources.some((s) => typeof s !== 'string')) throw new Error('Invalid metadata sources.');
    for (const s of body.sources) providers.get(s);
  }
  return out;
}

router.post('/libraries', requireAdmin, async (req, res) => {
  let fields;
  let owner;
  try {
    fields = validateLibrary(req.body || {});
    owner = ownerField(req.body || {}, null, req.user);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  let dir = String(req.body?.path || '').trim();
  if (!path.isAbsolute(dir)) return res.status(400).json({ error: 'Use an absolute folder path.' });
  dir = path.resolve(dir);
  const st = await fsp.stat(dir).catch(() => null);
  if (!st?.isDirectory()) return res.status(400).json({ error: "That folder doesn't exist or isn't readable." });
  if (q('SELECT 1 FROM libraries WHERE path = ?').get(dir)) return res.status(409).json({ error: 'That folder is already a library.' });
  const { lastInsertRowid } = q(
    'INSERT INTO libraries (name, path, kind, mode, auto_metadata, cover_policy, sources, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(fields.name, dir, fields.kind, fields.mode, fields.auto_metadata, fields.cover_policy, fields.sources, owner, Date.now());
  scanner.requestScan(Number(lastInsertRowid));
  res.status(201).json({ id: Number(lastInsertRowid) });
});

router.patch('/libraries/:id', requireAdmin, (req, res) => {
  const lib = q('SELECT * FROM libraries WHERE id = ?').get(Number(req.params.id));
  if (!lib) return res.status(404).json({ error: 'Library not found.' });
  let f;
  let owner;
  try {
    f = validateLibrary(req.body || {}, lib);
    owner = ownerField(req.body || {}, lib.owner_id, req.user);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  q('UPDATE libraries SET name = ?, kind = ?, mode = ?, auto_metadata = ?, cover_policy = ?, sources = ?, owner_id = ? WHERE id = ?').run(
    f.name, f.kind, f.mode, f.auto_metadata, f.cover_policy, f.sources, owner, lib.id,
  );
  // Changing type or folder structure regroups series.
  if (f.mode !== lib.mode || f.kind !== lib.kind) {
    q('UPDATE books SET needs_meta = 1 WHERE library_id = ?').run(lib.id);
    scanner.requestScan(lib.id);
  } else if (f.auto_metadata && !lib.auto_metadata) {
    require('../metadata-service').queueAuto(lib.id);
  }
  res.json({ ok: true });
});

/** Forget a library (its files on disk are never touched). */
async function removeLibrary(id) {
  const bookIds = q('SELECT id FROM books WHERE library_id = ?').all(id).map((r) => r.id);
  const seriesIds = q('SELECT id FROM series WHERE library_id = ?').all(id).map((r) => r.id);
  q('DELETE FROM libraries WHERE id = ?').run(id);
  for (const b of bookIds) await covers.removeCovers(b);
  for (const s of seriesIds) await covers.removeSeriesCover(s);
}

router.delete('/libraries/:id', requireAdmin, async (req, res) => {
  await removeLibrary(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/libraries/:id/scan', requireAdmin, (req, res) => {
  scanner.requestScan(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/libraries/:id/match', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  // Retry series that previously found no match.
  q("UPDATE series SET metadata_source = NULL WHERE library_id = ? AND metadata_source = 'none'").run(id);
  require('../metadata-service').queueAuto(id);
  res.json({ ok: true });
});

router.post('/scan', requireAdmin, (req, res) => {
  scanner.requestScan(null);
  res.json({ ok: true });
});

router.get('/scan/status', (req, res) => res.json(scanner.state));

router.post('/libraries/:id/cleanup', requireAdmin, async (req, res) => {
  const libId = Number(req.params.id);
  const ids = q('SELECT id FROM books WHERE library_id = ? AND missing = 1').all(libId).map((r) => r.id);
  tx(() => {
    for (const id of ids) q('DELETE FROM books WHERE id = ?').run(id);
    q('DELETE FROM series WHERE library_id = ? AND id NOT IN (SELECT DISTINCT series_id FROM books WHERE series_id IS NOT NULL)').run(libId);
  });
  for (const id of ids) await covers.removeCovers(id);
  res.json({ removed: ids.length });
});

// Folder picker for adding libraries.
router.get('/fs', requireAdmin, async (req, res) => {
  const dir = path.resolve(String(req.query.path || os.homedir()));
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: `Can't open ${dir}: ${err.code || err.message}` });
  }
  const dirs = [];
  let bookFiles = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) isDir = (await fsp.stat(path.join(dir, e.name)).catch(() => null))?.isDirectory();
    if (isDir) dirs.push({ name: e.name, path: path.join(dir, e.name) });
    else if (scanner.FILE_FORMATS[path.extname(e.name).toLowerCase()]) bookFiles++;
  }
  dirs.sort((a, b) => archive.naturalSort(a.name, b.name));
  const parent = path.dirname(dir);
  res.json({ path: dir, parent: parent !== dir ? parent : null, dirs, bookFiles, sep: path.sep });
});

// ---------------------------------------------------------------------------
// Browsing facets

router.get('/genres', (req, res) => {
  const age = accessFilter(req.user, 's');
  const rows = q(`SELECT j.value AS name, COUNT(DISTINCT s.id) AS count
                  FROM series s, json_each(s.genres) j
                  WHERE ${age.sql} AND EXISTS (SELECT 1 FROM books b WHERE b.series_id = s.id AND b.missing = 0)
                  GROUP BY lower(j.value) ORDER BY count DESC, name COLLATE NOCASE`).all(...age.args);
  res.json(rows);
});

// Global search for the top bar.
router.get('/search', (req, res) => {
  const term = String(req.query.q || '').trim();
  if (!term) return res.json({ series: [], books: [], people: [], genres: [], collections: [] });
  const like = likeArg(term);
  const user = req.user;
  const limit = Math.min(Number(req.query.limit) || 8, 100);
  const series = listSeries(user, {
    where: [`(s.name LIKE ? ESCAPE '\\' OR s.localized_name LIKE ? ESCAPE '\\' OR s.sort_name LIKE ? ESCAPE '\\'
             OR EXISTS (SELECT 1 FROM json_each(s.people) j WHERE json_extract(j.value, '$.name') LIKE ? ESCAPE '\\'))`],
    args: [like, like, like, like],
    limit,
  }).items;
  const age = accessFilter(user, 's');
  const books = q(`${BOOK_SELECT} WHERE b.missing = 0 AND ${age.sql} AND (b.title LIKE ? ESCAPE '\\' OR b.author LIKE ? ESCAPE '\\')
                   ORDER BY b.title COLLATE NOCASE LIMIT ?`).all(user.id, user.id, ...age.args, like, like, limit).map((r) => toBook(r, false, user));
  const people = q(`SELECT DISTINCT json_extract(j.value, '$.name') AS name FROM series s, json_each(s.people) j
                    WHERE ${age.sql} AND json_extract(j.value, '$.name') LIKE ? ESCAPE '\\' LIMIT ?`).all(...age.args, like, limit).map((r) => r.name);
  const genres = q(`SELECT DISTINCT j.value AS name FROM series s, json_each(s.genres) j
                    WHERE ${age.sql} AND j.value LIKE ? ESCAPE '\\' LIMIT ?`).all(...age.args, like, limit).map((r) => r.name);
  const collections = q(`SELECT id, name FROM collections WHERE (user_id = ? OR promoted = 1) AND name LIKE ? ESCAPE '\\' LIMIT ?`).all(user.id, like, limit);
  res.json({ series, books, people, genres, collections });
});

module.exports = { router, KINDS, LIB_SELECT, libraryRow, validateLibrary, removeLibrary };
