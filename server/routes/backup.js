'use strict';

// Backup & restore.
//   GET    /api/admin/backup/estimate          sizes of the database, data folders and books
//   GET    /api/admin/backup?books=1           download a backup zip (books optional)
//   POST   /api/admin/restore                  upload a backup zip → { id, manifest }
//   POST   /api/admin/restore/:id { books }    restore the uploaded backup
//   DELETE /api/admin/restore/:id              throw the upload away
// The same upload/restore pair is open at /api/setup/restore while Flyleaf has no users yet,
// so a fresh install can start from a backup.

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const express = require('express');
const { q } = require('../db');
const { requireAdmin } = require('../auth');
const backup = require('../backup');

const pending = new Map(); // id → { file, manifest, timer }
const PENDING_TTL = 30 * 60_000;

function forget(id) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  fsp.rm(p.file, { force: true }).catch(() => {});
}

async function upload(req, res) {
  const file = await backup.receive(req);
  let manifest;
  try {
    manifest = await backup.inspect(file);
  } catch (e) {
    await fsp.rm(file, { force: true });
    throw e;
  }
  const id = crypto.randomBytes(12).toString('hex');
  pending.set(id, { file, manifest, timer: setTimeout(() => forget(id), PENDING_TTL).unref() });
  res.json({
    id,
    manifest: {
      version: manifest.version,
      createdAt: manifest.createdAt,
      includesBooks: Boolean(manifest.includesBooks),
      bookFiles: manifest.bookFiles,
      libraries: (manifest.libraries || []).map((l) => ({ name: l.name, path: l.path })),
    },
  });
}

async function apply(req, res) {
  const p = pending.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'That upload has expired. Upload the backup again.' });
  pending.delete(req.params.id);
  clearTimeout(p.timer);
  try {
    const result = await backup.restore(p.file, { includeBooks: Boolean(req.body?.books) });
    res.json({ ok: true, ...result });
  } finally {
    fsp.rm(p.file, { force: true }).catch(() => {});
  }
}

const admin = express.Router();
admin.use(requireAdmin);
admin.get('/backup/estimate', async (req, res) => res.json(await backup.estimate()));
admin.get('/backup', async (req, res) => {
  const books = req.query.books === '1';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  res.attachment(`flyleaf-backup-${stamp}${books ? '-with-books' : ''}.zip`);
  res.set('Cache-Control', 'no-store');
  await backup.create(res, { includeBooks: books });
});
admin.post('/restore', upload);
admin.post('/restore/:id', apply);
admin.delete('/restore/:id', (req, res) => {
  forget(req.params.id);
  res.json({ ok: true });
});

// First run only.
const setup = express.Router();
setup.use((req, res, next) => {
  if (q('SELECT COUNT(*) AS n FROM users').get().n > 0) return res.status(409).json({ error: 'Flyleaf is already set up. Restore from Settings → Backup & restore.' });
  next();
});
setup.post('/', upload);
setup.post('/:id', apply);

module.exports = { admin, setup };
