const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.resolve(dir, e.name)] : []);

test('all frontend modules parse and their static imports resolve', async () => {
  assert.equal(typeof vm.SourceTextModule, 'function', 'Run with node --experimental-vm-modules tests/frontend-modules.test.cjs');
  const files = walk('public/js');
  const cache = new Map();
  const load = (file) => {
    if (!cache.has(file)) cache.set(file, new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: file }));
    return cache.get(file);
  };
  const root = new vm.SourceTextModule(files.map((file, i) => `import * as module${i} from ${JSON.stringify(file)};`).join('\n'));
  await root.link((specifier, ref) => load(path.isAbsolute(specifier) ? specifier : path.resolve(path.dirname(ref.identifier), specifier)));
  assert.equal(root.status, 'linked');
  assert.equal(cache.size, files.length);
});
