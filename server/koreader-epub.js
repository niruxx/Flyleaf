'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const config = require('./config');
const jobs = new Map();

async function renditionPath(book) {
  if (!['mobi', 'azw3'].includes(book.format)) return null;
  const stat = await fs.stat(book.path);
  if (stat.size > 64 * 1024 * 1024) throw new Error('Book exceeds the 64 MiB conversion limit');
  const revision = crypto.createHash('sha256').update(JSON.stringify(['koreader-epub-v1', book.path, stat.size, stat.mtimeMs, stat.ctimeMs])).digest('hex');
  return path.join(config.cacheDir, 'koreader-epub', `${revision}.epub`);
}

async function existingRendition(book) {
  const file = await renditionPath(book);
  if (!file) return null;
  try { await fs.access(file); return file; } catch { return null; }
}

async function toEpub(book) {
  const file = await renditionPath(book);
  if (!file) throw new Error('EPUB export supports MOBI and AZW3 books');
  if (jobs.has(file)) return jobs.get(file);
  try { await fs.access(file); return file; } catch {}
  if (jobs.has(file)) return jobs.get(file);
  if (jobs.size >= 2) throw new Error('EPUB converter is busy; try again shortly');
  const job = (async () => {
    const buffer = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(config.root || path.resolve('.'), 'server', 'koreader-epub-worker.js'), {
        workerData: { file: book.path, revision: path.basename(file, '.epub') },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('EPUB conversion timed out')); }, 30000);
      worker.once('message', value => { clearTimeout(timeout); worker.terminate(); value.error ? reject(new Error(value.error)) : resolve(value.buffer); });
      worker.once('error', error => { clearTimeout(timeout); reject(error); });
      worker.once('exit', () => { clearTimeout(timeout); reject(new Error('EPUB converter exited before replying')); });
    });
    if (await renditionPath(book) !== file) throw new Error('Source changed during conversion; try again');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(tmp, buffer); await fs.rename(tmp, file); }
    finally { await fs.rm(tmp, { force: true }); }
    return file;
  })();
  jobs.set(file, job);
  try { return await job; } finally { jobs.delete(file); }
}

module.exports = { toEpub, existingRendition };
