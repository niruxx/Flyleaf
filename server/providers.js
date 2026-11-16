'use strict';

// Metadata providers. Every provider returns results in one normalised shape:
// { provider, id, title, altTitles, localizedName, summary, status, year, genres, tags,
//   people: [{name, role}], publisher, ageRating, links: [{source, url}], coverUrl, thumbUrl,
//   format, volumes, chapters, providerIds }

const { stripHtml, linkSource, mergeLinks } = require('./util');
const settings = require('./settings');

const UA = 'Flyleaf/2.0 (self-hosted library; https://github.com)';

// ---------------------------------------------------------------------------
// HTTP with per-provider pacing

const lastCall = new Map();
async function pace(name, minGapMs) {
  const prev = lastCall.get(name) || Promise.resolve(0);
  const next = prev.then(async (t) => {
    const wait = t + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return Date.now();
  });
  lastCall.set(name, next.catch(() => Date.now()));
  await next;
}

async function http(name, gap, url, opts = {}) {
  await pace(name, gap);
  const res = await fetchOrExplain(name, url, {
    ...opts,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429) throw new Error(`${name} is rate limiting requests – try again in a minute.`);
  if (!res.ok) throw new Error(`${name} request failed (${res.status})`);
  return res.json();
}

async function fetchOrExplain(name, url, opts) {
  try {
    return await fetch(url, opts);
  } catch (err) {
    throw new Error(`Couldn't reach ${name} (${err.name === 'TimeoutError' ? 'timed out' : err.cause?.code || err.message}).`);
  }
}

const STATUS = (s) => {
  const v = String(s || '').toLowerCase();
  if (/releasing|ongoing|publishing|continuing/.test(v)) return 'ongoing';
  if (/finished|completed|complete|ended/.test(v)) return 'completed';
  if (/hiatus/.test(v)) return 'hiatus';
  if (/cancel|discontinued|abandon/.test(v)) return 'cancelled';
  if (/not.?yet|upcoming/.test(v)) return 'upcoming';
  return null;
};

// ---------------------------------------------------------------------------
// AniList (GraphQL, no key)

const ANILIST_FIELDS = `
  id idMal siteUrl format status(version: 2) isAdult countryOfOrigin volumes chapters
  title { romaji english native } synonyms description(asHtml: false)
  startDate { year } genres tags { name rank isMediaSpoiler isAdult }
  coverImage { extraLarge large }
  staff(perPage: 10, sort: [RELEVANCE]) { edges { role node { name { full } } } }`;

function fromAniList(m) {
  const title = m.title.english || m.title.romaji || m.title.native;
  const links = [{ source: 'AniList', url: m.siteUrl }];
  if (m.idMal) links.push({ source: 'MyAnimeList', url: `https://myanimelist.net/manga/${m.idMal}` });
  return {
    provider: 'anilist',
    id: String(m.id),
    title,
    altTitles: [m.title.romaji, m.title.english, m.title.native, ...(m.synonyms || [])].filter((t) => t && t !== title),
    localizedName: m.title.native || null,
    summary: stripHtml(m.description),
    status: STATUS(m.status),
    year: m.startDate?.year || null,
    genres: m.genres || [],
    tags: (m.tags || []).filter((t) => !t.isMediaSpoiler && t.rank >= 50).map((t) => t.name),
    people: (m.staff?.edges || []).map((e) => ({
      name: e.node.name.full,
      role: /story|original/i.test(e.role) ? 'Writer' : /art/i.test(e.role) ? 'Artist' : e.role.replace(/\s*\(.*\)/, ''),
    })),
    ageRating: m.isAdult ? 3 : null,
    links,
    coverUrl: m.coverImage?.extraLarge || m.coverImage?.large || null,
    thumbUrl: m.coverImage?.large || null,
    format: m.format,
    volumes: m.volumes,
    chapters: m.chapters,
    providerIds: { anilist: String(m.id), ...(m.idMal ? { mal: String(m.idMal) } : {}) },
  };
}

const anilist = {
  name: 'AniList',
  kinds: ['manga', 'comics', 'books'],
  async search(query) {
    const data = await http('AniList', 700, 'https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query ($q: String) { Page(perPage: 12) { media(search: $q, type: MANGA) { ${ANILIST_FIELDS} } } }`,
        variables: { q: query },
      }),
    });
    return (data.data?.Page?.media || []).map(fromAniList);
  },
  async details(id) {
    const data = await http('AniList', 700, 'https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query ($id: Int) { Media(id: $id, type: MANGA) { ${ANILIST_FIELDS} } }`, variables: { id: Number(id) } }),
    });
    return fromAniList(data.data.Media);
  },
};

