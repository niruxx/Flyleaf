'use strict';

// Recommendations, without AI or outside services: every series is described by its
// genres, tags, creators, publisher and library type (rare genres and tags weigh more
// than common ones).
//   similar(user, id)  "More like this": the series closest to one series.
//   forYou(user)       "Recommended for you": a taste profile built from what you've read,
//                      finished, rated with a status or saved, matched against what you haven't
//                      started, each with a reason ("Because you read Berserk").

const { q } = require('./db');
const { accessFilter, json } = require('./util');

const lower = (list) => [...new Set(json(list, []).map((x) => String(x).toLowerCase().trim()).filter(Boolean))];
const names = (people) => [...new Set(json(people, []).map((p) => String(p.name || '').toLowerCase().trim()).filter(Boolean))];

/** Every series the user can see, with its features weighted. */
function catalog(user) {
  const age = accessFilter(user, 's');
  const rows = q(`SELECT s.id, s.name, s.genres, s.tags, s.people, s.publisher, s.year, l.kind
                  FROM series s JOIN libraries l ON l.id = s.library_id
                  WHERE ${age.sql} AND EXISTS (SELECT 1 FROM books b WHERE b.series_id = s.id AND b.missing = 0)`).all(...age.args);
  const items = rows.map((r) => ({ id: r.id, name: r.name, rawGenres: json(r.genres, []), rawTags: json(r.tags, []), rawPeople: json(r.people, []).map((p) => p.name).filter(Boolean), year: r.year, kind: r.kind, publisher: (r.publisher || '').toLowerCase().trim(), genres: lower(r.genres), tags: lower(r.tags), people: names(r.people) }));
  // How common each genre/tag is, so "Fantasy" matters less than "Time travel".
  const freq = new Map();
  for (const it of items) for (const g of new Set([...it.genres, ...it.tags])) freq.set(g, (freq.get(g) || 0) + 1);
  const weight = (g) => 1 / Math.log2(2 + (freq.get(g) || 0));
  for (const it of items) {
    // Feature vector: genres count most, then creators, then tags (capped so a long tag
    // list can't dominate), with a nudge for the same publisher and type of library.
    const v = new Map();
    for (const g of it.genres) v.set(`g:${g}`, 4 * weight(g));
    const tagW = it.tags.map((t) => [t, 2 * weight(t)]);
    const tagTotal = tagW.reduce((a, [, w]) => a + w, 0);
    const scale = tagTotal > 6 ? 6 / tagTotal : 1;
    for (const [t, w] of tagW) if (!it.genres.includes(t)) v.set(`g:${t}`, w * scale);
    for (const p of it.people) v.set(`p:${p}`, 3);
    if (it.publisher) v.set(`pub:${it.publisher}`, 0.5);
    v.set(`k:${it.kind}`, 0.5);
    it.vec = v;
    it.norm = Math.sqrt([...v.values()].reduce((a, x) => a + x * x, 0)) || 1;
  }
  return { items, byId: new Map(items.map((it) => [it.id, it])) };
}

/** Shared evidence between two series (0 = nothing in common besides type/publisher). */
function overlap(a, b) {
  let score = 0;
  for (const [f, w] of a.vec) {
    if (f.startsWith('k:') || f.startsWith('pub:')) continue;
    const o = b.vec.get(f);
    if (o) score += Math.min(w, o);
  }
  if (score === 0) return 0;
  if (a.kind === b.kind) score += 0.5;
  if (a.publisher && a.publisher === b.publisher) score += 0.5;
  if (a.year && b.year && Math.abs(a.year - b.year) <= 5) score += 0.3;
  return score;
}

/** Ids of the series most like `seriesId`, best first. Related series are left out (they have their own section). */
function similar(user, seriesId, limit = 12) {
  const { items, byId } = catalog(user);
  const me = byId.get(seriesId);
  if (!me) return [];
  const exclude = new Set([seriesId, ...q('SELECT related_id FROM series_relations WHERE series_id = ?').all(seriesId).map((r) => r.related_id)]);
  return items
    .filter((it) => !exclude.has(it.id))
    .map((it) => ({ id: it.id, score: overlap(me, it) }))
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.id);
}

