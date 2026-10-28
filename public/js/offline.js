import { t } from './i18n.js';
// Books saved on this device for reading without a connection.
//
// A saved book is the set of requests the reader makes, stored in Cache Storage under the
// same URLs: its /reader data, the file (EPUB, PDF…) or every page image, the page count and
// the cover. The service worker answers those URLs from the cache when the network can't.
// What's saved is listed in localStorage (flyleaf.offline). Reading progress made while
// offline is queued (flyleaf.pendingProgress) and sent when the connection comes back.

import { api, fileUrl, pageUrl, localDay, request } from './api.js';

const CACHE = 'flyleaf-offline';
const INDEX = 'flyleaf.offline';
const QUEUE = 'flyleaf.pendingProgress';

export const offlineSupported = () => 'caches' in window && 'serviceWorker' in navigator && window.isSecureContext;

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || '') || fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/** Saved books, newest first: [{ id, title, label, series, seriesId, coverUrl, engine, format, size, pages, savedAt }]. */
export function savedBooks() {
  return Object.values(readJson(INDEX, {})).sort((a, b) => b.savedAt - a.savedAt);
}
export const isSaved = (bookId) => Boolean(readJson(INDEX, {})[bookId]);

const listeners = new Set();
/** Called with no arguments whenever the saved list changes. */
export const onSavedChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const changed = () => listeners.forEach((fn) => fn());

/** The URLs a book needs (pages are stored without the data-saver width). */
function urlsFor(book, pageCount, trackCount = 0) {
  const urls = [`/api/books/${book.id}/reader`];
  if (book.coverUrl) urls.push(book.coverUrl);
  if (book.engine === 'audio') {
    urls.push(`/api/books/${book.id}/tracks`);
    for (let i = 0; i < trackCount; i++) urls.push(`/api/books/${book.id}/tracks/${i}?v=${book.version}`);
  } else if (book.engine === 'pages' && book.format !== 'pdf') {
    urls.push(`/api/books/${book.id}/pages`);
    for (let i = 0; i < pageCount; i++) urls.push(pageUrl(book, i));
  } else {
    urls.push(fileUrl(book));
  }
  return urls;
}

// The reader's own code, fetched once so the service worker has it even if this device
// has never opened a book of that kind before going offline.
const ENGINE_FILES = {
  text: ['/js/reader/text.js', ...['view', 'epub', 'epubcfi', 'paginator', 'overlayer', 'progress', 'text-walker', 'search', 'fixed-layout', 'mobi', 'fb2', 'footnotes', 'vendor/zip', 'vendor/fflate'].map((f) => `/vendor/foliate/${f}.js`)],
  pages: ['/js/reader/pages.js'],
  audio: ['/js/reader/audio.js'],
  pdf: ['/js/reader/pages.js', '/vendor/pdfjs/pdf.min.mjs', '/vendor/pdfjs/pdf.worker.min.mjs'],
};
const warmEngine = (book) =>
  Promise.all((ENGINE_FILES[book.format === 'pdf' ? 'pdf' : book.engine] || []).map((u) => fetch(u).catch(() => null)));

const inFlight = new Map(); // bookId → promise

/**
 * Save a book for offline reading. `onProgress(fraction)` reports progress.
 * Resolves with the index entry; rejects if a request fails (nothing half-saved is kept).
 */
export function saveBook(bookId, { onProgress } = {}) {
  if (inFlight.has(bookId)) return inFlight.get(bookId);
  const job = (async () => {
    if (!offlineSupported()) throw new Error(t('Offline reading needs HTTPS (or localhost) and a browser with service workers.'));
    // Ask the browser not to clear saved books when space runs low.
    navigator.storage?.persist?.().catch(() => {});
    const data = await api.reader(bookId);
    const { book } = data;
    let pageCount = 0;
    let trackCount = 0;
    if (book.engine === 'pages' && book.format !== 'pdf') pageCount = (await api.pages(bookId)).count;
    if (book.engine === 'audio') trackCount = (await api.audioTracks(bookId)).tracks.length;
    const urls = urlsFor(book, pageCount, trackCount);
    warmEngine(book);
    const cache = await caches.open(CACHE);
    let done = 0;
    let size = 0;
    const fetchOne = async (url) => {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(t('Couldn’t save {value} ({status}).', { value: url.includes('/pages/') ? t('a page') : t('the book'), status: res.status }));
      const blob = await res.clone().blob();
      size += blob.size;
      await cache.put(url, res);
      onProgress?.(++done / urls.length);
    };
    try {
      // Four at a time, like the server's own page downloads.
      const queue = [...urls];
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (queue.length) await fetchOne(queue.shift());
      }));
    } catch (e) {
      await Promise.all(urls.map((u) => cache.delete(u)));
      throw e;
    }
    const entry = {
      id: book.id,
      title: book.title,
      label: book.label,
      series: book.series,
      seriesId: book.seriesId,
      coverUrl: book.coverUrl,
      engine: book.engine,
      format: book.format,
      version: book.version,
      pages: pageCount || book.pageCount || null,
      urls,
      size,
      savedAt: Date.now(),
    };
    const index = readJson(INDEX, {});
    index[book.id] = entry;
    writeJson(INDEX, index);
    changed();
    return entry;
  })().finally(() => inFlight.delete(bookId));
  inFlight.set(bookId, job);
  return job;
}

export async function removeBook(bookId) {
  const index = readJson(INDEX, {});
  const entry = index[bookId];
  if (!entry) return;
  const cache = await caches.open(CACHE);
  await Promise.all((entry.urls || []).map((u) => cache.delete(u)));
  delete index[bookId];
  writeJson(INDEX, index);
  changed();
}

export async function removeAll() {
  await caches.delete(CACHE);
  writeJson(INDEX, {});
  changed();
}

/** Bytes used and available for this site, when the browser says. */
export async function storageEstimate() {
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Progress made while offline

/** Keep a progress save that couldn't reach the server; seconds for the same book and day add up. */
export function queueProgress(bookId, body) {
  const queue = readJson(QUEUE, []);
  const day = body.day || localDay();
  const prev = queue.find((x) => x.bookId === bookId && x.body.day === day);
  if (prev) prev.body = { ...prev.body, ...body, seconds: (prev.body.seconds || 0) + (body.seconds || 0), day };
  else queue.push({ bookId, body: { ...body, day } });
  writeJson(QUEUE, queue);
}

let flushing = false;
/** Send queued progress (oldest first). Stops at the first failure and tries again later. */
export async function flushProgress() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    let queue = readJson(QUEUE, []);
    while (queue.length) {
      const { bookId, body } = queue[0];
      try {
        await request('PUT', `/api/books/${bookId}/progress`, body);
      } catch (e) {
        // Gone or not allowed any more: drop it. Unreachable: keep it for next time.
        if (!e.status) break;
      }
      queue = queue.slice(1);
      writeJson(QUEUE, queue);
    }
  } finally {
    flushing = false;
  }
}

addEventListener('online', () => flushProgress());

// ---------------------------------------------------------------------------
// Signed-in user for offline start-up

const LAST_USER = 'flyleaf.lastUser';
export const rememberUser = (user) => writeJson(LAST_USER, user ? { ...user, backgroundUrl: null } : null);
export const lastUser = () => readJson(LAST_USER, null);
