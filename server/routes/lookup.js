'use strict';

// Look up selected text while reading: definitions (Wiktionary), Wikipedia summaries and
// translations (MyMemory). The server asks on the reader's behalf – one place to cache, a
// proper User-Agent for Wikimedia, and readers' browsers never talk to those sites directly.
// LOOKUP=0 turns it off (the reader then only offers links that open the sites).

const express = require('express');
const { stripHtml } = require('../util');
const log = require('../log').logger('lookup');

const router = express.Router();
const ENABLED = process.env.LOOKUP !== '0';
const UA = `Flyleaf/${require('../../package.json').version} (self-hosted e-book server; https://github.com/niruxx/Flyleaf)`;
const TTL = 24 * 3600_000;
const cache = new Map(); // url → { at, data }

/** GET JSON with a timeout and a day-long cache. 404 → null. */
async function getJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).hostname} answered ${res.status}`), { status: 502, expose: true });
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  return data;
}

const lang = (v, fallback = 'en') => (/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(String(v || '')) ? String(v).toLowerCase() : fallback);
const base = (l) => l.split('-')[0];
const text = (v, max = 200) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

router.use('/lookup', (req, res, next) => (ENABLED ? next() : res.status(503).json({ error: 'Look-up is turned off on this server.', disabled: true })));

/**
 * Definitions from Wiktionary: { word, url, entries: [{ language, partOfSpeech, definitions: [{ text, examples }] }] }.
 * Entries in the book's language come first.
 */
router.get('/lookup/define', async (req, res) => {
  const word = text(req.query.word, 80).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!word) return res.status(400).json({ error: 'Select a word to look up.' });
  const want = base(lang(req.query.lang));
  // English Wiktionary describes words of every language. Lower-case first (a capital at the start
  // of a sentence would otherwise find surnames), then as written (names, German nouns).
  let data = null;
  let found = word;
  for (const w of [...new Set([word.toLowerCase(), word])]) {
    data = await getJson(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w.replace(/ /g, '_'))}`);
    if (data) {
      found = w;
      break;
    }
  }
  const entries = Object.entries(data || {})
    .sort(([a], [b]) => (b === want) - (a === want) || (b === 'en') - (a === 'en'))
    .flatMap(([code, list]) => (Array.isArray(list) ? list : []).map((e) => ({
      code,
      language: e.language,
      partOfSpeech: e.partOfSpeech,
      definitions: (e.definitions || [])
        .map((d) => ({ text: stripHtml(d.definition || ''), examples: (d.parsedExamples || []).map((x) => stripHtml(x.example || '')).filter(Boolean).slice(0, 2) }))
        .filter((d) => d.text)
        .slice(0, 6),
    })))
    .filter((e) => e.definitions.length)
    .slice(0, 8);
  res.json({ word: found, url: `https://en.wiktionary.org/wiki/${encodeURIComponent(found.replace(/ /g, '_'))}`, entries });
});

/** A Wikipedia summary: { title, description, extract, url, thumbnail } (null when nothing matches). */
router.get('/lookup/wiki', async (req, res) => {
  const q = text(req.query.q, 200);
  if (!q) return res.status(400).json({ error: 'Select something to look up.' });
  const l = base(lang(req.query.lang));
  const site = `https://${l}.wikipedia.org`;
  let page = await getJson(`${site}/api/rest_v1/page/summary/${encodeURIComponent(q.replace(/ /g, '_'))}?redirect=true`).catch(() => null);
  if (!page || page.type === 'disambiguation') {
    // Not an exact title: take the best search hit.
    const hits = await getJson(`${site}/w/rest.php/v1/search/title?q=${encodeURIComponent(q)}&limit=1`).catch(() => null);
    const key = hits?.pages?.[0]?.key;
    if (key) page = await getJson(`${site}/api/rest_v1/page/summary/${encodeURIComponent(key)}`).catch(() => null) || page;
  }
  if (!page?.extract) return res.json({ result: null, searchUrl: `${site}/w/index.php?search=${encodeURIComponent(q)}` });
  res.json({
    result: {
      title: page.title,
      description: page.description || null,
      extract: page.extract,
      url: page.content_urls?.desktop?.page || `${site}/wiki/${encodeURIComponent(page.title)}`,
      thumbnail: page.thumbnail?.source || null,
      disambiguation: page.type === 'disambiguation',
    },
  });
});

/** Translate with MyMemory (free, no key): { text, from, to }. */
router.get('/lookup/translate', async (req, res) => {
  const q = text(req.query.q, 500);
  if (!q) return res.status(400).json({ error: 'Select some text to translate.' });
  const to = base(lang(req.query.to));
  const from = base(lang(req.query.from, 'en'));
  if (from === to) return res.json({ text: q, from, to, same: true });
  const data = await getJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${from}|${to}`);
  const out = data?.responseData?.translatedText;
  if (!out || data.responseStatus >= 400) {
    log.file(`translate failed: ${data?.responseDetails || data?.responseStatus}`);
    return res.status(502).json({ error: data?.responseDetails || 'The translation service didn’t answer. Try again later, or open it in your translator.' });
  }
  res.json({ text: out, from, to });
});

module.exports = { router, ENABLED };
