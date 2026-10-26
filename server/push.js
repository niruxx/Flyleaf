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
// Notifications: the bell in the top bar, plus push to subscribed devices.

const userRow = (id) => q('SELECT * FROM users WHERE id = ?').get(id);
const admins = () => q("SELECT id FROM users WHERE role = 'admin'").all().map((r) => r.id);
const fire = (p) => p.catch((e) => log.file(`push failed: ${e.message}`));

function wants(userId, kind) {
  let prefs = {};
  try {
    prefs = JSON.parse(userRow(userId)?.prefs || '{}');
  } catch {}
  // Failed downloads follow the "My downloads" setting.
  const key = kind === 'downloadFailed' ? 'downloads' : kind;
  return Boolean({ ...require('./auth').PREF_DEFAULTS.notify, ...(prefs.notify || {}) }[key]);
}

/**
 * Tell a user something: it goes in their notifications (the bell) and, if they turned that kind
 * on in Settings → Notifications, to their devices. `newBooks` is opt-in for the bell too, since
 * every scan would otherwise ring it.
 */
function notify(userId, { title, body = null, url = null, image = null, tag }, kind) {
  if (kind !== 'newBooks' || wants(userId, kind)) {
    q('INSERT INTO notifications (user_id, kind, title, body, url, image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, kind, String(title).slice(0, 200), body == null ? null : String(body).slice(0, 1000), url, image, Date.now());
    // Keep the newest 300 per person.
    q(`DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 300)`).run(userId, userId);
  }
  if (wants(userId, kind)) fire(notifyUser(userId, { title, body, url, tag }));
}

// Downloads finish (or fail) in bursts – a batch of chapters – so collect them for a few
// seconds and send one notification per batch.
const batches = new Map(); // `${userId}:${done|failed}` → { titles: [], error, timer }
function downloadBatch(userId, outcome, title, error = null) {
  const key = `${userId}:${outcome}`;
  let entry = batches.get(key);
  if (!entry) {
    entry = { titles: [], error: null, timer: null };
    batches.set(key, entry);
  }
  entry.titles.push(title);
  entry.error ||= error;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    batches.delete(key);
    const n = entry.titles.length;
    const list = `${entry.titles.slice(0, 3).join(', ')}${n > 3 ? ` and ${n - 3} more` : ''}`;
    const failed = outcome === 'failed';
    notify(userId, {
      title: failed ? (n === 1 ? 'Download failed' : `${n} downloads failed`) : (n === 1 ? 'Download finished' : `${n} downloads finished`),
      body: failed && n === 1 ? `${list}: ${entry.error || 'unknown error'}` : list,
      url: '/#/finder/downloads',
      tag: `downloads-${outcome}`,
    }, failed ? 'downloadFailed' : 'downloads');
  }, 8000);
  entry.timer.unref?.();
}

function wire() {
  events.on('download.completed', (d) => {
    const row = q('SELECT user_id FROM downloads WHERE id = ?').get(d.downloadId);
    if (row?.user_id) downloadBatch(row.user_id, 'done', d.title);
  });
  events.on('download.failed', (d) => {
    const row = q('SELECT user_id FROM downloads WHERE id = ?').get(d.downloadId);
    if (row?.user_id && d.error !== 'Cancelled') downloadBatch(row.user_id, 'failed', d.title, d.error);
  });
  events.on('series.updated', (d) => {
    const follow = q('SELECT cover FROM follows WHERE id = ?').get(d.followId);
    notify(d.userId, {
      title: `${d.count} new in ${d.title}`,
      body: `${d.files.slice(0, 3).join(', ')}${d.count > 3 ? ` and ${d.count - 3} more` : ''}${d.downloading ? ' · downloading now' : ' · tap to download'}`,
      url: '/#/finder/following',
      image: follow?.cover || null,
      tag: `follow-${d.followId}`,
    }, 'newChapters');
  });
  // One notification per scan and library, not per book.
  events.on('library.scanned', (d) => {
    if (!d.added) return;
    const { toUser } = require('./auth');
    for (const u of q('SELECT * FROM users').all()) {
      if (!listsLibrary(toUser(u), d.libraryId)) continue;
      notify(u.id, { title: `${d.added} new in ${d.name}`, body: d.added === 1 ? 'A new book was added.' : `${d.added} new books were added.`, url: `/#/library/${d.libraryId}`, tag: `library-${d.libraryId}` }, 'newBooks');
    }
  });
  events.on('upload.completed', (d) => {
    for (const id of admins()) {
      if (id === d.userId) continue;
      notify(id, { title: `${d.username} uploaded ${d.files?.length || 0} ${d.files?.length === 1 ? 'file' : 'files'}`, body: 'Review it in their Downloads & uploads.', url: `/#/admin/users/${d.userId}/files`, tag: `upload-${d.userId}` }, 'admin');
    }
  });
  events.on('user.created', (d) => {
    if (!d.registered) return;
    for (const id of admins()) notify(id, { title: 'New sign-up', body: `${d.username} created an account.`, url: '/#/settings/users', tag: 'signup' }, 'admin');
  });
}

module.exports = { publicKey, subscribe, notifyUser, notify, wire, encrypt };
