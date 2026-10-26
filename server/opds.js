'use strict';

// OPDS 1.2 catalog for third-party readers (Panels, Chunky, KOReader, Moon+,
// Thorium, KyBook…). Authenticated by an API key in the URL:
//   /api/opds/<key>
// Comics/manga also expose OPDS-PSE page streaming so readers can stream pages
// without downloading the whole archive; streamed pages update reading progress.

const express = require('express');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { q } = require('./db');
const auth = require('./auth');
const archive = require('./archive');
const settings = require('./settings');
const { listSeries, getSeries, seriesBooks, getBook, BOOK_SELECT, toBook } = require('./serialize');
const { accessFilter, listsLibrary, likeArg } = require('./util');
const { ORIGINAL_MIME } = require('./routes/books');

const router = express.Router();

const NAV = 'application/atom+xml;profile=opds-catalog;kind=navigation';
const ACQ = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
const PAGE_SIZE = 50;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const iso = (t) => new Date(t || Date.now()).toISOString();

router.use('/:key', (req, res, next) => {
  if (settings.get('opdsEnabled') === false) return res.status(404).end();
  const user = auth.userFromApiKey(req.params.key);
  if (!user) return res.status(401).type('text/plain').send('Invalid OPDS key. Create one in Flyleaf → Settings → OPDS & clients.');
  req.user = user;
  req.base = `/api/opds/${encodeURIComponent(req.params.key)}`;
  next();
});

