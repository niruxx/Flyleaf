const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../server/tracking-providers');

function mock(t, fixtures) {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(fixtures.length, 'Unexpected request: ' + url);
    const response = fixtures.shift();
    return new Response(response.body === undefined ? JSON.stringify(response.data) : response.body, { status: response.status || 200, headers: response.headers });
  };
  return calls;
}
const account = { access_token: 'secret', remote_id: '55' };

test('AniList uses normalized scores and writes chapter/volume progress without changing scores', async (t) => {
  const calls = mock(t, [
    { data: { data: { Media: { chapters: 10, volumes: 2, mediaListEntry: { status: 'CURRENT', progress: 4, progressVolumes: 1, score: 8.5 } } } } },
    { data: { data: { SaveMediaListEntry: { id: 1 } } } },
  ]);
  const entry = await p.readEntry('anilist', account, 123);
  assert.equal(entry.score, 8.5);
  assert.match(JSON.parse(calls[0].body).query, /score\(format:POINT_10_DECIMAL\)/);
  await p.writeEntry('anilist', account, 123, { progress: 10, progressVolumes: 2, status: 'COMPLETED' });
  const mutation = JSON.parse(calls[1].body);
  assert.deepEqual(mutation.variables, { id: 123, progress: 10, volumes: 2, status: 'COMPLETED' });
  assert.doesNotMatch(mutation.query, /score/);
});

test('MAL sends a form update and exchanges authorization with PKCE', async (t) => {
  const previous = { id: process.env.MAL_CLIENT_ID, secret: process.env.MAL_CLIENT_SECRET, base: process.env.TRACKING_BASE_URL };
  process.env.MAL_CLIENT_ID = 'id'; process.env.MAL_CLIENT_SECRET = 'client-secret'; process.env.TRACKING_BASE_URL = 'https://reader.example';
  t.after(() => { for (const [key, value] of [['MAL_CLIENT_ID', previous.id], ['MAL_CLIENT_SECRET', previous.secret], ['TRACKING_BASE_URL', previous.base]]) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const calls = mock(t, [{ data: { access_token: 'token', refresh_token: 'refresh', expires_in: 3600 } }, { data: { status: 'completed' } }]);
  const url = new URL(p.authorizationUrl('mal', 'state', 'verifier'));
  assert.equal(url.searchParams.get('code_challenge'), 'verifier');
  assert.equal(url.searchParams.get('code_challenge_method'), 'plain');
  await p.redeem('mal', 'code', 'verifier');
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get('code_verifier'), 'verifier');
  assert.equal(form.get('redirect_uri'), 'https://reader.example/api/tracking/mal/callback');
  await p.writeEntry('mal', account, 22, { progress: 12, progressVolumes: 3, status: 'completed' });
  assert.equal(calls[1].method, 'PUT');
  assert.equal(new URLSearchParams(calls[1].body).get('num_chapters_read'), '12');
});

test('MangaUpdates exchanges a password for a session token and uses typed account lists', async (t) => {
  const calls = mock(t, [
    { data: { status: 'success', context: { session_token: 'session-secret' } } },
    { data: { user_id: 50, username: 'MU reader' } },
    { data: [{ list_id: 13, type: 'read', custom: false }, { list_id: 44, type: 'complete', custom: false }] },
    { body: '' },
  ]);
  const tokens = await p.login('mangaupdates', 'name', 'password');
  assert.equal(tokens.accessToken, 'session-secret');
  assert.equal(calls[0].method, 'PUT');
  assert.deepEqual(await p.identity('mangaupdates', tokens.accessToken), { id: '50', name: 'MU reader' });
  await p.writeEntry('mangaupdates', account, 303000000000, { progress: 10, progressVolumes: 2, status: 'complete' }, { exists: true });
  assert.match(calls[3].url, /\/lists\/series\/update$/);
  assert.deepEqual(JSON.parse(calls[3].body), [{ series: { id: 303000000000 }, list_id: 44, status: { chapter: 10, volume: 2 } }]);
});

test('Kitsu uses JSON:API and leaves volumes-owned untouched', async (t) => {
  const calls = mock(t, [
    { data: { access_token: 'token', expires_in: 3600, refresh_token: 'refresh' } },
    { data: { data: { attributes: { chapterCount: 10 } } } },
    { data: { data: [{ id: '77', attributes: { status: 'current', progress: 2, ratingTwenty: 17, volumesOwned: 4 } }] } },
    { data: { data: { id: '77' } } },
  ]);
  await p.login('kitsu', 'name', 'password');
  assert.equal(JSON.parse(calls[0].body).grant_type, 'password');
  const entry = await p.readEntry('kitsu', account, 12);
  assert.equal(entry.score, 8.5);
  const filter = new URL(calls[2].url).searchParams;
  assert.equal(filter.get('filter[userId]'), '55');
  assert.equal(filter.get('filter[mangaId]'), '12');
  await p.writeEntry('kitsu', account, 12, { progress: 10, progressVolumes: 3, status: 'completed' }, entry);
  assert.equal(calls[3].method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[3].body).data.attributes, { status: 'completed', progress: 10 });
});

test('numeric IDs and linked Kitsu records are validated without title guessing', () => {
  assert.equal(p.mediaId({ provider_ids: '{}', links: JSON.stringify([{ url: 'https://kitsu.app/manga/12' }]) }, 'kitsu'), 12);
  assert.equal(p.mediaId({ provider_ids: '{"mal":"12/path"}' }, 'mal'), null);
  assert.equal(p.mediaId({ provider_ids: '{"mangaupdates":"9007199254740992"}' }, 'mangaupdates'), null);
});

test('rate limits retain retry timing without exposing upstream error bodies', async (t) => {
  mock(t, [{ status: 429, headers: { 'Retry-After': '120' }, body: 'sensitive provider response' }]);
  await assert.rejects(p.identity('mal', 'token'), (err) => err.status === 429 && err.retryAfter === 120000 && !err.message.includes('sensitive'));
});
