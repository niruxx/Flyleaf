const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('extension data is optional and survives backup and restore', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flyleaf-backup-test-'));
  const filename = path.resolve('server/backup.js');
  const realRequire = createRequire(filename);
  const { DatabaseSync } = require('node:sqlite');
  let live = new DatabaseSync(path.join(dir, 'flyleaf.db'));
  live.exec('CREATE TABLE users (id INTEGER); INSERT INTO users VALUES (1)');
  const events = [];
  const db = {
    get db() { return live; }, SCHEMA_VERSION: 1,
    q: () => ({ all: () => [] }),
    reopen: (replace) => { live.close(); replace(path.join(dir, 'flyleaf.db')); live = new DatabaseSync(path.join(dir, 'flyleaf.db')); },
  };
  const mocks = {
    './config': { dataDir: dir }, './db': db,
    './log': { logger: () => ({ info() {}, warn() {} }) },
    './plugins/suwayomi-host': { status: () => ({ phase: 'running' }), stop: async () => events.push('stop'), start: async () => events.push('start') },
    './settings': { clearCache() {} }, './plugins/manager': {}, './scanner': { requestScan() {} },
  };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => mocks[name] || realRequire(name), module: mod, Buffer, Date, setInterval,
  }, { filename });
  const backup = mod.exports;
  const source = path.join(dir, 'suwayomi', 'data', 'extensions', 'source.apk');
  try {
    await fsp.mkdir(path.dirname(source), { recursive: true });
    await fsp.writeFile(source, 'original extension');
    const plain = path.join(dir, 'plain.zip');
    await backup.create(fs.createWriteStream(plain));
    assert.equal((await backup.inspect(plain)).includesExtensions, false);
    assert.deepEqual(events, []);
    const full = path.join(dir, 'full.zip');
    await backup.create(fs.createWriteStream(full), { includeExtensions: true });
    assert.equal((await backup.inspect(full)).includesExtensions, true);
    assert.deepEqual(events, ['stop', 'start']);
    await fsp.writeFile(source, 'changed extension');
    await backup.restore(full);
    assert.equal(await fsp.readFile(source, 'utf8'), 'changed extension');
    await backup.restore(full, { includeExtensions: true });
    assert.equal(await fsp.readFile(source, 'utf8'), 'original extension');
    assert.deepEqual(events, ['stop', 'start', 'stop', 'start']);
  } finally {
    live.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
