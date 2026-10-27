'use strict';

// Lua plugin runtime (Lua 5.4 compiled to WebAssembly via wasmoon).
//
// Each call runs in a fresh, sandboxed Lua state: no file system, no `os.execute`,
// no `require`, no `debug`. Plugins reach the outside world only through the host
// API below, and a call is stopped if it runs longer than its time budget.
//
// Host API available to plugins (see docs/plugins.md):
//   http.get(url, opts) / http.post(url, opts)  → { status, ok, body, headers, url }
//   json.decode(s) / json.encode(v)
//   html.select(markup, css) → { { tag, text, html, attrs } … }   html.select_one(markup, css)
//   url.encode(s) / url.decode(s) / url.resolve(base, rel) / url.query(tbl)
//   text.strip_html(s) / text.trim(s)
//   base64.encode(s) / base64.decode(s)
//   settings.<key>   (values the admin configured for this plugin)
//   source           (for plugins with a sources() function: the sub-source being used)
//   log(...)

const { LuaFactory } = require('wasmoon');
const pkg = require('../../package.json');
const { stripHtml } = require('../util');
const log = require('../log').logger('plugins');

const factory = new LuaFactory();
const MAX_BODY = 10 * 1024 * 1024;
const HTTP_TIMEOUT = 20_000; // per request; plugins may ask for up to MAX_HTTP_TIMEOUT
const MAX_HTTP_TIMEOUT = 45_000;
const USER_AGENT = `Flyleaf/${pkg.version} (+https://github.com/niruxx/Flyleaf)`;

class PluginError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

/** Turn a Lua error into a readable one-line message. */
function cleanError(err) {
  const msg = String(err?.message || err || 'Plugin error')
    .split('\nstack traceback:')[0]
    .replace(/\[string "[^"]*"\]:\d+:\s*/g, '')
    .trim();
  return msg.slice(0, 500) || 'Plugin error';
}

// ---------------------------------------------------------------------------
// Host functions

/**
 * wasmoon can't take `null` from a host function (it probes the value for `.then`),
 * so nulls become undefined – which Lua sees as nil – all the way down.
 */
function noNull(v) {
  if (v === null) return undefined;
  if (Array.isArray(v)) return v.map(noNull);
  if (typeof v === 'object' && v !== undefined && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (x !== null) out[k] = noNull(x);
    return out;
  }
  return v;
}
/** Wrap a host function so its (possibly async) result is null-free. */
const host = (fn) => (...args) => {
  const r = fn(...args);
  return r && typeof r.then === 'function' ? r.then(noNull) : noNull(r);
};

function checkUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`Invalid URL: ${String(raw).slice(0, 200)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Plugins may only use http:// and https:// URLs.');
  return u;
}

async function readLimited(res, max = MAX_BODY) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      throw new Error('Response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function makeHttp(ctx) {
  const request = async (method, url, opts = {}) => {
    const u = checkUrl(url);
    if (opts.query && typeof opts.query === 'object') for (const [k, v] of Object.entries(opts.query)) u.searchParams.set(k, String(v));
    const headers = { 'User-Agent': USER_AGENT, ...(opts.headers || {}) };
    let body;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers['Content-Type'] ||= 'application/json';
    } else if (opts.form && typeof opts.form === 'object') {
      body = new URLSearchParams(Object.entries(opts.form).map(([k, v]) => [k, String(v)])).toString();
      headers['Content-Type'] ||= 'application/x-www-form-urlencoded';
    } else if (opts.body != null) body = String(opts.body);
    ctx.requests++;
    if (ctx.requests > 60) throw new Error('Too many HTTP requests in one call (limit 60).');
    const wait = Math.min(Math.max(Number(opts.timeout) || HTTP_TIMEOUT, 1000), MAX_HTTP_TIMEOUT);
    let res;
    try {
      res = await fetch(u, { method, headers, body, signal: AbortSignal.timeout(wait), redirect: 'follow' });
    } catch (e) {
      if (e.name === 'TimeoutError') throw new Error(`${u.hostname} didn't answer within ${Math.round(wait / 1000)} s. It may be busy – try again.`);
      throw e;
    }
    const text = await readLimited(res);
    return { status: res.status, ok: res.ok, body: text, url: res.url, headers: Object.fromEntries(res.headers.entries()) };
  };
  return {
    get: (url, opts) => request('GET', url, opts || {}),
    post: (url, opts) => request('POST', url, opts || {}),
  };
}

