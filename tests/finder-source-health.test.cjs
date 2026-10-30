const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
async function load() {
  const mod = new vm.SourceTextModule(fs.readFileSync('public/js/finder-source-health.js', 'utf8'));
  await mod.link(() => {}); await mod.evaluate();
  return mod.namespace.sourceHealth;
}
test('failed-source visibility is opt-in, persisted per account, and reversible', async () => {
  const sourceHealth = await load();
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const health = sourceHealth(storage, 1);
  health.fail('a', 'HTTP 500');
  health.fail('b', 'HTTP 418');
  assert.equal(health.allows('a'), true);
  health.setHide(true);
  assert.equal(health.allows('a'), false);
  assert.equal(health.allows('b'), false);
  assert.equal(health.allows('working'), true);
  assert.equal(sourceHealth(storage, 1).allows('a'), false);
  assert.equal(sourceHealth(storage, 2).allows('a'), true);
  health.setHide(false);
  assert.equal(health.allows('a'), true);
  health.setDisabled('a', true);
  assert.equal(health.allows('a'), false);
  health.clear('a');
  assert.equal(health.allows('a'), false);
  health.setDisabled('a', false);
  assert.equal(health.allows('a'), true);
  assert.equal(sourceHealth(storage, 1).failures.has('a'), false);
});
test('malformed or unavailable browser storage does not break source selection', async () => {
  const sourceHealth = await load();
  for (const storage of [undefined, { getItem: () => '{', setItem: () => { throw new Error('Quota'); } }]) {
    const health = sourceHealth(storage, 1);
    health.fail('a', 'HTTP 500'); health.setHide(true);
    assert.equal(health.allows('a'), false);
    health.clear('a');
    assert.equal(health.allows('a'), true);
  }
});
