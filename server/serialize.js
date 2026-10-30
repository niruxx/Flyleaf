'use strict';

// Shared queries and JSON shapes for books and series.

const { q } = require('./db');
const { json, accessFilter, canSeeLibrary, AGE_RATINGS } = require('./util');

const TEXT_FORMATS = new Set(['epub', 'mobi', 'azw3', 'fb2', 'txt', 'docx', 'rtf']);

function volumeLabel(b) {
  if (b.special || b.kind === 'books') return b.title;
  if (b.volume != null && b.chapter != null) return `Vol. ${b.volume} Ch. ${b.chapter}`;
  if (b.volume != null) return `Volume ${b.volume}`;
  if (b.chapter != null) return `Chapter ${b.chapter}`;
  return b.title;
}

// ---------------------------------------------------------------------------
// Books

const BOOK_SELECT = `
  SELECT b.*, l.kind, s.name AS series_name, s.age_rating AS s_age_rating, us.blur AS us_blur,
    p.percent AS p_percent, p.page AS p_page, p.finished AS p_finished, p.updated_at AS p_updated_at,
    p.position AS p_position, p.settings AS p_settings
  FROM books b
  JOIN libraries l ON l.id = b.library_id
  LEFT JOIN series s ON s.id = b.series_id
  LEFT JOIN user_series us ON us.series_id = b.series_id AND us.user_id = ?
  LEFT JOIN progress p ON p.book_id = b.id AND p.user_id = ?`;

function toBook(row, detail = false, user = null) {
  const embeddedRating = json(row.embedded, {}).ageRating;
  const ratings = [row.s_age_rating, embeddedRating].filter((value) => [0, 1, 2, 3].includes(value));
  const b = {
    id: row.id,
    libraryId: row.library_id,
    seriesId: row.series_id,
    kind: row.kind,
    format: row.format,
    engine: TEXT_FORMATS.has(row.format) ? 'text' : row.format === 'audio' ? 'audio' : 'pages',
    title: row.title,
    label: volumeLabel(row),
    author: row.author,
    ageRating: ratings.length ? Math.max(...ratings) : null,
    language: json(row.embedded, {}).language || null,
    series: row.series_name || row.series,
    seriesIndex: row.series_index,
    volume: row.volume,
    chapter: row.chapter,
    special: Boolean(row.special),
    pageCount: row.page_count,
    size: row.size,
    addedAt: row.added_at,
    coverUrl: row.cover ? `/api/books/${row.id}/cover?v=${encodeURIComponent(row.cover)}` : null,
    blur: shouldBlur(row.us_blur, row.s_age_rating, user),
    version: row.mtime,
    canDelete: canDeleteBook(user, row),
    canMove: canMoveBook(user, row),
    progress:
      row.p_updated_at != null
        ? { percent: row.p_percent, page: row.p_page, finished: Boolean(row.p_finished), updatedAt: row.p_updated_at }
        : null,
  };
  if (detail) {
    Object.assign(b, {
      description: row.description,
      relPath: row.rel_path,
      metaLocked: Boolean(row.meta_locked),
      missing: Boolean(row.missing),
    });
    if (b.progress) {
      b.progress.position = row.p_position;
      b.progress.settings = json(row.p_settings, null);
    }
  }
  return b;
}

// Files each request's user downloaded with Content Finder, looked up once per request.
const downloadedCache = new WeakMap();
function downloadedFiles(user) {
  let files = downloadedCache.get(user);
  if (!files) {
    files = new Set(q("SELECT file FROM downloads WHERE user_id = ? AND status = 'done' AND file IS NOT NULL").all(user.id).map((r) => r.file));
    downloadedCache.set(user, files);
  }
  return files;
}

/**
 * Whether the user may delete this book's file. Admins may delete anything; other users
 * (with the deleteBooks permission) only books in their own libraries or ones they downloaded.
 */
function canDeleteBook(user, row) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!user.permissions?.deleteBooks) return false;
  return (user.ownLibraryIds || []).includes(row.library_id) || Boolean(row.path && downloadedFiles(user).has(row.path));
}

/**
 * Whether the user may move this book to another library. Admins: always. Others: from their
 * own libraries (when they have another to move to), or a book they downloaded into a shared
 * library (which takes it out of that library, so it needs the delete permission too).
 */
function canMoveBook(user, row) {
  if (!user || !row) return false;
  if (user.role === 'admin') return true;
  const own = user.ownLibraryIds || [];
  if (own.includes(row.library_id)) return own.length > 1;
  return own.length > 0 && Boolean(user.permissions?.deleteBooks && row.path && downloadedFiles(user).has(row.path));
}

