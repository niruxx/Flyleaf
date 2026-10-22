'use strict';

// Managing Mihon/Tachiyomi extensions on the Suwayomi-Server that the "mihon"
// plugin is connected to: extension repositories, and installing, updating and
// removing extensions. Searching and downloading go through the plugin itself.

const { q } = require('../db');
const { json } = require('../util');
const runtime = require('./runtime');
const manager = require('./manager');

const PLUGIN_ID = 'mihon';
const err = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

function connection() {
  const p = q('SELECT settings FROM plugins WHERE id = ?').get(PLUGIN_ID);
  if (!p) throw err('Install the “Mihon extensions” plugin first.', 404);
  const s = json(p.settings, {});
  const base = String(s.url || '').replace(/\/+$/, '');
  if (!base) throw err('Set the Suwayomi URL in the Mihon extensions plugin settings.');
  runtime.checkUrl(base);
  const headers = { 'User-Agent': runtime.USER_AGENT };
  if (s.username) headers.Authorization = `Basic ${Buffer.from(`${s.username}:${s.password || ''}`).toString('base64')}`;
  return { base, headers };
}

async function call(path, { method = 'GET', body, timeout = 30_000 } = {}) {
  const { base, headers } = connection();
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw err(`Can't reach Suwayomi at ${base}. Is it running?`, 502);
  }
  if (res.status === 401) throw err('Suwayomi rejected the login. Check the plugin’s username and password.', 502);
  const text = await res.text();
  if (!res.ok) throw err(`Suwayomi returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`, 502);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function graphql(query, variables) {
  const r = await call('/api/graphql', { method: 'POST', body: { query, variables } });
  if (r?.errors?.length) throw err(`Suwayomi: ${r.errors[0].message}`, 502);
  return r.data;
}

async function status() {
  const about = await call('/api/v1/settings/about');
  const native = await nativeStores();
  return { version: about?.version || null, url: connection().base, nativeStores: native };
}

// Mihon's newer repositories are "extension stores" with a compressed index.pb (Keiyoushi,
// Yūzōnō…). Suwayomi v2.3+ reads them itself. Older versions only accept GitHub
// index.min.json URLs (they reject anything else), so .pb stores need a newer Suwayomi.
let storesSupport = null; // { base, native, version, at }
async function nativeStores() {
  const { base } = connection();
  if (storesSupport && storesSupport.base === base && Date.now() - storesSupport.at < 600_000) return storesSupport.native;
  const about = await call('/api/v1/settings/about').catch(() => null);
  const version = about?.version || null;
  const [maj, min] = String(version || '').replace(/^v/i, '').split('.').map(Number);
  let native = maj > 2 || (maj === 2 && min >= 3);
  if (!native) {
    try {
      await graphql('{ extensionStores { nodes { indexUrl } } }');
      native = true;
    } catch {}
  }
  storesSupport = { base, native, version, at: Date.now() };
  return native;
}

const isPb = (u) => /\.pb(\?.*)?$/i.test(u);
const isGithubJson = (u) => /^https:\/\/(?:www\.|raw\.)?(?:github|githubusercontent)\.com\/[^/]+\/[^/]+/i.test(u) && !isPb(u);
// Suwayomi lists a JSON repository by its repo.json and may follow a repo to its index.pb, so
// compare repositories by their folder.
const repoBase = (u) => String(u).replace(/\/(?:index\.min\.json|repo\.json|index\.pb)(?:\?.*)?$/i, '').toLowerCase();
const sameRepo = (a, b) => repoBase(a) === repoBase(b);

async function repos() {
  if (await nativeStores()) {
    const data = await graphql('{ extensionStores { nodes { indexUrl } } }');
    return (data.extensionStores?.nodes || []).map((n) => n.indexUrl);
  }
  return (await graphql('{ settings { extensionRepos } }')).settings.extensionRepos || [];
}

// Repositories whose index.min.json is now only a stub ("Outdated App"): use their index.pb.
// (Suwayomi also follows the "index_v2" link in their repo.json, so this just saves a step.)
const MOVED_TO_PB = {
  'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json': 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb',
};

/** Accept what people paste: "mihon://extension-store?url=…" / "tachiyomi://add-repo?url=…" links from repo sites. */
function normalizeRepo(u) {
  let url = String(u || '').trim();
  const deep = url.match(/^[a-z]+:\/\/[a-z-]+\?(?:.*&)?url=([^&]+)/i);
  if (deep && !/^https?:/i.test(url)) url = decodeURIComponent(deep[1]);
  return url;
}

