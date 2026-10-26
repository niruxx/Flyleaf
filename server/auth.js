'use strict';

const crypto = require('node:crypto');
const { q } = require('./db');
const config = require('./config');

const COOKIE = 'flyleaf_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, n, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    ...SCRYPT,
    N: Number(n),
  });
  return crypto.timingSafeEqual(expected, actual);
}

// Compared against when the username doesn't exist, so timing doesn't reveal valid names.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (password.length > 256) return 'Password is too long.';
  return null;
}

function validateUsername(username) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.';
  }
  return null;
}

const PREF_DEFAULTS = {
  blurUnreadSummaries: false,
  promptOnDownload: true,
  disableAnimations: false,
  collapseRelationships: false,
  colorScape: true,
  dataSaver: false,
  blurMature: true,
  opdsEmbedProgress: true,
  opdsContinueFrom: true,
  theme: null,
  keybinds: null,
  enabledFonts: null,
  // false until a new account has been through the first-run setup wizard.
  onboarded: true,
  // App background: { source: 'upload' | 'url', url, dim (0–95), blur (0–30), fit: 'cover' | 'contain' | 'tile' } or null.
  background: null,
  // Content Finder suggestions on Home: { enabled, sources: [source ids] (empty = pick automatically), nsfw }.
  finderRecs: { enabled: true, sources: [], nsfw: false },
  // Minutes a day to aim for on the stats page (0 = no daily goal).
  dailyGoalMinutes: 0,
  // Which push notifications to send: new chapters of followed series, your downloads, new books in
  // your libraries, and (admins) sign-ups & uploads.
  notify: { newChapters: true, downloads: true, newBooks: false, admin: true, security: true },
  // Content Finder: follow every series you download, and check downloads for newer chapters.
  watchDownloads: true,
  // App language (a code from public/locales/index.json); null follows the browser.
  language: null,
};

/** What a user may do beyond reading. Admins always have everything. */
const PERMISSION_DEFAULTS = {
  download: true, // download original files / zips, Send to device
  contentFinder: false, // search plugins and download new books into libraries
  apiAccess: true, // create API keys for OPDS apps and the REST API
  upload: false, // upload files into the libraries they can see
  deleteBooks: true, // delete books in their own libraries and files they downloaded (never other shared books)
};

function parseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

/** Normalise a users row into req.user. */
function toUser(row) {
  const prefs = parseJson(row.prefs, {});
  const admin = row.role === 'admin';
  const perms = { ...PERMISSION_DEFAULTS, ...parseJson(row.permissions, {}) };
  if (admin) for (const k of Object.keys(perms)) perms[k] = true;
  const libraryIds = admin ? null : parseJson(row.library_ids, null);
  // What shows up while browsing: their own libraries plus the shared ones the admin allowed.
  // Users' personal libraries never appear in anyone else's views, including the admin's
  // reading views; the admin reaches them through the admin panel (see accessFilter's `direct`).
  let visibleLibraryIds;
  let ownLibraryIds = [];
  if (admin) {
    // The admin is a reader too: shared libraries plus the admin's own private ones.
    const libs = q('SELECT id, owner_id FROM libraries WHERE owner_id IS NULL OR owner_id = ?').all(row.id);
    visibleLibraryIds = libs.map((l) => l.id);
    ownLibraryIds = libs.filter((l) => l.owner_id === row.id).map((l) => l.id);
  } else {
    const libs = q('SELECT id, owner_id FROM libraries').all();
    const allowed = Array.isArray(libraryIds) ? new Set(libraryIds.map(Number)) : null;
    ownLibraryIds = libs.filter((l) => l.owner_id === row.id).map((l) => l.id);
    visibleLibraryIds = libs.filter((l) => l.owner_id === row.id || (l.owner_id == null && (!allowed || allowed.has(l.id)))).map((l) => l.id);
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    email: row.email || null,
    role: row.role,
    maxAgeRating: row.max_age_rating,
    ageIncludeUnknown: Boolean(row.age_include_unknown),
    libraryIds: Array.isArray(libraryIds) ? libraryIds.map(Number) : null,
    homeDir: row.home_dir || null,
    avatarUrl: row.avatar ? `/api/users/${row.id}/avatar?v=${row.avatar}` : null,
    backgroundUrl: row.background ? `/api/me/background?v=${row.background}` : null,
    visibleLibraryIds,
    ownLibraryIds,
    permissions: perms,
    prefs: { ...PREF_DEFAULTS, ...prefs },
  };
}

