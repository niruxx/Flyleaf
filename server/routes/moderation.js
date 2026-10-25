'use strict';

// What a user added to the server, for the admin to review (e.g. files that break the
// server's rules or a source's terms).
//   GET  /api/users/:id/files?library=   their Content Finder downloads and uploads, newest first
//   POST /api/users/:id/files/delete     { items: [{ source: 'download' | 'upload', id }] } → delete the files

const fsp = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { q } = require('../db');
const { requireAdmin } = require('../auth');
const { toBook, BOOK_SELECT } = require('../serialize');

const router = express.Router();
router.use(requireAdmin);

const err = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

function targetUser(req) {
  const u = q('SELECT id, username, display_name, role FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) throw err('User not found.', 404);
  return u;
}

/** The book a file belongs to: the file itself, or an image-folder book containing it. */
function bookFor(file, admin) {
  const row = q(`${BOOK_SELECT} WHERE b.path = ?`).get(admin.id, admin.id, file);
  if (row) return row;
  const dir = path.dirname(file);
  return dir ? q(`${BOOK_SELECT} WHERE b.path = ? AND b.format = 'folder'`).get(admin.id, admin.id, dir) || null : null;
}

/** Downloads and uploads of one user, merged per book. */
function itemsOf(userId, admin, libraryId) {
  const libFilter = libraryId ? 'AND x.library_id = ?' : '';
  const args = libraryId ? [userId, Number(libraryId)] : [userId];
  const libs = new Map(q('SELECT id, name, path, owner_id FROM libraries').all().map((l) => [l.id, l]));
  const downloads = q(`SELECT x.id, x.library_id, x.file, x.title, x.plugin_id, x.total AS size, COALESCE(x.finished_at, x.created_at) AS at
                       FROM downloads x WHERE x.user_id = ? AND x.status = 'done' AND x.file IS NOT NULL ${libFilter}`).all(...args)
    .map((r) => ({ ...r, source: 'download' }));
  const uploads = q(`SELECT x.id, x.library_id, x.file, x.size, x.created_at AS at FROM uploads x WHERE x.user_id = ? ${libFilter}`).all(...args)
    .map((r) => ({ ...r, source: 'upload' }));

  const byKey = new Map();
  for (const r of [...downloads, ...uploads]) {
    const row = bookFor(r.file, admin);
    const key = row ? `book:${row.id}` : `file:${r.file}`;
    let item = byKey.get(key);
    if (!item) {
      const lib = libs.get(r.library_id);
      item = {
        key,
        source: r.source,
        refs: [],
        libraryId: r.library_id,
        libraryName: lib?.name || 'Deleted library',
        personal: lib?.owner_id != null,
        file: lib ? path.relative(lib.path, row?.path || r.file).split(path.sep).join('/') : r.file,
        title: row?.title || r.title || path.basename(r.file),
        plugin: r.plugin_id || null,
        size: 0,
        at: r.at,
        book: row ? toBook(row, false, admin) : null,
      };
      byKey.set(key, item);
    }
    item.refs.push({ source: r.source, id: r.id });
    item.size += r.size || 0;
    item.at = Math.max(item.at, r.at);
    if (r.source === 'download') item.plugin ||= r.plugin_id;
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at);
}

router.get('/:id/files', (req, res) => {
  const u = targetUser(req);
  const items = itemsOf(u.id, req.user, req.query.library);
  const libraries = new Map();
  for (const it of itemsOf(u.id, req.user)) {
    const l = libraries.get(it.libraryId) || { id: it.libraryId, name: it.libraryName, personal: it.personal, downloads: 0, uploads: 0 };
    for (const ref of it.refs) l[ref.source === 'download' ? 'downloads' : 'uploads']++;
    libraries.set(it.libraryId, l);
  }
  res.json({
    user: { id: u.id, username: u.username, displayName: u.display_name || u.username, role: u.role },
    libraries: [...libraries.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ownLibraries: q('SELECT id, name, kind FROM libraries WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(u.id),
    items,
  });
});

router.post('/:id/files/delete', async (req, res) => {
  const u = targetUser(req);
  const wanted = Array.isArray(req.body?.items) ? req.body.items.slice(0, 1000) : [];
  if (!wanted.length) throw err('Pick something to delete.');
  const keys = new Set(wanted.map((w) => `${w.source}:${Number(w.id)}`));
  const { deleteBook } = require('./books');
  let deleted = 0;
  const failed = [];
  for (const item of itemsOf(u.id, req.user)) {
    if (!item.refs.some((r) => keys.has(`${r.source}:${r.id}`))) continue;
    try {
      if (item.book) {
        const row = q('SELECT * FROM books WHERE id = ?').get(item.book.id);
        if (row) await deleteBook(row, req.user);
      } else {
        // A file Flyleaf never turned into a book (not scanned yet, or not a book at all).
        const lib = q('SELECT path FROM libraries WHERE id = ?').get(item.libraryId);
        const ref = item.refs[0];
        const file = q(`SELECT file FROM ${ref.source === 'download' ? 'downloads' : 'uploads'} WHERE id = ?`).get(ref.id)?.file;
        if (lib && file && path.resolve(file).startsWith(path.resolve(lib.path) + path.sep)) await fsp.rm(file, { force: true });
      }
      for (const r of item.refs) {
        if (r.source === 'download') q('UPDATE downloads SET file = NULL WHERE id = ?').run(r.id);
        else q('DELETE FROM uploads WHERE id = ?').run(r.id);
      }
      deleted++;
    } catch (e) {
      failed.push(`${item.title}: ${e.message}`);
    }
  }
  require('../log').logger('moderation').info(`${req.user.username} deleted ${deleted} of ${u.username}'s files`);
  res.json({ deleted, failed });
});

module.exports = { router };
