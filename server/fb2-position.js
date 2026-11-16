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
      const worker = new Worker(path.join(config.root || path.resolve('.'), 'server', script), { workerData: { file }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
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

function nativeOffset(text, raw, entry = {}) {
  if (!Number.isSafeInteger(raw) || raw < 0 || raw > text.length || (raw && /[\uD800-\uDBFF]/.test(text[raw - 1]) && /[\uDC00-\uDFFF]/.test(text[raw] || ''))) return null;
  if (entry.pre && text[raw - 1] === '\r' && text[raw] === '\n') return null;
  let prefix = text.slice(0, raw);
  if (entry.stripLeadingNewline) prefix = prefix.replace(/^(?:\r\n?|\n)/, '');
  return Array.from(entry.pre ? prefix.replace(/\r\n?/g, '\n') : prefix.replace(/[\t\n\r ]+/g, ' ')).length;
}

async function fb2XPointer(book, position) {
  if (!['fb2', 'mobi', 'azw3'].includes(book.format) || !CFI.isCFI.test(position || '') || position.length > 2000) return null;
  try {
    const parts = CFI.parse(CFI.collapse(position));
    if (parts.length !== 2 || parts.some(p => p.some(n => !Number.isSafeInteger(n.index) || n.index < 1 || n.temporal != null || n.spatial))) return null;
    const canonical = parts.map(p => p.map(n => '/' + n.index).join('')).join('!');
    const raw = parts[1].at(-1).offset || 0;
    const candidates = (await mappings(book)).filter(m => m.path === canonical && (!book.mobiDomProfile || !m.profile || m.profile === book.mobiDomProfile));
    const profiles = [...new Set(candidates.map(m => m.profile))];
    const pointers = profiles.map(profile => {
      const entries = candidates.filter(m => m.profile === profile);
      const entry = entries.find(m => raw >= m.chunkStart && raw < m.chunkStart + m.text.length) || entries.find(m => raw === m.chunkStart + m.text.length);
      if (!entry) return null;
      const offset = nativeOffset(entry.nativeRun?.text ?? entry.text, (entry.nativeStart || 0) + raw - entry.chunkStart, entry);
      return offset === null ? null : `${entry.native}.${offset}`;
    });
    // Without an observed DOM profile, only return positions on which all
    // models agree. Never guess between pre/post-20260812 anchor layouts.
    return pointers.length && pointers.every(p => p && p === pointers[0]) ? pointers[0] : null;
  } catch { return null; }
}

async function textPositionFromXPointer(book, pointer) {
  if (!['fb2', 'mobi', 'azw3'].includes(book.format) || typeof pointer !== 'string' || pointer.length > 4000) return null;
  const root = book.format === 'fb2' ? 'FictionBook' : 'body';
  const match = pointer.match(new RegExp(`^(\\/${root}(?:\\[1\\])?\\/(?:.*\\/)?text\\(\\)(?:\\[\\d+\\])?)\\.(\\d+)$`));
  if (!match) return null;
  try {
    const canonical = match[1].replace(`/${root}[1]`, `/${root}`).split('/').map(p => p && p !== root && !p.includes('[') ? p + '[1]' : p).join('/');
    const wanted = Number(match[2]);
    if (!Number.isSafeInteger(wanted)) return null;
    const candidates = (await mappings(book)).filter(m => m.native === canonical && (!book.mobiDomProfile || !m.profile || m.profile === book.mobiDomProfile));
    const positions = [];
    for (const profile of new Set(candidates.map(m => m.profile))) {
      const entries = candidates.filter(m => m.profile === profile);
      const text = entries[0].nativeRun?.text ?? entries[0].text;
      const boundaries = [0];
      let end = 0;
      for (const char of text) {
        end += char.length;
        if (!(entries[0].pre && text[end - 1] === '\r' && text[end] === '\n')) boundaries.push(end);
      }
      let low = 0, high = boundaries.length - 1;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (nativeOffset(text, boundaries[mid], entries[0]) < wanted) low = mid + 1; else high = mid;
      }
      const raw = boundaries[low];
      if (nativeOffset(text, raw, entries[0]) !== wanted) continue;
      const entry = entries.find(m => raw >= (m.nativeStart || 0) && raw < (m.nativeStart || 0) + m.text.length)
        || entries.find(m => raw === (m.nativeStart || 0) + m.text.length);
      if (entry) positions.push({ position: `epubcfi(${entry.path}:${entry.chunkStart + raw - (entry.nativeStart || 0)})`, profile });
    }
    if (!positions.length || positions.some(p => p.position !== positions[0].position)) return null;
    return { position: positions[0].position, profile: positions.length === 1 ? positions[0].profile : null };
  } catch { return null; }
}

async function fb2FromXPointer(book, pointer) {
  return (await textPositionFromXPointer(book, pointer))?.position || null;
}

module.exports = { fb2XPointer, fb2FromXPointer, mobiXPointer: fb2XPointer, mobiFromXPointer: fb2FromXPointer,
  textXPointer: fb2XPointer, textFromXPointer: fb2FromXPointer, textPositionFromXPointer };