function feed(req, { id, title, kind = 'navigation', entries, next, up = true }) {
  const self = req.originalUrl;
  const b = req.base;
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"
      xmlns:pse="http://vaemendis.net/opds-pse/ns" xmlns:dcterms="http://purl.org/dc/terms/"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <id>urn:flyleaf:${esc(id)}</id>
  <title>${esc(title)}</title>
  <updated>${iso()}</updated>
  <author><name>Flyleaf</name></author>
  <icon>/icons/icon-192.png</icon>
  <link rel="self" href="${esc(self)}" type="${kind === 'navigation' ? NAV : ACQ}"/>
  <link rel="start" href="${b}" type="${NAV}"/>
  ${up ? `<link rel="up" href="${b}" type="${NAV}"/>` : ''}
  <link rel="search" href="${b}/search.xml" type="application/opensearchdescription+xml"/>
  ${next ? `<link rel="next" href="${esc(next)}" type="${kind === 'navigation' ? NAV : ACQ}"/>` : ''}
${entries.join('\n')}
</feed>`;
}

function send(res, xml, kind = 'navigation') {
  res.set('Cache-Control', 'no-store');
  res.type(kind === 'navigation' ? NAV : ACQ).send(xml);
}

function navEntry(id, title, href, summary, kind = 'navigation', image) {
  return `  <entry>
    <id>urn:flyleaf:${esc(id)}</id>
    <title>${esc(title)}</title>
    <updated>${iso()}</updated>
    ${summary ? `<content type="text">${esc(summary)}</content>` : ''}
    ${image ? `<link rel="http://opds-spec.org/image" href="${esc(image)}"/><link rel="http://opds-spec.org/image/thumbnail" href="${esc(image)}"/>` : ''}
    <link rel="subsection" href="${esc(href)}" type="${kind === 'navigation' ? NAV : ACQ}"/>
  </entry>`;
}

const progressMark = (p) => (p >= 0.999 ? '✓ ' : p > 0 ? `◔ ${Math.round(p * 100)}% · ` : '');

function seriesEntry(req, s) {
  const prefix = req.user.prefs.opdsEmbedProgress ? progressMark(s.progress) : '';
  const summary = [s.authors.join(', '), s.count ? `${s.count} ${s.count === 1 ? 'item' : 'items'}` : null].filter(Boolean).join(' · ');
  return navEntry(`series:${s.id}`, `${prefix}${s.name}`, `${req.base}/series/${s.id}`, summary, 'acquisition', s.coverUrl ? `${req.base}/series/${s.id}/cover` : null);
}

function bookEntry(req, book, raw, { titlePrefix = '' } = {}) {
  const p = book.progress;
  const prefix = req.user.prefs.opdsEmbedProgress ? progressMark(p?.finished ? 1 : p?.percent || 0) : '';
  const isPages = archive.IMAGE_FORMATS.has(book.format) || book.format === 'pdf';
  const dirAudio = book.format === 'audio' && require('./audio').isDirSync(raw.path);
  const mime = book.format === 'folder' ? 'application/vnd.comicbook+zip' : dirAudio ? 'application/zip' : ORIGINAL_MIME[book.format] || require('./audio').AUDIO_MIME[path.extname(raw.path).toLowerCase()] || 'application/octet-stream';
  const ext = book.format === 'folder' ? 'cbz' : book.format === 'audio' && require('./audio').isDirSync(raw.path) ? 'zip' : path.extname(raw.path).slice(1);
  const pse =
    isPages && archive.IMAGE_FORMATS.has(book.format) && book.pageCount
      ? `<link rel="http://vaemendis.net/opds-pse/stream" type="image/jpeg" href="${req.base}/books/${book.id}/pages/{pageNumber}?width={maxWidth}" pse:count="${book.pageCount}"${p?.page != null ? ` pse:lastRead="${p.page}" pse:lastReadDate="${iso(p.updatedAt)}"` : ''}/>`
      : '';
  return `  <entry>
    <id>urn:flyleaf:book:${book.id}</id>
    <title>${esc(titlePrefix + prefix + (book.label || book.title))}</title>
    <updated>${iso(book.addedAt)}</updated>
    ${book.author ? `<author><name>${esc(book.author)}</name></author>` : ''}
    ${raw.description ? `<content type="text">${esc(raw.description)}</content>` : ''}
    <dcterms:extent>${esc(Math.round((book.size || 0) / 1024))} KB</dcterms:extent>
    ${book.coverUrl ? `<link rel="http://opds-spec.org/image" href="${req.base}/books/${book.id}/cover"/><link rel="http://opds-spec.org/image/thumbnail" href="${req.base}/books/${book.id}/cover"/>` : ''}
    ${req.user.permissions.download ? `<link rel="http://opds-spec.org/acquisition" href="${req.base}/books/${book.id}/download/${encodeURIComponent(path.basename(raw.path, path.extname(raw.path)))}.${ext}" type="${mime}"/>` : ''}
    ${pse}
  </entry>`;
}

// ---------------------------------------------------------------------------

router.get('/:key', (req, res) => {
  const b = req.base;
  const entries = [
    navEntry('ondeck', 'Continue reading', `${b}/on-deck`, 'Books you are in the middle of', 'acquisition'),
    navEntry('want', 'Want to read', `${b}/want-to-read`, 'Series on your list'),
    navEntry('recent', 'Recently added', `${b}/recent`, 'Newest series'),
    navEntry('libraries', 'Libraries', `${b}/libraries`, 'Browse by library'),
    navEntry('collections', 'Collections', `${b}/collections`, 'Your collections'),
    navEntry('all', 'All series', `${b}/all`, 'Everything, A–Z'),
  ];
  send(res, feed(req, { id: 'root', title: 'Flyleaf', entries, up: false }));
});

function seriesFeed(req, res, { id, title, where = [], args = [], sort }) {
  const page = Math.max(Number(req.query.page) || 0, 0);
  const { items, hasMore } = listSeries(req.user, { where, args, sort, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const u = new URL(req.originalUrl, 'http://x');
  u.searchParams.set('page', String(page + 1));
  send(res, feed(req, { id, title, entries: items.map((s) => seriesEntry(req, s)), next: hasMore ? u.pathname + u.search : null }));
}

router.get('/:key/all', (req, res) => seriesFeed(req, res, { id: 'all', title: 'All series' }));
router.get('/:key/recent', (req, res) => seriesFeed(req, res, { id: 'recent', title: 'Recently added', sort: 'added' }));
router.get('/:key/want-to-read', (req, res) => seriesFeed(req, res, { id: 'want', title: 'Want to read', where: ['us.want_to_read = 1'], sort: 'want' }));

router.get('/:key/libraries', (req, res) => {
  const libs = q('SELECT id, name, kind FROM libraries ORDER BY name COLLATE NOCASE').all().filter((l) => listsLibrary(req.user, l.id));
  send(res, feed(req, { id: 'libraries', title: 'Libraries', entries: libs.map((l) => navEntry(`library:${l.id}`, l.name, `${req.base}/libraries/${l.id}`, l.kind)) }));
});

router.get('/:key/libraries/:id', (req, res) => {
  const lib = q('SELECT name FROM libraries WHERE id = ?').get(Number(req.params.id));
  if (!lib || !listsLibrary(req.user, req.params.id)) return res.status(404).end();
  seriesFeed(req, res, { id: `library:${req.params.id}`, title: lib.name, where: ['s.library_id = ?'], args: [Number(req.params.id)] });
});

router.get('/:key/collections', (req, res) => {
  const rows = q('SELECT id, name, summary FROM collections WHERE user_id = ? OR promoted = 1 ORDER BY name COLLATE NOCASE').all(req.user.id);
  send(res, feed(req, { id: 'collections', title: 'Collections', entries: rows.map((c) => navEntry(`collection:${c.id}`, c.name, `${req.base}/collections/${c.id}`, c.summary)) }));
});

router.get('/:key/collections/:id', (req, res) => {
  const c = q('SELECT name FROM collections WHERE id = ? AND (user_id = ? OR promoted = 1)').get(Number(req.params.id), req.user.id);
  if (!c) return res.status(404).end();
  seriesFeed(req, res, {
    id: `collection:${req.params.id}`,
    title: c.name,
    where: ['s.id IN (SELECT series_id FROM collection_items WHERE collection_id = ?)'],
    args: [Number(req.params.id)],
  });
});

router.get('/:key/on-deck', (req, res) => {
  const age = accessFilter(req.user, 's');
  const rows = q(`${BOOK_SELECT} WHERE b.missing = 0 AND p.finished = 0 AND p.updated_at IS NOT NULL AND ${age.sql}
                  ORDER BY p.updated_at DESC LIMIT 30`).all(req.user.id, req.user.id, ...age.args);
  const entries = rows.map((r) => bookEntry(req, toBook(r, false, req.user), r, { titlePrefix: `${r.series_name || ''} – ` }));
  send(res, feed(req, { id: 'ondeck', title: 'Continue reading', kind: 'acquisition', entries }), 'acquisition');
});

router.get('/:key/series/:id', (req, res) => {
  const s = getSeries(req.params.id, req.user);
  if (!s) return res.status(404).end();
  const books = seriesBooks(s.id, req.user);
  const raws = new Map(q('SELECT id, path, description FROM books WHERE series_id = ?').all(s.id).map((r) => [r.id, r]));
  const entries = books.map((b) => bookEntry(req, b, raws.get(b.id)));
  if (req.user.prefs.opdsContinueFrom) {
    const next = books.find((b) => b.progress && !b.progress.finished) || books.find((b) => !b.progress?.finished);
    if (next) entries.unshift(bookEntry(req, next, raws.get(next.id), { titlePrefix: 'Continue reading: ' }).replace(`urn:flyleaf:book:${next.id}`, `urn:flyleaf:continue:${next.id}`));
  }
  send(res, feed(req, { id: `series:${s.id}`, title: s.name, kind: 'acquisition', entries }), 'acquisition');
});

router.get('/:key/search.xml', (req, res) => {
  res.type('application/opensearchdescription+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Flyleaf</ShortName>
  <Description>Search your Flyleaf library</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <OutputEncoding>UTF-8</OutputEncoding>
  <Url type="${ACQ}" template="${req.base}/search?q={searchTerms}"/>
</OpenSearchDescription>`);
});

