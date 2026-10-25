'use strict';

function json(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Age ratings, Kavita-style. null = unknown. */
const AGE_RATINGS = [
  { value: 0, label: 'Everyone' },
  { value: 1, label: 'Teen (13+)' },
  { value: 2, label: 'Mature (17+)' },
  { value: 3, label: 'Adults only (18+)' },
];

function parseAgeRating(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'boolean') return raw ? 3 : null;
  const s = String(raw).toLowerCase();
  if (/adult|18|x18|r18|porn|erotica|hentai|explicit/.test(s)) return 3;
  if (/mature|17|16|\bm\b|\bma\b|suggestive|r\+/.test(s)) return 2;
  if (/everyone|\bg\b|kids|\be\b|all ages|safe/.test(s)) return 0;
  if (/teen|13|12|pg|\bt\b/.test(s)) return 1;
  return null;
}

/**
 * SQL fragment restricting series to what `user` may see: their age rating and,
 * when set, the libraries they've been given (alias = series table alias).
 */
function accessFilter(user, alias = 's', { direct = false } = {}) {
  const parts = [];
  const args = [];
  if (user?.maxAgeRating != null) {
    parts.push(`((${alias}.age_rating IS NULL AND ? = 1) OR ${alias}.age_rating <= ?)`);
    args.push(user.ageIncludeUnknown ? 1 : 0, user.maxAgeRating);
  }
  // `direct`: one specific item or library was asked for. The admin may open anything that
  // way (from the admin panel); everyone else is limited to what they can browse.
  const bypass = direct && user?.role === 'admin';
  if (!bypass && Array.isArray(user?.visibleLibraryIds)) {
    parts.push(`${alias}.library_id IN (SELECT value FROM json_each(?))`);
    args.push(JSON.stringify(user.visibleLibraryIds));
  }
  return { sql: parts.length ? parts.join(' AND ') : '1 = 1', args };
}

/** Whether library `id` shows up in `user`'s browsing (shared ones they're allowed, plus their own). */
const listsLibrary = (user, id) => !Array.isArray(user?.visibleLibraryIds) || user.visibleLibraryIds.includes(Number(id));

/** Whether `user` may open library `id` at all. The admin can open every library. */
const canSeeLibrary = (user, id) => user?.role === 'admin' || listsLibrary(user, id);

/**
 * Whether `user` may put files (downloads, uploads) into library `id`. Users with a
 * personal folder write only into their own libraries; others into any library they see.
 */
const canWriteLibrary = (user, id) => {
  if (user?.role === 'admin') return true;
  if (user?.homeDir) return (user.ownLibraryIds || []).includes(Number(id));
  return canSeeLibrary(user, id);
};

function likeArg(s) {
  return `%${String(s).replace(/[\\%_]/g, '\\$&')}%`;
}

/** LIKE-escaped folder prefix, with a trailing separator, for matching the files inside `dir`. */
function likePrefix(dir) {
  return `${String(dir)}${require('node:path').sep}`.replace(/[\\%_]/g, '\\$&');
}

/** Strip HTML to readable plain text. */
function stripHtml(s) {
  if (!s) return null;
  const text = String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

/** Dice coefficient on bigrams of normalised strings (0–1). */
function similarity(a, b) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  a = norm(a);
  b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) || 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1)) || 0;
}

module.exports = { json, AGE_RATINGS, parseAgeRating, accessFilter, canSeeLibrary, listsLibrary, canWriteLibrary, likeArg, likePrefix, stripHtml, similarity };

const LINK_SOURCES = [
  [/myanimelist\.net/i, 'MyAnimeList'],
  [/anilist\.co/i, 'AniList'],
  [/mangadex\.org/i, 'MangaDex'],
  [/mangaupdates\.com|baka-updates/i, 'MangaUpdates'],
  [/comicvine\.gamespot\.com/i, 'ComicVine'],
  [/kitsu\.(io|app)/i, 'Kitsu'],
  [/goodreads\.com/i, 'Goodreads'],
  [/openlibrary\.org/i, 'Open Library'],
  [/books\.google\./i, 'Google Books'],
  [/amazon\./i, 'Amazon'],
  [/bookwalker/i, 'BookWalker'],
  [/wikipedia\.org/i, 'Wikipedia'],
];
function linkSource(url) {
  for (const [re, name] of LINK_SOURCES) if (re.test(url)) return name;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Link';
  }
}

/** Merge link lists by URL. */
function mergeLinks(a = [], b = []) {
  const map = new Map();
  for (const l of [...a, ...b]) if (l?.url && !map.has(l.url)) map.set(l.url, { source: l.source || linkSource(l.url), url: l.url });
  return [...map.values()];
}

function uniqBy(list, keyFn) {
  const seen = new Set();
  return list.filter((x) => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports.linkSource = linkSource;
module.exports.mergeLinks = mergeLinks;
module.exports.uniqBy = uniqBy;
