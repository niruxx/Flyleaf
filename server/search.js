'use strict';

// Relevance search. A plain SQL LIKE '%term%' matches inside words ("it" → "Kitchen")
// and can't rank, so results looked random. Here every word of the query has to
// start a word in the title (or a book title / creator), and matches are scored:
// exact title > title starts with the query > phrase at a word start > all words
// present > the words appear in a book or creator name.

const { q } = require('./db');
const { accessFilter, json } = require('./util');

/** Lower-case, accent-free text for comparisons ("Pokémon" → "pokemon"). */
function norm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(query) {
  return [...new Set(norm(query).split(' ').filter(Boolean))].slice(0, 8);
}

/** Does `word` start a word somewhere in normalised text `t`? */
const startsWord = (t, word) => t.startsWith(word) || t.includes(` ${word}`);

/** 0–100: how well `text` matches the query. 0 = not a match. */
function scoreText(text, qn, toks) {
  const t = norm(text);
  if (!t || !qn) return 0;
  if (t === qn) return 100;
  if (t.startsWith(qn)) return 88 - Math.min(10, (t.length - qn.length) / 8);
  if (t.includes(` ${qn}`)) return 72;
  if (toks.every((w) => startsWord(t, w))) return 55;
  return 0;
}

/** LIKE pattern for a token (escaped). */
const likeTok = (w) => `%${w.replace(/[\\%_]/g, '\\$&')}%`;

/**
 * Series ids for `query`, best first. Matches titles, alternative titles, book titles
 * and creators; respects the user's access (age rating and libraries).
 */
function rankSeries(user, query, { limit = 500 } = {}) {
  const toks = tokens(query);
  if (!toks.length) return [];
  const qn = norm(query);
  const age = accessFilter(user, 's');
  // Cheap SQL pre-filter: every token appears somewhere (accent-insensitive matching happens in JS).
  const conds = toks.map(() => `(s.name LIKE ? ESCAPE '\\' OR s.localized_name LIKE ? ESCAPE '\\' OR s.people LIKE ? ESCAPE '\\'
    OR EXISTS (SELECT 1 FROM books b2 WHERE b2.series_id = s.id AND b2.missing = 0 AND (b2.title LIKE ? ESCAPE '\\' OR b2.author LIKE ? ESCAPE '\\')))`);
  const args = toks.flatMap((w) => Array(5).fill(likeTok(w)));
  let rows = q(`SELECT s.id, s.name, s.localized_name, s.sort_name, s.people,
                  (SELECT group_concat(b.title, char(10)) FROM books b WHERE b.series_id = s.id AND b.missing = 0) AS titles
                FROM series s WHERE ${age.sql} AND ${conds.join(' AND ')} LIMIT 3000`).all(...age.args, ...args);
  if (!rows.length) {
    // Accents in the stored text ("Pokémon" for "pokemon"): fall back to checking everything visible.
    rows = q(`SELECT s.id, s.name, s.localized_name, s.sort_name, s.people,
                (SELECT group_concat(b.title, char(10)) FROM books b WHERE b.series_id = s.id AND b.missing = 0) AS titles
              FROM series s WHERE ${age.sql} LIMIT 20000`).all(...age.args);
  }
  const scored = [];
  for (const r of rows) {
    const people = json(r.people, []).map((p) => p.name);
    const score = Math.max(
      scoreText(r.name, qn, toks),
      scoreText(r.localized_name, qn, toks) * 0.95,
      scoreText(r.sort_name, qn, toks) * 0.95,
      ...String(r.titles || '').split('\n').map((t) => scoreText(t, qn, toks) * 0.8),
      ...people.map((p) => scoreText(p, qn, toks) * 0.7),
    );
    if (score > 0) scored.push({ id: r.id, score, name: r.name });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return scored.slice(0, limit).map((x) => x.id);
}

/** Rank arbitrary strings (people, genres) against the query. */
function rankStrings(values, query, limit) {
  const toks = tokens(query);
  const qn = norm(query);
  return [...new Set(values)]
    .map((v) => ({ v, s: scoreText(v, qn, toks) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || String(a.v).localeCompare(String(b.v)))
    .slice(0, limit)
    .map((x) => x.v);
}

module.exports = { norm, tokens, scoreText, rankSeries, rankStrings };
