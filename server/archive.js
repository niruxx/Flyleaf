'use strict';

// Page access for image-based formats: CBZ/ZIP, CBR/RAR and plain image folders.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
const config = require('./config');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.jxl']);
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.jxl': 'image/jxl',
};

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const naturalSort = (a, b) => collator.compare(a, b);

function isImageName(name) {
  const base = name.split('/').pop();
  if (!base || base.startsWith('.') || name.includes('__MACOSX/')) return false;
  return IMAGE_EXT.has(path.extname(base).toLowerCase());
}

const mimeFor = (name) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

// ---------------------------------------------------------------------------
// ZIP (CBZ)

/** Small LRU of open zip handles with their sorted page entries. */
const zipCache = new Map();
const ZIP_CACHE_MAX = 12;

async function openZip(file) {
  const stat = await fsp.stat(file);
  const key = `${file}:${stat.mtimeMs}`;
  const hit = zipCache.get(key);
  if (hit) {
    zipCache.delete(key);
    zipCache.set(key, hit);
    return hit;
  }
  const promise = (async () => {
    const zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false });
    const entries = [];
    const others = new Map();
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName.endsWith('/')) continue;
      if (isImageName(entry.fileName)) entries.push(entry);
      else others.set(entry.fileName.toLowerCase(), entry);
    }
    entries.sort((a, b) => naturalSort(a.fileName, b.fileName));
    return { zip, entries, others };
  })();
  zipCache.set(key, promise);
  promise.catch(() => zipCache.delete(key));
  while (zipCache.size > ZIP_CACHE_MAX) {
    const [oldKey, old] = zipCache.entries().next().value;
    zipCache.delete(oldKey);
    old.then((h) => h.zip.close()).catch(() => {});
  }
  return promise;
}

async function readZipEntry(zip, entry, maxBytes = 200 * 1024 * 1024) {
  if (entry.uncompressedSize > maxBytes) throw new Error('Entry too large');
  const stream = await zip.openReadStreamPromise(entry);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Read a named file (case-insensitive) from any zip, e.g. an EPUB's OPF. */
async function readZipFile(file, name) {
  const { zip, entries, others } = await openZip(file);
  const lower = name.toLowerCase();
  const entry = others.get(lower) || entries.find((e) => e.fileName.toLowerCase() === lower);
  return entry ? readZipEntry(zip, entry) : null;
}

// ---------------------------------------------------------------------------
// RAR (CBR) – extracted once to a disk cache, then served like a folder.

const rarJobs = new Map();

function rarCacheDir(file, mtimeMs) {
  const hash = crypto.createHash('sha1').update(`${file}:${mtimeMs}`).digest('hex').slice(0, 20);
  return path.join(config.cacheDir, 'rar', hash);
}

const flatten = (name) =>
  name
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '..' && p !== '.')
    .join('__');

async function ensureRarExtracted(file) {
  const stat = await fsp.stat(file);
  const dir = rarCacheDir(file, stat.mtimeMs);
  const marker = path.join(dir, '.complete');
  if (fs.existsSync(marker)) {
    const now = new Date();
    fs.utimes(marker, now, now, () => {});
    return dir;
  }
  if (rarJobs.has(dir)) return rarJobs.get(dir);
  const job = (async () => {
    const { createExtractorFromFile } = require('node-unrar-js');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const extractor = await createExtractorFromFile({
      filepath: file,
      targetPath: dir,
      filenameTransform: flatten,
    });
    const { files } = extractor.extract({ files: (h) => !h.flags.directory && isImageName(h.name.replace(/\\/g, '/')) });
    for (const _ of files); // eslint-disable-line no-unused-vars -- iterating performs the extraction
    await fsp.writeFile(marker, '');
    return dir;
  })();
  rarJobs.set(dir, job);
  try {
    return await job;
  } finally {
    rarJobs.delete(dir);
  }
}

