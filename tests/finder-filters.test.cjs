const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(tags, rating, details, language = '') {
  const source = fs.readFileSync('public/js/views/finder.js', 'utf8');
  const body = source.slice(source.indexOf('  async function filterPage('), source.indexOf("  const crumbs ="));
  const badges = fs.readFileSync('public/js/components/content-rating-badge.js', 'utf8');
  const contentRating = vm.runInNewContext('(' + badges.slice(badges.indexOf('export function contentRating(') + 7, badges.indexOf('export function contentRatingBadge')).trim() + ')');
  let calls = 0;
  const filter = vm.runInNewContext(body + '; filterPage', {
    tagFilter: tags, ratingFilter: rating, languageFilter: language,
    languageCodes: (value) => String(value || '').toLowerCase().replaceAll('_', '-').split(/[,;]+/).map(v => v.trim()).filter(Boolean), detailCache: new Map(), contentRating,
    api: { finderDetails: async (_, id) => { calls++; if (details[id] instanceof Error) throw details[id]; return details[id]; } },
  });
  return { filter, calls: () => calls };
}

test('matches all comma-separated genres and tags, case insensitively, using details', async () => {
  const { filter, calls } = setup('space, YURI', '', {
    a: { genres: ['Space'], tags: ['Yuri'] }, b: { genres: ['Space'] },
  });
  const result = await filter({}, { items: [{ id: 'a' }, { id: 'b' }], hasMore: true });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 'a');
  assert.equal(result.hasMore, true);
  await filter({}, { items: [{ id: 'a' }], hasMore: false });
  assert.equal(calls(), 2);
});

test('safe filter excludes unrated and adult books, preserves folders and pagination', async () => {
  const { filter } = setup('', 'safe', { unknown: new Error('Unavailable') });
  const r = await filter({ nsfw: false }, { items: [
    { id: 'safe', ageRating: 0 }, { id: 'adult', ageRating: 3 }, { id: 'unknown' }, { id: 'folder', folder: true },
  ], hasMore: true });
  assert.equal(r.items.map(i => i.id).join(','), 'safe,folder');
  assert.equal(r.hasMore, true);
});

test('adult source fallback and failed details do not classify unknown books as safe', async () => {
  const { filter } = setup('', 'nsfw', { a: new Error('Unavailable') });
  const r = await filter({ nsfw: true }, { items: [{ id: 'a' }], hasMore: false });
  assert.equal(r.items.length, 1);
  const empty = await setup('Yuri', '', { a: new Error('Unavailable') }).filter({}, { items: [{ id: 'a' }], hasMore: true });
  assert.equal(empty.items.length, 0);
  assert.equal(empty.hasMore, true);
});

test('language filtering checks book details, regional codes, and source fallback', async () => {
  const { filter } = setup('', '', { detail: { language: 'en-US' }, fallback: {}, unknown: {} }, 'en');
  const r = await filter({ language: 'ja' }, { items: [
    { id: 'english', language: 'EN' }, { id: 'japanese', language: 'ja' },
    { id: 'detail' }, { id: 'fallback' },
  ], hasMore: true });
  assert.equal(r.items.map(i => i.id).join(','), 'english,detail');
  assert.equal(r.hasMore, true);
  const fallback = await filter({ language: 'en' }, { items: [{ id: 'fallback' }], hasMore: false });
  assert.equal(fallback.items.length, 1);
  const unknown = await setup('', '', { unknown: {} }, 'und').filter({}, { items: [{ id: 'unknown' }, { id: 'known', language: 'en' }], hasMore: false });
  assert.equal(unknown.items.map(i => i.id).join(','), 'unknown');
});
