'use strict';

// Mihon "extension stores" (index.pb) for Suwayomi versions that only read the older
// index.min.json format.
//
// Newer repositories (Keiyoushi, Yūzōnō…) publish a gzipped protobuf index.pb; some keep
// only a stub index.min.json. Newer Suwayomi reads index.pb itself. For older ones, Flyleaf
// serves a converted copy that Suwayomi adds like any other repository:
//   /mihon-bridge/<key>/index.min.json   the extension list
//   /mihon-bridge/<key>/repo.json        name and signing key (Suwayomi checks APKs against it)
//   /mihon-bridge/<key>/apk/<file>       redirect to the real APK
//   /mihon-bridge/<key>/icon/<pkg>.png   redirect to the real icon
// Only stores the admin added are served, and redirects only go to URLs listed in them.

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const express = require('express');
const settings = require('../settings');
const runtime = require('./runtime');

const CACHE_MS = 30 * 60 * 1000;
const cache = new Map(); // key → { at, store }

// ---------------------------------------------------------------------------
// Protobuf wire format (just enough to read the store; field numbers below).

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('Truncated varint');
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (b < 0x80) return [result, pos];
    shift += 7n;
  }
}

/** Fields of one message: Map<fieldNumber, Array<BigInt | Buffer>>. */
function fields(buf) {
  const out = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const no = Number(key >> 3n);
    const type = Number(key & 7n);
    let value;
    if (type === 0) [value, pos] = readVarint(buf, pos);
    else if (type === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      value = buf.subarray(pos, pos + Number(len));
      pos += Number(len);
    } else if (type === 1) (value = buf.subarray(pos, pos + 8)), (pos += 8);
    else if (type === 5) (value = buf.subarray(pos, pos + 4)), (pos += 4);
    else throw new Error(`Unsupported protobuf wire type ${type}`);
    if (!out.has(no)) out.set(no, []);
    out.get(no).push(value);
  }
  return out;
}
const str = (m, no) => (m.get(no)?.[0] ? m.get(no)[0].toString('utf8') : null);
const int = (m, no) => (m.has(no) ? m.get(no)[0] : 0n);
const msgs = (m, no) => (m.get(no) || []).map(fields);

/**
 * Decode an index.pb (gzipped or not). Schema, from Mihon/Suwayomi:
 *   Store { 1 name, 2 badgeLabel, 3 signingKey, 4 Contact { 1 website, 2 discord }, 101 ExtensionList { 1 Extension[] } }
 *   Extension { 1 name, 2 packageName, 3 Resources { 1 apkUrl, 2 iconUrl }, 4 lib, 5 versionCode, 6 versionName,
 *               7 contentWarning (1 safe, 2 mixed, 3 NSFW), 8 Source[] }
 *   Source { 1 id (int64), 2 name, 3 language, 4 homeUrl }
 */
function decodeStore(raw) {
  const buf = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
  const top = fields(buf);
  const contact = msgs(top, 4)[0];
  const extensions = msgs(top, 101).flatMap((list) => msgs(list, 1)).map((e) => {
    const res = msgs(e, 3)[0] || new Map();
    const pkg = str(e, 2) || '';
    return {
      name: str(e, 1) || pkg,
      pkg,
      apkUrl: str(res, 1),
      iconUrl: str(res, 2),
      lib: str(e, 4),
      code: Number(int(e, 5)),
      version: str(e, 6) || '',
      contentWarning: Number(int(e, 7)),
      sources: msgs(e, 8).map((s) => ({
        // int64 ids don't fit a JS number; Suwayomi wants them as decimal strings anyway.
        id: BigInt.asIntN(64, int(s, 1)).toString(),
        name: str(s, 2) || '',
        lang: str(s, 3) || 'all',
        baseUrl: str(s, 4) || '',
      })),
    };
  }).filter((e) => e.pkg && e.apkUrl);
  return {
    name: str(top, 1) || 'Extension store',
    badgeLabel: str(top, 2),
    signingKey: str(top, 3),
    website: contact ? str(contact, 1) : null,
    extensions,
  };
}

