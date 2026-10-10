'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const log = require('./log').logger('covers');

fs.mkdirSync(config.coverDir, { recursive: true });

let sharp = null;
try {
  sharp = require('sharp');
  sharp.cache(false);
} catch {
  log.warn('sharp not available – covers will be stored at original size.');
}

const SIGNATURES = [
  ['.jpg', [0xff, 0xd8, 0xff]],
  ['.png', [0x89, 0x50, 0x4e, 0x47]],
  ['.gif', [0x47, 0x49, 0x46]],
  ['.webp', [0x52, 0x49, 0x46, 0x46]],
];
function sniffExt(buf) {
  for (const [ext, sig] of SIGNATURES) if (sig.every((b, i) => buf[i] === b)) return ext;
  return null;
}

async function removeByPrefix(prefix) {
  for (const f of await fsp.readdir(config.coverDir)) {
    if (f.startsWith(prefix)) await fsp.rm(path.join(config.coverDir, f), { force: true });
  }
}

async function store(prefix, buffer) {
  if (!buffer?.length) return null;
  let out = null;
  let ext = null;
  if (sharp) {
    try {
      out = await sharp(buffer, { failOn: 'none', limitInputPixels: 300_000_000 })
        .rotate()
        .resize({ width: 480, height: 720, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      ext = '.webp';
    } catch {
      out = null;
    }
  }
  if (!out) {
    ext = sniffExt(buffer);
    if (!ext) return null;
    out = buffer;
  }
  await removeByPrefix(prefix);
  // A timestamp in the name keeps browser caches honest when artwork changes.
  const name = `${prefix}${Date.now().toString(36)}${ext}`;
  await fsp.writeFile(path.join(config.coverDir, name), out);
  return name;
}

/** Book (volume) cover. */
const saveCover = (bookId, buffer) => store(`${bookId}.`, buffer);
const removeCovers = (bookId) => removeByPrefix(`${bookId}.`);
/** Series artwork (custom or from a metadata provider). */
const saveSeriesCover = (seriesId, buffer) => store(`s${seriesId}.`, buffer);
const removeSeriesCover = (seriesId) => removeByPrefix(`s${seriesId}.`);

function coverPath(name) {
  return path.join(config.coverDir, path.basename(name));
}

/** Download an image from a URL (provider artwork, "set cover from URL"). */
async function fetchImage(url, maxBytes = 15 * 1024 * 1024) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) image URLs are supported.');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Flyleaf/2.0 (self-hosted reader)' },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Image download failed (${res.status})`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error('Image is too large.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('Image is too large.');
  return buf;
}

module.exports = { saveCover, removeCovers, saveSeriesCover, removeSeriesCover, coverPath, sniffExt, fetchImage };