/** Whether the user may move a whole series: every book in it must be theirs to move. */
function canMoveSeries(user, row) {
  if (!user || !row) return false;
  if (user.role === 'admin') return true;
  const own = user.ownLibraryIds || [];
  if (own.includes(row.library_id)) return own.length > 1;
  if (!own.length || !user.permissions?.deleteBooks) return false;
  const files = downloadedFiles(user);
  if (!files.size) return false;
  const paths = q('SELECT path FROM books WHERE series_id = ?').all(row.id);
  return paths.length > 0 && paths.every((b) => files.has(b.path));
}

/** Whether the user may delete a whole series: every book in it must be theirs to delete. */
function canDeleteSeries(user, row) {
  if (!user || !row) return false;
  if (user.role === 'admin') return true;
  if (!user.permissions?.deleteBooks) return false;
  if ((user.ownLibraryIds || []).includes(row.library_id)) return true;
  const files = downloadedFiles(user);
  if (!files.size) return false;
  const paths = q('SELECT path FROM books WHERE series_id = ?').all(row.id);
  return paths.length > 0 && paths.every((b) => files.has(b.path));
}

function shouldBlur(userBlur, ageRating, user) {
  if (userBlur) return true;
  return Boolean(user?.prefs?.blurMature && ageRating != null && ageRating >= 3);
}

/** A book the user may access (respecting age restrictions), or null. */
function getBook(id, user) {
  const age = accessFilter(user, 's', { direct: true });
  const row = q(`${BOOK_SELECT} WHERE b.id = ? AND (b.series_id IS NULL OR ${age.sql})`).get(user.id, user.id, Number(id), ...age.args);
  return row && canSeeLibrary(user, row.library_id) ? row : null;
}

const bookSort = (a, b) =>
  (a.special ? 1 : 0) - (b.special ? 1 : 0) ||
  (a.volume ?? Infinity) - (b.volume ?? Infinity) ||
  (a.chapter ?? Infinity) - (b.chapter ?? Infinity) ||
  collator.compare(a.title, b.title);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------------------
// Series

/** Title for alphabetical order: the sort name if set, else the title without a leading "The/A/An". */
const TITLE_KEY = `COALESCE(NULLIF(s.sort_name, ''), CASE
    WHEN lower(s.name) LIKE 'the %' THEN substr(s.name, 5)
    WHEN lower(s.name) LIKE 'an %' THEN substr(s.name, 4)
    WHEN lower(s.name) LIKE 'a %' THEN substr(s.name, 3)
    ELSE s.name END)`;
/** First writer's name, for sorting by author. */
const AUTHOR_KEY = `(SELECT json_extract(j.value, '$.name') FROM json_each(s.people) j
    WHERE json_extract(j.value, '$.role') LIKE '%writer%' OR json_extract(j.value, '$.role') LIKE '%author%' LIMIT 1)`;

const SERIES_SORTS = {
  name: `${TITLE_KEY} COLLATE NOCASE`,
  name_desc: `${TITLE_KEY} COLLATE NOCASE DESC`,
  author: `${AUTHOR_KEY} IS NULL, ${AUTHOR_KEY} COLLATE NOCASE, ${TITLE_KEY} COLLATE NOCASE`,
  added: 'last_added DESC',
  read: 'last_read IS NULL, last_read DESC',
  year: 's.year IS NULL, s.year DESC, s.name COLLATE NOCASE',
  updated: 's.updated_at DESC',
  want: 'us.want_added_at DESC',
};

/**
 * List series visible to `user`.
 * opts: { where: [], args: [], having: [], sort, limit, offset }
 */
function listSeries(user, opts = {}) {
  const age = accessFilter(user, 's', { direct: Boolean(opts.direct) });
  const where = ['b.missing = 0', age.sql, ...(opts.where || [])];
  const args = [user.id, user.id, ...age.args, ...(opts.args || [])];
  const having = opts.having?.length ? `HAVING ${opts.having.join(' AND ')}` : '';
  const limit = Math.min(Number(opts.limit) || 120, 2000);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  let sort = SERIES_SORTS[opts.sort] || SERIES_SORTS.name;
  // Ranked ids (search, recommendations): only those, in that order when sorting by relevance.
  const orderArgs = [];
  if (Array.isArray(opts.rankIds)) {
    where.push('s.id IN (SELECT value FROM json_each(?))');
    args.push(JSON.stringify(opts.rankIds));
    if (opts.sort === 'relevance' || !opts.sort) {
      sort = '(SELECT key FROM json_each(?) WHERE json_each.value = s.id)';
      orderArgs.push(JSON.stringify(opts.rankIds));
    }
  }
  const rows = q(`
    SELECT s.*, l.kind, l.name AS library_name,
      COUNT(b.id) AS book_count,
      (SELECT json_group_array(DISTINCT lang.value)
       FROM books lb, json_each(lb.embedded, '$.language') lang
       WHERE lb.series_id = s.id AND lb.missing = 0 AND lang.type = 'text') AS languages,
      SUM(CASE WHEN p.finished = 1 THEN 1 ELSE 0 END) AS read_count,
      SUM(COALESCE(p.percent, 0)) AS pct_sum,
      MAX(p.updated_at) AS last_read,
      MAX(b.added_at) AS last_added,
      us.want_to_read, us.status AS user_status, us.blur AS user_blur, us.user_tags, us.want_added_at
    FROM series s
    JOIN libraries l ON l.id = s.library_id
    JOIN books b ON b.series_id = s.id
    LEFT JOIN progress p ON p.book_id = b.id AND p.user_id = ?
    LEFT JOIN user_series us ON us.series_id = s.id AND us.user_id = ?
    WHERE ${where.join(' AND ')}
    GROUP BY s.id
    ${having}
    ORDER BY ${sort}
    LIMIT ? OFFSET ?`).all(...args, ...orderArgs, limit + 1, offset);
  const items = rows.slice(0, limit).map((r) => toSeries(r, user));
  return { items, hasMore: rows.length > limit };
}