router.get('/:key/search', (req, res) => {
  const term = String(req.query.q || req.query.query || '').trim();
  const like = likeArg(term);
  seriesFeed(req, res, {
    id: `search:${term}`,
    title: `Search: ${term}`,
    where: [`(s.name LIKE ? ESCAPE '\\' OR s.localized_name LIKE ? ESCAPE '\\' OR b.title LIKE ? ESCAPE '\\'
             OR EXISTS (SELECT 1 FROM json_each(s.people) j WHERE json_extract(j.value, '$.name') LIKE ? ESCAPE '\\'))`],
    args: [like, like, like, like],
  });
});

// ---------------------------------------------------------------------------
// Binary endpoints

const coverOf = (name) => require('./covers').coverPath(name);

router.get('/:key/series/:id/cover', (req, res) => {
  const s = getSeries(req.params.id, req.user);
  if (!s?.coverUrl) return res.status(404).end();
  const m = s.coverUrl.match(/^\/api\/(series|books)\/(\d+)\/cover/);
  const row = q(`SELECT cover FROM ${m[1]} WHERE id = ?`).get(Number(m[2]));
  if (!row?.cover) return res.status(404).end();
  res.sendFile(coverOf(row.cover));
});

router.get('/:key/books/:id/cover', (req, res) => {
  const b = getBook(req.params.id, req.user);
  if (!b?.cover) return res.status(404).end();
  res.sendFile(coverOf(b.cover));
});

router.get(['/:key/books/:id/download', '/:key/books/:id/download/:name'], async (req, res) => {
  const b = getBook(req.params.id, req.user);
  if (!b || b.missing) return res.status(404).end();
  if (!req.user.permissions.download) return res.status(403).end();
  if (b.format === 'folder' || (b.format === 'audio' && require('./audio').isDirSync(b.path))) {
    const { ZipArchive } = require('archiver');
    const zip = new ZipArchive({ store: true });
    res.attachment(`${path.basename(b.path)}.cbz`);
    zip.pipe(res);
    zip.directory(b.path, false);
    await zip.finalize();
    return;
  }
  res.download(b.path, path.basename(b.path), { dotfiles: 'allow' });
});