// ---------------------------------------------------------------------------
// MangaDex (REST, no key)

const MD_LINKS = {
  al: (v) => ['AniList', `https://anilist.co/manga/${v}`],
  mal: (v) => ['MyAnimeList', `https://myanimelist.net/manga/${v}`],
  mu: (v) => ['MangaUpdates', /^\d+$/.test(v) ? `https://www.mangaupdates.com/series.html?id=${v}` : `https://www.mangaupdates.com/series/${v}`],
  kt: (v) => ['Kitsu', /^\d+$/.test(v) ? `https://kitsu.app/manga/${v}` : `https://kitsu.app/manga/${v}`],
  amz: (v) => ['Amazon', v],
  bw: (v) => ['BookWalker', `https://bookwalker.jp/${v}`],
  ebj: (v) => ['eBookJapan', v],
  raw: (v) => ['Official (raw)', v],
  engtl: (v) => ['Official (English)', v],
};

function fromMangaDex(m) {
  const a = m.attributes;
  const title = a.title.en || Object.values(a.title)[0];
  const alt = (a.altTitles || []).flatMap((t) => Object.values(t));
  const cover = m.relationships.find((r) => r.type === 'cover_art')?.attributes?.fileName;
  const people = m.relationships
    .filter((r) => (r.type === 'author' || r.type === 'artist') && r.attributes?.name)
    .map((r) => ({ name: r.attributes.name, role: r.type === 'author' ? 'Writer' : 'Artist' }));
  const links = [{ source: 'MangaDex', url: `https://mangadex.org/title/${m.id}` }];
  const ids = { mangadex: m.id };
  for (const [k, v] of Object.entries(a.links || {})) {
    if (!MD_LINKS[k] || !v) continue;
    const [source, url] = MD_LINKS[k](v);
    if (/^https?:/.test(url)) links.push({ source, url });
    if (k === 'al') ids.anilist = String(v);
    if (k === 'mal') ids.mal = String(v);
    if (k === 'mu') ids.mangaupdates = String(v);
    if (k === 'kt') ids.kitsu = String(v);
  }
  const tagsBy = (group) => (a.tags || []).filter((t) => t.attributes.group === group).map((t) => t.attributes.name.en);
  return {
    provider: 'mangadex',
    id: m.id,
    title,
    altTitles: alt,
    localizedName: (a.altTitles || []).map((t) => t.ja || t.ko || t.zh).find(Boolean) || null,
    summary: stripHtml(a.description?.en || Object.values(a.description || {})[0]),
    status: STATUS(a.status),
    year: a.year || null,
    genres: tagsBy('genre'),
    tags: [...tagsBy('theme'), ...tagsBy('format')],
    people,
    ageRating: { safe: 0, suggestive: 1, erotica: 2, pornographic: 3 }[a.contentRating] ?? null,
    links: mergeLinks(links),
    coverUrl: cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover}` : null,
    thumbUrl: cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover}.256.jpg` : null,
    format: a.publicationDemographic || null,
    volumes: a.lastVolume ? Number(a.lastVolume) || null : null,
    chapters: a.lastChapter ? Number(a.lastChapter) || null : null,
    providerIds: ids,
  };
}

const MD_INCLUDES = 'includes[]=cover_art&includes[]=author&includes[]=artist';
const MD_RATINGS = 'contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic';
const mangadex = {
  name: 'MangaDex',
  kinds: ['manga', 'comics'],
  async search(query) {
    const data = await http('MangaDex', 250, `https://api.mangadex.org/manga?title=${encodeURIComponent(query)}&limit=12&${MD_INCLUDES}&${MD_RATINGS}&order[relevance]=desc`);
    return (data.data || []).map(fromMangaDex);
  },
  async details(id) {
    const data = await http('MangaDex', 250, `https://api.mangadex.org/manga/${encodeURIComponent(id)}?${MD_INCLUDES}`);
    return fromMangaDex(data.data);
  },
};

// ---------------------------------------------------------------------------
// MyAnimeList via Jikan (unofficial MAL API, no key)

