'use strict';

// Applying provider metadata to series, and background auto-matching.

const { q } = require('./db');
const providers = require('./providers');
const covers = require('./covers');
const { json, similarity, mergeLinks } = require('./util');
const log = require('./log').logger('metadata');

const FIELDS = ['name', 'localized_name', 'summary', 'status', 'year', 'publisher', 'age_rating', 'genres', 'tags', 'people', 'links', 'cover', 'external_rating'];

/**
 * Apply a provider result to a series.
 * @param fields which fields to apply (defaults to all); locked fields are skipped unless `force`.
 */
async function applyToSeries(seriesId, result, { fields = FIELDS, force = false, coverPolicy = 'always' } = {}) {
  const s = q('SELECT * FROM series WHERE id = ?').get(seriesId);
  if (!s) throw new Error('Series not found.');
  const locked = new Set(force ? [] : json(s.locked, []));
  const want = (f) => fields.includes(f) && !locked.has(f);
  const sets = [];
  const vals = [];
  const put = (col, val) => {
    sets.push(`${col} = ?`);
    vals.push(val);
  };

  if (want('name') && result.title) put('name', result.title);
  if (want('localized_name') && result.localizedName) put('localized_name', result.localizedName);
  if (want('summary') && result.summary) put('summary', result.summary);
  if (want('status') && result.status) put('status', result.status);
  if (want('year') && result.year) put('year', result.year);
  if (want('publisher') && result.publisher) put('publisher', result.publisher);
  if (want('age_rating') && result.ageRating != null) put('age_rating', result.ageRating);
  if (want('genres') && result.genres?.length) put('genres', JSON.stringify(result.genres));
  if (want('tags') && result.tags?.length) put('tags', JSON.stringify(result.tags));
  if (want('people') && result.people?.length) put('people', JSON.stringify(result.people));
  if (want('links')) put('links', JSON.stringify(mergeLinks(json(s.links, []), result.links || [])));
  put('provider_ids', JSON.stringify({ ...json(s.provider_ids, {}), ...(result.providerIds || {}) }));
  put('metadata_source', result.provider);
  put('metadata_at', Date.now());

  const hasCover = Boolean(s.cover) || Boolean(q('SELECT 1 FROM books WHERE series_id = ? AND cover IS NOT NULL').get(seriesId));
  const takeCover = want('cover') && result.coverUrl && (coverPolicy === 'always' || (coverPolicy === 'missing' && !hasCover));
  if (takeCover) {
    try {
      const name = await covers.saveSeriesCover(seriesId, await covers.fetchImage(result.coverUrl));
      if (name) put('cover', name);
    } catch (err) {
      log.file(`cover download failed for series ${seriesId}: ${err.message}`);
    }
  }
  if (want('external_rating') && result.externalRating) {
    const current = takeCover && !force ? q('SELECT locked FROM series WHERE id = ?').get(seriesId) : null;
    if (!json(current?.locked, []).includes('external_rating')) put('external_rating', JSON.stringify(result.externalRating));
  }
  q(`UPDATE series SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), seriesId);
}

// ---------------------------------------------------------------------------
// Auto-matching

const autoQueue = [];
let autoRunning = false;

function bestMatch(name, results) {
  let best = null;
  for (const r of results) {
    const score = Math.max(similarity(name, r.title), ...(r.altTitles || []).map((t) => similarity(name, t)));
    if (!best || score > best.score) best = { result: r, score };
  }
  return best && best.score >= 0.86 ? best.result : null;
}

async function autoMatchSeries(series, lib) {
  const sources = json(lib.sources, null) || providers.DEFAULT_SOURCES[lib.kind];
  let providerError = null;
  for (const id of sources) {
    const p = providers.get(id);
    if (p.needsKey && !require('./settings').get('comicvineKey')) continue;
    let results;
    try {
      results = await p.search(series.name);
    } catch (err) {
      providerError = err;
      log.file(`${p.name} search failed for "${series.name}": ${err.message}`);
      continue;
    }
    const match = bestMatch(series.name, results);
    if (!match) continue;
    const full = await p.details(match.id).catch(() => match);
    await applyToSeries(series.id, full, { coverPolicy: lib.cover_policy, fields: FIELDS.filter((f) => f !== 'name') });
    return full;
  }
  if (providerError) throw providerError;
  // Remember the attempt so we don't retry every scan.
  q("UPDATE series SET metadata_source = 'none', metadata_at = ? WHERE id = ?").run(Date.now(), series.id);
  return null;
}

/** Queue auto-matching for series in a library that have never been matched. */
function queueAuto(libraryId) {
  if (!autoQueue.includes(libraryId)) autoQueue.push(libraryId);
  runAuto();
}

async function runAuto() {
  if (autoRunning) return;
  autoRunning = true;
  try {
    while (autoQueue.length) {
      const libId = autoQueue.shift();
      const lib = q('SELECT * FROM libraries WHERE id = ?').get(libId);
      if (!lib) continue;
      const pending = q('SELECT * FROM series WHERE library_id = ? AND metadata_source IS NULL').all(libId);
      if (!pending.length) continue;
      const tasks = require('./tasks');
      const task = tasks.start('metadata', lib.name, { libraryId: lib.id, total: pending.length });
      let completed = 0;
      let errors = 0;
      let matched = 0;
      for (const s of pending) {
        try {
          if (await autoMatchSeries(s, lib)) matched++;
        } catch (err) {
          errors++;
          log.file(`auto-match "${s.name}": ${err.message}`);
        }
        tasks.progress(task, ++completed, pending.length);
      }
      // Progress is updated after every provider attempt.
      tasks.finish(task, errors ? `${errors} metadata lookups failed. Retry to try the pending series again.` : null);
      log.info(`"${lib.name}": matched metadata for ${matched} of ${pending.length} new series`);
    }
  } finally {
    autoRunning = false;
  }
}

module.exports = { applyToSeries, queueAuto, autoMatchSeries, FIELDS };
