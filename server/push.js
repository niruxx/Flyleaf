'use strict';

// Web push notifications (RFC 8030 delivery, RFC 8291 payload encryption, RFC 8292 VAPID),
// built on node:crypto so there's nothing extra to install. Browsers subscribe in
// Settings → Notifications; server events below turn into notifications.

const crypto = require('node:crypto');
const { q } = require('./db');
const settings = require('./settings');
const events = require('./events');
const { listsLibrary } = require('./util');
const log = require('./log').logger('push');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** The server's VAPID key pair, made on first use and kept in settings. */
function vapid() {
  let keys = settings.get('vapid');
  if (!keys?.publicKey) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    keys = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
    settings.set('vapid', keys);
  }
  return keys;
}

const publicKey = () => vapid().publicKey;

/** A P-256 private key object from raw base64url parts. */
function signingKey({ publicKey: pub, privateKey: priv }) {
  const p = Buffer.from(pub, 'base64url');
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: priv, x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33, 65)) },
    format: 'jwk',
  });
}

function vapidHeader(endpoint) {
  const keys = vapid();
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  // Push services want a way to reach whoever runs the server (Apple rejects made-up addresses).
  const email = q("SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL ORDER BY id LIMIT 1").get()?.email;
  const publicUrl = settings.get('publicUrl');
  const contact = /^https:\/\//.test(publicUrl || '') ? publicUrl : email ? `mailto:${email}` : 'https://github.com/niruxx/Flyleaf';
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** aes128gcm-encrypt `payload` for one subscription (RFC 8291). */
function encrypt(payload, { p256dh, auth }) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Deliver one notification. Gone subscriptions (404/410) are removed. */
async function sendTo(sub, message) {
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidHeader(sub.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'normal',
      },
      body: encrypt(JSON.stringify(message), sub),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) {
      q('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      return { ok: false, gone: true };
    }
    if (!res.ok) {
      const error = `HTTP ${res.status}`;
      q('UPDATE push_subscriptions SET last_error = ? WHERE id = ?').run(error, sub.id);
      return { ok: false, error };
    }
    q('UPDATE push_subscriptions SET last_error = NULL WHERE id = ?').run(sub.id);
    return { ok: true };
  } catch (e) {
    q('UPDATE push_subscriptions SET last_error = ? WHERE id = ?').run(e.message, sub.id);
    return { ok: false, error: e.message };
  }
}

/** Send to every device of a user. `kind` is the notify preference that must be on (or null). */
async function notifyUser(userId, message, kind = null) {
  if (kind) {
    const row = q('SELECT prefs FROM users WHERE id = ?').get(userId);
    const prefs = (() => {
      try {
        return JSON.parse(row?.prefs || '{}');
      } catch {
        return {};
      }
    })();
    const defaults = require('./auth').PREF_DEFAULTS.notify;
    if (!{ ...defaults, ...(prefs.notify || {}) }[kind]) return [];
  }
  const subs = q('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  return Promise.all(subs.map((s) => sendTo(s, message)));
}

function subscribe(userId, sub, userAgent) {
  const endpoint = String(sub?.endpoint || '');
  const { p256dh, auth } = sub?.keys || {};
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw Object.assign(new Error('That isn’t a valid push subscription.'), { status: 400, expose: true });
  q(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`)
    .run(userId, endpoint, String(p256dh), String(auth), String(userAgent || '').slice(0, 300), Date.now());
}

// ---------------------------------------------------------------------------
// Which events become notifications

const userRow = (id) => q('SELECT * FROM users WHERE id = ?').get(id);
const admins = () => q("SELECT id FROM users WHERE role = 'admin'").all().map((r) => r.id);
const fire = (p) => p.catch((e) => log.file(`push failed: ${e.message}`));

function wire() {
  events.on('download.completed', (d) => {
    const row = q('SELECT user_id FROM downloads WHERE id = ?').get(d.downloadId);
    if (row?.user_id) fire(notifyUser(row.user_id, { title: 'Download finished', body: d.title, url: '/#/finder/downloads', tag: `download-${d.downloadId}` }, 'downloads'));
  });
  events.on('download.failed', (d) => {
    const row = q('SELECT user_id FROM downloads WHERE id = ?').get(d.downloadId);
    if (row?.user_id) fire(notifyUser(row.user_id, { title: 'Download failed', body: `${d.title}: ${d.error || 'unknown error'}`, url: '/#/finder/downloads', tag: `download-${d.downloadId}` }, 'downloads'));
  });
  // One notification per scan and library, not per book.
  events.on('library.scanned', (d) => {
    if (!d.added) return;
    const subscribers = q('SELECT DISTINCT user_id FROM push_subscriptions').all().map((r) => r.user_id);
    const { toUser } = require('./auth');
    for (const id of subscribers) {
      const u = userRow(id);
      if (!u || !listsLibrary(toUser(u), d.libraryId)) continue;
      fire(notifyUser(id, { title: `${d.added} new in ${d.name}`, body: d.added === 1 ? 'A new book was added.' : `${d.added} new books were added.`, url: `/#/library/${d.libraryId}`, tag: `library-${d.libraryId}` }, 'newBooks'));
    }
  });
  events.on('upload.completed', (d) => {
    for (const id of admins()) {
      if (id === d.userId) continue;
      fire(notifyUser(id, { title: `${d.username} uploaded ${d.files?.length || 0} ${d.files?.length === 1 ? 'file' : 'files'}`, body: 'Review it in Settings → Users.', url: `/#/settings/users`, tag: `upload-${d.userId}` }, 'admin'));
    }
  });
  events.on('user.created', (d) => {
    if (!d.registered) return;
    for (const id of admins()) fire(notifyUser(id, { title: 'New sign-up', body: `${d.username} created an account.`, url: '/#/settings/users', tag: 'signup' }, 'admin'));
  });
}

module.exports = { publicKey, subscribe, notifyUser, wire, encrypt };
