'use strict';

// Storage limits.
//   • Per-user quota for personal folders: users.quota_mb, or the server default
//     (Settings → Server & email → Storage). Admins have no quota.
//   • Server-wide: the largest single upload, and free space that must be left on the disk.
// Uploads and Content Finder downloads check these before writing.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { q } = require('./db');
const settings = require('./settings');
const events = require('./events');

const DEFAULTS = { defaultQuotaMb: null, maxUploadMb: null, reserveFreeMb: 1024 };
const MB = 1024 * 1024;
const err = (message, status = 413) => Object.assign(new Error(message), { status, expose: true });

const limits = () => ({ ...DEFAULTS, ...(settings.get('storage') || {}) });

function setLimits(patch) {
  const cur = limits();
  const num = (v, fallback) => (v === undefined ? fallback : v === null || v === '' ? null : Math.max(0, Math.round(Number(v)) || 0));
  const next = {
    defaultQuotaMb: num(patch.defaultQuotaMb, cur.defaultQuotaMb),
    maxUploadMb: num(patch.maxUploadMb, cur.maxUploadMb),
    reserveFreeMb: num(patch.reserveFreeMb, cur.reserveFreeMb) ?? 0,
  };
  settings.set('storage', next);
  return next;
}

/** The largest file someone may upload, in bytes (setting, else MAX_UPLOAD_MB, else 4 GB). */
const maxUploadBytes = () => (limits().maxUploadMb || Number(process.env.MAX_UPLOAD_MB) || 4096) * MB;

// ---------------------------------------------------------------------------
// Usage of personal folders (walked, then cached; refreshed after writes)

const cache = new Map(); // userId → { bytes, files, at }
const CACHE_MS = 5 * 60_000;

async function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        const st = await fsp.stat(full).catch(() => null);
        if (st) {
          bytes += st.size;
          files++;
        }
      }
    }
  }
  return { bytes, files };
}

/** Bytes in a user's personal folder (0 without one). */
async function usage(userId, { fresh = false } = {}) {
  const hit = cache.get(userId);
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit;
  const home = q('SELECT home_dir FROM users WHERE id = ?').get(userId)?.home_dir;
  const out = home ? { ...(await dirSize(home)), at: Date.now() } : { bytes: 0, files: 0, at: Date.now() };
  cache.set(userId, out);
  return out;
}
const forget = (userId) => (userId ? cache.delete(userId) : cache.clear());

/** A user's quota in bytes, or null for no limit. */
function quotaOf(userId) {
  const u = q('SELECT role, home_dir, quota_mb FROM users WHERE id = ?').get(userId);
  if (!u || u.role === 'admin' || !u.home_dir) return null;
  const mb = u.quota_mb ?? limits().defaultQuotaMb;
  return mb ? mb * MB : null;
}

/** Free bytes on the disk holding `dir`, or null when the system won't say. */
function diskFree(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}
function diskTotal(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.blocks) * Number(st.bsize);
  } catch {
    return null;
  }
}

/** Is this library inside the user's personal folder (so it counts towards their quota)? */
const personal = (userId, libraryId) => Boolean(q('SELECT 1 FROM libraries WHERE id = ? AND owner_id = ?').get(Number(libraryId), userId));

const human = (bytes) => (bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`);

/**
 * Throw a friendly 413 if writing `bytes` (0 when unknown) into `libraryId` for `userId` would
 * go over their quota or leave the disk below the reserve.
 */
async function check(userId, libraryId, bytes = 0) {
  const lib = q('SELECT path FROM libraries WHERE id = ?').get(Number(libraryId));
  if (lib) {
    const reserve = (limits().reserveFreeMb || 0) * MB;
    const free = diskFree(lib.path);
    if (free != null && free - bytes < reserve) {
      throw err(`The server’s disk is nearly full (${human(Math.max(0, free))} free). Ask the admin to make room.`, 507);
    }
  }
  if (!personal(userId, libraryId)) return;
  const quota = quotaOf(userId);
  if (!quota) return;
  const { bytes: used } = await usage(userId);
  if (used + bytes > quota) {
    throw err(`Your storage is full: ${human(used)} of ${human(quota)} used. Delete something, or ask the admin for more space.`);
  }
}

/** For the UI: { used, quota, free, files }. */
async function summary(userId) {
  const home = q('SELECT home_dir FROM users WHERE id = ?').get(userId)?.home_dir;
  const u = await usage(userId);
  return { used: u.bytes, files: u.files, quota: quotaOf(userId), free: home ? diskFree(home) : null };
}

// Writes change usage: recount next time it's asked for.
for (const ev of ['download.completed', 'upload.completed', 'book.deleted', 'library.scanned']) events.on(ev, (d) => forget(d?.userId));

module.exports = { limits, setLimits, maxUploadBytes, usage, quotaOf, check, summary, diskFree, diskTotal, forget, human, MB };
