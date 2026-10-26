'use strict';

// Reading profiles: named bundles of reader settings, bound to libraries or series.

const { q } = require('./db');
const { json } = require('./util');

const DEFAULT_SETTINGS = {
  // Image readers (manga, comics, PDF)
  layout: 'single', // single | double | webtoon
  direction: 'auto', // auto (from library type) | ltr | rtl
  scaling: 'screen', // screen | width | height | original
  pageSplit: 'none', // none | split | split-reverse | fit
  background: '#000000',
  webtoonGap: 0,
  autoScrollSpeed: 3, // 1–10
  smartSpreads: true, // double-page: wide pages alone
  coverAlone: true, // double-page: the first page alone
  // Behaviour
  autoCloseMenu: true,
  immersive: false,
  tapToPaginate: true,
  swipeToPaginate: true,
  // Ebooks
  fontFamily: 'publisher',
  fontSize: 100,
  lineHeight: 1.5,
  margin: 'normal',
  textTheme: 'auto', // auto | light | sepia | dark | black
  flow: 'paginated', // paginated | scrolled
  columns: 'auto', // auto | 1 | 2
  justify: true,
  hyphenate: true,
};

const KEYS = Object.keys(DEFAULT_SETTINGS);

function clean(settings) {
  const out = {};
  for (const k of KEYS) if (settings?.[k] !== undefined) out[k] = settings[k];
  return out;
}

function ensureDefault(userId) {
  let row = q('SELECT * FROM reading_profiles WHERE user_id = ? AND is_default = 1').get(userId);
  if (!row) {
    const id = q('INSERT INTO reading_profiles (user_id, name, settings, is_default, created_at) VALUES (?, ?, ?, 1, ?)').run(
      userId, 'Default', JSON.stringify({}), Date.now(),
    ).lastInsertRowid;
    row = q('SELECT * FROM reading_profiles WHERE id = ?').get(Number(id));
  }
  return row;
}

function list(userId) {
  ensureDefault(userId);
  return q('SELECT * FROM reading_profiles WHERE user_id = ? ORDER BY is_default DESC, name COLLATE NOCASE').all(userId).map((p) => ({
    id: p.id,
    name: p.name,
    isDefault: Boolean(p.is_default),
    settings: { ...DEFAULT_SETTINGS, ...json(p.settings, {}) },
    libraries: q("SELECT target_id FROM profile_bindings WHERE user_id = ? AND profile_id = ? AND target = 'library'").all(userId, p.id).map((r) => r.target_id),
  }));
}

/**
 * Effective reader settings for a book:
 * defaults ← profile (series binding › library binding › user default) ← per-series tweaks made in the reader.
 */
function resolve(userId, book) {
  const binding =
    q("SELECT profile_id FROM profile_bindings WHERE user_id = ? AND target = 'series' AND target_id = ?").get(userId, book.series_id ?? -1) ||
    q("SELECT profile_id FROM profile_bindings WHERE user_id = ? AND target = 'library' AND target_id = ?").get(userId, book.library_id);
  const profile = binding
    ? q('SELECT * FROM reading_profiles WHERE id = ? AND user_id = ?').get(binding.profile_id, userId)
    : ensureDefault(userId);
  const base = { ...DEFAULT_SETTINGS, ...json(profile?.settings, {}) };
  const override = book.series_id
    ? json(q('SELECT reader_settings FROM user_series WHERE user_id = ? AND series_id = ?').get(userId, book.series_id)?.reader_settings, null)
    : null;
  return {
    profile: profile ? { id: profile.id, name: profile.name } : null,
    settings: { ...base, ...clean(override || {}) },
    overridden: Boolean(override && Object.keys(clean(override)).length),
  };
}

module.exports = { DEFAULT_SETTINGS, KEYS, clean, ensureDefault, list, resolve };
