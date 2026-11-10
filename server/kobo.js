'use strict';

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { q, tx } = require('./db');
const auth = require('./auth');
const { BOOK_SELECT, getBook } = require('./serialize');
const { accessFilter } = require('./util');
const sync = require('./client-sync');
const { koboLocation, koboCFI } = require('./kobo-position');
const { rendition, VERSION: renditionVersion } = require('./kepub');
const router = express.Router();
const iso = (n) => new Date(n || 0).toISOString();
const uuid = (id) => `f17eaf00-0000-4000-8000-${String(id).padStart(12, '0')}`;
const bookId = (value) => /^f17eaf00-0000-4000-8000-\d{12}$/.test(value) ? Number(value.slice(-12)) : 0;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

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
  const overrides = shelfOverrides(user, collection.id);
  return q(`${BOOK_SELECT} WHERE b.format = 'epub' AND b.missing = 0 AND ${filter.sql}
    AND (b.series_id IN (SELECT series_id FROM collection_items WHERE collection_id = ?)
      OR b.id IN (${overrides.include.map(() => '?').join(',') || 'NULL'}))
    AND b.id NOT IN (${overrides.exclude.map(() => '?').join(',') || '0'}) ORDER BY b.id`)
    .all(user.id, user.id, ...filter.args, collection.id, ...overrides.include, ...overrides.exclude);
}
function shelfOverrides(user, id) {
  const stored = sync.load(user, 'kobo-shelf', `collection:${id}`);
  return stored ? JSON.parse(stored.data) : { include: [], exclude: [] };
}
function editShelf(user, id, ids, remove = false) {
  const value = shelfOverrides(user, id);
  const include = new Set(value.include), exclude = new Set(value.exclude);
  for (const book of ids) {
    if (remove) { include.delete(book); exclude.add(book); }
    else { exclude.delete(book); include.add(book); }
  }
  sync.store(user, 'kobo-shelf', `collection:${id}`, null, { include: [...include], exclude: [...exclude] });
}
function visibleBook(req) {
  const book = getBook(bookId(req.params.id), req.user);
  return book && !book.missing && book.format === 'epub' && books(req.user).some((b) => b.id === book.id) ? book : null;
}
function visibleBooks(req) {
  const ids = req.params.id.split(',');
  if (!ids.length || ids.length > 100 || ids.some(id => !bookId(id))) return null;
  const available = new Map(books(req.user).map(b => [uuid(b.id), b]));
  if (ids.some(id => !available.has(id))) return null;
  return [...new Set(ids)].map(id => available.get(id));
}
function tags(user, visible = books(user)) {
  return q('SELECT * FROM collections WHERE user_id = ? ORDER BY id').all(user.id).map(c => {
    const series = new Set(q('SELECT series_id FROM collection_items WHERE collection_id = ?').all(c.id).map(i => i.series_id));
    const overrides = shelfOverrides(user, c.id);
    return { Id: uuid(c.id), Name: c.name, Type: 'UserTag', Created: iso(c.created_at), LastModified: iso(c.updated_at),
      Items: visible.filter(b => !overrides.exclude.includes(b.id) && (series.has(b.series_id) || overrides.include.includes(b.id))).map(b => ({ RevisionId: uuid(b.id), Type: 'ProductRevisionTagItem' })) };
  });
}
function ownedTag(req) {
  return q('SELECT * FROM collections WHERE id = ? AND user_id = ?').get(bookId(req.params.tag), req.user.id);
}
function tagBookIds(req) {
  if (!Array.isArray(req.body?.Items) || req.body.Items.length > 1000) return null;
  const ids = [];
  for (const item of req.body.Items) {
    if (item?.Type !== 'ProductRevisionTagItem' || typeof item.RevisionId !== 'string') return null;
    const b = getBook(bookId(item.RevisionId), req.user);
    if (!b || b.missing || b.format !== 'epub') return null;
    ids.push(b.id);
  }
  return [...new Set(ids)];
}
const tagName = req => typeof req.body?.Name === 'string' ? req.body.Name.trim().slice(0, 120) : '';
async function state(user, book) {
  const p = q('SELECT * FROM progress WHERE user_id = ? AND book_id = ?').get(user.id, book.id);
  const native = sync.load(user, 'kobo', uuid(book.id));
  const data = native ? JSON.parse(native.data) : {};
  const generated = await rendition(book).catch(() => null);
  const modified = iso(p?.updated_at || book.added_at);
  const bookmark = { LastModified: modified, ProgressPercent: (p?.percent || 0) * 100,
    ContentSourceProgressPercent: (p?.percent || 0) * 100 };
  if (native && p && native.updated_at >= p.updated_at && data.CurrentBookmark?.Location &&
      (!generated || data.renditionKey === generated.key)) {
    bookmark.Location = data.CurrentBookmark.Location;
    if (Number.isFinite(data.CurrentBookmark.ContentSourceProgressPercent)) bookmark.ContentSourceProgressPercent = data.CurrentBookmark.ContentSourceProgressPercent;
  }
  else if (p?.position) {
    const location = await koboLocation(book, p.position);
    if (location) {
      bookmark.Location = location;
      delete bookmark.ContentSourceProgressPercent;
    }
  }
  return { EntitlementId: uuid(book.id), Created: iso(book.added_at), LastModified: modified, PriorityTimestamp: modified,
    StatusInfo: { LastModified: modified, Status: p?.finished ? 'Finished' : p?.percent ? 'Reading' : 'ReadyToRead', TimesStartedReading: p ? 1 : 0 },
    Statistics: { ...(data.Statistics || {}), LastModified: modified }, CurrentBookmark: bookmark };
}
async function metadata(req, b) {
  const id = uuid(b.id);
  const generated = await rendition(b).catch(() => null);
  return { Id: id, RevisionId: id, CrossRevisionId: id, EntitlementId: id, WorkId: id, CoverImageId: id,
    Title: b.title, Contributors: b.author ? [b.author] : [], ContributorRoles: b.author ? [{ Name: b.author }] : [],
    Description: b.description || '', Language: b.language || 'en', PublicationDate: iso(b.added_at),
    Publisher: { Name: b.publisher || '', Imprint: '' }, IsPreOrder: false, IsSocialEnabled: false,
    IsInternetArchive: false, IsEligibleForKoboLove: false, ExternalIds: [], PhoneticPronunciations: {},
    Categories: ['00000000-0000-0000-0000-000000000001'], Genre: '00000000-0000-0000-0000-000000000001',
    CurrentDisplayPrice: { CurrencyCode: 'USD', TotalAmount: 0 }, CurrentLoveDisplayPrice: { TotalAmount: 0 },
    DownloadUrls: (generated ? ['KEPUB'] : ['EPUB', 'EPUB3']).map((Format) => ({ Format, Platform: 'Generic', Size: generated?.size || b.size || 0, Url: `${req.koboBase}/download/${id}${generated ? '?revision=' + generated.key : ''}` })) };
}
function entitlementHeader(b, removed = false) {
  const id = uuid(b.id);
  return { Id: id, RevisionId: id, CrossRevisionId: id, Accessibility: 'Full',
    Created: iso(b.added_at), LastModified: iso(b.updated_at), ActivePeriod: { From: iso(b.added_at) },
    IsRemoved: removed, IsHiddenFromArchive: false, IsLocked: false, OriginCategory: 'Imported', Status: 'Active' };
}
async function entitlement(req, b) {
  return { BookEntitlement: entitlementHeader(b),
    BookMetadata: await metadata(req, b), ReadingState: await state(req.user, b) };
}

