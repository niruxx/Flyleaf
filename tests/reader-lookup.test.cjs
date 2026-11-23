const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function setup(key, response) {
  const filename = path.resolve('server/routes/lookup.js');
  const module = { exports: {} };
  const calls = [];
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, require: createRequire(filename), AbortSignal, URL,
    process: { env: { DEEPL_AUTH_KEY: key } },
    fetch: async (url, options) => { calls.push({ url, options }); return response; },
  }, { filename });
  const translate = (body) => new Promise((resolve, reject) => {
    const req = { method: 'POST', url: '/lookup/translate', body };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { resolve({ code: this.code, data }); } };
    module.exports.router.handle(req, res, reject);
  });
  return { calls, translate };
}

test('DeepL Free accepts an automatically detected source and keeps the key on the server', async () => {
  const { calls, translate } = setup('example:fx', Response.json({ translations: [{ detected_source_language: 'DE', text: 'Good morning' }] }));
  const result = await translate({ q: 'Guten Morgen', to: 'en' });
  assert.equal(result.code, 200);
  assert.equal(result.data.text, 'Good morning');
  assert.equal(result.data.from, 'de');
  assert.equal(result.data.provider, 'DeepL');
  assert.equal(calls[0].url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(calls[0].options.headers.Authorization, 'DeepL-Auth-Key example:fx');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { text: ['Guten Morgen'], target_lang: 'EN-US' });
});

test('DeepL Pro reports quota errors without resending the selection', async () => {
  const { calls, translate } = setup('example-pro', new Response(null, { status: 456 }));
  const result = await translate({ q: 'Good morning', from: 'en', to: 'pt' });
  assert.equal(result.code, 503);
  assert.match(result.data.error, /quota/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepl.com/v2/translate');
  assert.deepEqual(JSON.parse(calls[0].options.body), { text: ['Good morning'], source_lang: 'EN', target_lang: 'PT-PT' });
});
