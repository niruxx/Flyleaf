'use strict';

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { q } = require('./db');
const auth = require('./auth');
const { BOOK_SELECT, getBook } = require('./serialize');
const { accessFilter } = require('./util');
const sync = require('./client-sync');
const router = express.Router();
const iso = (n) => new Date(n || 0).toISOString();
const uuid = (id) => `f17eaf00-0000-4000-8000-${String(id).padStart(12, '0')}`;
const bookId = (value) => /^f17eaf00-0000-4000-8000-\d{12}$/.test(value) ? Number(value.slice(-12)) : 0;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

router.use(express.json({ limit: '64kb' }));
router.use('/:key', (req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const user = auth.userFromApiKey(req.params.key);
  if (!user) return res.status(401).json({ error: 'Invalid key' });
  if (user.apiKey.scope !== 'full' || !user.permissions.download) return res.status(403).json({ error: 'Kobo requires download permission and a full-access key.' });
  req.user = user;
  req.koboBase = `${req.protocol}://${req.get('host')}/api/kobo/${encodeURIComponent(req.params.key)}`;
  next();
});

function shelf(user) {
  const id = user.prefs.koboCollectionId;
  return Number.isSafeInteger(id) ? q('SELECT * FROM collections WHERE id = ? AND user_id = ?').get(id, user.id) : null;
}
function books(user) {
  const collection = shelf(user);
  if (!collection) return [];
  const filter = accessFilter(user);
  return q(`${BOOK_SELECT} WHERE b.format = 'epub' AND b.missing = 0 AND ${filter.sql}
    AND b.series_id IN (SELECT series_id FROM collection_items WHERE collection_id = ?) ORDER BY b.id`)
    .all(user.id, user.id, ...filter.args, collection.id);
}
function visibleBook(req) {
  const book = getBook(bookId(req.params.id), req.user);
  return book && !book.missing && book.format === 'epub' && books(req.user).some((b) => b.id === book.id) ? book : null;
}
function state(user, book) {
  const p = q('SELECT * FROM progress WHERE user_id = ? AND book_id = ?').get(user.id, book.id);
  const native = sync.load(user, 'kobo', uuid(book.id));
  const data = native ? JSON.parse(native.data) : {};
  const modified = iso(p?.updated_at || book.added_at);
  const bookmark = { LastModified: modified, ProgressPercent: (p?.percent || 0) * 100,
    ContentSourceProgressPercent: (p?.percent || 0) * 100 };
  if (native && p && native.updated_at >= p.updated_at && data.CurrentBookmark?.Location) bookmark.Location = data.CurrentBookmark.Location;
  return { EntitlementId: uuid(book.id), Created: iso(book.added_at), LastModified: modified, PriorityTimestamp: modified,
    StatusInfo: { LastModified: modified, Status: p?.finished ? 'Finished' : p?.percent ? 'Reading' : 'ReadyToRead', TimesStartedReading: p ? 1 : 0 },
    Statistics: { LastModified: modified }, CurrentBookmark: bookmark };
}
function metadata(req, b) {
  const id = uuid(b.id);
  return { Id: id, RevisionId: id, CrossRevisionId: id, EntitlementId: id, WorkId: id, CoverImageId: id,
    Title: b.title, Contributors: b.author ? [b.author] : [], ContributorRoles: b.author ? [{ Name: b.author }] : [],
    Description: b.description || '', Language: b.language || 'en', PublicationDate: iso(b.added_at),
    Publisher: { Name: b.publisher || '', Imprint: '' }, IsPreOrder: false, IsSocialEnabled: false,
    IsInternetArchive: false, IsEligibleForKoboLove: false, ExternalIds: [], PhoneticPronunciations: {},
    Categories: ['00000000-0000-0000-0000-000000000001'], Genre: '00000000-0000-0000-0000-000000000001',
    CurrentDisplayPrice: { CurrencyCode: 'USD', TotalAmount: 0 }, CurrentLoveDisplayPrice: { TotalAmount: 0 },
    DownloadUrls: ['EPUB', 'EPUB3'].map((Format) => ({ Format, Platform: 'Generic', Size: b.size || 0, Url: `${req.koboBase}/download/${id}` })) };
}
function entitlement(req, b, removed = false) {
  const id = uuid(b.id);
  return { BookEntitlement: { Id: id, RevisionId: id, CrossRevisionId: id, Accessibility: 'Full',
    Created: iso(b.added_at), LastModified: iso(b.updated_at), ActivePeriod: { From: iso(b.added_at) },
    IsRemoved: removed, IsHiddenFromArchive: false, IsLocked: false, OriginCategory: 'Imported', Status: 'Active' },
    BookMetadata: metadata(req, b), ReadingState: state(req.user, b) };
}

