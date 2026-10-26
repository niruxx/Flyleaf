'use strict';

// Uploading books, comics and image folders into a library from the browser.
//   GET  /api/uploads/folders?library=&path=   sub-folders inside a library
//   POST /api/uploads/folders                  create a folder { libraryId, path, name }
//   PUT  /api/uploads/file?library=&folder=&name=   raw file body (name may contain sub-folders)
//   POST /api/uploads/done                     { libraryId, files, collectionId } → scan (+ add to collection)

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const express = require('express');
const { q } = require('../db');
const config = require('../config');
const { requirePermission } = require('../auth');
const { canWriteLibrary } = require('../util');
const { IMAGE_EXT } = require('../archive');
const events = require('../events');
const log = require('../log').logger('uploads');

const router = express.Router();
router.use(requirePermission('upload', 'Uploading isn’t enabled for your account. Ask the admin.'));

const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB || 4096) * 1024 * 1024;
const err = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

/** A library the user may upload into. */
function libraryFor(req, id) {
  const lib = q('SELECT * FROM libraries WHERE id = ?').get(Number(id));
  if (!lib || !canWriteLibrary(req.user, lib.id)) throw err('Choose a library you can upload into.', 404);
  return lib;
}

/** Clean, relative path segments ("Series/Vol 1") – no "..", no hidden names, no odd characters. */
function cleanSegments(rel) {
  return String(rel || '')
    .split(/[\\/]+/)
    .map((s) => s.replace(/[:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s && s !== '.' && s !== '..' && !s.startsWith('.'))
    .map((s) => s.slice(0, 150));
}

/** Absolute path inside the library, refusing anything that escapes it. */
function inside(lib, ...segments) {
  const root = path.resolve(lib.path);
  const full = path.resolve(root, ...segments);
  if (full !== root && !full.startsWith(root + path.sep)) throw err('That path is outside the library.');
  return full;
}

function supported(name) {
  const { FILE_FORMATS } = require('../scanner');
  const lower = name.toLowerCase();
  const ext = path.extname(lower);
  return Boolean(FILE_FORMATS[ext] || IMAGE_EXT.has(ext) || require('../audio').AUDIO_EXT.has(ext) || lower.endsWith('.kepub.epub') || lower === 'comicinfo.xml');
}

function fsMessage(e, dir) {
  return require('../plugins/downloads').friendlyFsError(e, dir);
}

// ---------------------------------------------------------------------------

router.get('/folders', async (req, res) => {
  const lib = libraryFor(req, req.query.library);
  const segs = cleanSegments(req.query.path);
  const dir = inside(lib, ...segs);
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw err(`Can't open that folder: ${e.code || e.message}`);
  }
  const { naturalSort } = require('../archive');
  const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort(naturalSort);
  const files = entries.filter((e) => e.isFile() && supported(e.name)).length;
  res.json({ library: { id: lib.id, name: lib.name, kind: lib.kind, mode: lib.mode }, path: segs.join('/'), folders, files });
});

router.post('/folders', async (req, res) => {
  const lib = libraryFor(req, req.body?.libraryId);
  const name = cleanSegments(req.body?.name);
  if (name.length !== 1) throw err('Give the folder a name.');
  const dir = inside(lib, ...cleanSegments(req.body?.path), name[0]);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    throw err(fsMessage(e, path.dirname(dir)));
  }
  res.status(201).json({ path: path.relative(lib.path, dir).split(path.sep).join('/') });
});

router.put('/file', async (req, res) => {
  const lib = libraryFor(req, req.query.library);
  const nameSegs = cleanSegments(req.query.name);
  if (!nameSegs.length) throw err('Missing file name.');
  const fileName = nameSegs[nameSegs.length - 1];
  if (!supported(fileName)) throw err(`“${fileName}” isn’t a format Flyleaf reads.`);
  const declared = Number(req.get('content-length'));
  if (declared > MAX_BYTES) throw err(`Files can be at most ${Math.round(MAX_BYTES / 1048576)} MB.`, 413);

  const dir = inside(lib, ...cleanSegments(req.query.folder), ...nameSegs.slice(0, -1));
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    throw err(fsMessage(e, dir));
  }
  const { uniquePath } = require('../plugins/downloads');
  const dest = await uniquePath(path.join(dir, fileName));
  const part = `${dest}.part`;
  let received = 0;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_BYTES) req.destroy(err('File too large.', 413));
  });
  try {
    await pipeline(req, fs.createWriteStream(part, { flags: 'wx' }));
    if (declared && received !== declared) throw new Error('The upload was interrupted.');
    await fsp.rename(part, dest);
  } catch (e) {
    await fsp.rm(part, { force: true }).catch(() => {});
    if (e.status) throw e;
    throw err(['EROFS', 'EACCES', 'EPERM', 'ENOSPC'].includes(e.code) ? (e.code === 'ENOSPC' ? 'The server is out of disk space.' : fsMessage(e, dir)) : e.message);
  }
  const rel = path.relative(lib.path, dest).split(path.sep).join('/');
  q('INSERT INTO uploads (user_id, library_id, file, size, created_at) VALUES (?, ?, ?, ?, ?)').run(req.user.id, lib.id, dest, received, Date.now());
  log.file(`${req.user.username} uploaded ${rel} to "${lib.name}"`);
  res.status(201).json({ path: rel, name: path.basename(dest), size: received, renamed: path.basename(dest) !== fileName });
});

// ---------------------------------------------------------------------------
// After a batch: scan, and add whatever the files became to a collection.

const pending = []; // { libraryId, prefixes: Set, collectionId, until }

events.on('book.added', (b) => {
  const now = Date.now();
  for (let i = pending.length - 1; i >= 0; i--) if (pending[i].until < now) pending.splice(i, 1);
  for (const p of pending) {
    if (p.libraryId !== b.libraryId || !b.seriesId) continue;
    // A file upload matches its own path; an uploaded image folder matches the folder book.
    const hit = p.files.has(b.path) || [...p.files].some((f) => f.startsWith(`${b.path}/`));
    if (hit) require('./personal').addToCollection(p.collectionId, b.seriesId);
  }
});

router.post('/done', (req, res) => {
  const lib = libraryFor(req, req.body?.libraryId);
  const files = (Array.isArray(req.body?.files) ? req.body.files : []).map(String).slice(0, 5000);
  const collectionId = req.body?.collectionId ? Number(req.body.collectionId) : null;
  if (collectionId) {
    const c = q('SELECT id FROM collections WHERE id = ? AND user_id = ?').get(collectionId, req.user.id);
    if (!c) throw err('Collection not found.', 404);
    pending.push({ libraryId: lib.id, files: new Set(files), collectionId, until: Date.now() + 60 * 60_000 });
    // Files that were already in the library (re-uploads) won't fire book.added; match them now.
    for (const f of files) {
      const b = q("SELECT series_id FROM books WHERE library_id = ? AND (rel_path = ? OR ? LIKE rel_path || '/%') AND series_id IS NOT NULL").get(lib.id, f, f);
      if (b) require('./personal').addToCollection(collectionId, b.series_id);
    }
  }
  require('../scanner').requestScan(lib.id);
  events.emit('upload.completed', { userId: req.user.id, username: req.user.username, libraryId: lib.id, files });
  res.json({ ok: true, scanning: true });
});

router.get('/limits', (req, res) => res.json({ maxBytes: MAX_BYTES }));

module.exports = { router };
