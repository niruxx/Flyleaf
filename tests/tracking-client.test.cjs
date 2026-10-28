const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const uri = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');

test('account controls call the tracking API with the correct methods and CSRF header', async (t) => {
  const calls = [];
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async (url, options) => { calls.push({ url, ...options }); return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); };
  const source = fs.readFileSync('public/js/api.js', 'utf8').replace("'./i18n.js'", JSON.stringify(uri('export const t = (text) => text;')));
  const { api } = await import(uri(source));
  await api.trackingAccounts();
  await api.connectTracking('anilist');
  await api.loginTracking('kitsu', { username: 'reader', password: 'not-a-real-password' });
  await api.updateTracking('mal', { pullEnabled: true });
  await api.pullTracking('mangaupdates');
  await api.disconnectTracking('anilist');
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ['GET', '/api/tracking'], ['POST', '/api/tracking/anilist/connect'], ['POST', '/api/tracking/kitsu/login'],
    ['PATCH', '/api/tracking/mal'], ['POST', '/api/tracking/mangaupdates/pull'], ['DELETE', '/api/tracking/anilist'],
  ]);
  assert.ok(calls.every((c) => c.headers['X-Flyleaf'] === '1' && c.credentials === 'same-origin'));
  assert.equal(JSON.parse(calls[3].body).pullEnabled, true);
});