function fromJikan(m) {
  const flipName = (n) => (n.includes(', ') ? n.split(', ').reverse().join(' ') : n);
  return {
    provider: 'mal',
    id: String(m.mal_id),
    title: m.title_english || m.title,
    altTitles: [m.title, m.title_japanese, ...(m.title_synonyms || [])].filter(Boolean),
    localizedName: m.title_japanese || null,
    summary: m.synopsis ? m.synopsis.replace(/\[Written by MAL Rewrite\]/g, '').trim() : null,
    status: STATUS(m.status),
    year: m.published?.prop?.from?.year || null,
    genres: [...(m.genres || []), ...(m.demographics || [])].map((g) => g.name),
    tags: (m.themes || []).map((g) => g.name),
    people: (m.authors || []).map((a) => ({ name: flipName(a.name), role: 'Writer' })),
    publisher: m.serializations?.[0]?.name || null,
    ageRating: (m.explicit_genres || []).length || (m.genres || []).some((g) => /hentai|erotica/i.test(g.name)) ? 3 : null,
    links: [{ source: 'MyAnimeList', url: m.url }],
    coverUrl: m.images?.jpg?.large_image_url || m.images?.jpg?.image_url || null,
    thumbUrl: m.images?.jpg?.image_url || null,
    format: m.type,
    volumes: m.volumes,
    chapters: m.chapters,
    providerIds: { mal: String(m.mal_id) },
  };
}

// Official MAL API (used when an admin adds a MAL Client ID).
const MAL_FIELDS = 'id,title,main_picture,alternative_titles,start_date,synopsis,genres,status,authors{first_name,last_name},num_volumes,num_chapters,nsfw,serialization{name},media_type';
function fromMalOfficial(m) {
  const alt = m.alternative_titles || {};
  return {
    provider: 'mal',
    id: String(m.id),
    title: alt.en || m.title,
    altTitles: [m.title, alt.ja, ...(alt.synonyms || [])].filter(Boolean),
    localizedName: alt.ja || null,
    summary: m.synopsis ? m.synopsis.replace(/\[Written by MAL Rewrite\]/g, '').trim() : null,
    status: STATUS(m.status?.replace(/_/g, ' ').replace('currently publishing', 'publishing')),
    year: m.start_date ? Number(m.start_date.slice(0, 4)) || null : null,
    genres: (m.genres || []).map((g) => g.name),
    tags: [],
    people: (m.authors || []).map((a) => ({
      name: [a.node?.first_name, a.node?.last_name].filter(Boolean).join(' '),
      role: /art/i.test(a.role || '') && !/story/i.test(a.role || '') ? 'Artist' : 'Writer',
    })).filter((p) => p.name),
    publisher: m.serialization?.[0]?.node?.name || null,
    ageRating: m.nsfw === 'black' ? 3 : m.nsfw === 'gray' ? 2 : null,
    links: [{ source: 'MyAnimeList', url: `https://myanimelist.net/manga/${m.id}` }],
    coverUrl: m.main_picture?.large || m.main_picture?.medium || null,
    thumbUrl: m.main_picture?.medium || null,
    format: m.media_type,
    volumes: m.num_volumes || null,
    chapters: m.num_chapters || null,
    providerIds: { mal: String(m.id) },
  };
}

const mal = {
  name: 'MyAnimeList',
  kinds: ['manga', 'comics', 'books'],
  async search(query) {
    const clientId = settings.get('malClientId');
    if (clientId) {
      const data = await http('MAL', 500, `https://api.myanimelist.net/v2/manga?q=${encodeURIComponent(query.slice(0, 64))}&limit=12&nsfw=true&fields=${MAL_FIELDS}`, { headers: { 'X-MAL-CLIENT-ID': clientId } });
      return (data.data || []).map((d) => fromMalOfficial(d.node));
    }
    const data = await http('Jikan', 1100, `https://api.jikan.moe/v4/manga?q=${encodeURIComponent(query)}&limit=12&sfw=false`);
    return (data.data || []).map(fromJikan);
  },
  async details(id) {
    const clientId = settings.get('malClientId');
    if (clientId) {
      return fromMalOfficial(await http('MAL', 500, `https://api.myanimelist.net/v2/manga/${encodeURIComponent(id)}?fields=${MAL_FIELDS}`, { headers: { 'X-MAL-CLIENT-ID': clientId } }));
    }
    const data = await http('Jikan', 1100, `https://api.jikan.moe/v4/manga/${encodeURIComponent(id)}/full`);
    return fromJikan(data.data);
  },
};