router.get('/:key', (req, res) => res.json({}));
router.get('/:key/v1/initialization', (req, res) => {
  const base = req.koboBase;
  res.set('x-kobo-apitoken', 'e30=').json({ Resources: {
    library_sync: `${base}/v1/library/sync`, library: `${base}/v1/library`,
    library_items: `${base}/v1/library/{ItemId}`, library_item: `${base}/v1/library/{ItemId}`,
    library_item_state: `${base}/v1/library/{ItemId}/state`, library_tags: `${base}/v1/library/tags`,
    book: `${base}/v1/products/books/{ProductId}`,
    device_auth: `${base}/v1/auth/device`, device_refresh: `${base}/v1/auth/refresh`,
    reading_state: `${base}/v1/library/{Ids}/state`, library_metadata: `${base}/v1/library/{Ids}/metadata`,
    image_host: base, image_url_template: `${base}/{ImageId}/{Width}/{Height}/false/image.jpg`,
    image_url_quality_template: `${base}/{ImageId}/{Width}/{Height}/{Quality}/{IsGreyscale}/image.jpg`,
  } });
});
router.post(['/:key/v1/auth/device', '/:key/v1/auth/refresh'], (req, res) => res.json({
  AccessToken: crypto.randomBytes(24).toString('base64'), RefreshToken: crypto.randomBytes(24).toString('base64'),
  TokenType: 'Bearer', TrackingId: crypto.randomUUID(), UserKey: String(req.body?.UserKey || '') }));

router.get('/:key/v1/library/sync', (req, res) => {
  const document = `snapshot:${req.user.apiKey.id}`;
  const stored = sync.load(req.user, 'kobo-sync', document);
  const old = stored ? JSON.parse(stored.data) : null;
  const previous = old && req.get('x-kobo-synctoken') === old.token ? old : { items: {}, tag: null };
  const items = {}, results = [];
  for (const b of books(req.user)) {
    const item = entitlement(req, b);
    const fingerprint = hash(item);
    items[b.id] = { fingerprint, entitlement: item.BookEntitlement };
    if (!previous.items[b.id]) results.push({ NewEntitlement: item });
    else if (previous.items[b.id].fingerprint !== fingerprint) results.push({ ChangedEntitlement: item });
  }
  for (const [id, entry] of Object.entries(previous.items)) {
    if (!items[id]) results.push({ ChangedEntitlement: { BookEntitlement: { ...entry.entitlement, IsRemoved: true, LastModified: iso(Date.now()) } } });
  }
  const collection = shelf(req.user);
  const tag = collection ? { Id: uuid(collection.id), Name: collection.name, Type: 'UserTag', Created: iso(collection.created_at),
    LastModified: iso(collection.updated_at), Items: Object.keys(items).map((id) => ({ RevisionId: uuid(id), Type: 'ProductRevisionTagItem' })) } : null;
  if (previous.tag && previous.tag.Id !== tag?.Id) results.push({ DeletedTag: { Tag: { Id: previous.tag.Id } } });
  if (tag && hash(tag) !== hash(previous.tag)) results.push({ [previous.tag?.Id === tag.Id ? 'ChangedTag' : 'NewTag']: { Tag: tag } });
  const token = crypto.randomBytes(24).toString('base64url');
  sync.store(req.user, 'kobo-sync', document, null, { token, items, tag });
  res.set({ 'x-kobo-synctoken': token, 'x-kobo-sync': 'complete' }).json(results);
});

router.get(['/:key/v1/products/books/:id', '/:key/v1/library/:id/metadata'], (req, res) => {
  const b = visibleBook(req); if (!b) return res.status(404).end();
  res.json([metadata(req, b)]);
});
router.get('/:key/v1/library/:id/state', (req, res) => {
  const b = visibleBook(req); if (!b) return res.status(404).end();
  res.json([state(req.user, b)]);
});
router.put('/:key/v1/library/:id/state', (req, res) => {
  const b = visibleBook(req); if (!b) return res.status(404).end();
  const input = req.body?.ReadingStates;
  if (!Array.isArray(input) || input.length !== 1 || !input[0] || typeof input[0] !== 'object') return res.status(400).json({ error: 'Invalid ReadingStates' });
  const value = input[0];
  const status = value.StatusInfo?.Status;
  const percent = value.CurrentBookmark?.ProgressPercent;
  if ((percent !== undefined && (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100)) ||
      (status !== undefined && !['ReadyToRead', 'Reading', 'Finished'].includes(status)) || (percent === undefined && status === undefined)) return res.status(400).json({ error: 'Invalid reading state' });
  const before = q('SELECT percent FROM progress WHERE user_id = ? AND book_id = ?').get(req.user.id, b.id);
  const fraction = status === 'Finished' ? 1 : status === 'ReadyToRead' ? 0 : percent === undefined ? before?.percent || 0 : percent / 100;
  const now = sync.saveProgress(req.user, b, { percent: fraction, finished: status ? status === 'Finished' : fraction >= 0.999 });
  sync.store(req.user, 'kobo', uuid(b.id), b.id, value, now);
  res.json({ RequestResult: 'Success', UpdateResults: [{ EntitlementId: uuid(b.id), CurrentBookmarkResult: { Result: 'Success' },
    StatusInfoResult: { Result: 'Success' }, StatisticsResult: { Result: 'Success' }, LastModified: iso(now), PriorityTimestamp: iso(now) }] });
});
router.get('/:key/download/:id', (req, res) => {
  const b = visibleBook(req); if (!b) return res.status(404).end();
  res.download(b.path, path.basename(b.path), { dotfiles: 'allow' });
});
router.get(['/:key/:id/:width/:height/:grey/image.jpg', '/:key/:id/:width/:height/:quality/:grey/image.jpg'], (req, res) => {
  const b = visibleBook(req); if (!b?.cover) return res.status(404).end();
  res.sendFile(path.join(require('./config').coverDir, b.cover));
});
router.use((err, req, res, next) => { if (res.headersSent) return next(err); res.status(err.status || 500).json({ error: err.status === 400 ? 'Invalid JSON' : 'Kobo sync failed' }); });
module.exports = { router, uuid };