const STATUS_SIGNAL = { completed: 3, reading: 2, on_hold: 1, plan: 1, dropped: -2 };

/** How much the user likes each series they've touched (negative = dropped). */
function signals(userId) {
  const out = new Map();
  const add = (id, v, verb) => {
    const cur = out.get(id) || { score: 0, verb: null, strength: 0 };
    cur.score += v;
    if (verb && v > cur.strength) Object.assign(cur, { verb, strength: v });
    out.set(id, cur);
  };
  // Reading progress: finishing counts most.
  for (const r of q(`SELECT b.series_id AS id, MAX(p.finished) AS finished, MAX(p.percent) AS pct, MAX(p.updated_at) AS at
                     FROM progress p JOIN books b ON b.id = p.book_id WHERE p.user_id = ? GROUP BY b.series_id`).all(userId)) {
    if (r.finished) add(r.id, 3, 'you finished');
    else if (r.pct > 0.02) add(r.id, 2, 'you’re reading');
    // Recent reading matters a little more than reading from years ago.
    const ageDays = (Date.now() - r.at) / 86_400_000;
    if (ageDays < 30) add(r.id, 0.5, null);
  }
  // Time actually spent reading.
  for (const r of q(`SELECT b.series_id AS id, SUM(l.seconds) AS sec FROM reading_log l JOIN books b ON b.id = l.book_id
                     WHERE l.user_id = ? GROUP BY b.series_id`).all(userId)) {
    add(r.id, Math.min(2, Math.log10(1 + r.sec / 600)), null);
  }
  for (const r of q('SELECT series_id AS id, status, want_to_read FROM user_series WHERE user_id = ?').all(userId)) {
    if (r.status && STATUS_SIGNAL[r.status]) add(r.id, STATUS_SIGNAL[r.status], r.status === 'completed' ? 'you finished' : r.status === 'reading' ? 'you’re reading' : r.status === 'dropped' ? null : 'you liked');
    if (r.want_to_read) add(r.id, 1.5, 'you want to read');
  }
  return out;
}

/**
 * Personal recommendations: [{ id, reason }], best first. Series you've started, finished,
 * dropped or saved to Want to read are never suggested. With no history yet, falls back to
 * what other people on this server read most.
 */
function forYou(user, limit = 24) {
  const { items, byId } = catalog(user);
  const sig = signals(user.id);
  const seeds = [...sig.entries()].filter(([id]) => byId.has(id));
  const taken = new Set(q(`SELECT DISTINCT b.series_id AS id FROM progress p JOIN books b ON b.id = p.book_id WHERE p.user_id = ? AND (p.percent > 0 OR p.finished = 1)`).all(user.id).map((r) => r.id));
  for (const r of q(`SELECT series_id AS id FROM user_series WHERE user_id = ? AND (want_to_read = 1 OR status IN ('reading', 'completed', 'dropped'))`).all(user.id)) taken.add(r.id);
  for (const [id] of seeds) taken.add(id);

  const positive = seeds.filter(([, s]) => s.score > 0);
  if (!positive.length) return popular(user, byId, taken, limit);

  // Taste profile: the sum of the feature vectors of what you liked (minus what you dropped).
  const profile = new Map();
  for (const [id, s] of seeds) {
    const it = byId.get(id);
    const w = Math.max(-2, Math.min(s.score, 6)) / it.norm;
    for (const [f, v] of it.vec) profile.set(f, (profile.get(f) || 0) + w * v);
  }
  const pNorm = Math.sqrt([...profile.values()].reduce((a, x) => a + (x > 0 ? x * x : 0), 0)) || 1;

  const scored = [];
  for (const it of items) {
    if (taken.has(it.id)) continue;
    let dot = 0;
    for (const [f, v] of it.vec) dot += (profile.get(f) || 0) * v;
    const score = dot / (pNorm * it.norm);
    if (score <= 0.05) continue;
    // The reason: the liked series this one is closest to.
    let best = null;
    for (const [id, s] of positive) {
      const o = overlap(byId.get(id), it) * Math.min(s.score, 6);
      if (o > 0 && (!best || o > best.o)) best = { o, id, verb: s.verb };
    }
    if (best) scored.push({ id: it.id, score, because: best.id, verb: best.verb });
  }
  scored.sort((a, b) => b.score - a.score);

  // Keep it varied: each further pick explained by the same series counts a bit less.
  const used = new Map();
  const picked = [];
  const pool = scored.slice(0, limit * 4);
  while (picked.length < limit && pool.length) {
    let bi = 0;
    let bv = -Infinity;
    pool.forEach((x, i) => {
      const v = x.score * 0.85 ** (used.get(x.because) || 0);
      if (v > bv) [bi, bv] = [i, v];
    });
    const [x] = pool.splice(bi, 1);
    used.set(x.because, (used.get(x.because) || 0) + 1);
    const seed = byId.get(x.because);
    picked.push({ id: x.id, reason: `Because ${x.verb || 'you read'} ${seed.name}`, becauseId: seed.id });
  }
  return picked;
}