// ---------------------------------------------------------------------------
// MangaUpdates (REST, no key)

function fromMangaUpdates(r) {
  const authors = (r.authors || []).map((a) => ({ name: a.name, role: a.type === 'Artist' ? 'Artist' : 'Writer' }));
  const status = r.completed ? 'completed' : STATUS(r.status) || (r.status && /ongoing/i.test(r.status) ? 'ongoing' : null);
  return {
    provider: 'mangaupdates',
    id: String(r.series_id),
    title: r.title,
    altTitles: (r.associated || []).map((a) => a.title),
    localizedName: null,
    summary: stripHtml(r.description),
    status,
    year: r.year ? Number(r.year) || null : null,
    genres: (r.genres || []).map((g) => g.genre),
    tags: (r.categories || []).filter((c) => (c.votes || 0) >= 2).slice(0, 20).map((c) => c.category),
    people: authors,
    publisher: (r.publishers || []).find((p) => p.type === 'Original')?.publisher_name || null,
    ageRating: (r.genres || []).some((g) => /hentai|adult|smut/i.test(g.genre)) ? 3 : (r.genres || []).some((g) => /mature/i.test(g.genre)) ? 2 : null,
    links: r.url ? [{ source: 'MangaUpdates', url: r.url }] : [],
    coverUrl: r.image?.url?.original || null,
    thumbUrl: r.image?.url?.thumb || r.image?.url?.original || null,
    format: r.type,
    volumes: null,
    chapters: r.latest_chapter || null,
    providerIds: { mangaupdates: String(r.series_id) },
  };
}

const mangaupdates = {
  name: 'MangaUpdates',
  kinds: ['manga', 'comics', 'books'],
  async search(query) {
    const data = await http('MangaUpdates', 600, 'https://api.mangaupdates.com/v1/series/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search: query, perpage: 12 }),
    });
    return (data.results || []).map((x) => fromMangaUpdates(x.record));
  },
  async details(id) {
    return fromMangaUpdates(await http('MangaUpdates', 600, `https://api.mangaupdates.com/v1/series/${encodeURIComponent(id)}`));
  },
};

// ---------------------------------------------------------------------------
// ComicVine (needs a free API key)

function cvKey() {
  const key = settings.get('comicvineKey');
  if (!key) throw new Error('Add a ComicVine API key in Settings → Metadata sources first.');
  return key;
}

function fromComicVine(v) {
  return {
    provider: 'comicvine',
    id: String(v.id),
    title: v.name,
    altTitles: (v.aliases || '').split('\n').filter(Boolean),
    localizedName: null,
    summary: stripHtml(v.description) || v.deck || null,
    status: null,
    year: v.start_year ? Number(v.start_year) || null : null,
    genres: [],
    tags: (v.concepts || []).slice(0, 15).map((c) => c.name),
    people: (v.people || []).slice(0, 12).map((p) => ({ name: p.name, role: 'Creator' })),
    publisher: v.publisher?.name || null,
    ageRating: null,
    links: v.site_detail_url ? [{ source: 'ComicVine', url: v.site_detail_url }] : [],
    coverUrl: v.image?.original_url || v.image?.super_url || null,
    thumbUrl: v.image?.thumb_url || v.image?.small_url || null,
    format: 'Comic',
    volumes: null,
    chapters: v.count_of_issues || null,
    providerIds: { comicvine: String(v.id) },
  };
}

const comicvine = {
  name: 'ComicVine',
  kinds: ['comics', 'manga'],
  needsKey: true,
  async search(query) {
    const fields = 'id,name,aliases,start_year,publisher,image,description,deck,count_of_issues,site_detail_url';
    const data = await http('ComicVine', 1100, `https://comicvine.gamespot.com/api/search/?api_key=${cvKey()}&format=json&resources=volume&limit=12&field_list=${fields}&query=${encodeURIComponent(query)}`);
    if (data.error && data.error !== 'OK') throw new Error(`ComicVine: ${data.error}`);
    return (data.results || []).map(fromComicVine);
  },
  async details(id) {
    const data = await http('ComicVine', 1100, `https://comicvine.gamespot.com/api/volume/4050-${encodeURIComponent(id)}/?api_key=${cvKey()}&format=json`);
    if (data.error && data.error !== 'OK') throw new Error(`ComicVine: ${data.error}`);
    return fromComicVine(data.results);
  },
};

