'use strict';

const fs = require('node:fs/promises');
const { constants, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { q } = require('./db');
const config = require('./config');
const scanner = require('./scanner');
const { AUDIO_EXT } = require('./audio');
const { json, similarity } = require('./util');
const log = require('./log').logger('bookdrop');

const QUIET_MS = 5000;
const documents = new Set(['txt', 'docx', 'rtf', 'audio']);
const observed = new Map();
const available = new Map();
const importing = new Set();
let folderError = null;
let polling = false;

const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};
const stamp = (st) => [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':');

async function inboxRoot() {
  let root;
  try { root = await fs.realpath(config.bookDropDir); } catch {
    throw fail('BookDrop folder is unavailable. Check BOOKDROP_DIR and the folder permissions.', 503);
  }
  for (const lib of q('SELECT path FROM libraries').all()) {
    const library = await fs.realpath(lib.path).catch(() => path.resolve(lib.path));
    if (within(library, root) || within(root, library)) throw fail('BookDrop needs a folder separate from all libraries.', 409);
  }
  return root;
}

async function currentFile(file) {
  const st = await fs.lstat(file.path).catch(() => null);
  return st?.isFile() && stamp(st) === file.stamp;
}

async function preview(file) {
  const title = path.basename(file.name, path.extname(file.name)).replace(/[_.]+/g, ' ');
  const format = await scanner.resolveFormat(file);
  if (!format) return { title, error: 'Unsupported or unreadable archive.' };
  let info;
  try {
    info = await scanner.readBookMetadata({ ...file, format });
  } catch {
    return { format, title, error: 'Could not read the embedded metadata.' };
  }
  const embedded = info.embedded;
  const item = { format, title: info.update.title || title, author: info.update.author || null,
    description: info.update.description || null, isbn: embedded.isbn || null };
  if (!config.bookDropOnline || ['txt', 'docx', 'rtf', 'audio', 'cbz', 'cbr', 'cb7', 'cbt'].includes(format)) return item;

  const providers = require('./providers');
  const search = item.isbn || item.title;
  for (const id of ['openlibrary', 'googlebooks']) {
    try {
      const provider = providers.get(id);
      const results = await provider.search(search);
      const best = results.find((candidate) => similarity(candidate.title, item.title) >= 0.9 && (!item.author ||
        candidate.people?.some((person) => similarity(person.name, item.author) >= 0.85)));
      if (!best) continue;
      item.match = await provider.details(best.id).catch(() => best);
      break;
    } catch (e) {
      log.file(`${id} BookDrop search failed: ${e.message}`);
    }
  }
  return item;
}

async function poll() {
  if (!config.bookDropDir || polling) return;
  polling = true;
  try {
    const root = await inboxRoot();
    const entries = await fs.readdir(root, { withFileTypes: true });
    const now = Date.now();
    folderError = null;
    const seen = new Set();
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const format = scanner.FILE_FORMATS[ext] || (AUDIO_EXT.has(ext) ? 'audio' : null);
      if (!format || (format === 'txt' && /^(readme|license|licence|changelog|notes?|info|credits|copying|nfo)\b/i.test(entry.name))) continue;
      const filePath = path.join(root, entry.name);
      const st = await fs.lstat(filePath).catch(() => null);
      if (!st?.isFile() || !st.size) continue;
      const fingerprint = stamp(st);
      const id = createHash('sha256').update(JSON.stringify([filePath, fingerprint])).digest('hex');
      seen.add(id);
      const first = observed.get(id) ?? now;
      observed.set(id, first);
      if (now - first < QUIET_MS) continue;
      const file = { path: filePath, id, name: entry.name, size: st.size, stamp: fingerprint, format };
      let row = q('SELECT * FROM book_drop WHERE id = ?').get(id);
      if (!row) {
        const metadata = await preview(file);
        if (!await currentFile(file)) continue;
        q('INSERT INTO book_drop (id, metadata, created_at) VALUES (?, ?, ?)').run(id, JSON.stringify(metadata), now);
        row = { state: 'ready', metadata: JSON.stringify(metadata), created_at: now };
      }
      available.set(id, { ...file, metadata: json(row.metadata, {}), state: row.state, addedAt: row.created_at });
    }
    for (const id of observed.keys()) if (!seen.has(id)) observed.delete(id);
    for (const id of available.keys()) if (!seen.has(id)) available.delete(id);
  } catch (e) {
    folderError = e.expose ? e.message : 'The BookDrop folder could not be read.';
    available.clear();
    observed.clear();
    log.file(e.message);
  } finally {
    polling = false;
  }
}

function inbox() {
  const items = Array.from(available.values()).filter((file) => file.state === 'ready').sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name));
  return { enabled: Boolean(config.bookDropDir), folder: config.bookDropDir, error: folderError, items: items.map(({ id, name, size, metadata }) => ({
    id, name, size, metadata: { ...metadata, match: metadata.match ? { title: metadata.match.title, provider: metadata.match.provider,
      summary: metadata.match.summary } : null },
  })) };
}

