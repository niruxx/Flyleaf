'use strict';

// Fixed provider endpoints: account tokens never leave the server.
const DEFINITIONS = {
  anilist: { name: 'AniList', authorize: 'https://anilist.co/api/v2/oauth/authorize', token: 'https://anilist.co/api/v2/oauth/token' },
  mangaupdates: { name: 'MangaUpdates', login: true },
  kitsu: { name: 'Kitsu', login: true, token: 'https://kitsu.io/api/oauth/token' },
  mal: { name: 'MyAnimeList', authorize: 'https://myanimelist.net/v1/oauth2/authorize', token: 'https://myanimelist.net/v1/oauth2/token' },
};

function credentials(provider) {
  const prefix = provider === 'anilist' ? 'ANILIST' : 'MAL';
  return { client_id: process.env[`${prefix}_CLIENT_ID`], client_secret: process.env[`${prefix}_CLIENT_SECRET`] };
}
function callback(provider) {
  const base = new URL(process.env.TRACKING_BASE_URL);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new Error('TRACKING_BASE_URL must use HTTPS (or localhost).');
  }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('TRACKING_BASE_URL must be an origin without a path.');
  return `${base.origin}/api/tracking/${provider}/callback`;
}
function configured(provider) {
  if (DEFINITIONS[provider]?.login) return true;
  try { return Boolean(DEFINITIONS[provider] && credentials(provider).client_id && (provider === 'mal' || credentials(provider).client_secret) && callback(provider)); }
  catch { return false; }
}
function authorizationUrl(provider, state, verifier) {
  const url = new URL(DEFINITIONS[provider].authorize);
  url.search = new URLSearchParams({ client_id: credentials(provider).client_id, redirect_uri: callback(provider), response_type: 'code', state,
    ...(provider === 'mal' ? { code_challenge: verifier, code_challenge_method: 'plain' } : {}) });
  return url.href;
}

