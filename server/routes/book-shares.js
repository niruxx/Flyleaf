'use strict';

const { createHash, randomBytes } = require('node:crypto');
const express = require('express');
const { q } = require('../db');
const { requirePermission, toUser } = require('../auth');
const { getBook, toBook } = require('../serialize');
const { DEFAULT_SETTINGS } = require('../profiles');
const { readable, readerFile, originalFile, trackList, trackFile, pageList, pageImage } = require('./books');

const manage = express.Router();
const guest = express.Router();
const day = 86_400_000;
const hash = (token) => createHash('sha256').update(token).digest('hex');
const missing = (res) => res.status(404).json({ error: 'This book link is unavailable or has expired.' });
const describe = (s) => ({ id: s.id, locator: s.locator, allowDownload: Boolean(s.allow_download), createdAt: s.created_at, expiresAt: s.expires_at });

manage.get('/books/:id/shares', (req, res) => {
  if (!readable(req, res)) return;
  res.json(q('SELECT * FROM book_shares WHERE user_id = ? AND book_id = ? AND expires_at > ? ORDER BY created_at DESC')
    .all(req.user.id, Number(req.params.id), Date.now()).map(describe));
});

manage.post('/books/:id/shares', requirePermission('download', 'Sharing books isn’t enabled for your account.'), (req, res) => {
  if (req.user.apiKey) return res.status(403).json({ error: 'Sign in to create a book link.' });
  const book = readable(req, res);
  if (!book) return;
  const { locator = null, allowDownload = false, days = 7 } = req.body || {};
  if ((locator !== null && (typeof locator !== 'string' || locator.length > 4096)) || typeof allowDownload !== 'boolean' || ![1, 7, 30].includes(days)) {
    return res.status(400).json({ error: 'Choose a valid reading position, expiration, and download option.' });
  }
  const now = Date.now();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + days * day;
  q('DELETE FROM book_shares WHERE expires_at <= ?').run(now);
  const { lastInsertRowid } = q(`INSERT INTO book_shares
    (token_hash, user_id, book_id, book_version, book_size, locator, allow_download, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hash(token), req.user.id, book.id, book.mtime, book.size, locator || null, Number(allowDownload), now, expiresAt);
  res.status(201).json({ id: Number(lastInsertRowid), path: `/#/shared/${token}`, expiresAt });
});

manage.delete('/book-shares/:id', (req, res) => {
  if (req.user.apiKey) return res.status(403).json({ error: 'Sign in to revoke a book link.' });
  q('DELETE FROM book_shares WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

guest.use('/:token', (req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  if (!/^[A-Za-z0-9_-]{43}$/.test(req.params.token)) return missing(res);
  const share = q('SELECT * FROM book_shares WHERE token_hash = ? AND expires_at > ?').get(hash(req.params.token), Date.now());
  if (!share) return missing(res);
  const ownerRow = q('SELECT * FROM users WHERE id = ?').get(share.user_id);
  const owner = ownerRow && toUser(ownerRow);
  if (!owner?.permissions.download) return missing(res);
  const book = getBook(share.book_id, owner);
  if (!book || book.missing || book.mtime !== share.book_version || book.size !== share.book_size) return missing(res);
  req.bookShare = share;
  req.sharedBook = book;
  next();
});

guest.get('/:token/reader', (req, res) => {
  const book = toBook(req.sharedBook);
  const { id, title, label, kind, format, engine, pageCount, version } = book;
  res.json({
    shared: true, locator: req.bookShare.locator,
    allowDownload: Boolean(req.bookShare.allow_download),
    book: { id, title, label, kind, format, engine, pageCount, version },
    settings: DEFAULT_SETTINGS, annotations: [],
  });
});

guest.get('/:token/file', (req, res) => {
  const book = req.sharedBook;
  if (toBook(book).engine !== 'text' && book.format !== 'pdf') return missing(res);
  return readerFile(req, res, book, 'no-store');
});
guest.get('/:token/pages', (req, res) => pageList(req, res, req.sharedBook, { readOnly: true }));
guest.get('/:token/pages/:n', (req, res) => pageImage(req, res, req.sharedBook, 'no-store'));
guest.get('/:token/tracks', (req, res) => trackList(req, res, req.sharedBook));
guest.get('/:token/tracks/:n', (req, res) => trackFile(req, res, req.sharedBook, 'no-store'));
guest.get('/:token/download', (req, res) => {
  if (!req.bookShare.allow_download) return res.status(403).json({ error: 'Downloads are disabled for this book link.' });
  return originalFile(req, res, req.sharedBook, { scoped: true });
});

module.exports = { guest, manage };
