'use strict';

// Content Finder download queue: asks the plugin for a file URL, streams it into
// the chosen library folder, then rescans that library so the book shows up.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { q } = require('../db');
const { json } = require('../util');
const runtime = require('./runtime');
const manager = require('./manager');
const events = require('../events');
const log = require('../log').logger('downloads');

const CONCURRENCY = 2;
const MAX_FILE = 2 * 1024 * 1024 * 1024;
const STALL_MS = 60_000;
const running = new Map(); // download id → AbortController

const FORMAT_EXT = { epub: 'epub', kepub: 'kepub.epub', pdf: 'pdf', mobi: 'mobi', azw3: 'azw3', fb2: 'fb2', txt: 'txt', docx: 'docx', rtf: 'rtf', cbz: 'cbz', cbr: 'cbr', cb7: 'cb7', cbt: 'cbt', zip: 'zip' };

/** Safe single path segment for a file or folder name. */
const segment = (s, fallback = 'Untitled') =>
  String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || fallback;

function supportedExt(name) {
  const { FILE_FORMATS } = require('../scanner');
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.kepub.epub')) return '.kepub.epub';
  const ext = path.extname(lower);
  return FILE_FORMATS[ext] ? ext : null;
}

function filenameFrom(res, spec, item) {
  const cd = res.headers.get('content-disposition') || '';
  const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(cd);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  const candidates = [
    spec.filename,
    star && decodeURIComponent(star[1]),
    plain && plain[1],
    decodeURIComponent(new URL(res.url).pathname.split('/').pop() || ''),
  ];
  for (const c of candidates) if (c && supportedExt(c)) return c;
  // Fall back to the format the plugin reported.
  const ext = FORMAT_EXT[item.format];
  return ext ? `${segment(item.title)}.${ext}` : null;
}

/** Where a download lands inside the library. */
function targetPath(lib, item, filename) {
  const ext = supportedExt(filename);
  let dir;
  let name;
  if (lib.kind === 'books') {
    // Calibre-like: Author/Title.ext
    dir = segment(item.author, 'Unknown author');
    name = `${segment(item.bookTitle || item.title)}${ext}`;
  } else {
    // Komga/Kavita friendly: Series/<chapter or volume file>
    dir = segment(item.series || item.bookTitle || item.title);
    name = item.fileTitle && item.fileTitle !== item.bookTitle ? `${segment(`${item.series || item.bookTitle} ${item.fileTitle}`)}${ext}` : segment(path.basename(filename, ext)) + ext;
  }
  const root = path.resolve(lib.path);
  const full = path.resolve(root, dir, name);
  if (!full.startsWith(root + path.sep)) throw new Error('Refusing to write outside the library folder.');
  return full;
}

async function uniquePath(file) {
  const ext = file.endsWith('.kepub.epub') ? '.kepub.epub' : path.extname(file);
  const base = file.slice(0, -ext.length);
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? file : `${base} (${i})${ext}`;
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error('Too many files with that name.');
}

function friendlyFsError(e, dir) {
  if (['EROFS', 'EACCES', 'EPERM'].includes(e.code)) {
    return `Flyleaf can't write to ${dir}. Give the Flyleaf service write access to this library folder (when it runs under systemd with ProtectHome=read-only, add the folder to ReadWritePaths).`;
  }
  return e.message;
}

