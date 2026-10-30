const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('content badges distinguish mature, safe, and unrated metadata', async () => {
  const mod = new vm.SourceTextModule(fs.readFileSync('public/js/components/content-rating-badge.js', 'utf8'));
  await mod.link((name) => name.endsWith('i18n.js')
    ? new vm.SyntheticModule(['t'], function () { this.setExport('t', v => v); })
    : new vm.SyntheticModule(['h', 'icon'], function () {
      this.setExport('h', (...args) => args); this.setExport('icon', v => v);
    }));
  await mod.evaluate();
  const { contentRating, contentRatingBadge } = mod.namespace;
  for (const ageRating of [2, 3]) assert.equal(contentRating({ ageRating }), 'nsfw');
  for (const ageRating of [0, 1]) assert.equal(contentRating({ ageRating }), 'safe');
  assert.equal(contentRating({}), 'unknown');
  assert.equal(contentRating({ ageRating: null }), 'unknown');
  assert.equal(contentRating({}, { nsfw: false }), 'unknown');
  assert.equal(contentRating({}, { nsfw: true }), 'nsfw');
  assert.equal(contentRating({ nsfw: false }), 'safe');
  assert.equal(contentRating({ nsfw: false, ageRating: 3 }), 'nsfw');
  assert.equal(contentRating({ nsfw: true, ageRating: 0 }), 'nsfw');
  assert.equal(contentRatingBadge({ ageRating: 3 })[0], 'span.language-badge.content-rating-badge.nsfw');
});
