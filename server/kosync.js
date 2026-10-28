'use strict';

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { q } = require('./db');
const auth = require('./auth');
const { getBook, BOOK_SELECT } = require('./serialize');
const { accessFilter } = require('./util');
const sync = require('./client-sync');
const router = express.Router();
const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');

// KOReader hashes sparse 1 KiB samples at 0, 1 KiB, 4 KiB, ... 1 GiB.
async function partialMD5(file) {
  const handle = await fs.open(file, 'r');
  try {
    const hash = crypto.createHash('md5');
    const buffer = Buffer.alloc(1024);
    for (const offset of [0, ...Array.from({ length: 11 }, (_, i) => 1024 * 4 ** i)]) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally { await handle.close(); }
}

router.use(express.json({ limit: '32kb', type: ['application/json', 'application/*+json'] }));
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // KOReader MD5s the password before sending it. Use a revocable full API key as
  // that password; never store an MD5 of the Flyleaf account password.
  const username = req.get('x-auth-user');
  const digest = req.get('x-auth-key');
  if (typeof username !== 'string' || !/^[a-f0-9]{32}$/i.test(digest || '')) return res.status(401).json({ message: 'Unauthorized' });
  const keys = q(`SELECT k.key FROM api_keys k JOIN users u ON u.id = k.user_id WHERE u.username = ? AND k.scope = 'full'`).all(username);
  const key = keys.find((k) => crypto.timingSafeEqual(Buffer.from(md5(k.key), 'hex'), Buffer.from(digest, 'hex')));
  const user = key && auth.userFromApiKey(key.key);
  if (!user) return res.status(401).json({ message: 'Unauthorized' });
  req.user = user;
  next();
});
router.get('/users/auth', (req, res) => res.json({ authorized: 'OK' }));
router.post('/users/create', (req, res) => res.status(403).json({ message: 'Create a Flyleaf account and a full-access API key in the web app, then log in.' }));

async function findBook(user, document) {
  const existing = sync.load(user, 'kosync', document);
  if (existing?.book_id) return getBook(existing.book_id, user);
  const filter = accessFilter(user);
  const books = q(`${BOOK_SELECT} WHERE b.missing = 0 AND ${filter.sql}`).all(user.id, user.id, ...filter.args);
  // Never search books outside this user's current library and age restrictions.
  for (const book of books) {
    if (book.format === 'folder' || book.format === 'audio') continue;
    if (md5(path.basename(book.path)) === document) return book;
    try { if (await partialMD5(book.path) === document) return book; } catch {}
  }
  return null;
}

router.put('/syncs/progress', async (req, res) => {
  const b = req.body || {};
  if (!/^[a-f0-9]{32}$/i.test(b.document || '') || typeof b.progress !== 'string' || !b.progress || b.progress.length > 4000 ||
      typeof b.percentage !== 'number' || !Number.isFinite(b.percentage) || b.percentage < 0 || b.percentage > 1) return res.status(400).json({ message: 'Invalid progress' });
  const document = b.document.toLowerCase();
  const book = await findBook(req.user, document);
  if (!book || book.missing) return res.status(404).json({ message: 'Document not found in your library' });
  const page = /^\d+$/.test(b.progress) ? Math.max(0, Number(b.progress) - 1) : null;
  if (page !== null && (!Number.isSafeInteger(page) || (book.page_count && page >= book.page_count))) return res.status(400).json({ message: 'Invalid page' });
  const now = sync.saveProgress(req.user, book, { percent: b.percentage, page });
  const old = sync.load(req.user, 'kosync', document);
  const anchors = old ? JSON.parse(old.data).anchors || [] : [];
  anchors.push({ percentage: b.percentage, progress: b.progress });
  sync.store(req.user, 'kosync', document, book.id, { progress: b.progress, percentage: b.percentage,
    device: String(b.device || '').slice(0, 200), device_id: String(b.device_id || '').slice(0, 200), anchors: anchors.slice(-500) }, now);
  res.json({ document, timestamp: Math.floor(now / 1000) });
});

router.get('/syncs/progress/:document', async (req, res) => {
  const document = req.params.document.toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(document)) return res.status(400).json({ message: 'Invalid document' });
  const book = await findBook(req.user, document);
  if (!book || book.missing) return res.status(404).json({ message: 'Document not found' });
  const stored = sync.load(req.user, 'kosync', document);
  const p = q('SELECT * FROM progress WHERE user_id = ? AND book_id = ?').get(req.user.id, book.id);
  if (!p) return res.status(404).json({ message: 'No progress' });
  const data = stored ? JSON.parse(stored.data) : null;
  if (data && stored.updated_at >= p.updated_at) return res.json({ ...data, anchors: undefined, document, timestamp: Math.floor(stored.updated_at / 1000) });
  // Page-based formats have a portable position. Reflowable text needs a native
  // XPointer: return the closest position previously sent by KOReader.
  let progress;
  let percentage = p.percent;
  if (['pdf', 'cbz', 'cbr', 'cb7', 'cbt'].includes(book.format)) progress = String((p.page ?? Math.round(p.percent * Math.max(0, (book.page_count || 1) - 1))) + 1);
  else {
    const anchor = data?.anchors?.reduce((best, a) => !best || Math.abs(a.percentage - p.percent) < Math.abs(best.percentage - p.percent) ? a : best, null);
    if (!anchor) return res.status(409).json({ message: 'Push once from KOReader to establish native text positions.' });
    progress = anchor.progress; percentage = anchor.percentage;
  }
  res.json({ document, progress, percentage, device: 'Flyleaf', device_id: 'flyleaf-web', timestamp: Math.floor(p.updated_at / 1000) });
});

router.use((err, req, res, next) => { if (res.headersSent) return next(err); res.status(err.status || 500).json({ message: err.status === 400 ? 'Invalid JSON' : 'Sync failed' }); });
module.exports = { router, partialMD5 };
