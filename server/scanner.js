'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { q, tx } = require('./db');
const archive = require('./archive');
const meta = require('./metadata');
const { saveCover } = require('./covers');

const FILE_FORMATS = {
  '.epub': 'epub',
  '.kepub': 'epub',
  '.pdf': 'pdf',
  '.cbz': 'cbz',
  '.zip': 'cbz',
  '.cbr': 'cbr',
  '.rar': 'cbr',
};

const state = {
  running: false,
  libraryId: null,
  phase: 'idle',
  found: 0,
  processed: 0,
  total: 0,
  lastError: null,
  finishedAt: null,
};
const queue = [];

/** Walk a library root and return candidate books: {path, format, isDir, size, mtime}. */
async function walk(root) {
  const results = [];
  const seen = new Set();

  async function visit(dir, depth) {
    if (depth > 12) return;
    let real;
    try {
      real = await fsp.realpath(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let images = 0;
    let bookFiles = 0;
    let newestImage = 0;
    const subdirs = [];
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name === '@eaDir' || ent.name === '__MACOSX') continue;
      const full = path.join(dir, ent.name);
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        try {
          const st = await fsp.stat(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        subdirs.push(full);
      } else if (isFile) {
        const ext = path.extname(ent.name).toLowerCase();
        if (FILE_FORMATS[ext]) {
          bookFiles++;
          const st = await fsp.stat(full).catch(() => null);
          if (st) results.push({ path: full, format: FILE_FORMATS[ext], isDir: false, size: st.size, mtime: Math.floor(st.mtimeMs) });
          state.found = results.length;
        } else if (archive.IMAGE_EXT.has(ext)) {
          images++;
          const st = await fsp.stat(full).catch(() => null);
          if (st) newestImage = Math.max(newestImage, Math.floor(st.mtimeMs));
        }
      }
    }
    // A folder that holds images directly (e.g. an extracted chapter) is a comic.
    if (images >= 2 && bookFiles === 0 && dir !== root) {
      results.push({ path: dir, format: 'folder', isDir: true, size: images, mtime: newestImage });
      state.found = results.length;
    }
    for (const sub of subdirs) await visit(sub, depth + 1);
  }

  await visit(root, 0);
  return results;
}

/** Series name from the folder structure: the containing folder below the library root. */
function folderSeries(root, file) {
  const rel = path.relative(root, path.dirname(file));
  if (!rel || rel.startsWith('..')) return null;
  return path.basename(rel);
}

async function scanLibrary(lib) {
  const stat = await fsp.stat(lib.path).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Library folder not found: ${lib.path}`);

  state.phase = 'walking';
  const found = await walk(lib.path);
  const existing = new Map(q('SELECT id, path, size, mtime, missing FROM books WHERE library_id = ?').all(lib.id).map((b) => [b.path, b]));
  const now = Date.now();

  state.phase = 'indexing';
  tx(() => {
    for (const f of found) {
      const prev = existing.get(f.path);
      existing.delete(f.path);
      if (prev) {
        if (prev.size !== f.size || prev.mtime !== f.mtime || prev.missing) {
          q('UPDATE books SET size = ?, mtime = ?, missing = 0, needs_meta = 1, updated_at = ? WHERE id = ?').run(f.size, f.mtime, now, prev.id);
        }
        continue;
      }
      const title = meta.titleFromFilename(f.path, f.isDir);
      const series = lib.kind === 'books' ? null : folderSeries(lib.path, f.path);
      q(`INSERT INTO books (library_id, path, rel_path, format, title, series, series_index, size, mtime, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        lib.id,
        f.path,
        path.relative(lib.path, f.path),
        f.format,
        title,
        series,
        series ? meta.numberFromTitle(title) : null,
        f.size,
        f.mtime,
        now,
        now,
      );
    }
    for (const gone of existing.values()) {
      if (!gone.missing) q('UPDATE books SET missing = 1, updated_at = ? WHERE id = ?').run(now, gone.id);
    }
    q('UPDATE libraries SET last_scan_at = ? WHERE id = ?').run(now, lib.id);
  });
}

