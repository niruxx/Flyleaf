'use strict';

// Installing, updating and running Content Finder plugins.
//
// Plugins come from the built-in repository (./plugins in the app folder), from
// third-party repositories (an index.json listing plugins, like Mihon/Tachiyomi
// extension repos), from a direct .lua URL, or from an uploaded file.

const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const { q } = require('../db');
const { json } = require('../util');
const runtime = require('./runtime');
const log = require('../log').logger('plugins');

const BUILTIN_DIR = path.join(config.root, 'plugins');
const BUILTIN_REPO = 'builtin';
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const KINDS = ['books', 'manga', 'comics'];
const MAX_SOURCE = 512 * 1024;

const err = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

/** Compare dotted versions numerically ("1.10.0" > "1.9.2"). */
function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** Validate a plugin's source; returns its normalised manifest. */
async function validate(source) {
  if (typeof source !== 'string' || !source.trim()) throw err('The plugin file is empty.');
  if (source.length > MAX_SOURCE) throw err('Plugins can be at most 512 KB.');
  const { manifest: m, functions } = await runtime.inspect(source);
  if (!m || typeof m !== 'object') throw err('The file must define a global `plugin = { id = …, name = …, version = … }` table.');
  if (!ID_RE.test(String(m.id || ''))) throw err('plugin.id must be 2–64 lowercase letters, digits, dots, dashes or underscores.');
  if (!m.name || !m.version) throw err('plugin.name and plugin.version are required.');
  for (const fn of ['search', 'details', 'download']) if (!functions[fn]) throw err(`The plugin must define a ${fn}() function.`);
  const kinds = (Array.isArray(m.kinds) ? m.kinds : [m.kinds]).filter((k) => KINDS.includes(k));
  const settings = (Array.isArray(m.settings) ? m.settings : [])
    .filter((s) => s && /^[A-Za-z_][\w]{0,40}$/.test(String(s.key || '')))
    .map((s) => ({
      key: String(s.key),
      label: String(s.label || s.key).slice(0, 80),
      type: ['text', 'password', 'number', 'toggle', 'select'].includes(s.type) ? s.type : 'text',
      help: s.help ? String(s.help).slice(0, 300) : null,
      required: Boolean(s.required),
      default: s.default ?? null,
      options: Array.isArray(s.options) ? s.options.map(String).slice(0, 50) : null,
    }));
  return {
    id: String(m.id),
    name: String(m.name).slice(0, 80),
    version: String(m.version).slice(0, 20),
    author: m.author ? String(m.author).slice(0, 80) : null,
    description: m.description ? String(m.description).slice(0, 500) : null,
    site: /^https?:\/\//.test(m.site || '') ? String(m.site) : null,
    icon: /^https?:\/\//.test(m.icon || '') ? String(m.icon) : null,
    kinds: kinds.length ? kinds : ['books'],
    language: m.language ? String(m.language).slice(0, 10) : null,
    nsfw: Boolean(m.nsfw),
    // Serve this plugin's images through Flyleaf (for servers the browser can't reach or that need a login).
    proxyImages: Boolean(m.proxy_images) || functions.image,
    settings,
    functions,
  };
}

// ---------------------------------------------------------------------------
// Repositories