router.get('/:key/books/:id/pages/:n', async (req, res) => {
  const b = getBook(req.params.id, req.user);
  if (!b || b.missing || !archive.IMAGE_FORMATS.has(b.format)) return res.status(404).end();
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 0) return res.status(400).end();
  const width = Number(req.query.width) || null;
  const page = await archive.openPage(b, n, { width: width && width >= 100 && width <= 4000 ? width : null });
  if (!page) return res.status(404).end();
  // Streaming a page through OPDS-PSE counts as reading progress.
  const count = b.page_count || 1;
  const now = Date.now();
  q(`INSERT INTO progress (user_id, book_id, position, page, percent, finished, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, book_id) DO UPDATE SET position = excluded.position, page = excluded.page, percent = excluded.percent,
       finished = MAX(finished, excluded.finished), updated_at = excluded.updated_at`).run(
    req.user.id, b.id, String(n), n, Math.min(1, (n + 1) / count), n + 1 >= count ? 1 : 0, now, now,
  );
  res.set({ 'Content-Type': page.mime, 'Content-Length': String(page.size) });
  if (page.buffer) return res.end(page.buffer);
  await pipeline(page.stream, res).catch(() => {});
});

// ---------------------------------------------------------------------------
// OPDS 2.0 (JSON) at /api/opds/<key>/v2 – the same catalog for newer apps (Thorium, Readest…).

const OPDS2 = 'application/opds+json';

function send2(req, res, { title, navigation, publications, next, page, total }) {
  const b = req.base;
  const links = [
    { rel: 'self', href: req.originalUrl, type: OPDS2 },
    { rel: 'start', href: `${b}/v2`, type: OPDS2 },
    { rel: 'search', href: `${b}/v2/search{?query}`, type: OPDS2, templated: true },
  ];
  if (next) links.push({ rel: 'next', href: next, type: OPDS2 });
  const metadata = { title };
  if (page != null) Object.assign(metadata, { itemsPerPage: PAGE_SIZE, currentPage: page + 1 });
  if (total != null) metadata.numberOfItems = total;
  res.set('Cache-Control', 'no-store');
  res.type(OPDS2).send(JSON.stringify({ metadata, links, ...(navigation ? { navigation } : {}), ...(publications ? { publications } : {}) }));
}

const nav2 = (title, href) => ({ title, href, type: OPDS2, rel: 'subsection' });

function publication2(req, book, raw) {
  const ext = book.format === 'folder' ? 'cbz' : book.format === 'audio' && require('./audio').isDirSync(raw.path) ? 'zip' : path.extname(raw.path).slice(1);
  const dirAudio = book.format === 'audio' && require('./audio').isDirSync(raw.path);
  const mime = book.format === 'folder' ? 'application/vnd.comicbook+zip' : dirAudio ? 'application/zip' : ORIGINAL_MIME[book.format] || require('./audio').AUDIO_MIME[path.extname(raw.path).toLowerCase()] || 'application/octet-stream';
  const p = book.progress;
  const metadata = {
    '@type': 'http://schema.org/Book',
    identifier: `urn:flyleaf:book:${book.id}`,
    title: book.label || book.title,
    modified: iso(book.addedAt),
  };
  if (book.author) metadata.author = book.author.split(/\s*[,&]\s*/).filter(Boolean).map((name) => ({ name }));
  if (raw.description) metadata.description = raw.description;
  if (book.pageCount) metadata.numberOfPages = book.pageCount;
  if (book.series) metadata.belongsTo = { series: [{ name: book.series, ...(book.volume != null ? { position: book.volume } : {}) }] };
  if (p) metadata.progression = { percent: p.finished ? 1 : p.percent || 0, modified: iso(p.updatedAt) };
  const links = [];
  if (req.user.permissions.download) {
    links.push({ rel: 'http://opds-spec.org/acquisition', href: `${req.base}/books/${book.id}/download/${encodeURIComponent(path.basename(raw.path, path.extname(raw.path)))}.${ext}`, type: mime });
  }
  return {
    metadata,
    links,
    images: book.coverUrl ? [{ href: `${req.base}/books/${book.id}/cover`, type: 'image/jpeg' }] : [],
  };
}

