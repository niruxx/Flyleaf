'use strict';

// Page access for image-based books: CBZ/ZIP, CBR/RAR, CB7/7z, CBT/tar and
// plain image folders. ZIPs are read in place; RAR/7z/tar are extracted once
// into a disk cache and then served like folders.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const yauzl = require('yauzl');
const config = require('./config');
const log = require('./log').logger('archive');

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
const IMAGE_FORMATS = new Set(['cbz', 'cbr', 'cb7', 'cbt', 'folder']);

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const naturalSort = (a, b) => collator.compare(a, b);

function isImageName(name) {
  const norm = name.replace(/\\/g, '/');
  const base = norm.split('/').pop();
  if (!base || base.startsWith('.') || norm.includes('__MACOSX/')) return false;
  return IMAGE_EXT.has(path.extname(base).toLowerCase());
}
const mimeFor = (name) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

/** Identify an archive by its signature rather than its extension. */
async function sniff(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buf, 0, 512, 0);
    if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
    if (buf.toString('latin1', 0, 4) === 'Rar!') return 'rar';
    if (buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc && buf[3] === 0xaf) return '7z';
    if (bytesRead >= 262 && buf.toString('latin1', 257, 262) === 'ustar') return 'tar';
    if (buf.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
    return null;
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// ZIP

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
    const zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false, strictFileNames: false });
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

async function readZipFile(file, name) {
  const { zip, entries, others } = await openZip(file);
  const lower = name.toLowerCase();
  const entry = others.get(lower) || entries.find((e) => e.fileName.toLowerCase() === lower);
  return entry ? readZipEntry(zip, entry) : null;
}

// ---------------------------------------------------------------------------
// Extracted formats (RAR / 7z / tar)

const extractJobs = new Map();

function extractDir(file, mtimeMs) {
  const hash = crypto.createHash('sha1').update(`${file}:${mtimeMs}`).digest('hex').slice(0, 20);
  return path.join(config.cacheDir, 'extract', hash);
}

const flatten = (name) =>
  name.replace(/\\/g, '/').split('/').filter((p) => p && p !== '..' && p !== '.').join('__');

let sevenZip = null;
function sevenZipPath() {
  if (sevenZip) return sevenZip;
  sevenZip = require('7zip-bin').path7za;
  try {
    fs.chmodSync(sevenZip, 0o755);
  } catch {}
  return sevenZip;
}

async function extractRar(file, dir) {
  const { createExtractorFromFile } = require('node-unrar-js');
  const extractor = await createExtractorFromFile({ filepath: file, targetPath: dir, filenameTransform: flatten });
  const { files } = extractor.extract({ files: (h) => !h.flags.directory && (isImageName(h.name) || /comicinfo\.xml$/i.test(h.name)) });
  for (const _ of files); // eslint-disable-line no-unused-vars -- iterating performs the extraction
}

function extract7z(file, dir) {
  return new Promise((resolve, reject) => {
    execFile(sevenZipPath(), ['x', '-y', '-bd', `-o${dir}`, file], { maxBuffer: 16 * 1024 * 1024 }, (err) =>
      err ? reject(new Error(`7-Zip failed: ${err.message.split('\n')[0]}`)) : resolve(),
    );
  });
}

async function extractTar(file, dir) {
  const tar = require('tar');
  await tar.x({
    file,
    cwd: dir,
    strict: false,
    preservePaths: false, // strips absolute paths and refuses '..' entries
    filter: (p, entry) => entry.type === 'File' && (isImageName(p) || /comicinfo\.xml$/i.test(p)),
  });
}

async function ensureExtracted(book) {
  const stat = await fsp.stat(book.path);
  const dir = extractDir(book.path, stat.mtimeMs);
  const marker = path.join(dir, '.complete');
  if (fs.existsSync(marker)) {
    const now = new Date();
    fs.utimes(marker, now, now, () => {});
    return dir;
  }
  if (extractJobs.has(dir)) return extractJobs.get(dir);
  const job = (async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    if (book.format === 'cbr') await extractRar(book.path, dir);
    else if (book.format === 'cb7') await extract7z(book.path, dir);
    else if (book.format === 'cbt') await extractTar(book.path, dir);
    await fsp.writeFile(marker, '');
    return dir;
  })();
  extractJobs.set(dir, job);
  try {
    return await job;
  } finally {
    extractJobs.delete(dir);
  }
}