/** Is this a Mihon/Tachiyomi repository link (rather than a Flyleaf plugin repository)? */
const isMihonRepo = (u) => /^(?:mihon|tachiyomi|aniyomi):\/\//i.test(String(u).trim()) || isPb(u) || /\/index\.min\.json(?:\?.*)?$/i.test(String(u).trim());

async function setRepos(list) {
  if (Array.isArray(list)) list = [...new Set(list.map(normalizeRepo))];
  if (!Array.isArray(list) || list.some((u) => typeof u !== 'string' || !/^https?:\/\/\S+$/.test(u))) throw err('Repository URLs must start with http:// or https://');
  if (await nativeStores()) {
    list = list.map((u) => MOVED_TO_PB[u] || u);
    const current = await repos();
    for (const url of current.filter((u) => !list.some((x) => sameRepo(x, u)))) {
      await graphql('mutation ($url: String!) { removeExtensionStore(input: { indexUrl: $url }) { clientMutationId } }', { url });
    }
    for (const url of list.filter((u) => !current.some((x) => sameRepo(x, u)))) {
      await graphql('mutation ($url: String!) { addExtensionStore(input: { indexUrl: $url }) { clientMutationId } }', { url })
        .catch((e) => {
          throw err(`Suwayomi couldn’t read ${url}: ${e.message.replace(/^Suwayomi: /, '')}`, 502);
        });
    }
    return repos();
  }
  // Older Suwayomi: only GitHub index.min.json repositories.
  const version = storesSupport?.version || 'this version';
  const pb = list.find(isPb);
  if (pb) {
    throw err(`Suwayomi ${version} can’t use index.pb repositories like ${pb}. They need Suwayomi v2.3 or newer, which reads them itself. Update Suwayomi-Server (for Docker: docker pull ghcr.io/suwayomi/suwayomi-server:stable and recreate the container), then add it again.`);
  }
  const other = list.find((u) => !isGithubJson(u));
  if (other) throw err(`Suwayomi ${version} only accepts GitHub repositories (https://raw.githubusercontent.com/…/index.min.json). Update Suwayomi to v2.3 or newer to use ${other}.`);
  try {
    await graphql('mutation ($repos: [String!]!) { setSettings(input: { settings: { extensionRepos: $repos } }) { settings { extensionRepos } } }', { repos: list });
  } catch (e) {
    throw err(`Suwayomi rejected the repository list: ${e.message.replace(/^Suwayomi: /, '')}`, 502);
  }
  return repos();
}


/** All extensions from the configured repositories (refreshed from the repos each time). */
async function extensions() {
  const { base } = connection();
  const showNsfw = Boolean(json(q('SELECT settings FROM plugins WHERE id = ?').get(PLUGIN_ID)?.settings, {}).nsfw);
  const fields = 'pkgName name versionName lang isNsfw isInstalled hasUpdate isObsolete iconUrl repo';
  // fetchExtensions re-reads the repositories; the plain list is cached by Suwayomi.
  const data = await graphql(`mutation { fetchExtensions(input: {}) { extensions { ${fields} } } }`);
  return (data.fetchExtensions?.extensions || [])
    .filter((e) => showNsfw || !e.isNsfw || e.isInstalled)
    .map((e) => ({
      pkgName: e.pkgName,
      name: e.name?.replace(/^Tachiyomi:\s*/, '') || e.pkgName,
      version: e.versionName,
      lang: e.lang,
      nsfw: Boolean(e.isNsfw),
      installed: Boolean(e.isInstalled),
      hasUpdate: Boolean(e.hasUpdate),
      obsolete: Boolean(e.isObsolete),
      repo: e.repo || null,
      icon: e.iconUrl ? manager.proxied(PLUGIN_ID, new URL(e.iconUrl, `${base}/`).href) : null,
    }));
}

const PKG_RE = /^[A-Za-z0-9_.]{3,200}$/;

/** install | update | uninstall an extension by package name. */
async function extensionAction(action, pkgName) {
  if (!['install', 'update', 'uninstall'].includes(action)) throw err('Unknown action.');
  if (!PKG_RE.test(String(pkgName))) throw err('Invalid package name.');
  await call(`/api/v1/extension/${action}/${encodeURIComponent(pkgName)}`, { timeout: 180_000 });
  manager.refreshSources(PLUGIN_ID);
  return { ok: true };
}