// ---------------------------------------------------------------------------
// Open Library (books, no key)

function fromOpenLibrary(d, work) {
  const desc = work?.description;
  return {
    provider: 'openlibrary',
    id: d.key.replace('/works/', ''),
    title: d.title,
    altTitles: [],
    localizedName: null,
    summary: typeof desc === 'string' ? desc : desc?.value || null,
    status: 'completed',
    year: d.first_publish_year || null,
    genres: (d.subject || work?.subjects || []).slice(0, 8),
    tags: [],
    people: (d.author_name || []).map((name) => ({ name, role: 'Writer' })),
    publisher: d.publisher?.[0] || null,
    ageRating: null,
    links: [{ source: 'Open Library', url: `https://openlibrary.org${d.key}` }],
    coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
    thumbUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
    format: 'Book',
    volumes: null,
    chapters: null,
    providerIds: { openlibrary: d.key.replace('/works/', '') },
  };
}

const openlibrary = {
  name: 'Open Library',
  kinds: ['books'],
  async search(query) {
    const fields = 'key,title,author_name,first_publish_year,cover_i,subject,publisher';
    const data = await http('OpenLibrary', 400, `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=12&fields=${fields}`);
    return (data.docs || []).map((d) => fromOpenLibrary(d));
  },
  async details(id) {
    const work = await http('OpenLibrary', 400, `https://openlibrary.org/works/${encodeURIComponent(id)}.json`);
    const search = await http('OpenLibrary', 400, `https://openlibrary.org/search.json?q=key:/works/${encodeURIComponent(id)}&fields=key,title,author_name,first_publish_year,cover_i,subject,publisher`);
    const doc = search.docs?.[0] || { key: `/works/${id}`, title: work.title, cover_i: work.covers?.[0] };
    return fromOpenLibrary(doc, work);
  },
};

// ---------------------------------------------------------------------------
// Google Books (no key needed for light use)

function fromGoogle(item) {
  const v = item.volumeInfo || {};
  const img = v.imageLinks?.extraLarge || v.imageLinks?.large || v.imageLinks?.medium || v.imageLinks?.thumbnail;
  const https = (u) => u?.replace(/^http:/, 'https:').replace('&edge=curl', '');
  return {
    provider: 'googlebooks',
    id: item.id,
    title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title,
    altTitles: [],
    localizedName: null,
    summary: stripHtml(v.description),
    status: 'completed',
    year: v.publishedDate ? Number(v.publishedDate.slice(0, 4)) || null : null,
    genres: v.categories || [],
    tags: [],
    people: (v.authors || []).map((name) => ({ name, role: 'Writer' })),
    publisher: v.publisher || null,
    ageRating: v.maturityRating === 'MATURE' ? 3 : null,
    links: v.infoLink ? [{ source: 'Google Books', url: https(v.infoLink) }] : [],
    coverUrl: https(img) || null,
    thumbUrl: https(v.imageLinks?.thumbnail) || null,
    format: 'Book',
    volumes: null,
    chapters: null,
    providerIds: { googlebooks: item.id },
  };
}

const gbKey = (sep = '&') => (settings.get('googleBooksKey') ? `${sep}key=${encodeURIComponent(settings.get('googleBooksKey'))}` : '');

const googlebooks = {
  name: 'Google Books',
  kinds: ['books'],
  async search(query) {
    const data = await http('GoogleBooks', 300, `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=12${gbKey()}`);
    return (data.items || []).map(fromGoogle);
  },
  async details(id) {
    return fromGoogle(await http('GoogleBooks', 300, `https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(id)}${gbKey('?')}`));
  },
};

const PROVIDERS = { anilist, mangadex, mal, mangaupdates, comicvine, openlibrary, googlebooks };

/** Default provider order for automatic matching. */
const DEFAULT_SOURCES = {
  manga: ['anilist', 'mangadex', 'mal', 'mangaupdates'],
  comics: ['comicvine', 'anilist', 'mangadex'],
  books: ['openlibrary', 'googlebooks', 'anilist'],
};

function list() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    name: p.name,
    kinds: p.kinds,
    needsKey: Boolean(p.needsKey),
    configured: !p.needsKey || Boolean(settings.get('comicvineKey')),
  }));
}

function get(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown metadata source: ${id}`);
  return p;
}

module.exports = { list, get, DEFAULT_SOURCES, linkSource };
