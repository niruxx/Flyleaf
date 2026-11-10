'use strict';

const { Worker } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const CFI = require('foliate-js/epubcfi.js');
const config = require('./config');
const cache = new Map();
let active = 0;
const waiting = [];

async function convert(file, format) {
  if (active >= 2) {
    if (waiting.length >= 32) throw new Error('Position converter is busy');
    await new Promise(resolve => waiting.push(resolve));
  } else active++;
  try {
    return await new Promise((resolve, reject) => {
      const script = format === 'fb2' ? 'fb2-position-worker.js' : 'mobi-position-worker.js';
      const worker = new Worker(path.join(config.root || path.resolve('.'), 'server', script), { workerData: { file } });
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Position conversion timed out')); }, 15000);
      worker.once('message', value => { clearTimeout(timeout); worker.terminate(); value.error ? reject(new Error(value.error)) : resolve(value.mappings); });
      worker.once('error', error => { clearTimeout(timeout); reject(error); });
      worker.once('exit', () => { clearTimeout(timeout); reject(new Error('Position converter exited before replying')); });
    });
  } finally {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}

async function mappings(book) {
  const stat = await fs.stat(book.path);
  if (stat.size > 64 * 1024 * 1024) return [];
  const key = JSON.stringify([book.format, book.path, stat.size, stat.mtimeMs]);
  if (!cache.has(key)) {
    const job = convert(book.path, book.format);
    cache.set(key, job);
    job.catch(() => cache.delete(key));
    while (cache.size > 8) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

function nativeOffset(text, raw) {
  if (!Number.isSafeInteger(raw) || raw < 0 || raw > text.length || (raw && /[\uD800-\uDBFF]/.test(text[raw - 1]) && /[\uDC00-\uDFFF]/.test(text[raw] || ''))) return null;
  return Array.from(text.slice(0, raw).replace(/[\t\n\r ]+/g, ' ')).length;
}

async function fb2XPointer(book, position) {
  if (!['fb2', 'mobi', 'azw3'].includes(book.format) || !CFI.isCFI.test(position || '') || position.length > 2000) return null;
  try {
    const parts = CFI.parse(CFI.collapse(position));
    if (parts.length !== 2 || parts.some(p => p.some(n => !Number.isSafeInteger(n.index) || n.index < 1))) return null;
    const canonical = parts.map(p => p.map(n => '/' + n.index).join('')).join('!');
    const raw = parts[1].at(-1).offset || 0;
    const candidates = (await mappings(book)).filter(m => m.path === canonical);
    const entry = candidates.find(m => raw >= m.chunkStart && raw < m.chunkStart + m.text.length) || candidates.find(m => raw === m.chunkStart + m.text.length);
    if (!entry) return null;
    const offset = nativeOffset(entry.text, raw - entry.chunkStart);
    return offset === null ? null : `${entry.native}.${offset}`;
  } catch { return null; }
}

async function fb2FromXPointer(book, pointer) {
  if (!['fb2', 'mobi', 'azw3'].includes(book.format) || typeof pointer !== 'string' || pointer.length > 4000) return null;
  const root = book.format === 'fb2' ? 'FictionBook' : 'body';
  const match = pointer.match(new RegExp(`^(\\/${root}(?:\\[1\\])?\\/(?:.*\\/)?text\\(\\)(?:\\[\\d+\\])?)\\.(\\d+)$`));
  if (!match) return null;
  try {
    const canonical = match[1].replace(`/${root}[1]`, `/${root}`).split('/').map(p => p && p !== root && !p.includes('[') ? p + '[1]' : p).join('/');
    const entry = (await mappings(book)).find(m => m.native === canonical);
    if (!entry) return null;
    const wanted = Number(match[2]);
    let raw = 0, count = 0, previousSpace = false;
    for (const char of entry.text) {
      if (count === wanted) break;
      raw += char.length;
      const space = /^[\t\n\r ]$/.test(char);
      if (!space || !previousSpace) count++;
      previousSpace = space;
    }
    if (count !== wanted) return null;
    return `epubcfi(${entry.path}:${entry.chunkStart + raw})`;
  } catch { return null; }
}

module.exports = { fb2XPointer, fb2FromXPointer, mobiXPointer: fb2XPointer, mobiFromXPointer: fb2FromXPointer,
  textXPointer: fb2XPointer, textFromXPointer: fb2FromXPointer };