const firstCoverStmt = () =>
  q(`SELECT id, cover FROM books WHERE series_id = ? AND cover IS NOT NULL AND missing = 0
     ORDER BY special, volume IS NULL, volume, chapter IS NULL, chapter, title COLLATE NOCASE LIMIT 1`);

function seriesCoverUrl(row) {
  if (row.cover) return `/api/series/${row.id}/cover?v=${encodeURIComponent(row.cover)}`;
  const b = firstCoverStmt().get(row.id);
  return b ? `/api/books/${b.id}/cover?v=${encodeURIComponent(b.cover)}` : null;
}

function toSeries(row, user, detail = false) {
  const people = json(row.people, []);
  const s = {
    id: row.id,
    libraryId: row.library_id,
    libraryName: row.library_name,
    kind: row.kind,
    name: row.name,
    localizedName: row.localized_name,
    languages: json(row.languages, []),
    year: row.year,
    status: row.status,
    ageRating: row.age_rating,
    genres: json(row.genres, []),
    authors: people.filter((p) => /writer|author|creator|story/i.test(p.role)).map((p) => p.name).slice(0, 3),
    coverUrl: seriesCoverUrl(row),
    count: row.book_count ?? null,
    readCount: row.read_count ?? 0,
    progress: row.book_count ? Math.min(1, (row.pct_sum || 0) / row.book_count) : 0,
    lastRead: row.last_read ?? null,
    lastAdded: row.last_added ?? null,
    wantToRead: Boolean(row.want_to_read),
    userStatus: row.user_status || null,
    blur: shouldBlur(row.user_blur, row.age_rating, user),
    canDelete: canDeleteSeries(user, row),
    canMove: canMoveSeries(user, row),
  };
  if (detail) {
    Object.assign(s, {
      sortName: row.sort_name,
      summary: row.summary,
      publisher: row.publisher,
      language: row.language,
      ageRatingLabel: AGE_RATINGS.find((a) => a.value === row.age_rating)?.label || 'Unknown',
      tags: json(row.tags, []),
      people,
      links: json(row.links, []),
      providerIds: json(row.provider_ids, {}),
      locked: json(row.locked, []),
      metadataSource: row.metadata_source,
      metadataAt: row.metadata_at,
      hasCustomCover: Boolean(row.cover),
      userTags: json(row.user_tags, []),
      userBlur: Boolean(row.user_blur),
      updatedAt: row.updated_at,
    });
  }
  return s;
}

/** Full series row for the user, or null if hidden/missing. */
function getSeries(id, user) {
  const { items } = listSeries(user, { where: ['s.id = ?'], args: [Number(id)], limit: 1, direct: true });
  if (!items.length) return null;
  const row = q(`SELECT s.*, l.kind, l.name AS library_name, us.want_to_read, us.status AS user_status, us.blur AS user_blur, us.user_tags
                 FROM series s JOIN libraries l ON l.id = s.library_id
                 LEFT JOIN user_series us ON us.series_id = s.id AND us.user_id = ?
                 WHERE s.id = ?`).get(user.id, Number(id));
  return { ...toSeries(row, user, true), ...pick(items[0], ['count', 'readCount', 'progress', 'lastRead', 'lastAdded', 'coverUrl', 'languages']) };
}

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

function seriesBooks(seriesId, user) {
  return q(`${BOOK_SELECT} WHERE b.series_id = ? AND b.missing = 0`)
    .all(user.id, user.id, Number(seriesId))
    .map((r) => toBook(r, false, user))
    .sort(bookSort);
}

module.exports = {
  TITLE_KEY,
  TEXT_FORMATS,
  BOOK_SELECT,
  toBook,
  getBook,
  canDeleteBook,
  canDeleteSeries,
  canMoveBook,
  canMoveSeries,
  bookSort,
  listSeries,
  toSeries,
  getSeries,
  seriesBooks,
  seriesCoverUrl,
  volumeLabel,
};