async function rarFirstImageAndInfo(file) {
  const { createExtractorFromData } = require('node-unrar-js');
  const data = await fsp.readFile(file);
  const extractor = await createExtractorFromData({ data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
  const names = [];
  let comicInfo = null;
  for (const h of extractor.getFileList().fileHeaders) {
    if (h.flags.directory) continue;
    const name = h.name.replace(/\\/g, '/');
    if (isImageName(name)) names.push(h.name);
    else if (name.split('/').pop().toLowerCase() === 'comicinfo.xml') comicInfo = h.name;
  }
  names.sort(naturalSort);
  const wanted = [names[0], comicInfo].filter(Boolean);
  const out = { pageCount: names.length, cover: null, comicInfo: null };
  if (!wanted.length) return out;
  const { files } = extractor.extract({ files: wanted });
  for (const f of files) {
    if (!f.extraction) continue;
    if (f.fileHeader.name === names[0]) out.cover = Buffer.from(f.extraction);
    else out.comicInfo = Buffer.from(f.extraction).toString('utf8');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Folder of images

async function listFolderImages(dir) {
  const names = (await fsp.readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isFile() && isImageName(d.name))
    .map((d) => d.name);
  return names.sort(naturalSort);
}

// ---------------------------------------------------------------------------
// Public API

const folderCache = new Map();

async function listPages(book) {
  switch (book.format) {
    case 'cbz': {
      const { entries } = await openZip(book.path);
      return entries.map((e) => e.fileName);
    }
    case 'cbr': {
      const dir = await ensureRarExtracted(book.path);
      return listFolderImages(dir);
    }
    case 'folder': {
      const key = `${book.path}:${book.mtime}`;
      if (!folderCache.has(key)) folderCache.set(key, await listFolderImages(book.path));
      return folderCache.get(key);
    }
    default:
      throw new Error(`Not an image format: ${book.format}`);
  }
}

/** Returns { stream, mime, size } for page `index` (0-based). */
async function openPage(book, index) {
  if (book.format === 'cbz') {
    const { zip, entries } = await openZip(book.path);
    const entry = entries[index];
    if (!entry) return null;
    const stream = await zip.openReadStreamPromise(entry);
    return { stream, mime: mimeFor(entry.fileName), size: entry.uncompressedSize };
  }
  const pages = await listPages(book);
  const name = pages[index];
  if (!name) return null;
  const dir = book.format === 'cbr' ? await ensureRarExtracted(book.path) : book.path;
  const file = path.join(dir, name);
  const stat = await fsp.stat(file);
  return { stream: fs.createReadStream(file), mime: mimeFor(name), size: stat.size };
}

/** Page count, first image and ComicInfo.xml for metadata/cover extraction. */
async function inspect(book) {
  if (book.format === 'cbz') {
    const { zip, entries, others } = await openZip(book.path);
    const infoEntry = [...others.entries()].find(([n]) => n.split('/').pop() === 'comicinfo.xml')?.[1];
    return {
      pageCount: entries.length,
      cover: entries[0] ? await readZipEntry(zip, entries[0], 60 * 1024 * 1024) : null,
      comicInfo: infoEntry ? (await readZipEntry(zip, infoEntry, 1024 * 1024)).toString('utf8') : null,
    };
  }
  if (book.format === 'cbr') return rarFirstImageAndInfo(book.path);
  if (book.format === 'folder') {
    const pages = await listFolderImages(book.path);
    let comicInfo = null;
    try {
      comicInfo = await fsp.readFile(path.join(book.path, 'ComicInfo.xml'), 'utf8');
    } catch {}
    return {
      pageCount: pages.length,
      cover: pages[0] ? await fsp.readFile(path.join(book.path, pages[0])) : null,
      comicInfo,
    };
  }
  throw new Error(`Not an image format: ${book.format}`);
}

/** Drop extracted RAR caches that haven't been used for `days` days. */
async function pruneRarCache(days = 14) {
  const root = path.join(config.cacheDir, 'rar');
  let dirs;
  try {
    dirs = await fsp.readdir(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - days * 86400_000;
  for (const d of dirs) {
    const dir = path.join(root, d);
    try {
      const stat = await fsp.stat(path.join(dir, '.complete'));
      if (stat.mtimeMs > cutoff) continue;
    } catch {}
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  IMAGE_EXT,
  isImageName,
  naturalSort,
  listPages,
  openPage,
  inspect,
  readZipFile,
  pruneRarCache,
};
