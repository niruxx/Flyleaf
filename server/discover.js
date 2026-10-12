'use strict';

// "Discover in Content Finder": recommendations from outside your library. Your favourite
// creators and genres (recommend.taste) are searched on your Content Finder sources, and
// whatever you don't already have is ranked by how many of those searches found it.
// Plugin calls are slow and hit other people's websites, so results are cached per user.

const manager = require('./plugins/manager');
const { taste } = require('./recommend');
const { norm } = require('./search');
const { q } = require('./db');
const { accessFilter } = require('./util');

const CACHE_MS = 6 * 60 * 60 * 1000;
const CALL_TIMEOUT = 25_000;
const MAX_SOURCES = 4;
const cache = new Map(); // userId → { key, at, result, pending }

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);

/** Run async jobs `limit` at a time. */
async function pool(jobs, limit) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (i < jobs.length) {
      const n = i++;
      out[n] = await jobs[n]().catch(() => null);
    }
  }));
  return out;
}

/** Sources to search: the user's picks, or the first few ready ones that fit their reading. */
async function pickSources(opts, kinds) {
  const all = (await manager.list()).filter((s) => !s.needsSetup && !s.error && s.enabled !== false);
  if (opts.sources?.length) return all.filter((s) => opts.sources.includes(s.id)).slice(0, 8);
  const ok = all.filter((s) => opts.nsfw || !s.nsfw);
  const fits = (s) => !kinds.length || (s.kinds || []).some((k) => kinds.includes(k));
  return [...ok.filter(fits), ...ok.filter((s) => !fits(s))].slice(0, MAX_SOURCES);
}

/** "Frankenstein, or, The Modern Prometheus" → "frankenstein": the title without its subtitle. */
const mainTitle = (t) => norm(String(t || '').split(/\s*(?:[:;(\[]|,\s*or\b|\s-\s)/i)[0]);

/** Titles already in the user's libraries, normalised, so we don't suggest what they have. */
function ownedTitles(user) {
  const age = accessFilter(user, 's');
  const set = new Set();
  for (const r of q(`SELECT s.name, s.localized_name, (SELECT group_concat(b.title, char(10)) FROM books b WHERE b.series_id = s.id) AS titles FROM series s WHERE ${age.sql}`).all(...age.args)) {
    for (const t of [r.name, r.localized_name, ...String(r.titles || '').split('\n')]) if (t) set.add(norm(t)).add(mainTitle(t));
  }
  return set;
}

async function compute(user, opts, imager) {
  const t = taste(user);
  if (!t.creators.length && !t.genres.length) return { items: [], sources: [], reason: 'no-history' };
  const kinds = [...new Set([...t.creators, ...t.genres].slice(0, 20).flatMap((x) => x.kinds))];
  const sources = await pickSources(opts, kinds);
  if (!sources.length) return { items: [], sources: [], reason: 'no-sources' };

  // A few searches per source: top creators first (precise), then specific genres/tags.
  const searches = [
    ...t.creators.slice(0, 3).map((c) => ({ query: c.name, creator: c.name, why: `Because you like ${c.name}`, kinds: c.kinds, weight: 1.2 })),
    ...t.genres.slice(0, 2).map((g) => ({ query: g.name, why: `More ${g.name}, like ${g.seed}`, kinds: g.kinds, weight: 1 })),
  ];
  const jobs = [];
  for (const src of sources) {
    for (const s of searches) {
      // Don't ask a books-only source about a manga artist, and vice versa.
      if (src.kinds?.length && s.kinds.length && !src.kinds.some((k) => s.kinds.includes(k))) continue;
      jobs.push(async () => ({ src, s, r: await withTimeout(manager.run(src.id, 'search', [s.query, 1]), CALL_TIMEOUT) }));
    }
  }
  const results = await pool(jobs, 4);

  const owned = ownedTitles(user);
  const found = new Map();
  for (const res of results) {
    if (!res?.r?.items) continue;
    const img = await imager(res.src.id).catch(() => (u) => u);
    res.r.items.slice(0, 12).forEach((raw, rank) => {
      if (!raw || raw.id == null || raw.folder) return;
      const title = String(raw.title || '').slice(0, 300);
      const key = norm(title);
      if (!key || owned.has(key) || owned.has(mainTitle(title))) return;
      let score = res.s.weight * (1 - rank / 15);
      let reason = res.s.why;
      if (res.s.creator) {
        // A search for an author also finds books *about* them; rank their own work first.
        const surname = norm(res.s.creator).split(' ').pop();
        if (surname && norm(raw.author).split(' ').includes(surname)) score *= 1.5;
        else {
          score *= 0.4;
          reason = `Related to ${res.s.creator}`;
        }
      }
      const cur = found.get(key);
      if (cur) {
        cur.score += score * 0.6;
        return;
      }
      found.set(key, {
        score,
        reason,
        source: { id: res.src.id, name: res.src.name, icon: res.src.icon || null, kinds: res.src.kinds || [] },
        item: {
          id: String(raw.id).slice(0, 2000),
          title: title || 'Untitled',
          author: raw.author ? String(raw.author).slice(0, 200) : null,
          cover: typeof raw.cover === 'string' && /^https?:\/\//i.test(raw.cover) ? img(raw.cover) : null,
        },
      });
    });
  }
  // Interleave sources so one site doesn't fill the whole shelf.
  const bySource = new Map();
  for (const x of [...found.values()].sort((a, b) => b.score - a.score)) {
    if (!bySource.has(x.source.id)) bySource.set(x.source.id, []);
    bySource.get(x.source.id).push(x);
  }
  const items = [];
  const lists = [...bySource.values()];
  while (items.length < 30 && lists.some((l) => l.length)) for (const l of lists) if (l.length && items.length < 30) items.push(l.shift());
  return { items: items.map(({ score, ...rest }) => rest), sources: sources.map((s) => s.name) };
}

/** Cached suggestions; `refresh` recomputes. Concurrent calls share one computation. */
async function forUser(user, { refresh = false, imager } = {}) {
  const opts = { enabled: true, sources: [], nsfw: false, ...(user.prefs?.finderRecs || {}) };
  if (!opts.enabled) return { items: [], sources: [], reason: 'disabled' };
  const key = JSON.stringify(opts);
  const c = cache.get(user.id);
  if (c && c.key === key) {
    if (c.pending) return c.pending;
    if (!refresh && Date.now() - c.at < CACHE_MS) return c.result;
  }
  const pending = compute(user, opts, imager).then((result) => {
    result.generatedAt = Date.now();
    cache.set(user.id, { key, at: Date.now(), result });
    return result;
  }).catch((e) => {
    cache.delete(user.id);
    throw e;
  });
  cache.set(user.id, { key, at: 0, pending });
  return pending;
}

module.exports = { forUser };
