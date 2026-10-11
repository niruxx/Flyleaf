'use strict';

// Page access for image-based books: CBZ/ZIP, CBR/RAR, CB7/7z, CBT/tar and
// plain image folders. Every archive is read in place – nothing is unpacked
// to disk:
//   ZIP  – entries are inflated on demand (yauzl)
//   RAR  – the archive is held in memory and single entries are decoded with
//          unrar (WASM); solid archives are decoded once into a page cache
//   7z   – single entries are streamed out of 7-Zip (`7za e -so`)
//   tar  – entries are byte ranges of the file, read directly

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, execFile } = require('node:child_process');
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
const MAX_ENTRY = 200 * 1024 * 1024;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const naturalSort = (a, b) => collator.compare(a, b);

function isImageName(name) {
  const norm = name.replace(/\\/g, '/');
  const base = norm.split('/').pop();
  if (!base || base.startsWith('.') || norm.includes('__MACOSX/')) return false;
  return IMAGE_EXT.has(path.extname(base).toLowerCase());
}
const mimeFor = (name) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
const isComicInfo = (name) => /(^|[\\/])comicinfo\.xml$/i.test(name);

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
    if (buf[0] === 0x1f && buf[1] === 0x8b) return 'tar'; // gzipped tar (.cbt / .tar.gz)
    return null;
  } finally {
    await fh.close();
  }
}

async function streamToBuffer(stream, max = MAX_ENTRY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) throw new Error('Entry too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** A small LRU keyed by string; `cost` lets byte-sized caches evict by size. */
class Lru {
  constructor(max, cost = () => 1, maxCount = Infinity) {
    this.max = max;
    this.maxCount = maxCount;
    this.cost = cost;
    this.total = 0;
    this.map = new Map();
  }
  get(key) {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.delete(key);
    this.map.set(key, value);
    this.total += this.cost(value);
    while ((this.total > this.max || this.map.size > this.maxCount) && this.map.size > 1) this.delete(this.map.keys().next().value);
  }
  delete(key) {
    const v = this.map.get(key);
    if (v === undefined) return;
    this.map.delete(key);
    this.total -= this.cost(v);
    v?.close?.();
  }
}

// ---------------------------------------------------------------------------
// Handles: { pages: [names], others: Map(lowercase name → name), read(name) → Buffer | {stream,size} }

async function openZipHandle(file) {
  const zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false, strictFileNames: false });
  const byName = new Map();
  const pages = [];
  const others = new Map();
  for await (const entry of zip.eachEntry()) {
    if (entry.fileName.endsWith('/')) continue;
    byName.set(entry.fileName, entry);
    if (isImageName(entry.fileName)) pages.push(entry.fileName);
    else others.set(entry.fileName.toLowerCase(), entry.fileName);
  }
  pages.sort(naturalSort);
  return {
    pages,
    others,
    async read(name, { stream = false } = {}) {
      const entry = byName.get(name);
      if (!entry) return null;
      if (entry.uncompressedSize > MAX_ENTRY) throw new Error('Entry too large');
      const s = await zip.openReadStreamPromise(entry);
      return stream ? { stream: s, size: entry.uncompressedSize } : streamToBuffer(s);
    },
    close: () => zip.close(),
  };
}

// RAR ------------------------------------------------------------------------

let unrarWasm = null;
const RAR_MEMORY = 512 * 1024 * 1024; // archives + decoded pages kept in memory
const rarPageCache = new Lru(256 * 1024 * 1024, (b) => b.length);

async function rarExtractor(data) {
  const { createExtractorFromData } = require('node-unrar-js');
  unrarWasm ||= fs.readFileSync(path.join(path.dirname(require.resolve('node-unrar-js')), 'js', 'unrar.wasm')).buffer;
  return createExtractorFromData({ data, wasmBinary: unrarWasm });
}