function getReady(id) {
  const file = available.get(id);
  if (!file || file.state !== 'ready') throw fail('This file is no longer in the inbox.', 404);
  if (importing.has(id)) throw fail('This file is already being imported.', 409);
  return file;
}

function finish(file, state) {
  q('UPDATE book_drop SET state = ? WHERE id = ?').run(state, file.id);
  file.state = state;
  if (available.has(file.id)) available.get(file.id).state = state;
}

function dismiss(id) {
  finish(getReady(id), 'dismissed');
}

async function importFile(id, libraryId, userId, useMatch, folder = '') {
  const file = getReady(id);
  const lib = q('SELECT * FROM libraries WHERE id = ?').get(libraryId);
  if (!lib) throw fail('Choose a destination library.', 404);
  if (documents.has(file.format) && lib.kind !== 'books') throw fail('Choose a books library for this format.');
  if (!file.metadata.format) throw fail('This archive could not be read.');
  const segments = typeof folder === 'string' && folder.trim() ? folder.trim().split(/[\\/]/) : [];
  if (segments.length > 8 || segments.some((segment) => !segment || segment.length > 120 || /^\.|[. ]$|[:*?"<>|\x00-\x1f]/.test(segment))) {
    throw fail('Enter a folder name inside the library, such as Author/Series.');
  }
  importing.add(id);
  let stage;
  let name;
  try {
    const root = await inboxRoot();
    if (path.dirname(file.path) !== root || !await currentFile(file)) throw fail('The inbox file changed. Wait for it to be detected again.', 409);
    const libraryRoot = await fs.realpath(lib.path);
    const targetStat = await fs.stat(libraryRoot);
    if (!targetStat.isDirectory() || (lib.storage_device != null && lib.storage_device !== String(targetStat.dev))) {
      throw fail('The destination library is unavailable.', 409);
    }
    const storage = require('./storage');
    await storage.check(lib.owner_id || userId, lib.id, file.size);
    let target = libraryRoot;
    for (const segment of segments) {
      target = path.join(target, segment);
      await fs.mkdir(target).catch((e) => { if (e.code !== 'EEXIST') throw e; });
      if (!(await fs.lstat(target)).isDirectory()) throw fail('The destination must be a folder inside the library.');
    }
    stage = await fs.mkdtemp(path.join(target, '.flyleaf-drop-'));
    const copy = path.join(stage, 'book.part');
    const source = await fs.open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const st = await source.stat();
      if (!st.isFile() || stamp(st) !== file.stamp) throw fail('The inbox file changed during import.', 409);
      await pipeline(source.createReadStream({ autoClose: false }), createWriteStream(copy, { flags: 'wx' }));
    } finally {
      await source.close();
    }
    if (!await currentFile(file) || (await fs.stat(copy)).size !== file.size) throw fail('The inbox file changed during import.', 409);
    const library = q('SELECT path FROM libraries WHERE id = ?').get(lib.id);
    if (library?.path !== lib.path || await fs.realpath(lib.path) !== libraryRoot || await fs.realpath(target) !== target) {
      throw fail('The library moved during import.', 409);
    }
    const ext = path.extname(file.name);
    const stem = path.basename(file.name, ext);
    // Publish the complete copy without ever replacing an existing library file.
    for (let n = 1; n <= 1000; n++) {
      name = n === 1 ? file.name : `${stem.slice(0, 64)} (${n})${ext}`;
      try { await fs.link(copy, path.join(target, name)); break; } catch (e) {
        if (e.code !== 'EEXIST' || n === 1000) throw e;
      }
    }
    finish(file, 'imported');
    storage.forget(lib.owner_id || userId);
  } catch (e) {
    if (e.expose) throw e;
    throw fail(`Could not copy the book into the destination library (${e.code || 'storage error'}).`, 409);
  } finally {
    importing.delete(id);
    if (stage) {
      await fs.unlink(path.join(stage, 'book.part')).catch(() => {});
      await fs.rmdir(stage).catch(() => {});
    }
  }

  try {
    await scanner.scanAndWait(lib.id);
    const rel = path.join(...segments, name);
    const book = q('SELECT id, series_id FROM books WHERE library_id = ? AND rel_path = ? AND missing = 0').get(lib.id, rel);
    if (!book) return { name, warning: 'The file was copied, but the scan did not recognize it as a book.' };
    if (useMatch && file.metadata.match && q('SELECT COUNT(*) AS n FROM books WHERE series_id = ? AND missing = 0').get(book.series_id).n === 1) {
      const service = require('./metadata-service');
      await service.applyToSeries(book.series_id, file.metadata.match, { fields: service.FIELDS.filter((field) => field !== 'name'), coverPolicy: lib.cover_policy });
    }
    return { name, bookId: book.id, seriesId: book.series_id };
  } catch (e) {
    log.file(e.message);
    return { name, warning: 'The file was copied, but the scan or metadata update failed. Check Activity for the scan result.' };
  }
}

function start() {
  if (!config.bookDropDir) return;
  void poll();
  setInterval(poll, QUIET_MS).unref();
}

module.exports = { start, poll, inbox, dismiss, importFile };
