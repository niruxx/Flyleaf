'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { q, tx } = require('./db');
const archive = require('./archive');
const meta = require('./metadata');
const formats = require('./formats');
const { saveCover } = require('./covers');
const { parseFilename, normalizeKey } = require('./parser');
const { json, parseAgeRating, mergeLinks, uniqBy } = require('./util');
const log = require('./log').logger('scan');

// Extension → format. Archives are re-identified by signature (a .cbr that is really a zip, etc.).
const FILE_FORMATS = {
  '.epub': 'epub',
  '.kepub': 'epub',
  '.mobi': 'mobi',
  '.azw': 'mobi',
  '.prc': 'mobi',
  '.azw3': 'azw3',
  '.fb2': 'fb2',
  '.txt': 'txt',
  '.docx': 'docx',
  '.rtf': 'rtf',
  '.pdf': 'pdf',
  '.cbz': 'archive',
  '.zip': 'archive',
  '.cbr': 'archive',
  '.rar': 'archive',
  '.cb7': 'archive',
  '.7z': 'archive',
  '.cbt': 'archive',
  '.tar': 'archive',
};
const ARCHIVE_FORMAT = { zip: 'cbz', rar: 'cbr', '7z': 'cb7', tar: 'cbt', pdf: 'pdf' };
const IGNORED_TXT = /^(readme|license|licence|changelog|notes?|info|credits|copying|nfo)\b/i;

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

async function walk(lib) {
  const root = lib.path;
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
        continue;
      }
      if (!isFile) continue;
      const ext = path.extname(ent.name).toLowerCase();
      let format = FILE_FORMATS[ext];
      // Loose documents only count as books in ebook libraries (comic folders often hold readme files).
      if (['txt', 'docx', 'rtf'].includes(format) && (lib.kind !== 'books' || IGNORED_TXT.test(ent.name))) format = null;
      if (format) {
        const st = await fsp.stat(full).catch(() => null);
        if (!st || !st.size) continue;
        bookFiles++;
        results.push({ path: full, format, isDir: false, size: st.size, mtime: Math.floor(st.mtimeMs) });
        state.found = results.length;
      } else if (archive.IMAGE_EXT.has(ext)) {
        images++;
        const st = await fsp.stat(full).catch(() => null);
        if (st) newestImage = Math.max(newestImage, Math.floor(st.mtimeMs));
      }
    }
    // A folder of images (an extracted chapter) is a comic. A lone cover.jpg next to archives is not.
    if (images >= 2 && bookFiles === 0 && dir !== root) {
      results.push({ path: dir, format: 'folder', isDir: true, size: images, mtime: newestImage });
      state.found = results.length;
    }
    for (const sub of subdirs) await visit(sub, depth + 1);
  }

  await visit(root, 0);
  return results;
}

async function resolveFormat(f) {
  if (f.format !== 'archive') return f.format;
  try {
    const kind = await archive.sniff(f.path);
    return ARCHIVE_FORMAT[kind] || null;
  } catch {
    return null;
  }
}

async function scanLibrary(lib, stats) {
  const stat = await fsp.stat(lib.path).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Library folder not found: ${lib.path}`);

  state.phase = 'walking';
  const found = await walk(lib);
  const existing = new Map(q('SELECT id, path, size, mtime, missing, format FROM books WHERE library_id = ?').all(lib.id).map((b) => [b.path, b]));
  const now = Date.now();

  // Identify archive types for new/changed files before the write transaction.
  for (const f of found) {
    const prev = existing.get(f.path);
    if (prev && prev.size === f.size && prev.mtime === f.mtime) f.format = prev.format;
    else f.format = await resolveFormat(f);
  }

  state.phase = 'indexing';
  tx(() => {
    for (const f of found) {
      if (!f.format) continue;
      const prev = existing.get(f.path);
      existing.delete(f.path);
      if (prev) {
        if (prev.size !== f.size || prev.mtime !== f.mtime || prev.missing) {
          q('UPDATE books SET size = ?, mtime = ?, format = ?, missing = 0, needs_meta = 1, updated_at = ? WHERE id = ?').run(
            f.size, f.mtime, f.format, now, prev.id,
          );
          stats.changed++;
        }
        continue;
      }
      const { lastInsertRowid } = q(`INSERT INTO books (library_id, path, rel_path, format, title, size, mtime, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        lib.id, f.path, path.relative(lib.path, f.path), f.format, meta.titleFromFilename(f.path, f.isDir), f.size, f.mtime, now, now,
      );
      stats.added++;
      (stats.newIds ||= []).push(Number(lastInsertRowid));
    }
    for (const gone of existing.values()) {
      if (!gone.missing) {
        q('UPDATE books SET missing = 1, updated_at = ? WHERE id = ?').run(now, gone.id);
        stats.missing++;
      }
    }
    q('UPDATE libraries SET last_scan_at = ? WHERE id = ?').run(now, lib.id);
  });
  stats.total += found.filter((f) => f.format).length;
}