async function fetchText(url, limit = MAX_SOURCE) {
  runtime.checkUrl(url);
  const res = await fetch(url, { headers: { 'User-Agent': runtime.USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw err(`${url} returned HTTP ${res.status}`, 502);
  const text = await res.text();
  if (text.length > limit) throw err('That file is too large.');
  return text;
}

/**
 * A repository's plugin list. index.json format:
 *   { "name": "…", "plugins": [ { "id", "name", "version", "description", "kinds", "url" | "file", "icon" } ] }
 * Entries without name/version are read from the plugin file itself.
 */
async function repoIndex(repo) {
  const builtin = repo.id === BUILTIN_REPO;
  const raw = builtin ? await fsp.readFile(path.join(BUILTIN_DIR, 'index.json'), 'utf8') : await fetchText(repo.url, 2 * 1024 * 1024);
  let index;
  try {
    index = JSON.parse(raw);
  } catch {
    throw err('The repository index isn’t valid JSON.', 502);
  }
  const list = Array.isArray(index) ? index : index.plugins;
  if (!Array.isArray(list)) throw err('The repository index has no "plugins" list.', 502);
  const out = [];
  for (const p of list.slice(0, 500)) {
    if (!p || !ID_RE.test(String(p.id || ''))) continue;
    const entry = { ...p, repo: repo.id, repoName: index.name || repo.name || repo.url };
    if (builtin) {
      entry.source = await fsp.readFile(path.join(BUILTIN_DIR, path.basename(p.file)), 'utf8');
      const m = await validate(entry.source);
      Object.assign(entry, { name: m.name, version: m.version, description: m.description, kinds: m.kinds, icon: m.icon, site: m.site, settings: m.settings });
      entry.origin = `builtin:${path.basename(p.file)}`;
    } else {
      entry.origin = new URL(p.url || p.file, repo.url).href;
    }
    out.push(entry);
  }
  return out;
}

function repos() {
  return [{ id: BUILTIN_REPO, name: 'Flyleaf built-in sources', url: null, builtin: true }, ...q('SELECT * FROM plugin_repos ORDER BY created_at').all().map((r) => ({ id: r.id, name: r.name, url: r.url, builtin: false }))];
}

async function addRepo(url) {
  runtime.checkUrl(url);
  if (q('SELECT 1 FROM plugin_repos WHERE url = ?').get(url)) throw err('That repository is already added.', 409);
  const list = await repoIndex({ id: 0, url });
  const name = list[0]?.repoName !== url ? list[0]?.repoName || null : null;
  q('INSERT INTO plugin_repos (url, name, created_at) VALUES (?, ?, ?)').run(url, name, Date.now());
  return { name, count: list.length };
}

/** Everything installable, across repositories, with install/update state. */
async function catalog() {
  const installed = new Map(q('SELECT id, version, origin FROM plugins').all().map((p) => [p.id, p]));
  const out = [];
  const errors = [];
  for (const repo of repos()) {
    try {
      for (const p of await repoIndex(repo)) {
        const have = installed.get(p.id);
        out.push({
          id: p.id, name: p.name || p.id, version: p.version || null, description: p.description || null,
          kinds: p.kinds || [], icon: p.icon || null, site: p.site || null, nsfw: Boolean(p.nsfw),
          repo: repo.id, repoName: p.repoName, origin: p.origin,
          installed: Boolean(have),
          installedVersion: have?.version || null,
          update: Boolean(have && p.version && compareVersions(p.version, have.version) > 0),
        });
      }
    } catch (e) {
      errors.push({ repo: repo.id, name: repo.name || repo.url, error: e.message });
    }
  }
  return { plugins: out, errors };
}

// ---------------------------------------------------------------------------
// Install / update / remove

async function sourceFromOrigin(origin) {
  if (origin.startsWith('builtin:')) return fsp.readFile(path.join(BUILTIN_DIR, path.basename(origin.slice(8))), 'utf8');
  return fetchText(origin);
}

/** Install or update from source text. `origin` lets updates re-fetch it later. */
async function install(source, origin = null) {
  const m = await validate(source);
  const now = Date.now();
  const existing = q('SELECT id FROM plugins WHERE id = ?').get(m.id);
  if (existing) {
    q('UPDATE plugins SET name = ?, version = ?, source = ?, origin = COALESCE(?, origin), updated_at = ? WHERE id = ?').run(m.name, m.version, source, origin, now, m.id);
  } else {
    // Seed settings with the manifest's defaults.
    const defaults = Object.fromEntries(m.settings.filter((s) => s.default != null).map((s) => [s.key, s.default]));
    q('INSERT INTO plugins (id, name, version, source, origin, enabled, settings, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)').run(
      m.id, m.name, m.version, source, origin, JSON.stringify(defaults), now, now,
    );
  }
  log.info(`${existing ? 'Updated' : 'Installed'} plugin ${m.id} ${m.version}`);
  return { ...m, updated: Boolean(existing) };
}

async function installFromCatalog(id, repoId = BUILTIN_REPO) {
  const repo = repos().find((r) => String(r.id) === String(repoId));
  if (!repo) throw err('Repository not found.', 404);
  const entry = (await repoIndex(repo)).find((p) => p.id === id);
  if (!entry) throw err('That plugin isn’t in the repository.', 404);
  const source = entry.source || (await sourceFromOrigin(entry.origin));
  const m = await install(source, entry.origin);
  if (m.id !== id) throw err(`The repository lists "${id}" but the file defines "${m.id}".`, 502);
  return m;
}

async function update(id) {
  const p = q('SELECT origin FROM plugins WHERE id = ?').get(id);
  if (!p) throw err('Plugin not found.', 404);
  if (!p.origin) throw err('This plugin was uploaded from a file; upload the new version instead.');
  return install(await sourceFromOrigin(p.origin), p.origin);
}

/** Install the built-in sources on first start so Content Finder isn't empty. */
async function seedBuiltins() {
  if (q('SELECT COUNT(*) AS n FROM plugins').get().n) return;
  try {
    // Some built-ins need setting up first (e.g. a server to connect to); those are offered, not installed.
    for (const entry of await repoIndex({ id: BUILTIN_REPO })) if (entry.seed !== false) await install(entry.source, entry.origin);
  } catch (e) {
    log.warn(`Couldn't install the built-in plugins: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Running

function row(id) {
  const p = q('SELECT * FROM plugins WHERE id = ?').get(id);
  if (!p) throw err('Plugin not found.', 404);
  return p;
}

const manifestCache = new Map();
async function manifestOf(p) {
  const key = `${p.id}@${p.updated_at}`;
  if (!manifestCache.has(key)) manifestCache.set(key, validate(p.source));
  return manifestCache.get(key);
}

// ---------------------------------------------------------------------------
// Plugins that provide several sources (e.g. one per Mihon extension) define
// sources(). Each becomes its own Content Finder source with the id "<plugin>~<sub id>".

const SEP = '~';
const SUB_TTL = 10 * 60_000;
const subCache = new Map(); // plugin id → { at, key, list }

function splitId(id) {
  const i = String(id).indexOf(SEP);
  return i < 0 ? [String(id), null] : [String(id).slice(0, i), String(id).slice(i + 1)];
}

async function subSources(p) {
  const key = `${p.updated_at}:${p.settings}`;
  const hit = subCache.get(p.id);
  if (hit && hit.key === key && Date.now() - hit.at < SUB_TTL) return hit.list;
  const raw = await runtime.call(p.source, 'sources', [], { settings: json(p.settings, {}), pluginId: p.id });
  const list = (Array.isArray(raw) ? raw : []).filter((x) => x && x.id != null).slice(0, 1000).map((x) => ({
    id: String(x.id).slice(0, 200),
    name: String(x.name || x.id).slice(0, 100),
    icon: typeof x.icon === 'string' ? x.icon.slice(0, 2000) : null,
    language: x.language ? String(x.language).slice(0, 20) : null,
    nsfw: Boolean(x.nsfw),
    browse: x.browse !== false,
  }));
  subCache.set(p.id, { at: Date.now(), key, list });
  return list;
}

/** Forget cached sub-sources (after installing extensions, changing settings…). */
function refreshSources(id) {
  if (id) subCache.delete(id);
  else subCache.clear();
}

// Proxied image URLs are signed, so the proxy only ever fetches URLs a plugin returned.
const IMAGE_KEY = require('node:crypto').randomBytes(32);
const imageSig = (id, url) => require('node:crypto').createHmac('sha256', IMAGE_KEY).update(`${id}\n${url}`).digest('base64url').slice(0, 32);

/** URL that serves an image through the plugin (see the /image route). */
const proxied = (id, url) => `/api/finder/${encodeURIComponent(id)}/image?u=${encodeURIComponent(url)}&s=${imageSig(id, url)}`;
const validImage = (id, url, sig) => typeof sig === 'string' && sig.length === 32 && require('node:crypto').timingSafeEqual(Buffer.from(sig), Buffer.from(imageSig(id, url)));

async function list({ includeDisabled = false } = {}) {
  const rows = q(`SELECT * FROM plugins ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY name COLLATE NOCASE`).all();
  const out = [];
  for (const p of rows) {
    try {
      const m = await manifestOf(p);
      const values = json(p.settings, {});
      const missing = m.settings.filter((s) => s.required && (values[s.key] == null || values[s.key] === '')).map((s) => s.label);
      // Content Finder lists each sub-source instead of the plugin itself.
      if (!includeDisabled && m.functions.sources && !missing.length) {
        try {
          const subs = await subSources(p);
          for (const sub of subs) {
            const icon = sub.icon && m.proxyImages && /^https?:/i.test(sub.icon) ? proxied(`${p.id}${SEP}${sub.id}`, sub.icon) : sub.icon && /^https?:/i.test(sub.icon) ? sub.icon : null;
            out.push({
              id: `${p.id}${SEP}${sub.id}`, parent: p.id, parentName: m.name, name: sub.name,
              description: [m.name, sub.language].filter(Boolean).join(' · '), icon, kinds: m.kinds, language: sub.language,
              nsfw: sub.nsfw, enabled: true, canBrowse: sub.browse && m.functions.latest, needsSetup: null,
            });
          }
          if (!subs.length) out.push({ id: p.id, name: m.name, icon: m.icon, kinds: m.kinds, description: m.description, enabled: true, error: 'No sources yet. Install extensions in Settings → Content Finder plugins.' });
        } catch (e) {
          out.push({ id: p.id, name: m.name, icon: m.icon, kinds: m.kinds, description: m.description, enabled: true, error: e.message });
        }
        continue;
      }
      out.push({
        id: p.id, name: m.name, version: m.version, author: m.author, description: m.description, site: m.site, icon: m.icon,
        kinds: m.kinds, language: m.language, nsfw: m.nsfw, enabled: Boolean(p.enabled), origin: p.origin,
        canBrowse: m.functions.latest, needsSetup: missing.length ? missing : null,
        settings: includeDisabled ? m.settings : undefined,
        values: includeDisabled ? Object.fromEntries(Object.entries(values).map(([k, v]) => [k, m.settings.find((s) => s.key === k)?.type === 'password' && v ? '••••••••' : v])) : undefined,
        installedAt: p.installed_at, updatedAt: p.updated_at,
      });
    } catch (e) {
      out.push({ id: p.id, name: p.name, version: p.version, enabled: Boolean(p.enabled), error: e.message });
    }
  }
  return out;
}

function saveSettings(id, values) {
  const p = row(id);
  const cur = json(p.settings, {});
  for (const [k, v] of Object.entries(values || {})) {
    if (!/^[A-Za-z_][\w]{0,40}$/.test(k)) continue;
    if (v === '••••••••') continue; // masked password left unchanged
    cur[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
  }
  q('UPDATE plugins SET settings = ? WHERE id = ?').run(JSON.stringify(cur), id);
  refreshSources(id);
}

/** Call a plugin function with its settings ("<plugin>~<sub>" ids run with that sub-source). */
async function run(id, fn, args = []) {
  const [pluginId, subId] = splitId(id);
  const p = row(pluginId);
  if (!p.enabled) throw err('That source is turned off.', 403);
  let sub = null;
  if (subId != null) {
    sub = (await subSources(p).catch(() => [])).find((x) => x.id === subId) || { id: subId, name: subId };
  }
  return runtime.call(p.source, fn, args, { settings: json(p.settings, {}), pluginId, sub });
}

/** The plugin row and manifest behind a (possibly "<plugin>~<sub>") source id. */
async function describe(id) {
  const p = row(splitId(id)[0]);
  return { row: p, manifest: await manifestOf(p) };
}

module.exports = {
  BUILTIN_REPO, compareVersions, validate, repos, addRepo, catalog, install, installFromCatalog, update, seedBuiltins, list, saveSettings, run, row,
  describe, splitId, proxied, validImage, refreshSources,
};
