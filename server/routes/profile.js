'use strict';

// Profile pictures, per-user backgrounds and share links.
//   PUT/DELETE /api/me/avatar        image body → 256×256 profile picture
//   GET        /api/users/:id/avatar any signed-in user (shown next to names)
//   PUT/DELETE /api/me/background    image or GIF body → your app background
//   GET        /api/me/background    your own background only
//   GET        /api/share-info       links others can open: home network and internet

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const config = require('../config');
const settings = require('../settings');
const { q } = require('../db');

const router = express.Router();
const AVATAR_DIR = path.join(config.dataDir, 'avatars');
const BG_DIR = path.join(config.dataDir, 'backgrounds');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
fs.mkdirSync(BG_DIR, { recursive: true });

let sharp = null;
try {
  sharp = require('sharp');
} catch {}

const err = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });
const noApiKey = (req) => {
  if (req.user.apiKey?.scope === 'read' && req.method !== 'GET') throw err('This API key is read-only.', 403);
};

/** Identify an image by its first bytes. */
function imageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 4, 12).includes('ftypavi')) return 'avif';
  return null;
}
const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };

async function replaceFile(dir, column, userId, buf, ext) {
  const name = `${userId}-${Date.now().toString(36)}.${ext}`;
  await fsp.writeFile(path.join(dir, name), buf);
  const old = q(`SELECT ${column} AS f FROM users WHERE id = ?`).get(userId)?.f;
  q(`UPDATE users SET ${column} = ? WHERE id = ?`).run(name, userId);
  if (old) await fsp.rm(path.join(dir, path.basename(old)), { force: true }).catch(() => {});
  return name;
}

async function removeFile(dir, column, userId) {
  const old = q(`SELECT ${column} AS f FROM users WHERE id = ?`).get(userId)?.f;
  q(`UPDATE users SET ${column} = NULL WHERE id = ?`).run(userId);
  if (old) await fsp.rm(path.join(dir, path.basename(old)), { force: true }).catch(() => {});
}

function sendStored(res, dir, name) {
  if (!name) return res.status(404).end();
  const ext = path.extname(name).slice(1);
  res.set({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.sendFile(path.join(dir, path.basename(name)), (e) => e && !res.headersSent && res.status(404).end());
}

const rawImage = (mb) => express.raw({ type: () => true, limit: `${mb}mb` });

// ---------------------------------------------------------------------------
// Profile pictures

router.put('/me/avatar', rawImage(10), async (req, res) => {
  noApiKey(req);
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !imageType(buf)) throw err('Choose a JPEG, PNG, WebP, GIF or AVIF image.');
  let out = buf;
  let ext = imageType(buf);
  if (sharp) {
    // A square crop, centred on the most interesting part of the picture.
    out = await sharp(buf, { failOn: 'none' }).rotate().resize(256, 256, { fit: 'cover', position: 'attention' }).webp({ quality: 86 }).toBuffer()
      .catch(() => {
        throw err('That image couldn’t be read.');
      });
    ext = 'webp';
  } else if (buf.length > 2 * 1024 * 1024) {
    throw err('Without image processing on the server, profile pictures can be at most 2 MB.');
  }
  const name = await replaceFile(AVATAR_DIR, 'avatar', req.user.id, out, ext);
  res.json({ avatarUrl: `/api/users/${req.user.id}/avatar?v=${name}` });
});

router.delete('/me/avatar', async (req, res) => {
  noApiKey(req);
  await removeFile(AVATAR_DIR, 'avatar', req.user.id);
  res.json({ ok: true });
});

router.get('/users/:id/avatar', (req, res) => {
  const u = q('SELECT avatar FROM users WHERE id = ?').get(Number(req.params.id));
  sendStored(res, AVATAR_DIR, u?.avatar);
});

// ---------------------------------------------------------------------------
// Backgrounds (each user's own; GIFs keep their animation)

router.put('/me/background', rawImage(30), async (req, res) => {
  noApiKey(req);
  const buf = req.body;
  const type = Buffer.isBuffer(buf) ? imageType(buf) : null;
  if (!type) throw err('Choose a JPEG, PNG, WebP, GIF or AVIF image.');
  let out = buf;
  let ext = type;
  if (sharp && type !== 'gif') {
    const meta = await sharp(buf, { failOn: 'none' }).metadata().catch(() => null);
    if (!meta) throw err('That image couldn’t be read.');
    // Keep animated WebP as-is; shrink large stills so they load fast on phones.
    if (!(meta.pages > 1) && (meta.width > 2560 || buf.length > 3 * 1024 * 1024)) {
      out = await sharp(buf, { failOn: 'none' }).rotate().resize({ width: 2560, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      ext = 'webp';
    }
  }
  const name = await replaceFile(BG_DIR, 'background', req.user.id, out, ext);
  res.json({ backgroundUrl: `/api/me/background?v=${name}` });
});

router.delete('/me/background', async (req, res) => {
  noApiKey(req);
  await removeFile(BG_DIR, 'background', req.user.id);
  res.json({ ok: true });
});

router.get('/me/background', (req, res) => {
  sendStored(res, BG_DIR, q('SELECT background FROM users WHERE id = ?').get(req.user.id)?.background);
});

// ---------------------------------------------------------------------------
// Share links: the server's address on the home network, and the public one if set.

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|lo|tun|tap|wg|tailscale|zt)/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Private ranges only: these are what other devices at home can reach.
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push(a.address);
    }
  }
  // Typical home networks (192.168.x.x) first.
  return [...new Set(out)].sort((a, b) => Number(!a.startsWith('192.168.')) - Number(!b.startsWith('192.168.')));
}

router.get('/share-info', (req, res) => {
  const listening = config.host === '127.0.0.1' || config.host === 'localhost' ? [] : lanAddresses();
  res.json({
    local: listening.map((ip) => `http://${ip}:${config.port}`),
    public: (settings.get('publicUrl') || '').replace(/\/+$/, '') || null,
  });
});

module.exports = { router };