async function runDownload(d) {
  const controller = new AbortController();
  running.set(d.id, controller);
  const item = json(d.item, {});
  const lib = q('SELECT * FROM libraries WHERE id = ?').get(d.library_id);
  let part = null;
  try {
    if (!lib) throw new Error('The target library no longer exists.');
    q("UPDATE downloads SET status = 'downloading', error = NULL WHERE id = ?").run(d.id);
    const spec = await manager.run(d.plugin_id, 'download', [item.fileId]);
    if (Array.isArray(spec?.pages)) {
      await downloadPages(d, item, lib, spec, controller);
      return;
    }
    if (!spec?.url) throw new Error('The plugin didn’t return a download URL.');
    runtime.checkUrl(spec.url);

    // Abort if the connection stalls.
    let stall = setTimeout(() => controller.abort(new Error('Download stalled')), STALL_MS);
    const res = await fetch(spec.url, { headers: { 'User-Agent': runtime.USER_AGENT, ...(spec.headers || {}) }, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`The source returned HTTP ${res.status}.`);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.startsWith('text/html')) throw new Error('The source sent a web page instead of a file. It may need you to log in or accept terms first.');
    const total = Number(res.headers.get('content-length')) || null;
    if (total && total > MAX_FILE) throw new Error('That file is larger than 2 GB.');
    const filename = filenameFrom(res, spec, item);
    if (!filename) throw new Error('That file type isn’t supported by Flyleaf.');

    const dest = await uniquePath(targetPath(lib, item, filename));
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
    } catch (e) {
      throw new Error(friendlyFsError(e, path.dirname(dest)));
    }
    part = `${dest}.part`;
    q('UPDATE downloads SET total = ?, received = 0 WHERE id = ?').run(total, d.id);

    let received = 0;
    let lastWrite = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      received += chunk.length;
      clearTimeout(stall);
      stall = setTimeout(() => controller.abort(new Error('Download stalled')), STALL_MS);
      if (received > MAX_FILE) controller.abort(new Error('That file is larger than 2 GB.'));
      if (Date.now() - lastWrite > 500) {
        lastWrite = Date.now();
        q('UPDATE downloads SET received = ? WHERE id = ?').run(received, d.id);
      }
    });
    try {
      await pipeline(body, fs.createWriteStream(part, { flags: 'wx' }), { signal: controller.signal });
    } catch (e) {
      throw new Error(friendlyFsError(e, path.dirname(dest)));
    } finally {
      clearTimeout(stall);
    }
    await fsp.rename(part, dest);
    part = null;
    q("UPDATE downloads SET status = 'done', received = ?, total = ?, file = ?, finished_at = ? WHERE id = ?").run(received, received, dest, Date.now(), d.id);
    require('../scanner').requestScan(lib.id);
    log.info(`Downloaded "${d.title}" to ${dest}`);
    rememberRating(lib.id, dest, item.ageRating, item.layout, d.user_id);
    events.emit('download.completed', { downloadId: d.id, plugin: d.plugin_id, libraryId: lib.id, title: d.title, file: path.relative(lib.path, dest) });
  } catch (e) {
    const message = controller.signal.aborted && controller.signal.reason?.message === 'cancelled' ? 'Cancelled' : e.message;
    q("UPDATE downloads SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(message.slice(0, 500), Date.now(), d.id);
    if (message !== 'Cancelled') {
      log.file(`Download ${d.id} "${d.title}" failed: ${message}`);
      events.emit('download.failed', { downloadId: d.id, plugin: d.plugin_id, title: d.title, error: message });
    }
    if (part) await fsp.rm(part, { force: true }).catch(() => {});
  } finally {
    running.delete(d.id);
  }
}

// ---------------------------------------------------------------------------
// Page-by-page downloads: the plugin lists image URLs and Flyleaf packs them into a CBZ.

const MAX_PAGES = 2000;
const MAX_PAGE_BYTES = 50 * 1024 * 1024;
const PAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/jxl': '.jxl', 'image/bmp': '.bmp' };
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function comicInfo(item, spec, pageCount) {
  const info = { Series: item.series || item.bookTitle, Title: item.fileTitle, Number: item.chapter, Volume: item.volume, Writer: item.author, PageCount: pageCount, ...(spec.comicInfo || {}) };
  const body = Object.entries(info).filter(([, v]) => v != null && v !== '').map(([k, v]) => `  <${k}>${xmlEsc(v)}</${k}>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n${body}\n</ComicInfo>\n`;
}

async function fetchPage(url, headers, signal) {
  runtime.checkUrl(url);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': runtime.USER_AGENT, ...headers }, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'unknown type'})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_PAGE_BYTES) throw new Error('page too large');
      return { buf, ext: PAGE_EXT[type] || '.jpg' };
    } catch (e) {
      if (signal.aborted) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function downloadPages(d, item, lib, spec, controller) {
  const pages = spec.pages.slice(0, MAX_PAGES + 1).map(String);
  if (!pages.length) throw new Error('This chapter has no pages.');
  if (pages.length > MAX_PAGES) throw new Error(`Chapters can have at most ${MAX_PAGES} pages.`);
  const headers = spec.headers || {};
  const base = String(spec.filename || item.fileTitle || item.title).replace(/\.(cbz|zip)$/i, '');
  const dest = await uniquePath(targetPath(lib, item, `${base}.cbz`));
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
  } catch (e) {
    throw new Error(friendlyFsError(e, path.dirname(dest)));
  }
  const part = `${dest}.part`;
  q('UPDATE downloads SET total = NULL, received = 0 WHERE id = ?').run(d.id);

  // Fetch four pages at a time, keeping them in order.
  const results = new Array(pages.length);
  let next = 0;
  let received = 0;
  let lastWrite = 0;
  async function worker() {
    while (next < pages.length) {
      const i = next++;
      try {
        results[i] = await fetchPage(pages[i], headers, controller.signal);
      } catch (e) {
        throw new Error(`Page ${i + 1} failed: ${e.message}`);
      }
      received += results[i].buf.length;
      if (Date.now() - lastWrite > 500) {
        lastWrite = Date.now();
        q('UPDATE downloads SET received = ? WHERE id = ?').run(received, d.id);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, pages.length) }, worker));

  const { ZipArchive } = require('archiver');
  const zip = new ZipArchive({ store: true });
  const out = fs.createWriteStream(part, { flags: 'wx' });
  const done = new Promise((resolve, reject) => {
    out.on('close', resolve);
    out.on('error', reject);
    zip.on('error', reject);
  });
  zip.pipe(out);
  const width = String(pages.length).length;
  results.forEach((r, i) => zip.append(r.buf, { name: `${String(i + 1).padStart(Math.max(3, width), '0')}${r.ext}` }));
  zip.append(comicInfo(item, spec, pages.length), { name: 'ComicInfo.xml' });
  await zip.finalize();
  try {
    await done;
  } catch (e) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw new Error(friendlyFsError(e, path.dirname(dest)));
  }
  await fsp.rename(part, dest);
  q("UPDATE downloads SET status = 'done', received = ?, total = ?, file = ?, finished_at = ? WHERE id = ?").run(received, received, dest, Date.now(), d.id);
  require('../scanner').requestScan(lib.id);
  log.info(`Downloaded "${d.title}" (${pages.length} pages) to ${dest}`);
  rememberRating(lib.id, dest, item.ageRating, item.layout, d.user_id);
  events.emit('download.completed', { downloadId: d.id, plugin: d.plugin_id, libraryId: lib.id, title: d.title, file: path.relative(lib.path, dest) });
}