function seriesFeed2(req, res, { title, where = [], args = [], sort }) {
  const page = Math.max(Number(req.query.page) || 0, 0);
  const { items, hasMore, total } = listSeries(req.user, { where, args, sort, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const u = new URL(req.originalUrl, 'http://x');
  u.searchParams.set('page', String(page + 1));
  const prefix = (s) => (req.user.prefs.opdsEmbedProgress ? progressMark(s.progress) : '');
  send2(req, res, {
    title,
    page,
    total,
    navigation: items.map((s) => nav2(`${prefix(s)}${s.name}`, `${req.base}/v2/series/${s.id}`)),
    next: hasMore ? u.pathname + u.search : null,
  });
}

router.get('/:key/v2', (req, res) => {
  const b = `${req.base}/v2`;
  send2(req, res, {
    title: 'Flyleaf',
    navigation: [
      nav2('Continue reading', `${b}/on-deck`),
      nav2('Want to read', `${b}/want-to-read`),
      nav2('Recently added', `${b}/recent`),
      nav2('Libraries', `${b}/libraries`),
      nav2('Collections', `${b}/collections`),
      nav2('All series', `${b}/all`),
    ],
  });
});
router.get('/:key/v2/all', (req, res) => seriesFeed2(req, res, { title: 'All series' }));
router.get('/:key/v2/recent', (req, res) => seriesFeed2(req, res, { title: 'Recently added', sort: 'added' }));
router.get('/:key/v2/want-to-read', (req, res) => seriesFeed2(req, res, { title: 'Want to read', where: ['us.want_to_read = 1'], sort: 'want' }));

router.get('/:key/v2/libraries', (req, res) => {
  const libs = q('SELECT id, name FROM libraries ORDER BY name COLLATE NOCASE').all().filter((l) => listsLibrary(req.user, l.id));
  send2(req, res, { title: 'Libraries', navigation: libs.map((l) => nav2(l.name, `${req.base}/v2/libraries/${l.id}`)) });
});
router.get('/:key/v2/libraries/:id', (req, res) => {
  const lib = q('SELECT name FROM libraries WHERE id = ?').get(Number(req.params.id));
  if (!lib || !listsLibrary(req.user, req.params.id)) return res.status(404).end();
  seriesFeed2(req, res, { title: lib.name, where: ['s.library_id = ?'], args: [Number(req.params.id)] });
});

router.get('/:key/v2/collections', (req, res) => {
  const rows = q('SELECT id, name FROM collections WHERE user_id = ? OR promoted = 1 ORDER BY name COLLATE NOCASE').all(req.user.id);
  send2(req, res, { title: 'Collections', navigation: rows.map((c) => nav2(c.name, `${req.base}/v2/collections/${c.id}`)) });
});
router.get('/:key/v2/collections/:id', (req, res) => {
  const c = q('SELECT name FROM collections WHERE id = ? AND (user_id = ? OR promoted = 1)').get(Number(req.params.id), req.user.id);
  if (!c) return res.status(404).end();
  seriesFeed2(req, res, { title: c.name, where: ['s.id IN (SELECT series_id FROM collection_items WHERE collection_id = ?)'], args: [Number(req.params.id)] });
});

router.get('/:key/v2/on-deck', (req, res) => {
  const age = accessFilter(req.user, 's');
  const rows = q(`${BOOK_SELECT} WHERE b.missing = 0 AND p.finished = 0 AND p.updated_at IS NOT NULL AND ${age.sql}
                  ORDER BY p.updated_at DESC LIMIT 30`).all(req.user.id, req.user.id, ...age.args);
  send2(req, res, { title: 'Continue reading', publications: rows.map((r) => publication2(req, toBook(r, false, req.user), r)) });
});

router.get('/:key/v2/series/:id', (req, res) => {
  const s = getSeries(req.params.id, req.user);
  if (!s) return res.status(404).end();
  const raws = new Map(q('SELECT id, path, description FROM books WHERE series_id = ?').all(s.id).map((r) => [r.id, r]));
  send2(req, res, { title: s.name, publications: seriesBooks(s.id, req.user).map((b) => publication2(req, b, raws.get(b.id))) });
});

router.get('/:key/v2/search', (req, res) => {
  const term = String(req.query.query || req.query.q || '').trim();
  const like = likeArg(term);
  seriesFeed2(req, res, {
    title: `Search: ${term}`,
    where: [`(s.name LIKE ? ESCAPE '\\' OR s.localized_name LIKE ? ESCAPE '\\' OR b.title LIKE ? ESCAPE '\\'
             OR EXISTS (SELECT 1 FROM json_each(s.people) j WHERE json_extract(j.value, '$.name') LIKE ? ESCAPE '\\'))`],
    args: [like, like, like, like],
  });
});

module.exports = { router };
