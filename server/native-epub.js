'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const config = require('./config');
const jobs = new Map();
async function toNativeEpub(book) {
  if (!['fb2','mobi','azw3'].includes(book.format)) throw new Error('No native rendition is needed for this format.');
  const stat = await fs.stat(book.path);
  if (stat.size > 64 * 1024 * 1024) throw new Error('Native conversion exceeds the 64 MiB input limit.');
  const key = crypto.createHash('sha256').update(JSON.stringify(['native-v1',book.path,stat.mtimeMs,stat.size,book.format])).digest('hex');
  const output = path.join(config.cacheDir, 'native-epub', key + '.epub');
  try { await fs.access(output); return output; } catch {}
  if (jobs.has(key)) return jobs.get(key);
  if (jobs.size >= 2) throw Object.assign(new Error('Native conversion is busy. Retry shortly.'), { status: 503, expose: true });
  const job = (async () => {
    const data = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(config.root || path.resolve('.'), 'server/native-epub-worker.js'), { workerData: { file: book.path, format: book.format, title: book.title }, resourceLimits: { maxOldGenerationSizeMb: 384 } });
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('Native conversion timed out.')); }, 30000);
      worker.once('message', message => { clearTimeout(timer); worker.terminate(); message.error ? reject(new Error(message.error)) : resolve(message.data); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', code => { clearTimeout(timer); reject(new Error('Native converter exited before replying: ' + code)); });
    });
    await fs.mkdir(path.dirname(output), { recursive: true });
    const temporary = output + '.' + crypto.randomUUID() + '.part';
    try { await fs.writeFile(temporary, data); await fs.rename(temporary, output); }
    finally { await fs.rm(temporary, { force: true }); }
    return output;
  })();
  jobs.set(key, job);
  try { return await job; } finally { jobs.delete(key); }
}
module.exports = { toNativeEpub };
