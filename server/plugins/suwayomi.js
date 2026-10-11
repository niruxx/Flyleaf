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
  return { version: about?.version || null, url: connection().base };
}

async function repos() {
  return (await graphql('{ settings { extensionRepos } }')).settings.extensionRepos || [];
}

async function setRepos(list) {
  if (!Array.isArray(list) || list.some((u) => typeof u !== 'string' || !/^https?:\/\/\S+$/.test(u))) throw err('Repository URLs must start with http:// or https://');
  const data = await graphql('mutation ($repos: [String!]!) { setSettings(input: { settings: { extensionRepos: $repos } }) { settings { extensionRepos } } }', { repos: [...new Set(list)] });
  return data.setSettings.settings.extensionRepos;
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

module.exports = { PLUGIN_ID, status, repos, setRepos, extensions, extensionAction };