// ---------------------------------------------------------------------------
// Stores the admin added (settings: key → index.pb URL).

const keyFor = (url) => crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
const registered = () => settings.get('mihonBridge') || {};

/** Register an index.pb URL and return its key. */
function register(url) {
  const all = registered();
  const key = keyFor(url);
  if (all[key] !== url) settings.set('mihonBridge', { ...all, [key]: url });
  return key;
}

/** The index.pb URL behind a bridge URL, or null if it isn't one. */
function originalOf(url) {
  const m = String(url).match(/\/mihon-bridge\/([0-9a-f]{16})\/index\.min\.json$/);
  return m ? registered()[m[1]] || null : null;
}

async function load(key) {
  const url = registered()[key];
  if (!url) return null;
  const c = cache.get(key);
  if (c && Date.now() - c.at < CACHE_MS) return c.store;
  runtime.checkUrl(url);
  const res = await fetch(url, { headers: { 'User-Agent': runtime.USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw Object.assign(new Error(`${url} returned HTTP ${res.status}`), { status: 502, expose: true });
  const store = decodeStore(Buffer.from(await res.arrayBuffer()));
  cache.set(key, { at: Date.now(), store });
  return store;
}

// APK file names in the converted index must be unique; use the real file name when it is.
const apkName = (e) => {
  const base = decodeURIComponent(String(e.apkUrl).split('?')[0].split('/').pop() || '');
  return /^[\w.+-]+\.apk$/.test(base) ? base : `${e.pkg}-${e.code}.apk`;
};
const langOf = (e) => e.pkg.match(/\.extension\.([^.]+)\./)?.[1] || e.sources[0]?.lang || 'all';

/** Convert a decoded store to the index.min.json Suwayomi (and old Mihon) read. */
function toLegacyIndex(store) {
  return store.extensions.map((e) => ({
    name: e.name.startsWith('Tachiyomi: ') ? e.name : `Tachiyomi: ${e.name}`,
    pkg: e.pkg,
    apk: apkName(e),
    lang: langOf(e),
    code: e.code,
    version: e.version,
    // "Mixed" sources (MangaDex…) were marked NSFW in the old format too.
    nsfw: e.contentWarning >= 2 ? 1 : 0,
    sources: e.sources.map((s) => ({ name: s.name, lang: s.lang, id: s.id, baseUrl: s.baseUrl })),
  }));
}

// ---------------------------------------------------------------------------
// Public routes (Suwayomi doesn't sign in to Flyleaf).

const router = express.Router();
const KEY = '/:key';

async function storeFor(req, res) {
  if (!/^[0-9a-f]{16}$/.test(req.params.key)) {
    res.status(404).end();
    return null;
  }
  try {
    const store = await load(req.params.key);
    if (!store) res.status(404).json({ error: 'Unknown extension store.' });
    return store;
  } catch (e) {
    res.status(502).json({ error: e.message });
    return null;
  }
}

router.get(`${KEY}/index.min.json`, async (req, res) => {
  const store = await storeFor(req, res);
  if (store) res.json(toLegacyIndex(store));
});

router.get(`${KEY}/repo.json`, async (req, res) => {
  const store = await storeFor(req, res);
  if (store) {
    res.json({ meta: { name: store.name, shortName: store.badgeLabel, website: store.website || registered()[req.params.key], signingKeyFingerprint: store.signingKey } });
  }
});

router.get(`${KEY}/apk/:file`, async (req, res) => {
  const store = await storeFor(req, res);
  if (!store) return;
  const e = store.extensions.find((x) => apkName(x) === req.params.file);
  if (!e) return res.status(404).end();
  res.redirect(302, e.apkUrl);
});

router.get(`${KEY}/icon/:file`, async (req, res) => {
  const store = await storeFor(req, res);
  if (!store) return;
  const e = store.extensions.find((x) => `${x.pkg}.png` === req.params.file);
  if (!e?.iconUrl) return res.status(404).end();
  res.redirect(302, e.iconUrl);
});

module.exports = { router, decodeStore, toLegacyIndex, register, originalOf, keyFor };