router.get('/:key', (req, res) => res.json({}));
router.get('/:key/v1/initialization', (req, res) => {
  const base = req.koboBase;
  res.set('x-kobo-apitoken', 'e30=').json({ Resources: {
    library_sync: `${base}/v1/library/sync`, library: `${base}/v1/library`,
    library_items: `${base}/v1/library/{ItemId}`, library_item: `${base}/v1/library/{ItemId}`,
    library_item_state: `${base}/v1/library/{ItemId}/state`, library_tags: `${base}/v1/library/tags`,
    tags: `${base}/v1/library/tags`, tag_items: `${base}/v1/library/tags/{TagId}/items`,
    rename_tag: `${base}/v1/library/tags/{TagId}`, delete_tag: `${base}/v1/library/tags/{TagId}`,
    delete_tag_items: `${base}/v1/library/tags/{TagId}/items/delete`,
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

router.get('/:key/v1/library/tags', (req, res) => res.json(tags(req.user)));
router.post('/:key/v1/library/tags', (req, res) => {
  const name = tagName(req), series = tagBookIds(req);
  if (!name || !series) return res.status(400).json({ error: 'Invalid shelf name or items' });
  let id;
  tx(() => {
    const now = Date.now();
    id = Number(q('INSERT INTO collections (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(req.user.id, name, now, now).lastInsertRowid);
    editShelf(req.user, id, series);
  });
  res.status(201).json(uuid(id));
});
router.put('/:key/v1/library/tags/:tag', (req, res) => {
  const c = ownedTag(req);
  if (!c) return res.status(404).end();
  const name = tagName(req);
  if (!name) return res.status(400).json({ error: 'Invalid shelf name' });
  q('UPDATE collections SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), c.id);
  res.status(200).end();
});
router.delete('/:key/v1/library/tags/:tag', (req, res) => {
  const c = ownedTag(req);
  if (!c) return res.status(404).end();
  tx(() => {
    q('DELETE FROM collections WHERE id = ?').run(c.id);
    q("DELETE FROM client_positions WHERE user_id = ? AND client = 'kobo-shelf' AND document = ?").run(req.user.id, `collection:${c.id}`);
  });
  res.status(200).end();
});
router.post(['/:key/v1/library/tags/:tag/items', '/:key/v1/library/tags/:tag/items/delete'], (req, res) => {
  const c = ownedTag(req);
  if (!c) return res.status(404).end();
  const series = tagBookIds(req);
  if (!series) return res.status(400).json({ error: 'Invalid shelf items' });
  const remove = req.path?.endsWith('/delete') || req.url.split('?')[0].endsWith('/delete');
  tx(() => {
    const now = Date.now();
    editShelf(req.user, c.id, series, remove);
    q('UPDATE collections SET updated_at = ? WHERE id = ?').run(now, c.id);
  });
  res.status(remove ? 200 : 201).end();
});

router.get('/:key/v1/library/sync', async (req, res) => {
  const prefix = `snapshot:${req.user.apiKey.id}:`;
  const requested = req.get('x-kobo-synctoken');
  const stored = typeof requested === 'string' && /^[\w-]{32}$/.test(requested)
    ? sync.load(req.user, 'kobo-sync', prefix + requested) : null;
  const old = stored ? JSON.parse(stored.data) : null;
  const previous = old && stored.updated_at > Date.now() - 86400_000 ? old : { items: {}, tags: {} };
  const items = {}, results = [];
  const visible = books(req.user);
  for (const b of visible) {
    // Don't convert an entire library just to deliver the first page. Fingerprint
    // source data cheaply, and prepare downloads only for the delivered records.
    const file = await fs.stat(b.path).then(s => [s.size, s.mtimeMs]).catch(() => null);
    const progress = q('SELECT * FROM progress WHERE user_id = ? AND book_id = ?').get(req.user.id, b.id);
    const native = sync.load(req.user, 'kobo', uuid(b.id));
    const fingerprint = hash({ book: b, file, progress, native: native?.data, renditionVersion });
    const item = { BookEntitlement: entitlementHeader(b), pendingBook: b };
    items[b.id] = { fingerprint, entitlement: item.BookEntitlement };
    if (!previous.items[b.id]) results.push({ NewEntitlement: item });
    else if (previous.items[b.id].fingerprint !== fingerprint) results.push({ ChangedEntitlement: item });
  }
  for (const [id, entry] of Object.entries(previous.items)) {
    if (!items[id]) results.push({ ChangedEntitlement: { BookEntitlement: { ...entry.entitlement, IsRemoved: true, LastModified: iso(Date.now()) } } });
  }
  const currentTags = Object.fromEntries(tags(req.user, visible).map(tag => [tag.Id, tag]));
  for (const id of Object.keys(previous.tags)) if (!currentTags[id]) results.push({ DeletedTag: { Tag: { Id: id } } });
  for (const [id, tag] of Object.entries(currentTags)) {
    if (hash(tag) !== hash(previous.tags[id])) results.push({ [previous.tags[id] ? 'ChangedTag' : 'NewTag']: { Tag: tag } });
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const page = results.slice(0, 100);
  for (const result of page) {
    for (const kind of ['NewEntitlement', 'ChangedEntitlement']) {
      if (result[kind]?.pendingBook) result[kind] = await entitlement(req, result[kind].pendingBook);
    }
  }
  // Advance only the entries actually delivered. The next request recomputes
  // against current permissions, so revoked content never leaks from a queue.
  const delivered = { ...previous.items };
  const deliveredTags = { ...previous.tags };
  for (const result of page) {
    const entry = result.NewEntitlement || result.ChangedEntitlement;
    if (entry) {
      const id = bookId(entry.BookEntitlement.Id);
      if (entry.BookEntitlement.IsRemoved) delete delivered[id];
      else delivered[id] = items[id];
    }
    const tag = (result.NewTag || result.ChangedTag)?.Tag;
    if (tag) deliveredTags[tag.Id] = tag;
    if (result.DeletedTag) delete deliveredTags[result.DeletedTag.Tag.Id];
  }
  tx(() => {
    sync.store(req.user, 'kobo-sync', prefix + token, null, { items: delivered, tags: deliveredTags });
    q("DELETE FROM client_positions WHERE user_id = ? AND client = 'kobo-sync' AND updated_at < ?").run(req.user.id, Date.now() - 86400_000);
    q("DELETE FROM client_positions WHERE user_id = ? AND client = 'kobo-sync' AND substr(document, 1, ?) = ? AND document NOT IN (SELECT document FROM client_positions WHERE user_id = ? AND client = 'kobo-sync' AND substr(document, 1, ?) = ? ORDER BY updated_at DESC, rowid DESC LIMIT 128)")
      .run(req.user.id, prefix.length, prefix, req.user.id, prefix.length, prefix);
  });
  res.set({ 'x-kobo-synctoken': token, 'x-kobo-sync': results.length > page.length ? 'continue' : 'complete' }).json(page);
});

router.get(['/:key/v1/products/books/:id', '/:key/v1/library/:id/metadata'], async (req, res) => {
  const list = visibleBooks(req); if (!list) return res.status(404).end();
  res.json(await Promise.all(list.map(b => metadata(req, b))));
});
router.get('/:key/v1/library/:id/state', async (req, res) => {
  const list = visibleBooks(req); if (!list) return res.status(404).end();
  res.json(await Promise.all(list.map(b => state(req.user, b))));
});
function validReadingState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value.StatusInfo?.Status;
  const percent = value.CurrentBookmark?.ProgressPercent;
  const hasStats = value.Statistics && typeof value.Statistics === 'object' && !Array.isArray(value.Statistics);
  const local = value.CurrentBookmark?.ContentSourceProgressPercent;
  const location = value.CurrentBookmark?.Location;
  if ((percent !== undefined && (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100)) ||
      (local != null && (!Number.isFinite(local) || local < 0 || local > 100)) ||
      (location != null && (typeof location !== 'object' || ['Source', 'Type', 'Value'].some(k => typeof location[k] !== 'string' || location[k].length > 2000))) ||
      (hasStats && ['SpentReadingMinutes', 'RemainingTimeMinutes'].some(k => value.Statistics[k] !== undefined && (!Number.isFinite(value.Statistics[k]) || value.Statistics[k] < 0))) ||
      (status !== undefined && !['ReadyToRead', 'Reading', 'Finished'].includes(status)) || (percent === undefined && status === undefined && !hasStats)) return false;
  return true;
}

async function prepareReadingState(req, b, value) {
  const status = value.StatusInfo?.Status;
  const percent = value.CurrentBookmark?.ProgressPercent;
  const location = value.CurrentBookmark?.Location;
  const before = q('SELECT * FROM progress WHERE user_id = ? AND book_id = ?').get(req.user.id, b.id);
  const fraction = status === 'Finished' ? 1 : status === 'ReadyToRead' ? 0 : percent === undefined ? before?.percent || 0 : percent / 100;
  const generated = await rendition(b).catch(() => null);
  const downloaded = sync.load(req.user, 'kobo-download', `${req.user.apiKey.id}:${uuid(b.id)}`);
  const renditionKey = downloaded ? JSON.parse(downloaded.data).key : null;
  const position = status === 'ReadyToRead' ? null : location
    ? generated && generated.key !== renditionKey ? null : await koboCFI(b, location)
    : percent === undefined ? before?.position || null : null;
  return () => {
    const hasProgress = percent !== undefined || status !== undefined;
    const now = hasProgress ? sync.saveProgress(req.user, b, { percent: fraction, position, finished: status ? status === 'Finished' : fraction >= 0.999 }) : Math.max(Date.now(), before?.updated_at || 0);
    const old = sync.load(req.user, 'kobo', uuid(b.id));
    const previous = old ? JSON.parse(old.data) : {};
    if (old && before && old.updated_at < before.updated_at) delete previous.CurrentBookmark;
    const merged = { ...previous, ...value, Statistics: { ...previous.Statistics, ...value.Statistics }, renditionKey };
    if (status === 'ReadyToRead') delete merged.CurrentBookmark;
    sync.store(req.user, 'kobo', uuid(b.id), b.id, merged, now);
    return { EntitlementId: uuid(b.id), CurrentBookmarkResult: { Result: 'Success' },
      StatusInfoResult: { Result: 'Success' }, StatisticsResult: { Result: 'Success' }, LastModified: iso(now), PriorityTimestamp: iso(now) };
  };
}

router.put('/:key/v1/library/:id/state', async (req, res) => {
  const list = visibleBooks(req); if (!list) return res.status(404).end();
  const input = req.body?.ReadingStates;
  if (!Array.isArray(input) || input.length !== list.length || !input.every(validReadingState)) return res.status(400).json({ error: 'Invalid ReadingStates' });
  const available = new Map(list.map(b => [uuid(b.id), b]));
  const seen = new Set();
  const pairs = [];
  for (const value of input) {
    const id = value.EntitlementId || (list.length === 1 ? uuid(list[0].id) : null);
    if (!available.has(id) || seen.has(id)) return res.status(400).json({ error: 'Reading state IDs must match the requested books' });
    seen.add(id); pairs.push([available.get(id), value]);
  }
  // Complete authorization, validation and position conversion before any write.
  const writes = await Promise.all(pairs.map(([book, value]) => prepareReadingState(req, book, value)));
  const results = tx(() => writes.map(write => write()));
  res.json({ RequestResult: 'Success', UpdateResults: results });
});
router.get('/:key/download/:id', async (req, res) => {
  const b = visibleBook(req); if (!b) return res.status(404).end();
  const generated = await rendition(b).catch(() => null);
  if (req.query.revision && req.query.revision !== generated?.key) return res.status(409).json({ error: 'The book changed. Sync again before downloading.' });
  res.download(generated?.file || b.path, generated ? path.basename(b.path, path.extname(b.path)) + '.kepub.epub' : path.basename(b.path), { dotfiles: 'allow' }, error => {
    if (error) { if (!res.headersSent) res.status(500).end(); return; }
    sync.store(req.user, 'kobo-download', `${req.user.apiKey.id}:${uuid(b.id)}`, b.id, { key: generated?.key || null });
  });
});
router.get(['/:key/:id/:width/:height/:grey/image.jpg', '/:key/:id/:width/:height/:quality/:grey/image.jpg'], (req, res) => {
  const b = visibleBook(req); if (!b?.cover) return res.status(404).end();
  res.sendFile(path.join(require('./config').coverDir, b.cover));
});
router.use((err, req, res, next) => { if (res.headersSent) return next(err); res.status(err.status || 500).json({ error: err.status === 400 ? 'Invalid JSON' : 'Kobo sync failed' }); });
module.exports = { router, uuid };
