'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');

fs.mkdirSync(config.coverDir, { recursive: true });

let sharp = null;
try {
  sharp = require('sharp');
  sharp.cache(false);
} catch {
  console.warn('[covers] sharp not available – covers will be stored at original size.');
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

async function removeCovers(bookId) {
  for (const f of await fsp.readdir(config.coverDir)) {
    if (f.startsWith(`${bookId}.`)) await fsp.rm(path.join(config.coverDir, f), { force: true });
  }
}

/** Store a cover image for a book; returns the file name or null when unusable. */
async function saveCover(bookId, buffer) {
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
  await removeCovers(bookId);
  const name = `${bookId}${ext}`;
  await fsp.writeFile(path.join(config.coverDir, name), out);
  return name;
}

function coverPath(name) {
  return path.join(config.coverDir, path.basename(name));
}

module.exports = { saveCover, removeCovers, coverPath, sniffExt };