/** Resolve an OPDS / third-party API key to a user. */
function userFromApiKey(key) {
  if (!key || key.length < 16) return null;
  const row = q('SELECT u.*, k.id AS key_id, k.scope AS key_scope FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key = ?').get(String(key));
  if (!row) return null;
  const user = toUser(row);
  if (!user.permissions.apiAccess) return null;
  q('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.key_id);
  user.apiKey = { id: row.key_id, scope: row.key_scope };
  return user;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(res, userId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expires = now + config.sessionDays * 86400_000;
  q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now,
    expires,
    String(userAgent || '').slice(0, 300),
  );
  setCookie(res, token, expires);
}

function setCookie(res, token, expires) {
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expires).toUTCString()}`,
  ];
  if (config.secureCookies || res.req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setCookie(res, '', 0);
}

/** Key from `Authorization: Bearer <key>` or `X-Api-Key: <key>`. */
function headerApiKey(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  return m ? m[1] : req.get('x-api-key') || null;
}

/** Attaches req.user from an API key header or a valid session cookie. */
function sessionMiddleware(req, res, next) {
  const key = headerApiKey(req);
  if (key) {
    const user = userFromApiKey(key);
    if (!user) return res.status(401).json({ error: 'Invalid API key.' });
    // Read-only keys may only read.
    if (user.apiKey.scope !== 'full' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return res.status(403).json({ error: 'This API key is read-only.' });
    }
    req.user = user;
    return next();
  }
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return next();
  const row = q(`
    SELECT s.token_hash, s.expires_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token));
  const now = Date.now();
  if (!row || row.expires_at < now) {
    if (row) q('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return next();
  }
  req.user = toUser(row);
  // Slide the session forward at most once an hour.
  if (!row.last_seen_at || now - row.last_seen_at > 3600_000) {
    const expires = now + config.sessionDays * 86400_000;
    q('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(expires, row.token_hash);
    q('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    setCookie(res, token, expires);
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

/** Route guard for a permission (see PERMISSION_DEFAULTS). */
const requirePermission = (perm, message) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  if (!req.user.permissions?.[perm]) return res.status(403).json({ error: message || 'You don’t have permission to do that.' });
  next();
};

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Guests have read-only access.' });
  next();
}

/**
 * Blocks cross-site form posts: every state-changing API call from the app
 * carries this header, which a plain HTML form can't set.
 */
function csrfGuard(req, res, next) {
  // API-key requests carry a header no cross-site form can set.
  if (req.user?.apiKey || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Flyleaf') !== '1') return res.status(403).json({ error: 'Missing request header.' });
  next();
}

// Simple in-memory login throttle: 10 failures per IP per 15 minutes.
const failures = new Map();
const WINDOW = 15 * 60_000;
const LOGIN_LIMIT = 10;

/** Addresses currently blocked from signing in: [{ ip, failures, until }] (for the admin panel). */
function blockedIps() {
  const now = Date.now();
  return [...failures].filter(([, e]) => now - e.first <= WINDOW && e.count >= LOGIN_LIMIT)
    .map(([ip, e]) => ({ ip, failures: e.count, until: e.first + WINDOW }));
}
function loginThrottle(ip) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (entry && now - entry.first > WINDOW) failures.delete(ip);
  const e = failures.get(ip);
  return {
    blocked: Boolean(e && e.count >= LOGIN_LIMIT),
    retryAfter: e ? Math.ceil((e.first + WINDOW - now) / 1000) : 0,
    fail() {
      const cur = failures.get(ip) || { first: now, count: 0 };
      cur.count++;
      failures.set(ip, cur);
    },
    reset() {
      failures.delete(ip);
    },
  };
}

function pruneSessions() {
  q('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

module.exports = {
  toUser,
  userFromApiKey,
  PREF_DEFAULTS,
  PERMISSION_DEFAULTS,
  requirePermission,
  hashPassword,
  verifyPassword,
  validatePassword,
  validateUsername,
  DUMMY_HASH,
  createSession,
  destroySession,
  sessionMiddleware,
  requireUser,
  requireAdmin,
  csrfGuard,
  loginThrottle,
  blockedIps,
  pruneSessions,
};