/** Extract metadata, page counts and covers for books flagged needs_meta. */
async function processMetadata(libraryId, stats) {
  const books = q(`SELECT b.*, l.kind FROM books b JOIN libraries l ON l.id = b.library_id
                   WHERE b.needs_meta = 1 AND b.missing = 0 AND b.library_id = ?`).all(libraryId);
  state.phase = 'metadata';
  state.total = books.length;
  state.processed = 0;
  for (const book of books) {
    try {
      await processBook(book);
    } catch (err) {
      stats.errors++;
      log.file(`${book.path}: ${err.message}`);
      q('UPDATE books SET needs_meta = 0 WHERE id = ?').run(book.id);
    }
    state.processed++;
  }
}

async function processBook(book) {
  const update = {};
  let cover = null;
  let embedded = {};

  switch (book.format) {
    case 'epub': {
      const m = await meta.epubMetadata(book.path);
      Object.assign(update, { title: m.title, author: m.author, description: m.description });
      embedded = {
        series: m.series, volume: m.seriesIndex, people: m.people, genres: m.subjects, publisher: m.publisher,
        year: m.year, language: m.language, links: m.links, description: m.description, isbn: m.isbn,
      };
      cover = m.cover;
      break;
    }
    case 'mobi':
    case 'azw3': {
      const m = await formats.mobiMetadata(book.path);
      Object.assign(update, { title: m.title, author: m.author, description: m.description });
      embedded = {
        people: m.authors.map((name) => ({ name, role: 'Writer' })), genres: m.subjects, publisher: m.publisher,
        year: m.year, language: m.language, description: m.description, isbn: m.isbn,
      };
      cover = m.cover;
      break;
    }
    case 'fb2': {
      const m = await formats.fb2Metadata(book.path);
      Object.assign(update, { title: m.title, author: m.author, description: m.description });
      embedded = {
        series: m.series, volume: m.seriesIndex, people: m.authors.map((name) => ({ name, role: 'Writer' })),
        genres: m.subjects, language: m.language, description: m.description,
      };
      cover = m.cover;
      break;
    }
    case 'docx':
    case 'rtf': {
      const m = book.format === 'docx' ? await formats.docxMetadata(book.path) : await formats.rtfMetadata(book.path);
      // Word's "Title" property is often a leftover template name; prefer the file name unless it looks real.
      if (m.title && m.title.length > 2 && !/^(untitled|document\d*|microsoft word)/i.test(m.title)) update.title = m.title;
      Object.assign(update, { author: m.author, description: m.description });
      if (m.author) embedded.people = [{ name: m.author, role: 'Writer' }];
      if (m.description) embedded.description = m.description;
      break;
    }
    case 'txt': {
      const m = await formats.txtMetadata(book.path);
      Object.assign(update, { title: m.title, author: m.author });
      if (m.author) embedded.people = [{ name: m.author, role: 'Writer' }];
      break;
    }
    case 'pdf': {
      const m = await meta.pdfMetadata(book.path);
      // PDF titles are frequently junk ("Microsoft Word - draft3.doc"); keep the filename unless it looks real.
      if (m.title && m.title.length > 2 && !/\.(docx?|pdf|indd|tex)$|^untitled/i.test(m.title)) update.title = m.title;
      update.author = m.author;
      update.page_count = m.pageCount;
      if (m.author) embedded.people = [{ name: m.author, role: 'Writer' }];
      break;
    }
    default: {
      const info = await archive.inspect(book);
      update.page_count = info.pageCount;
      const ci = meta.parseComicInfo(info.comicInfo);
      if (ci.title) update.title = ci.title;
      if (ci.author) update.author = ci.author;
      if (ci.description) update.description = ci.description;
      embedded = {
        series: ci.series, localizedSeries: ci.localizedSeries, volume: ci.volume, number: ci.number, count: ci.count,
        people: ci.people, genres: ci.genres, tags: ci.tags, publisher: ci.publisher, year: ci.year, language: ci.language,
        ageRating: ci.ageRating, links: ci.links, description: ci.description, manga: ci.manga, isbn: ci.isbn,
      };
      cover = info.cover;
    }
  }

  const sets = ['embedded = ?'];
  const values = [JSON.stringify(embedded)];
  for (const [key, val] of Object.entries(update)) {
    if (val == null || val === '') continue;
    // Respect manual edits made in the UI.
    if (book.meta_locked && ['title', 'author', 'description'].includes(key)) continue;
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

// ---------------------------------------------------------------------------
// Series grouping

/** Decide which series a book belongs to, according to the library's mode. */
function seriesFor(lib, book) {
  const emb = json(book.embedded, {});
  const isDir = book.format === 'folder';
  const parsed = parseFilename(book.path, isDir);
  const relDir = path.relative(lib.path, path.dirname(book.path));
  const folderName = relDir && !relDir.startsWith('..') ? path.basename(relDir) : null;
  const comic = lib.kind !== 'books';

  let name;
  if (lib.mode === 'books') {
    // Regular books (Calibre-style Author/Title/ folders work too): a book only joins a series when
    // its own metadata says so; otherwise it stands alone. Folders and file names are ignored.
    if (emb.series) return { name: String(emb.series).trim(), volume: emb.volume ?? null, chapter: null, special: 0 };
    const title = String(book.title || parsed.series || path.basename(book.path)).trim();
    return { name: title, key: normalizeKey(`${title} ${book.author || ''}`), volume: null, chapter: null, special: 0 };
  }
  if (lib.mode === 'kavita') {
    // Kavita: embedded metadata, then the file name, then the folder.
    name = emb.series || (comic ? parsed.series : null) || (comic ? folderName : null) || book.title;
  } else {
    // Komga: every folder that contains books is a series – including the library root itself.
    name = folderName || path.basename(lib.path);
  }
  // A volume number from ComicInfo/EPUB wins over one parsed from the name. ComicInfo <Number>
  // is the issue/chapter, unless the file is a volume and the number just repeats it.
  const volume = emb.volume ?? parsed.volume;
  let chapter = parsed.chapter;
  if (chapter == null && emb.number != null && emb.number !== volume) chapter = volume == null || comic ? emb.number : null;
  if (volume == null && chapter == null && emb.number != null) chapter = emb.number;
  return {
    name: String(name).trim(),
    volume: comic ? volume : emb.volume ?? null,
    chapter: comic ? chapter : null,
    special: comic && parsed.special ? 1 : 0,
  };
}

function assignSeries(lib) {
  const books = q('SELECT id, path, format, title, author, embedded, series_id FROM books WHERE library_id = ?').all(lib.id);
  const existing = new Map(q('SELECT id, key FROM series WHERE library_id = ?').all(lib.id).map((s) => [s.key, s.id]));
  const now = Date.now();
  const touched = new Set();
  tx(() => {
    for (const book of books) {
      const s = seriesFor(lib, book);
      const key = s.key || normalizeKey(s.name) || normalizeKey(book.title) || `book${book.id}`;
      let sid = existing.get(key);
      if (!sid) {
        sid = Number(q('INSERT INTO series (library_id, key, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(lib.id, key, s.name, now, now).lastInsertRowid);
        existing.set(key, sid);
      }
      touched.add(sid);
      const index = s.volume ?? s.chapter;
      q('UPDATE books SET series_id = ?, series = ?, series_index = ?, volume = ?, chapter = ?, special = ? WHERE id = ?').run(
        sid, s.name, index, s.volume, s.chapter, s.special, book.id,
      );
    }
    q(`DELETE FROM series WHERE library_id = ? AND id NOT IN (SELECT DISTINCT series_id FROM books WHERE series_id IS NOT NULL)`).run(lib.id);
  });
  for (const sid of touched) seedSeriesFromFiles(sid);
}

/** Fill series metadata from the books' embedded metadata (only fields not edited or scraped). */
function seedSeriesFromFiles(seriesId) {
  const s = q('SELECT * FROM series WHERE id = ?').get(seriesId);
  if (!s) return;
  const locked = new Set(json(s.locked, []));
  const scraped = Boolean(s.metadata_source);
  const books = q(`SELECT embedded, description FROM books WHERE series_id = ? AND missing = 0
                   ORDER BY special, volume IS NULL, volume, chapter IS NULL, chapter, title`).all(seriesId);
  const embs = books.map((b) => ({ ...json(b.embedded, {}), fallbackDescription: b.description }));
  if (!embs.length) return;

  const firstOf = (key) => embs.map((e) => e[key]).find((v) => v != null && v !== '');
  const proposed = {
    summary: firstOf('description') || firstOf('fallbackDescription'),
    localized_name: firstOf('localizedSeries'),
    publisher: firstOf('publisher'),
    language: firstOf('language'),
    year: embs.map((e) => e.year).filter(Boolean).sort()[0] || null,
    age_rating: embs.map((e) => parseAgeRating(e.ageRating)).filter((x) => x != null).sort().pop() ?? null,
    genres: JSON.stringify(uniqBy(embs.flatMap((e) => e.genres || []), (g) => g.toLowerCase()).slice(0, 25)),
    tags: JSON.stringify(uniqBy(embs.flatMap((e) => e.tags || []), (g) => g.toLowerCase()).slice(0, 40)),
    people: JSON.stringify(uniqBy(embs.flatMap((e) => e.people || []), (p) => `${p.role}:${p.name}`.toLowerCase()).slice(0, 30)),
  };
  if (!proposed.age_rating && embs.some((e) => e.manga === false)) delete proposed.age_rating;

  const sets = [];
  const vals = [];
  for (const [col, val] of Object.entries(proposed)) {
    if (locked.has(col) || val == null || val === '' || val === '[]') continue;
    // Scraped series keep provider data; files only fill gaps.
    const current = s[col];
    if (scraped && current != null && current !== '' && current !== '[]') continue;
    if (String(current ?? '') === String(val)) continue;
    sets.push(`${col} = ?`);
    vals.push(val);
  }
  const fileLinks = embs.flatMap((e) => (e.links || []).map((url) => ({ url })));
  if (fileLinks.length && !locked.has('links')) {
    const merged = JSON.stringify(mergeLinks(json(s.links, []), fileLinks));
    if (merged !== s.links) {
      sets.push('links = ?');
      vals.push(merged);
    }
  }
  if (sets.length) {
    q(`UPDATE series SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), seriesId);
  }
}

// ---------------------------------------------------------------------------

/** Webhook events for a finished scan (after grouping, so titles and series are final). */
function announce(lib, stats) {
  if (!(stats.added + stats.changed + stats.missing)) return;
  const events = require('./events');
  events.emit('library.scanned', { libraryId: lib.id, name: lib.name, total: stats.total, added: stats.added, changed: stats.changed, missing: stats.missing });
  for (const id of stats.newIds || []) {
    const b = q('SELECT id, title, author, format, series_id, series, volume, chapter, rel_path FROM books WHERE id = ?').get(id);
    if (b) {
      events.emit('book.added', {
        bookId: b.id, libraryId: lib.id, title: b.title, author: b.author, format: b.format,
        seriesId: b.series_id, series: b.series, volume: b.volume, chapter: b.chapter, path: b.rel_path,
      });
    }
  }
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
        const stats = { total: 0, added: 0, changed: 0, missing: 0, errors: 0 };
        const started = Date.now();
        try {
          await scanLibrary(lib, stats);
          await processMetadata(lib.id, stats);
          state.phase = 'grouping';
          assignSeries(lib);
          const changes = stats.added + stats.changed + stats.missing;
          // One line per scan; quiet when nothing changed.
          const summary = `"${lib.name}": ${stats.total} items (${stats.added} new, ${stats.changed} changed, ${stats.missing} missing) in ${((Date.now() - started) / 1000).toFixed(1)}s${stats.errors ? `, ${stats.errors} unreadable (see data/logs/flyleaf.log)` : ''}`;
          if (changes || stats.errors) log.info(summary);
          else log.file(summary);
          announce(lib, stats);
          if (lib.auto_metadata) require('./metadata-service').queueAuto(lib.id);
        } catch (err) {
          state.lastError = err.message;
          log.warn(`"${lib.name}": ${err.message}`);
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

module.exports = { requestScan, state, processBook, assignSeries, seedSeriesFromFiles, FILE_FORMATS };