class TrackerError extends Error {
  constructor(status, retryAfter = 0) {
    super(status === 401 || status === 403 ? 'Connection expired. Reconnect this tracking account.' : `Tracking service request failed (HTTP ${status}).`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
async function request(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!res.ok) {
    const raw = res.headers.get('retry-after');
    const delay = /^\d+$/.test(raw || '') ? Number(raw) * 1000 : Math.max(0, Date.parse(raw) - Date.now()) || 0;
    throw new TrackerError(res.status, Math.min(delay, 86400_000));
  }
  const body = await res.text();
  if (!body.trim()) return {};
  let result;
  try { result = JSON.parse(body); } catch { throw new TrackerError(502); }
  if (['error', 'failure'].includes(result.status)) throw new TrackerError(502);
  return result;
}
async function exchange(provider, grant) {
  const params = { ...(provider === 'kitsu' ? {} : credentials(provider)), ...grant };
  if (!params.client_secret) delete params.client_secret;
  const json = provider !== 'mal';
  const result = await request(DEFINITIONS[provider].token, { method: 'POST',
    headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: json ? JSON.stringify(params) : new URLSearchParams(params).toString() });
  if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 20000) throw new Error('Tracking service returned an invalid token.');
  return { accessToken: result.access_token, refreshToken: typeof result.refresh_token === 'string' ? result.refresh_token : null,
    expiresAt: Number(result.expires_in) > 0 ? Date.now() + Number(result.expires_in) * 1000 : null };
}
const redeem = (provider, code, verifier) => exchange(provider, { grant_type: 'authorization_code', code, redirect_uri: callback(provider), ...(provider === 'mal' ? { code_verifier: verifier } : {}) });
const refresh = (provider, token) => exchange(provider, { grant_type: 'refresh_token', refresh_token: token });

async function graphql(token, query, variables = {}) {
  const data = await request('https://graphql.anilist.co', { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (data.errors?.length) throw new TrackerError(Number(data.errors[0].status) || 502);
  if (!data.data) throw new TrackerError(502);
  return data.data;
}
async function login(provider, username, password) {
  if (provider === 'kitsu') return exchange(provider, { grant_type: 'password', username, password });
  const response = await request('https://api.mangaupdates.com/v1/account/login', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (typeof response.context?.session_token !== 'string' || !response.context.session_token) throw new TrackerError(401);
  return { accessToken: response.context.session_token, refreshToken: null, expiresAt: null };
}
const bearer = (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json' });
const kitsuHeaders = (token) => ({ ...bearer(token), Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' });
async function identity(provider, token) {
  if (provider === 'mangaupdates') {
    const user = await request('https://api.mangaupdates.com/v1/account/profile', { headers: bearer(token) });
    if (!user.user_id || !user.username) throw new TrackerError(502);
    return { id: String(user.user_id), name: user.username };
  }
  if (provider === 'kitsu') {
    const result = await request('https://kitsu.io/api/edge/users?filter[self]=true', { headers: kitsuHeaders(token) });
    const user = result.data?.[0];
    if (!user?.id || !user.attributes?.name) throw new TrackerError(502);
    return { id: String(user.id), name: user.attributes.name };
  }
  const user = provider === 'anilist' ? (await graphql(token, 'query { Viewer { id name } }')).Viewer
    : await request('https://api.myanimelist.net/v2/users/@me', { headers: { Authorization: `Bearer ${token}` } });
  if (!user?.id || typeof user.name !== 'string') throw new Error('Tracking service returned an invalid account.');
  return { id: String(user.id), name: user.name };
}
function mediaId(series, provider) {
  let ids;
  try { ids = JSON.parse(series.provider_ids || '{}'); } catch { return null; }
  let value = String(ids[provider] || '');
  if (!value) {
    let links;
    try { links = JSON.parse(series.links || '[]'); } catch { links = []; }
    const patterns = { kitsu: /^https:\/\/(?:kitsu\.io|kitsu\.app)\/manga\/(\d+)(?:[/?#]|$)/,
      anilist: /^https:\/\/anilist\.co\/manga\/(\d+)(?:[/?#]|$)/,
      mal: /^https:\/\/myanimelist\.net\/manga\/(\d+)(?:[/?#]|$)/ };
    for (const link of links) { const match = patterns[provider]?.exec(link.url || ''); if (match) { value = match[1]; break; } }
  }
  return /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}
async function readEntry(provider, account, id) {
  if (provider === 'mangaupdates') {
    const headers = bearer(account.access_token);
    const media = await request(`https://api.mangaupdates.com/v1/series/${id}`, { headers });
    let entry = null;
    try { entry = await request(`https://api.mangaupdates.com/v1/lists/series/${id}`, { headers }); } catch (e) { if (e.status !== 404) throw e; }
    let rating = 0;
    try { rating = (await request(`https://api.mangaupdates.com/v1/series/${id}/rating`, { headers })).rating || 0; } catch (e) { if (e.status !== 404) throw e; }
    return { chapters: media.completed ? media.latest_chapter || 0 : 0, volumes: 0,
      progress: entry?.status?.chapter || 0, progressVolumes: entry?.status?.volume || 0, status: entry?.list_type || null,
      score: rating, exists: Boolean(entry) };
  }
  if (provider === 'kitsu') {
    const headers = kitsuHeaders(account.access_token);
    const media = (await request(`https://kitsu.io/api/edge/manga/${id}`, { headers })).data;
    if (!media) throw new TrackerError(404);
    const params = new URLSearchParams({ 'filter[userId]': account.remote_id, 'filter[mangaId]': String(id) });
    const entry = (await request(`https://kitsu.io/api/edge/library-entries?${params}`, { headers })).data?.[0];
    return { chapters: media.attributes?.chapterCount || 0, volumes: 0, progress: entry?.attributes?.progress || 0,
      progressVolumes: 0, status: entry?.attributes?.status || null, score: (entry?.attributes?.ratingTwenty || 0) / 2,
      entryId: entry?.id || null };
  }
  if (provider === 'anilist') {
    const { Media } = await graphql(account.access_token,
      `query($id:Int!) { Media(id:$id,type:MANGA) { chapters volumes mediaListEntry { status progress progressVolumes score(format:POINT_10_DECIMAL) } } }`, { id });
    if (!Media) throw new TrackerError(404);
    const entry = Media.mediaListEntry;
    return { chapters: Media.chapters || 0, volumes: Media.volumes || 0,
      progress: entry?.progress || 0, progressVolumes: entry?.progressVolumes || 0, status: entry?.status || null, score: entry?.score || 0 };
  }
  const media = await request(`https://api.myanimelist.net/v2/manga/${id}?fields=num_chapters,num_volumes,my_list_status`, { headers: { Authorization: `Bearer ${account.access_token}` } });
  const entry = media.my_list_status;
  return { chapters: media.num_chapters || 0, volumes: media.num_volumes || 0,
    progress: entry?.num_chapters_read || 0, progressVolumes: entry?.num_volumes_read || 0, status: entry?.status || null, score: entry?.score || 0 };
}
function localProgress(books) {
  let chapters = 0, volumes = 0;
  for (const b of books) {
    if (!b.finished || b.special || b.missing) continue;
    if (b.chapter != null && Number.isFinite(Number(b.chapter))) chapters = Math.max(chapters, Math.floor(Number(b.chapter)));
    // A single chapter inside a volume does not mean that volume is finished.
    else if (b.volume != null && Number.isFinite(Number(b.volume))) volumes = Math.max(volumes, Math.floor(Number(b.volume)));
  }
  return { chapters, volumes };
}
function progressUpdate(provider, local, remote) {
  const clamp = (local, previous, total) => Math.max(previous || 0, total > 0 ? Math.min(local, total) : local);
  const progress = clamp(local.chapters, remote.progress, remote.chapters);
  const progressVolumes = clamp(local.volumes, remote.progressVolumes, remote.volumes);
  // Completion is based on the tracker total, never the number of locally owned files.
  const complete = (remote.chapters > 0 && progress >= remote.chapters) || (remote.volumes > 0 && progressVolumes >= remote.volumes);
  const completed = provider === 'anilist' ? 'COMPLETED' : provider === 'mangaupdates' ? 'complete' : 'completed';
  const reading = provider === 'anilist' ? 'CURRENT' : provider === 'mangaupdates' ? 'read' : provider === 'kitsu' ? 'current' : 'reading';
  return { progress, progressVolumes, status: remote.status === completed || complete ? completed : reading };
}
async function writeEntry(provider, account, id, update, remote = {}) {
  if (provider === 'mangaupdates') {
    const headers = { ...bearer(account.access_token), 'Content-Type': 'application/json' };
    const lists = await request('https://api.mangaupdates.com/v1/lists', { headers });
    const list = lists.find((list) => list.type === update.status && !list.custom);
    if (!list) throw new Error('The tracking account has no matching reading list.');
    await request(`https://api.mangaupdates.com/v1/lists/series${remote.exists ? '/update' : ''}`, { method: 'POST', headers,
      body: JSON.stringify([{ series: { id }, list_id: list.list_id, status: { chapter: update.progress, volume: update.progressVolumes } }]) });
    return;
  }
  if (provider === 'kitsu') {
    const entry = { type: 'libraryEntries', attributes: { status: update.status, progress: update.progress },
      ...(remote.entryId ? { id: String(remote.entryId) } : { relationships: {
        user: { data: { type: 'users', id: account.remote_id } }, manga: { data: { type: 'manga', id: String(id) } } } }) };
    await request(`https://kitsu.io/api/edge/library-entries${remote.entryId ? '/' + encodeURIComponent(remote.entryId) : ''}`, {
      method: remote.entryId ? 'PATCH' : 'POST', headers: kitsuHeaders(account.access_token), body: JSON.stringify({ data: entry }) });
    return;
  }
  if (provider === 'anilist') {
    await graphql(account.access_token, `mutation($id:Int!,$progress:Int!,$volumes:Int!,$status:MediaListStatus!) {
      SaveMediaListEntry(mediaId:$id,progress:$progress,progressVolumes:$volumes,status:$status) { id }
    }`, { id, progress: update.progress, volumes: update.progressVolumes, status: update.status });
  } else {
    await request(`https://api.myanimelist.net/v2/manga/${id}/my_list_status`, { method: 'PUT',
      headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ num_chapters_read: update.progress, num_volumes_read: update.progressVolumes, status: update.status }).toString() });
  }
}
function importedStatus(provider, status) {
  const map = provider === 'mangaupdates' ? { read: 'reading', complete: 'completed', wish: 'plan', hold: 'on_hold', unfinished: 'dropped' }
    : provider === 'kitsu' ? { current: 'reading', completed: 'completed', planned: 'plan', on_hold: 'on_hold', dropped: 'dropped' }
    : provider === 'anilist'
    ? { CURRENT: 'reading', REPEATING: 'reading', COMPLETED: 'completed', PLANNING: 'plan', PAUSED: 'on_hold', DROPPED: 'dropped' }
    : { reading: 'reading', completed: 'completed', plan_to_read: 'plan', on_hold: 'on_hold', dropped: 'dropped' };
  return map[status] || null;
}
module.exports = { DEFINITIONS, configured, callback, authorizationUrl, redeem, refresh, login, identity, mediaId, readEntry, writeEntry,
  localProgress, progressUpdate, importedStatus, TrackerError };