async function openRarHandle(file, key) {
  const buf = await fsp.readFile(file);
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const list = (await rarExtractor(data)).getFileList();
  const headers = [...list.fileHeaders].filter((h) => !h.flags.directory);
  if (headers.some((h) => h.flags.encrypted)) throw new Error('Password-protected RAR archives aren’t supported.');
  const solid = Boolean(list.arcHeader?.flags?.solid);
  const pages = headers.filter((h) => isImageName(h.name)).map((h) => h.name).sort(naturalSort);
  const others = new Map(headers.filter((h) => !isImageName(h.name)).map((h) => [h.name.toLowerCase(), h.name]));
  const wanted = new Set([...pages, ...others.values()].filter((n) => isImageName(n) || isComicInfo(n)));
  let solidJob = null;

  async function extract(names) {
    const set = new Set(names);
    const { files } = (await rarExtractor(data)).extract({ files: (h) => set.has(h.name) });
    const out = new Map();
    for (const f of files) if (f.extraction) out.set(f.fileHeader.name, Buffer.from(f.extraction));
    return out;
  }

  return {
    pages,
    others,
    size: buf.length,
    async read(name) {
      const cacheKey = `${key}\0${name}`;
      const hit = rarPageCache.get(cacheKey);
      if (hit) return hit;
      if (!solid) {
        const got = (await extract([name])).get(name) || null;
        if (got) rarPageCache.set(cacheKey, got);
        return got;
      }
      // Solid archives compress files as one stream: decoding page N means decoding
      // everything before it, so decode the whole set once and serve from memory.
      solidJob ||= extract([...wanted]).then((all) => {
        for (const [n, b] of all) rarPageCache.set(`${key}\0${n}`, b);
        return all;
      }).finally(() => {
        solidJob = null;
      });
      const all = await solidJob;
      return all.get(name) || rarPageCache.get(cacheKey) || null;
    },
  };
}

// 7z -------------------------------------------------------------------------

let sevenZip = null;
function sevenZipPath() {
  if (sevenZip) return sevenZip;
  sevenZip = require('7zip-bin').path7za;
  try {
    fs.chmodSync(sevenZip, 0o755);
  } catch {}
  return sevenZip;
}

function list7z(file) {
  return new Promise((resolve, reject) => {
    execFile(sevenZipPath(), ['l', '-slt', '-ba', '-sccUTF-8', file], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`7-Zip couldn't read the archive: ${err.message.split('\n')[0]}`));
      const entries = [];
      for (const block of stdout.split(/\r?\n\r?\n/)) {
        const fields = Object.fromEntries(block.split(/\r?\n/).map((l) => l.split(' = ')).filter((p) => p.length === 2));
        if (!fields.Path || fields.Folder === '+' || /D/.test(fields.Attributes || '')) continue;
        entries.push({ name: fields.Path, size: Number(fields.Size) || 0 });
      }
      resolve(entries);
    });
  });
}

async function open7zHandle(file) {
  const entries = await list7z(file);
  const pages = entries.filter((e) => isImageName(e.name)).map((e) => e.name).sort(naturalSort);
  const others = new Map(entries.filter((e) => !isImageName(e.name)).map((e) => [e.name.toLowerCase(), e.name]));
  return {
    pages,
    others,
    read(name) {
      // `e -so` writes just that entry to stdout. Wildcards are disabled (-spd) so names are literal.
      const child = spawn(sevenZipPath(), ['e', '-so', '-spd', '-bd', '-y', file, '--', name], { stdio: ['ignore', 'pipe', 'ignore'] });
      return streamToBuffer(child.stdout);
    },
  };
}

// tar ------------------------------------------------------------------------

/** Index a tar file: [{ name, offset, size }] for every regular file. */
async function indexTar(fh, size) {
  const entries = [];
  let pos = 0;
  let longName = null;
  let paxPath = null;
  const header = Buffer.alloc(512);
  const octal = (b) => parseInt(b.toString('latin1').replace(/\0.*$/s, '').trim() || '0', 8);
  const str = (b) => b.toString('utf8').replace(/\0.*$/s, '');
  while (pos + 512 <= size) {
    await fh.read(header, 0, 512, pos);
    if (header.every((x) => x === 0)) break;
    const type = String.fromCharCode(header[156] || 0x30);
    const len = octal(header.subarray(124, 136));
    const dataAt = pos + 512;
    if (type === 'L' || type === 'x') {
      const body = Buffer.alloc(len);
      await fh.read(body, 0, len, dataAt);
      if (type === 'L') longName = str(body);
      else paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null;
    } else {
      const prefix = header.toString('latin1', 257, 262) === 'ustar' ? str(header.subarray(345, 500)) : '';
      const name = paxPath || longName || (prefix ? `${prefix}/` : '') + str(header.subarray(0, 100));
      if ((type === '0' || type === '\0' || type === '7') && !name.split('/').includes('..')) entries.push({ name, offset: dataAt, size: len });
      longName = null;
      paxPath = null;
    }
    pos = dataAt + Math.ceil(len / 512) * 512;
  }
  return entries;
}