// ---------------------------------------------------------------------------
// Folders

async function listImages(dir, recursive = false) {
  const out = [];
  async function walk(d, prefix) {
    for (const ent of await fsp.readdir(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory() && recursive) await walk(path.join(d, ent.name), rel);
      else if (ent.isFile() && isImageName(ent.name)) out.push(rel);
    }
  }
  await walk(dir, '');
  return out.sort(naturalSort);
}

// ---------------------------------------------------------------------------
// Public API

const listCache = new Map();

async function pageSource(book) {
  if (book.format === 'cbz') return { type: 'zip' };
  const dir = book.format === 'folder' ? book.path : await ensureExtracted(book);
  const key = `${dir}:${book.mtime}`;
  if (!listCache.has(key)) {
    if (listCache.size > 200) listCache.clear();
    listCache.set(key, await listImages(dir, book.format !== 'folder'));
  }
  return { type: 'dir', dir, pages: listCache.get(key) };
}

async function listPages(book) {
  const src = await pageSource(book);
  if (src.type === 'zip') return (await openZip(book.path)).entries.map((e) => e.fileName);
  return src.pages;
}

let sharp;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

/**
 * Returns { stream | buffer, mime, size } for page `index` (0-based).
 * With `width`, the image is downscaled (data saver / OPDS clients).
 */
async function openPage(book, index, { width } = {}) {
  let entry = null;
  let file = null;
  const src = await pageSource(book);
  if (src.type === 'zip') {
    const { entries } = await openZip(book.path);
    entry = entries[index];
    if (!entry) return null;
  } else {
    const name = src.pages[index];
    if (!name) return null;
    file = path.join(src.dir, name);
  }
  const name = entry ? entry.fileName : file;

  if (width && sharp) {
    const input = entry ? await readZipEntry((await openZip(book.path)).zip, entry) : await fsp.readFile(file);
    try {
      const buffer = await sharp(input, { failOn: 'none' })
        .rotate()
        .resize({ width: Math.round(width), withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer();
      return { buffer, mime: 'image/webp', size: buffer.length };
    } catch {
      return { buffer: input, mime: mimeFor(name), size: input.length };
    }
  }
  if (entry) {
    const { zip } = await openZip(book.path);
    return { stream: await zip.openReadStreamPromise(entry), mime: mimeFor(name), size: entry.uncompressedSize };
  }
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
  const src = await pageSource(book);
  let comicInfo = null;
  try {
    const names = await fsp.readdir(src.dir);
    const ci = names.find((n) => /comicinfo\.xml$/i.test(n));
    if (ci) comicInfo = await fsp.readFile(path.join(src.dir, ci), 'utf8');
  } catch {}
  return {
    pageCount: src.pages.length,
    cover: src.pages[0] ? await fsp.readFile(path.join(src.dir, src.pages[0])) : null,
    comicInfo,
  };
}

/** Drop extraction caches unused for `days` days. */
async function pruneCache(days = 14) {
  for (const sub of ['extract', 'rar']) {
    const root = path.join(config.cacheDir, sub);
    let dirs;
    try {
      dirs = await fsp.readdir(root);
    } catch {
      continue;
    }
    const cutoff = Date.now() - days * 86400_000;
    for (const d of dirs) {
      const dir = path.join(root, d);
      try {
        const stat = await fsp.stat(path.join(dir, '.complete'));
        if (sub === 'extract' && stat.mtimeMs > cutoff) continue;
      } catch {}
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  log.file('extraction cache pruned');
}

module.exports = {
  IMAGE_EXT,
  IMAGE_FORMATS,
  isImageName,
  naturalSort,
  sniff,
  listPages,
  openPage,
  inspect,
  readZipFile,
  pruneCache,
};