const MAX_APK = 64 * 1024 * 1024;

async function installedExtensions() {
  const data = await graphql('{ extensions(condition: { isInstalled: true }) { nodes { pkgName name versionName versionCode } } }');
  return data.extensions?.nodes || [];
}

const cleanName = (e) => e.name?.replace(/^Tachiyomi:\s*/, '') || e.pkgName;
// Extension API versions Suwayomi accepts (its PackageTools LIB_VERSION_MIN/MAX), for explaining refusals.
const LIB_RANGE = [1.3, 1.6];

/**
 * Install an extension from an .apk file (e.g. an old Tachiyomi extension that's no longer in
 * any repository). A newer build of an installed extension updates it.
 * Returns { name, pkgName, version, updated, already }.
 */
async function installApk(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1024) throw err('That file is empty or not an APK.');
  if (buffer.length > MAX_APK) throw err('That file is too large to be an extension (64 MB at most).');
  let apk;
  try {
    apk = require('./apk').readApk(buffer);
  } catch {
    throw err('That isn’t an Android app (.apk), or it’s damaged. Choose a Tachiyomi or Mihon extension APK.');
  }
  if (apk.kind === 'anime') throw err('That’s an Aniyomi (anime) extension. Flyleaf and Suwayomi only use manga extensions.');
  if (!apk.kind) throw err(`${apk.pkgName} isn’t a Tachiyomi or Mihon extension.`);
  const label = `${apk.pkgName} ${apk.versionName || ''}`.trim();

  const { base, headers } = connection();
  // Suwayomi refuses the same or an older version of an installed extension (with a bare
  // HTTP 500), so answer that here.
  const current = (await installedExtensions().catch(() => [])).find((e) => e.pkgName === apk.pkgName);
  if (current && apk.versionCode <= (current.versionCode ?? Infinity)) {
    return { name: cleanName(current), pkgName: apk.pkgName, version: current.versionName, already: true, newer: apk.versionCode < current.versionCode };
  }

  const name = `${apk.pkgName}-v${apk.versionName || apk.versionCode}.apk`.replace(/[^\w.-]+/g, '_');
  const blob = () => new Blob([buffer], { type: 'application/vnd.android.package-archive' });
  let res;
  try {
    const form = new FormData();
    form.append('file', blob(), name);
    res = await fetch(`${base}/api/v1/extension/install`, { method: 'POST', headers, body: form, redirect: 'manual', signal: AbortSignal.timeout(180_000) });
    // Builds without the REST endpoint: the GraphQL upload (multipart request spec).
    if (res.status === 404 || res.status === 405) {
      const gql = new FormData();
      gql.append('operations', JSON.stringify({
        query: 'mutation ($file: Upload!) { installExternalExtension(input: { extensionFile: $file }) { extension { pkgName } } }',
        variables: { file: null },
      }));
      gql.append('map', JSON.stringify({ 0: ['variables.file'] }));
      gql.append('0', blob(), name);
      res = await fetch(`${base}/api/graphql`, { method: 'POST', headers, body: gql, signal: AbortSignal.timeout(180_000) });
      const body = await res.json().catch(() => null);
      if (body?.errors?.length) res = { status: 500, text: async () => body.errors[0].message };
    }
  } catch {
    throw err(`Can't reach Suwayomi at ${base}. Is it running?`, 502);
  }
  if (res.status === 401) throw err('Suwayomi rejected the login. Check the plugin’s username and password.', 502);
  if (res.status >= 400) {
    if (apk.lib && (apk.lib < LIB_RANGE[0] || apk.lib > LIB_RANGE[1])) {
      throw err(`${label} was built for extension API ${apk.lib}, and Suwayomi only runs ${LIB_RANGE[0]}–${LIB_RANGE[1]}. ${apk.lib < LIB_RANGE[0] ? 'It’s too old to load; look for a newer build of this extension.' : 'Update the extension runtime (or your Suwayomi) to use it.'}`, 422);
    }
    const detail = String(await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw err(`Suwayomi couldn’t install ${label}.${detail && detail !== 'Server Error' ? ` (${detail})` : ' Its log may say why.'}`, 502);
  }
  manager.refreshSources(PLUGIN_ID);
  const now = (await installedExtensions().catch(() => [])).find((e) => e.pkgName === apk.pkgName);
  return { name: now ? cleanName(now) : apk.pkgName, pkgName: apk.pkgName, version: now?.versionName || apk.versionName, updated: Boolean(current), already: false };
}