/**
 * Make CSS selectors forgiving for XML feeds: tag names match case-insensitively
 * ("Url" finds <Url>) and namespaced tags work as written ("dc:title").
 * Quoted strings and [attribute] parts are left alone.
 */
const PSEUDO = new Set(['not', 'is', 'has', 'where', 'matches', 'contains', 'icontains', 'empty', 'root', 'checked', 'disabled', 'enabled', 'selected', 'link',
  'first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type']);

function normalizeSelector(css) {
  let out = '';
  let i = 0;
  const src = String(css);
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      const stop = end < 0 ? src.length : end + 1;
      out += src.slice(i, stop);
      i = stop;
    } else if (c === '[' || c === '(') {
      const close = c === '[' ? ']' : ')';
      const end = src.indexOf(close, i + 1);
      const stop = end < 0 ? src.length : end + 1;
      out += src.slice(i, stop);
      i = stop;
    } else if (/[A-Za-z_]/.test(c) && (i === 0 || /[\s>+~,]/.test(src[i - 1]))) {
      const m = /^([A-Za-z_][\w-]*)(?::([A-Za-z_][\w-]*))?/.exec(src.slice(i));
      // "dc:title" is a namespaced tag; "a:not(…)" / "li:first-child" are pseudo-classes.
      if (m[2] && !PSEUDO.has(m[2].toLowerCase())) {
        out += `${m[1].toLowerCase()}\\:${m[2].toLowerCase()}`;
        i += m[0].length;
      } else {
        out += m[1].toLowerCase();
        i += m[1].length;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function makeHtml() {
  const { parse } = require('node-html-parser');
  const toNode = (el) => ({
    tag: el.rawTagName ? el.rawTagName.toLowerCase() : null,
    text: el.text.trim(),
    html: el.innerHTML,
    outer: el.outerHTML,
    attrs: el.attributes || {},
  });
  const root = (markup) => parse(String(markup ?? ''), { lowerCaseTagName: false, comment: false, blockTextElements: { script: true, style: true } });
  return {
    select: (markup, css) => root(markup).querySelectorAll(normalizeSelector(css)).slice(0, 2000).map(toNode),
    select_one: (markup, css) => {
      const el = root(markup).querySelector(normalizeSelector(css));
      return el ? toNode(el) : null;
    },
  };
}

// ---------------------------------------------------------------------------

const PRELUDE = `
local sethook, rawload = debug.sethook, load
local deadline = 0
local function budget(ms)
  deadline = __now() + ms
  sethook(function() if __now() > deadline then error("Plugin took longer than " .. (ms / 1000) .. " s", 2) end end, "", 20000)
end
-- Load the plugin file itself; top-level code gets a small budget.
function __load(src, ms)
  local chunk = assert(rawload(src, "=plugin", "t"))
  budget(ms)
  chunk()
end
function __invoke(ms, name, ...)
  local fn = _G[name]
  if type(fn) ~= "function" then error("This plugin doesn't implement " .. name .. "()", 0) end
  budget(ms)
  return fn(...)
end
-- Sandbox: plugins only talk to the outside world through the host API.
debug = nil; io = nil; package = nil; require = nil; dofile = nil; loadfile = nil
string.dump = nil
load = function(chunk, name, _, env) return rawload(chunk, name, "t", env) end
os = { time = os.time, date = os.date, clock = os.clock, difftime = os.difftime }

-- Friendlier synchronous wrappers around the async host calls.
http = {
  get = function(u, o) return __http_get(u, o or {}):await() end,
  post = function(u, o) return __http_post(u, o or {}):await() end,
}
json = { decode = __json_decode, encode = __json_encode, null = nil }
html = { select = __html_select, select_one = __html_select_one }
url = { encode = __url_encode, decode = __url_decode, resolve = __url_resolve, query = __url_query }
base64 = { encode = __b64_encode, decode = __b64_decode }
text = { strip_html = __strip_html, trim = function(s) return (tostring(s or ""):gsub("^%s+", ""):gsub("%s+$", "")) end }
function log(...) local t = {} for i = 1, select("#", ...) do t[#t + 1] = tostring(select(i, ...)) end __log(table.concat(t, " ")) end
`;

/**
 * Run `fn(...args)` from a plugin's Lua source in a fresh sandbox.
 * Returns the function's result converted to plain JS (tables → objects/arrays).
 */
async function call(source, fn, args = [], { settings = {}, pluginId = 'plugin', timeout = 60_000, sub = null } = {}) {
  const lua = await factory.createEngine({ injectObjects: false, enableProxy: false });
  const ctx = { requests: 0 };
  const http = makeHttp(ctx);
  const html = makeHtml();
  try {
    const g = lua.global;
    g.set('__now', () => Date.now());
    g.set('__http_get', host(http.get));
    g.set('__http_post', host(http.post));
    g.set('__json_decode', host((s) => {
      try {
        return JSON.parse(String(s));
      } catch (e) {
        throw new Error(`json.decode: ${e.message}`);
      }
    }));
    g.set('__json_encode', (v) => JSON.stringify(v ?? null) ?? 'null');
    g.set('__html_select', host(html.select));
    g.set('__html_select_one', host(html.select_one));
    g.set('__url_encode', (s) => encodeURIComponent(String(s ?? '')));
    g.set('__url_decode', (s) => decodeURIComponent(String(s ?? '')));
    g.set('__url_resolve', (base, rel) => new URL(String(rel ?? ''), String(base)).href);
    g.set('__url_query', (t) => new URLSearchParams(Object.entries(t || {}).map(([k, v]) => [k, String(v)])).toString());
    g.set('__strip_html', (s) => stripHtml(s) || '');
    g.set('__b64_encode', (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64'));
    g.set('__b64_decode', (s) => Buffer.from(String(s ?? ''), 'base64').toString('utf8'));
    g.set('__log', (s) => log.file(`[${pluginId}] ${s}`));
    g.set('settings', noNull({ ...settings }));
    // For plugins that provide several sources: which one this call is for (else nil).
    if (sub) g.set('source', noNull(sub));
    g.set('FLYLEAF_VERSION', pkg.version);
    await lua.doString(PRELUDE);
    g.set('__src', String(source));
    await lua.doString('__load(__src, 5000)');
    if (!fn) return g.get('plugin');
    g.set('__args', noNull(args));
    return await lua.doString(`return __invoke(${Number(timeout)}, ${JSON.stringify(fn)}, table.unpack(__args, 1, ${args.length}))`);
  } catch (err) {
    throw new PluginError(cleanError(err));
  } finally {
    lua.global.close();
  }
}

/** Load a plugin's source and return its manifest (the global `plugin` table) plus capabilities. */
async function inspect(source) {
  const lua = await factory.createEngine({ injectObjects: false, enableProxy: false });
  try {
    const g = lua.global;
    g.set('__now', () => Date.now());
    for (const name of ['__http_get', '__http_post', '__json_decode', '__json_encode', '__html_select', '__html_select_one',
      '__url_encode', '__url_decode', '__url_resolve', '__url_query', '__strip_html', '__b64_encode', '__b64_decode', '__log']) g.set(name, () => undefined);
    g.set('settings', {});
    g.set('FLYLEAF_VERSION', pkg.version);
    await lua.doString(PRELUDE);
    // Loading must not do any work: top-level code runs with a tight budget.
    g.set('__src', String(source));
    await lua.doString('__load(__src, 2000)');
    const manifest = g.get('plugin');
    const has = (name) => g.get(name) != null && typeof g.get(name) === 'function';
    return {
      manifest,
      functions: {
        search: has('search'), latest: has('latest'), browse: has('browse'), details: has('details'), download: has('download'),
        sources: has('sources'), image: has('image'),
        // Optional genre/category filters: genres() lists them, genre(id, page, query) browses one.
        genres: has('genres') && has('genre'),
      },
    };
  } catch (err) {
    throw new PluginError(cleanError(err), 400);
  } finally {
    lua.global.close();
  }
}

module.exports = { call, inspect, PluginError, USER_AGENT, checkUrl, normalizeSelector };
