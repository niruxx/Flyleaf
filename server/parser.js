'use strict';

// Filename parsing in the spirit of Kavita: series, volume and chapter are
// derived from the file name itself rather than the folder it lives in.

const path = require('node:path');

/** Grouping key: case/diacritic/punctuation-insensitive. */
function normalizeKey(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const SPECIAL = /\b(?:sp|specials?|omake|extras?|one-?shot|bonus|art ?book)\b/i;
const VOLUME = /\b(?:vol(?:ume)?s?|v|tome|band|libro)\.?\s*(\d+(?:\.\d+)?)(?:\s*-\s*\d+(?:\.\d+)?)?/i;
const CHAPTER = /(?:\b(?:ch(?:apter|p)?|c|ep(?:isode)?|issue|no)\.?\s*|#)(\d+(?:\.\d+)?)(?:\s*-\s*\d+(?:\.\d+)?)?/i;

function cleanName(s) {
  return s
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ') // [Group] {tags}
    .replace(/\((?!\d{4}\))[^)]*\)/g, ' ') // (Digital) (f) … but keep (2019) for year detection
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a book file/folder name.
 * @returns {{series: string|null, volume: number|null, chapter: number|null, special: boolean, year: number|null}}
 */
function parseFilename(file, isDir = false) {
  let base = path.basename(file);
  if (!isDir) base = base.replace(/\.[^.]+$/, '');
  const yearMatch = base.match(/\((\d{4})\)/);
  let s = cleanName(base).replace(/\(\d{4}\)/g, ' ').replace(/\s+/g, ' ').trim();

  const special = SPECIAL.test(s);
  const vol = s.match(VOLUME);
  const ch = s.match(CHAPTER);

  let cut = Infinity;
  if (vol) cut = Math.min(cut, vol.index);
  if (ch) cut = Math.min(cut, ch.index);

  let volume = vol ? Number(vol[1]) : null;
  let chapter = ch ? Number(ch[1]) : null;
  let series = Number.isFinite(cut) ? s.slice(0, cut) : s;

  // "Series Name 012" / "Series Name - 012": a trailing bare number is a chapter.
  if (!vol && !ch) {
    const trailing = s.match(/^(.*?\D)[\s\-–]+(\d{1,4}(?:\.\d+)?)$/);
    if (trailing && trailing[1].trim().length > 1) {
      series = trailing[1];
      chapter = Number(trailing[2]);
    }
  }
  if (special) series = series.replace(SPECIAL, ' ');
  series = series.replace(/[\s\-–:,.]+$/, '').replace(/^[\s\-–:,.]+/, '').replace(/\s+/g, ' ').trim();

  return {
    series: series || null,
    volume: Number.isFinite(volume) ? volume : null,
    chapter: Number.isFinite(chapter) ? chapter : null,
    special,
    year: yearMatch ? Number(yearMatch[1]) : null,
  };
}

module.exports = { parseFilename, normalizeKey };