// ---------------------------------------------------------------------------
// Suggested repositories, from the community list at wotaku.wiki/ext/mihon.

const WOTAKU = 'https://wotaku.wiki/ext/mihon';
// Used when wotaku.wiki can't be reached, and for names/descriptions.
const KNOWN = {
  'keiyoushi/extensions': { name: 'Keiyoushi', description: 'The main community repository: 1,000+ sources in every language' },
  'suwayomi/tachiyomi-extension': { name: 'Suwayomi', description: 'Suwayomi’s own extensions' },
  'kareadita/tach-extension': { name: 'Kavita', description: 'Read from a Kavita server' },
  'littlesurvival/copymanga-copy20': { name: 'CopyManga', description: 'CopyManga (Chinese)' },
  'felipegfa/extensoes': { name: 'FelipeGFA', description: 'Portuguese (Brazil) sources' },
  'yuzono/cursed-manga-repo': { name: 'Yūzōnō (Cursed)', description: 'Adult sources: E-Hentai, nHentai, Hitomi and more', nsfw: true },
  'mojuru/cursed-manga-repo': { name: 'Cursed manga', description: 'Adult sources', nsfw: true },
};
const FALLBACK = [
  'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb',
  'https://raw.githubusercontent.com/Suwayomi/tachiyomi-extension/repo/index.min.json',
  'https://raw.githubusercontent.com/Kareadita/tach-extension/repo/index.min.json',
  'https://raw.githubusercontent.com/LittleSurvival/copymanga-copy20/repo/index.min.json',
  'https://raw.githubusercontent.com/FelipeGFA/extensoes/refs/heads/repo/index.pb',
  'https://raw.githubusercontent.com/mojuru/cursed-manga-repo/repo/index.pb',
  'https://github.com/yuzono/cursed-manga-repo/raw/repo/index.pb',
];
// Repository sites listed on wotaku.wiki aren't always the only place to find stores.
const EXTRA = ['https://github.com/yuzono/cursed-manga-repo/raw/repo/index.pb'];
let suggestedCache = null;

const repoKey = (url) => (url.match(/(?:githubusercontent|github)\.com\/([^/]+\/[^/]+)/i)?.[1] || url).toLowerCase();

/** Wotaku's Mihon repositories, each checked for an index.min.json Suwayomi can use. Cached for a day. */
async function suggestedRepos() {
  if (suggestedCache && Date.now() - suggestedCache.at < 86_400_000) return suggestedCache.list;
  let links = [];
  let live = false;
  try {
    const html = await (await fetch(WOTAKU, { headers: { 'User-Agent': runtime.USER_AGENT }, signal: AbortSignal.timeout(15_000) })).text();
    // Only Mihon/Tachiyomi manga repos; aniyomi:// (anime) repos aren't supported by Suwayomi.
    links = [...html.matchAll(/(?:mihon|tachiyomi):\/\/[a-z-]+\?url=(https:\/\/[^"'&<\s]+)/gi)].map((m) => m[1].replace(/&amp;$/, ''));
    live = links.length > 0;
  } catch {}
  if (!links.length) links = FALLBACK;
  links = [...links, ...EXTRA];
  const list = await Promise.all([...new Set(links.map(normalizeRepo))].map(async (link) => {
    const url = normalizeRepo(link);
    const known = KNOWN[repoKey(url)] || {};
    let ok = false;
    try {
      const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': runtime.USER_AGENT }, signal: AbortSignal.timeout(10_000) });
      ok = r.ok;
    } catch {}
    return {
      url,
      name: known.name || repoKey(url).split('/')[0],
      description: known.description || null,
      nsfw: Boolean(known.nsfw),
      // index.pb stores need Suwayomi v2.3+ (the dialog says so on older versions).
      supported: ok,
      format: isPb(url) ? 'pb' : 'json',
    };
  }));
  const order = Object.keys(KNOWN);
  const rank = (x) => (order.indexOf(repoKey(x.url)) + 1) || order.length + 1;
  list.sort((a, b) => Number(b.supported) - Number(a.supported) || Number(a.nsfw) - Number(b.nsfw) || rank(a) - rank(b));
  const result = { source: live ? WOTAKU : null, list };
  suggestedCache = { at: Date.now(), list: result };
  return result;
}

module.exports = { PLUGIN_ID, status, repos, setRepos, extensions, extensionAction, installApk, suggestedRepos, normalizeRepo, nativeStores, isMihonRepo, sameRepo };