// ---------------------------------------------------------------------------
// Age ratings from the source (e.g. AO3's Explicit) aren't in the downloaded file, so
// apply them to the series once the scanner has picked the book up. Guests' age
// restrictions then cover downloaded books too.

const pendingRatings = []; // { libraryId, rel, rating, until }

function rememberRating(libraryId, file, rating, layout = null, userId = null) {
  if (rating == null && !layout) return;
  const lib = q('SELECT path FROM libraries WHERE id = ?').get(libraryId);
  if (!lib) return;
  pendingRatings.push({ libraryId, rel: path.relative(lib.path, file), rating, layout, userId, until: Date.now() + 60 * 60_000 });
}

events.on('book.added', (b) => {
  const now = Date.now();
  for (let i = pendingRatings.length - 1; i >= 0; i--) {
    const p = pendingRatings[i];
    if (p.until < now) {
      pendingRatings.splice(i, 1);
      continue;
    }
    if (p.libraryId !== b.libraryId || p.rel !== b.path || !b.seriesId) continue;
    pendingRatings.splice(i, 1);
    // Plugins can say how a series is read (webtoons scroll vertically): set it for whoever
    // downloaded it, unless they already chose reader settings for that series.
    if (p.layout && p.userId) {
      q(`INSERT INTO user_series (user_id, series_id, reader_settings, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, series_id) DO UPDATE SET reader_settings = excluded.reader_settings, updated_at = excluded.updated_at
         WHERE user_series.reader_settings IS NULL`).run(p.userId, b.seriesId, JSON.stringify({ layout: p.layout }), Date.now());
    }
    if (p.rating == null) continue;
    const s = q('SELECT age_rating, locked FROM series WHERE id = ?').get(b.seriesId);
    if (!s || json(s.locked, []).includes('age_rating')) continue;
    // Never lower a rating that's already there.
    if (s.age_rating == null || s.age_rating < p.rating) q('UPDATE series SET age_rating = ? WHERE id = ?').run(p.rating, b.seriesId);
  }
});

function pump() {
  while (running.size < CONCURRENCY) {
    const next = q("SELECT * FROM downloads WHERE status = 'queued' ORDER BY id LIMIT 1").get();
    if (!next) return;
    running.set(next.id, null); // reserve the slot before the async work starts
    q("UPDATE downloads SET status = 'downloading' WHERE id = ?").run(next.id);
    runDownload(next).finally(pump);
  }
}

/** Queue files from a plugin's details() result. Returns the new download ids. */
function enqueue({ userId, pluginId, libraryId, book, files }) {
  const now = Date.now();
  const ids = files.map((f) => Number(q(`INSERT INTO downloads (user_id, plugin_id, library_id, title, item, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    userId, pluginId, libraryId,
    files.length > 1 && f.title ? `${book.title} – ${f.title}` : book.title,
    JSON.stringify({
      fileId: f.id, fileTitle: f.title || null, format: f.format || null, volume: f.volume ?? null, chapter: f.chapter ?? null,
      title: book.title, bookTitle: book.title, author: book.author || null, series: book.series || null, ageRating: book.ageRating ?? null, layout: book.layout || null,
    }),
    now,
  ).lastInsertRowid));
  setImmediate(pump);
  return ids;
}

function cancel(id) {
  const d = q('SELECT status FROM downloads WHERE id = ?').get(id);
  if (!d) return false;
  if (d.status === 'queued') q("UPDATE downloads SET status = 'failed', error = 'Cancelled', finished_at = ? WHERE id = ?").run(Date.now(), id);
  running.get(id)?.abort(new Error('cancelled'));
  return true;
}

/** Re-queue downloads interrupted by a restart. */
function resume() {
  q("UPDATE downloads SET status = 'queued', received = 0 WHERE status = 'downloading'").run();
  pump();
}

module.exports = { enqueue, cancel, resume, pump, friendlyFsError, segment, uniquePath };