async function openTarHandle(file) {
  const head = Buffer.alloc(2);
  const fh = await fsp.open(file, 'r');
  let entries;
  let gz = null;
  try {
    await fh.read(head, 0, 2, 0);
    if (head[0] === 0x1f && head[1] === 0x8b) {
      // Compressed .tar.gz can't be seeked; inflate it in memory instead.
      gz = zlib.gunzipSync(await fsp.readFile(file), { maxOutputLength: 1024 * 1024 * 1024 });
      const mem = { read: async (buf, off, len, pos) => ({ bytesRead: gz.copy(buf, off, pos, pos + len) }) };
      entries = await indexTar(mem, gz.length);
    } else {
      entries = await indexTar(fh, (await fh.stat()).size);
    }
  } finally {
    await fh.close();
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const pages = entries.filter((e) => isImageName(e.name)).map((e) => e.name).sort(naturalSort);
  const others = new Map(entries.filter((e) => !isImageName(e.name)).map((e) => [e.name.toLowerCase(), e.name]));
  return {
    pages,
    others,
    size: gz?.length || 0,
    async read(name, { stream = false } = {}) {
      const e = byName.get(name);
      if (!e) return null;
      if (e.size > MAX_ENTRY) throw new Error('Entry too large');
      if (gz) return gz.subarray(e.offset, e.offset + e.size);
      if (stream) return { stream: fs.createReadStream(file, { start: e.offset, end: e.offset + e.size - 1 }), size: e.size };
      if (!e.size) return Buffer.alloc(0);
      const fd = await fsp.open(file, 'r');
      try {
        const b = Buffer.alloc(e.size);
        await fd.read(b, 0, e.size, e.offset);
        return b;
      } finally {
        await fd.close();
      }
    },
  };
}

// Folders --------------------------------------------------------------------

async function listImages(dir) {
  const out = [];
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    if (ent.isFile() && isImageName(ent.name)) out.push(ent.name);
  }
  return out.sort(naturalSort);
}

async function openFolderHandle(dir) {
  const pages = await listImages(dir);
  const names = await fsp.readdir(dir);
  const others = new Map(names.filter((n) => isComicInfo(n)).map((n) => [n.toLowerCase(), n]));
  return {
    pages,
    others,
    async read(name, { stream = false } = {}) {
      const file = path.join(dir, path.basename(name));
      if (stream) return { stream: fs.createReadStream(file), size: (await fsp.stat(file)).size };
      return fsp.readFile(file);
    },
  };
}

// ---------------------------------------------------------------------------
// Handle cache

// RAR handles hold the whole archive in memory, so the cache is bounded by bytes as well as count.
const handles = new Lru(RAR_MEMORY, (h) => h.size || 0, 24);
const opening = new Map();

async function handleFor(book) {
  const stat = await fsp.stat(book.path);
  const key = `${book.path}:${stat.mtimeMs}`;
  const hit = handles.get(key);
  if (hit) return hit;
  if (opening.has(key)) return opening.get(key);
  const job = (async () => {
    switch (book.format) {
      case 'cbz':
        return openZipHandle(book.path);
      case 'cbr':
        return openRarHandle(book.path, key);
      case 'cb7':
        return open7zHandle(book.path);
      case 'cbt':
        return openTarHandle(book.path);
      case 'folder':
        return openFolderHandle(book.path);
      default:
        throw new Error(`Not an image book: ${book.format}`);
    }
  })();
  opening.set(key, job);
  try {
    const h = await job;
    handles.set(key, h);
    return h;
  } finally {
    opening.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Public API

async function listPages(book) {
  return (await handleFor(book)).pages;
}

async function readZipFile(file, name) {
  const h = await handleFor({ path: file, format: 'cbz' });
  const real = h.others.get(name.toLowerCase()) || h.pages.find((p) => p.toLowerCase() === name.toLowerCase());
  return real ? h.read(real) : null;
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
  const h = await handleFor(book);
  const name = h.pages[index];
  if (!name) return null;
  if (width && sharp) {
    const input = await h.read(name);
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
  const got = await h.read(name, { stream: true });
  if (!got) return null;
  if (Buffer.isBuffer(got)) return { buffer: got, mime: mimeFor(name), size: got.length };
  return { stream: got.stream, mime: mimeFor(name), size: got.size };
}

/** Page count, first image and ComicInfo.xml for metadata/cover extraction. */
async function inspect(book) {
  const h = await handleFor(book);
  const info = [...h.others.entries()].find(([n]) => n.split(/[\\/]/).pop() === 'comicinfo.xml')?.[1];
  return {
    pageCount: h.pages.length,
    cover: h.pages[0] ? await h.read(h.pages[0]) : null,
    comicInfo: info ? (await h.read(info)).toString('utf8') : null,
  };
}

/** Remove the on-disk extraction caches older versions of Flyleaf created. */
async function pruneCache() {
  for (const sub of ['extract', 'rar']) {
    await fsp.rm(path.join(config.cacheDir, sub), { recursive: true, force: true }).catch(() => {});
  }
  log.file('old extraction caches removed');
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