/** No history yet: what other readers here have read most, then the newest additions. */
function popular(user, byId, taken, limit) {
  const rows = q(`SELECT b.series_id AS id, COUNT(DISTINCT p.user_id) AS readers FROM progress p JOIN books b ON b.id = p.book_id
                  WHERE p.user_id != ? AND (p.percent > 0.05 OR p.finished = 1) GROUP BY b.series_id ORDER BY readers DESC LIMIT 200`).all(user.id);
  const out = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (!byId.has(r.id) || taken.has(r.id)) continue;
    out.push({ id: r.id, reason: r.readers > 1 ? `Read by ${r.readers} people here` : 'Popular here' });
  }
  return out;
}

/**
 * What the user likes, for searching elsewhere (Content Finder): their favourite creators
 * and genres/tags, strongest first, each with the series that taught us ({ name, weight, seed, kinds }).
 */
function taste(user) {
  const { byId } = catalog(user);
  const creators = new Map();
  const genres = new Map();
  const bump = (map, name, w, it) => {
    const key = name.toLowerCase().trim();
    if (!key) return;
    const cur = map.get(key) || { name: name.trim(), weight: 0, seed: null, seedWeight: 0, kinds: new Set() };
    cur.weight += w;
    cur.kinds.add(it.kind);
    if (w > cur.seedWeight) Object.assign(cur, { seed: it.name, seedWeight: w });
    map.set(key, cur);
  };
  for (const [id, s] of signals(user.id)) {
    const it = byId.get(id);
    if (!it || s.score <= 0) continue;
    const w = Math.min(s.score, 6);
    for (const p of it.rawPeople) bump(creators, String(p), w, it);
    for (const g of [...it.rawGenres, ...it.rawTags]) bump(genres, String(g), w, it);
  }
  const out = (map) => [...map.values()].sort((a, b) => b.weight - a.weight).map(({ name, weight, seed, kinds }) => ({ name, weight, seed, kinds: [...kinds] }));
  // Ubiquitous genres ("Action", "Manga") make poor searches; prefer the more specific ones.
  const common = new Set(['action', 'comedy', 'drama', 'fantasy', 'romance', 'manga', 'comic', 'comics', 'fiction', 'adventure', 'shounen', 'shonen', 'seinen', 'shoujo', 'josei']);
  return { creators: out(creators), genres: out(genres).sort((a, b) => Number(common.has(a.name.toLowerCase())) - Number(common.has(b.name.toLowerCase())) || b.weight - a.weight) };
}

module.exports = { similar, forYou, taste };
