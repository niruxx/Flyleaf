const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(tags, rating, details, language = '', signals = AbortSignal) {
  const source = fs.readFileSync('public/js/views/finder.js', 'utf8');
  const body = source.slice(source.indexOf('  async function filterPage('), source.indexOf("  const crumbs ="));
  const badges = fs.readFileSync('public/js/components/content-rating-badge.js', 'utf8');
  const contentRating = vm.runInNewContext('(' + badges.slice(badges.indexOf('export function contentRating(') + 7, badges.indexOf('export function contentRatingBadge')).trim() + ')');
  let calls = 0;
  const filter = vm.runInNewContext(body + '; filterPage', {
    AbortSignal: signals,
    tagFilter: tags, ratingFilter: rating, languageFilter: language,
    languageCodes: (value) => String(value || '').toLowerCase().replaceAll('_', '-').split(/[,;]+/).map(v => v.trim()).filter(Boolean), detailCache: new Map(), contentRating,
    api: { finderDetails: async (_, id, options) => { calls++; if (typeof details[id] === 'function') return details[id](options); if (details[id] instanceof Error) throw details[id]; return details[id]; } },
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
  const r = await filter({}, { items: [
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

test('known metadata streams matches without fetching book details', async () => {
  const { filter, calls } = setup('Space', 'safe', {}, 'en');
  const received = [];
  const r = await filter({ language: 'en' }, { items: [{ id: 'a', genres: ['Space'], ageRating: 0 }], hasMore: false }, { onItem: item => received.push(item.id) });
  assert.equal(calls(), 0);
  assert.equal(received.join(','), 'a');
  assert.equal(r.items.length, 1);
});

test('stalled metadata lookups time out once per page and preserve immediate matches', async () => {
  const signals = { any: AbortSignal.any, timeout: () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    return controller.signal;
  } };
  const details = {};
  for (let i = 0; i < 20; i++) details[i] = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
  });
  const { filter, calls } = setup('Space', '', details, '', signals);
  const received = [];
  const pending = filter({}, { items: [{ id: 'known', tags: ['Space'] }, ...Object.keys(details).map(id => ({ id }))], hasMore: true }, { onItem: item => received.push(item.id) });
  assert.equal(received.join(','), 'known');
  const r = await pending;
  assert.equal(r.items.length, 1);
  assert.equal(r.hasMore, true);
  assert.equal(r.filterIncomplete, true);
  assert.equal(calls(), 4);
});

test('cancelled filtering stops starting metadata requests', async () => {
  const { filter, calls } = setup('Space', '', {});
  const controller = new AbortController(); controller.abort();
  const r = await filter({}, { items: [{ id: 'a' }], hasMore: false }, { signal: controller.signal });
  assert.equal(calls(), 0);
  assert.equal(r.items.length, 0);
});
