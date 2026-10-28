const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
function setup() {
  const calls = [];
  const tracking = {
    accounts: (uid) => [{ userId: uid }], begin: (uid, provider) => { calls.push(['begin', uid, provider]); return 'https://example.test/auth'; },
    finish: async (...args) => calls.push(['finish', ...args]), login: async (...args) => calls.push(['login', ...args]),
    disconnect: (...args) => calls.push(['disconnect', ...args]), setPull: (...args) => calls.push(['setPull', ...args]),
    pull: (...args) => { calls.push(['pull', ...args]); return 2; },
  };
  const m = { exports: {} };
  vm.runInNewContext(fs.readFileSync('server/routes/tracking.js', 'utf8'), { module: m, exports: m.exports,
    require: (name) => name === '../tracking' ? tracking : name === '../tracking-providers' ? require('../server/tracking-providers') : require(name), Date, Map });
  const router = m.exports.router;
  const request = (method, url, values = {}) => new Promise((resolve, reject) => {
    const req = { method, url, originalUrl: url, headers: {}, user: { id: 7 }, body: {}, query: {}, hostname: 'localhost', ...values };
    const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, set(key, value) { this.headers[key] = value; return this; },
      json(body) { resolve({ status: this.statusCode, body, headers: this.headers }); }, redirect(url) { resolve({ status: 302, url, headers: this.headers }); } };
    router.handle(req, res, (err) => err ? reject(err) : resolve({ status: 404 }));
  });
  return { calls, request };
}

test('tracking routes scope account operations to the signed-in user and reject API keys', async () => {
  const { request, calls } = setup();
  assert.equal((await request('GET', '/')).body[0].userId, 7);
  assert.equal((await request('GET', '/', { user: { id: 7, apiKey: { scope: 'full' } } })).status, 403);
  await request('DELETE', '/anilist', { body: { userId: 99 } });
  assert.deepEqual(calls[0], ['disconnect', 7, 'anilist']);
  assert.equal((await request('POST', '/__proto__/connect')).status, 404);
  assert.equal((await request('PATCH', '/anilist', { body: { pullEnabled: 'true' } })).status, 400);
});

test('password connections require HTTPS outside localhost and use only supported providers', async () => {
  const { request, calls } = setup();
  const body = { username: 'reader', password: 'pass' };
  assert.equal((await request('POST', '/kitsu/login', { body, hostname: 'reader.example', secure: false })).status, 400);
  assert.equal((await request('POST', '/anilist/login', { body })).status, 400);
  assert.equal((await request('POST', '/kitsu/login', { body, hostname: 'reader.example', secure: true })).status, 200);
  assert.deepEqual(calls[0], ['login', 7, 'kitsu', 'reader', 'pass']);
});

test('callback passes state to validation and redirects without exposing the authorization code', async () => {
  const { request, calls } = setup();
  const response = await request('GET', '/mal/callback', { query: { state: 'state-value', code: 'private-code' } });
  assert.equal(response.status, 302);
  assert.equal(response.headers['Referrer-Policy'], 'no-referrer');
  assert.ok(!response.url.includes('private-code'));
  assert.deepEqual(calls[0], ['finish', 7, 'mal', 'state-value', 'private-code', false]);
});
