const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('language metadata handles codes, lists, missing values and invalid tags', async () => {
  const mod = new vm.SourceTextModule(fs.readFileSync('public/js/languages.js', 'utf8'));
  await mod.link(() => new vm.SyntheticModule(['currentLanguage', 't'], function () {
    this.setExport('currentLanguage', () => 'en');
    this.setExport('t', (value) => value);
  }));
  await mod.evaluate();
  const { languageCodes, languageName } = mod.namespace;
  assert.deepEqual(Array.from(languageCodes(['EN; es', 'en', 'pt_BR'])), ['en', 'es', 'pt-br']);
  assert.equal(languageName('en'), 'English');
  assert.equal(languageName(['es', 'fr']), 'Spanish, French');
  assert.equal(languageName(null), '');
  assert.equal(languageName('all'), 'Multiple languages');
  assert.equal(languageName('not a code'), 'not a code');
});
