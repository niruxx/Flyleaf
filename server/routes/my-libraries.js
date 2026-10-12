'use strict';

// A user's own libraries, inside the personal folder the admin gave them.
//   GET    /api/me/folders?path=        sub-folders of the personal folder
//   POST   /api/me/folders              { path, name } create a folder
//   GET    /api/me/libraries            your libraries
//   POST   /api/me/libraries            { name, kind, mode, path } path is relative to the personal folder
//   PATCH  /api/me/libraries/:id        { name, kind, mode, autoMetadata }
//   POST   /api/me/libraries/:id/scan
//   DELETE /api/me/libraries/:id        forgets it; files are kept

const fsp = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { q } = require('../db');
const scanner = require('../scanner');
const { LIB_SELECT, libraryRow, validateLibrary, removeLibrary } = require('./library');

const router = express.Router();
const err = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

// Everything here needs a personal folder. Admins manage libraries in Settings → Libraries.
router.use(['/folders', '/libraries'], (req, res, next) => {
  if (req.user.role === 'admin') return next(err('Admins manage libraries in Settings → Libraries.', 400));
  if (!req.user.homeDir) return next(err('You don’t have a personal folder. Ask the admin to set one up.', 403));
  if (req.user.apiKey?.scope === 'read' && req.method !== 'GET') return next(err('This API key is read-only.', 403));
  next();
});

/** Clean relative path segments: no "..", no hidden names, no odd characters. */
function segments(rel) {
  return String(rel || '')
    .replace(/^~\/?/, '')
    .split(/[\\/]+/)
    .map((s) => s.replace(/[:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s && s !== '.' && s !== '..' && !s.startsWith('.'))
    .map((s) => s.slice(0, 150));
}

/** Absolute path inside the user's personal folder. */
function inHome(user, rel) {
  const root = path.resolve(user.homeDir);
  const full = path.resolve(root, ...segments(rel));
  if (full !== root && !full.startsWith(root + path.sep)) throw err('That folder is outside your personal folder.');
  return full;
}
const relOf = (user, full) => path.relative(user.homeDir, full).split(path.sep).join('/');

function ownLibrary(req) {
  const lib = q('SELECT * FROM libraries WHERE id = ? AND owner_id = ?').get(Number(req.params.id), req.user.id);
  if (!lib) throw err('Library not found.', 404);
  return lib;
}

function fsError(e, dir) {
  if (['EROFS', 'EACCES', 'EPERM'].includes(e.code)) {
    return `Flyleaf can't write to ${dir}. Ask the admin to give the Flyleaf service write access to your personal folder.`;
  }
  return e.message;
}

// ---------------------------------------------------------------------------

router.get('/folders', async (req, res) => {
  const dir = inHome(req.user, req.query.path);
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw err(`Can't open that folder: ${e.code || e.message}`);
  }
  const { naturalSort } = require('../archive');
  const libs = q('SELECT id, name, path FROM libraries WHERE owner_id = ?').all(req.user.id);
  res.json({
    home: req.user.homeDir,
    path: relOf(req.user, dir),
    folders: entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort(naturalSort).map((name) => {
      const full = path.join(dir, name);
      const lib = libs.find((l) => l.path === full);
      return { name, path: relOf(req.user, full), library: lib ? { id: lib.id, name: lib.name } : null };
    }),
    library: libs.find((l) => l.path === dir) ? { id: libs.find((l) => l.path === dir).id } : null,
  });
});

router.post('/folders', async (req, res) => {
  const name = segments(req.body?.name);
  if (name.length !== 1) throw err('Give the folder a name.');
  const dir = path.join(inHome(req.user, req.body?.path), name[0]);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    throw err(fsError(e, path.dirname(dir)));
  }
  res.status(201).json({ path: relOf(req.user, dir) });
});

router.get('/libraries', (req, res) => {
  const rows = q(`${LIB_SELECT} WHERE l.owner_id = ? ORDER BY l.name COLLATE NOCASE`).all(req.user.id);
  res.json({ home: req.user.homeDir, libraries: rows.map((l) => libraryRow(l, req.user)) });
});

router.post('/libraries', async (req, res) => {
  let fields;
  try {
    fields = validateLibrary({ mode: req.body?.kind === 'books' ? 'books' : 'komga', ...(req.body || {}) });
  } catch (e) {
    throw err(e.message);
  }
  const dir = inHome(req.user, req.body?.path);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    throw err(fsError(e, dir));
  }
  // Libraries can't overlap: the same file would belong to two libraries.
  const others = q('SELECT path FROM libraries').all().map((l) => l.path);
  for (const p of others) {
    if (p === dir) throw err('That folder is already a library.', 409);
    if (dir.startsWith(p + path.sep) || p.startsWith(dir + path.sep)) throw err('That folder is inside another library (or contains one). Pick a separate folder.', 409);
  }
  const { lastInsertRowid } = q(
    'INSERT INTO libraries (name, path, kind, mode, auto_metadata, cover_policy, sources, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(fields.name, dir, fields.kind, fields.mode, fields.auto_metadata, fields.cover_policy, fields.sources, req.user.id, Date.now());
  scanner.requestScan(Number(lastInsertRowid));
  res.status(201).json({ id: Number(lastInsertRowid), path: `~/${relOf(req.user, dir)}`.replace(/\/$/, '') });
});

router.patch('/libraries/:id', (req, res) => {
  const lib = ownLibrary(req);
  let f;
  try {
    // Users can rename and re-type their library; sources stay at the defaults.
    const { name, kind, mode, autoMetadata } = req.body || {};
    f = validateLibrary({ name, kind, mode, autoMetadata }, lib);
  } catch (e) {
    throw err(e.message);
  }
  q('UPDATE libraries SET name = ?, kind = ?, mode = ?, auto_metadata = ? WHERE id = ?').run(f.name, f.kind, f.mode, f.auto_metadata, lib.id);
  if (f.mode !== lib.mode || f.kind !== lib.kind) {
    q('UPDATE books SET needs_meta = 1 WHERE library_id = ?').run(lib.id);
    scanner.requestScan(lib.id);
  }
  res.json({ ok: true });
});

router.post('/libraries/:id/scan', (req, res) => {
  scanner.requestScan(ownLibrary(req).id);
  res.json({ ok: true });
});

router.delete('/libraries/:id', async (req, res) => {
  await removeLibrary(ownLibrary(req).id);
  res.json({ ok: true });
});

module.exports = { router };