/** Extract metadata, page counts and covers for books flagged needs_meta. */
async function processMetadata(libraryId) {
  const books = q(`SELECT b.*, l.kind, l.path AS library_path FROM books b JOIN libraries l ON l.id = b.library_id
                   WHERE b.needs_meta = 1 AND b.missing = 0 ${libraryId ? 'AND b.library_id = ?' : ''}`).all(...(libraryId ? [libraryId] : []));
  state.phase = 'metadata';
  state.total = books.length;
  state.processed = 0;
  for (const book of books) {
    try {
      await processBook(book);
    } catch (err) {
      console.warn(`[scan] ${book.path}: ${err.message}`);
      q('UPDATE books SET needs_meta = 0 WHERE id = ?').run(book.id);
    }
    state.processed++;
  }
}

async function processBook(book) {
  const update = {};
  let cover = null;

  if (book.format === 'epub') {
    const m = await meta.epubMetadata(book.path);
    Object.assign(update, { title: m.title, author: m.author, description: m.description, series: m.series, series_index: m.seriesIndex });
    cover = m.cover;
  } else if (book.format === 'pdf') {
    const m = await meta.pdfMetadata(book.path);
    // PDF titles are frequently junk ("Microsoft Word - draft3.doc"); keep the filename unless it looks real.
    if (m.title && m.title.length > 2 && !/\.(docx?|pdf|indd|tex)$|^untitled/i.test(m.title)) update.title = m.title;
    update.author = m.author;
    update.page_count = m.pageCount;
  } else {
    const info = await archive.inspect(book);
    update.page_count = info.pageCount;
    const ci = meta.parseComicInfo(info.comicInfo);
    if (ci.series) update.series = ci.series;
    if (ci.seriesIndex != null) update.series_index = ci.seriesIndex;
    if (ci.title) update.title = ci.series && ci.seriesIndex != null ? `${ci.series} #${ci.seriesIndex} – ${ci.title}` : ci.title;
    if (ci.author) update.author = ci.author;
    if (ci.description) update.description = ci.description;
    cover = info.cover;
  }

  const sets = [];
  const values = [];
  for (const [key, val] of Object.entries(update)) {
    if (val == null || val === '') continue;
    // Respect manual edits made in the UI.
    if (book.meta_locked && ['title', 'author', 'description', 'series', 'series_index'].includes(key)) continue;
    sets.push(`${key} = ?`);
    values.push(val);
  }
  if (!book.cover_custom && cover) {
    const name = await saveCover(book.id, cover);
    if (name) {
      sets.push('cover = ?');
      values.push(name);
    }
  }
  sets.push('needs_meta = 0', 'updated_at = ?');
  values.push(Date.now(), book.id);
  q(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

async function runQueue() {
  if (state.running) return;
  state.running = true;
  state.lastError = null;
  try {
    while (queue.length) {
      const libraryId = queue.shift();
      const libs = libraryId ? q('SELECT * FROM libraries WHERE id = ?').all(libraryId) : q('SELECT * FROM libraries').all();
      for (const lib of libs) {
        state.libraryId = lib.id;
        state.found = 0;
        try {
          await scanLibrary(lib);
          await processMetadata(lib.id);
        } catch (err) {
          state.lastError = err.message;
          console.warn(`[scan] ${lib.name}: ${err.message}`);
        }
      }
    }
  } finally {
    Object.assign(state, { running: false, libraryId: null, phase: 'idle', finishedAt: Date.now() });
  }
}

/** Queue a scan of one library (or all when id is omitted). */
function requestScan(libraryId = null) {
  if (!queue.includes(libraryId)) queue.push(libraryId);
  runQueue();
}

module.exports = { requestScan, state, processBook, FILE_FORMATS };
