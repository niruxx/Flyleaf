'use strict';

const express = require('express');
const { q } = require('../db');
const auth = require('../auth');
const config = require('../config');
const settings = require('../settings');

const router = express.Router();

const userCount = () => q('SELECT COUNT(*) AS n FROM users').get().n;

const publicUser = (u) =>
  u && {
    id: u.id,
    username: u.username,
    displayName: u.displayName || u.username,
    email: u.email,
    role: u.role,
    maxAgeRating: u.maxAgeRating,
    ageIncludeUnknown: u.ageIncludeUnknown,
    libraryIds: u.libraryIds,
    homeDir: u.homeDir,
    avatarUrl: u.avatarUrl,
    permissions: u.permissions,
    prefs: u.prefs,
  };

const validEmail = (e) => e == null || e === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

router.get('/status', (req, res) => {
  // Your own background is only ever sent to you.
  const reg = settings.get('registration') || {};
  res.json({
    needsSetup: userCount() === 0,
    // Whether the sign-in page offers "Create an account" (and asks for an invite code).
    registration: reg.enabled ? { inviteRequired: Boolean(reg.inviteCode) } : null,
    user: req.user ? { ...publicUser(req.user), backgroundUrl: req.user.backgroundUrl } : null,
  });
});

// ---------------------------------------------------------------------------
// Sign-up (when the admin turns it on in Settings → Server & email)

const registration = () => ({ ...settings.DEFAULTS.registration, ...(settings.get('registration') || {}) });

// At most 5 sign-ups (or wrong invite codes) per address per hour.
const signups = new Map();
function signupAllowed(ip) {
  const now = Date.now();
  const recent = (signups.get(ip) || []).filter((t) => now - t < 3600_000);
  signups.set(ip, recent);
  return recent.length < 5;
}
const noteSignup = (ip) => signups.get(ip)?.push(Date.now()) ?? signups.set(ip, [Date.now()]);

function sameCode(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && require('node:crypto').timingSafeEqual(x, y);
}

router.post('/register', async (req, res) => {
  const reg = registration();
  if (!reg.enabled || userCount() === 0) return res.status(403).json({ error: 'Sign-up is closed. Ask the admin for an account.' });
  if (!signupAllowed(req.ip)) return res.status(429).json({ error: 'Too many sign-ups from this address. Try again later.' });
  const { username, password, displayName, inviteCode } = req.body || {};
  const err = auth.validateUsername(username) || auth.validatePassword(password);
  if (err) return res.status(400).json({ error: err });
  if (reg.inviteCode && !sameCode(String(inviteCode || '').trim(), reg.inviteCode)) {
    noteSignup(req.ip);
    return res.status(403).json({ error: 'That invite code isn’t right.' });
  }
  if (q('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'That username is taken.' });
  noteSignup(req.ip);
  const { id } = await createGuest({ username, password, displayName }, {
    library_ids: reg.sharedLibraries === 'none' ? '[]' : null,
    permissions: { ...auth.PERMISSION_DEFAULTS, ...(reg.permissions || {}) },
  });
  require('../events').emit('user.created', { userId: id, username, registered: true });
  auth.createSession(res, id, req.get('user-agent'));
  const u = auth.toUser(q('SELECT * FROM users WHERE id = ?').get(id));
  res.status(201).json({ user: { ...publicUser(u), backgroundUrl: u.backgroundUrl } });
});

// First-run: create the admin account. Only possible while no users exist.
router.post('/setup', (req, res) => {
  if (userCount() > 0) return res.status(409).json({ error: 'Flyleaf is already set up.' });
  const { username, password, displayName, email } = req.body || {};
  const err = auth.validateUsername(username) || auth.validatePassword(password);
  if (err) return res.status(400).json({ error: err });
  if (!validEmail(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
  const { lastInsertRowid } = q(
    `INSERT INTO users (username, display_name, email, password_hash, role, created_at, prefs) VALUES (?, ?, ?, ?, 'admin', ?, '{"onboarded":false}')`,
  ).run(username, String(displayName || '').trim().slice(0, 64) || null, email || null, auth.hashPassword(password), Date.now());
  auth.createSession(res, Number(lastInsertRowid), req.get('user-agent'));
  res.status(201).json({ user: publicUser(auth.toUser(q('SELECT * FROM users WHERE id = ?').get(Number(lastInsertRowid)))) });
});

router.post('/login', (req, res) => {
  const throttle = auth.loginThrottle(req.ip);
  if (throttle.blocked) {
    res.set('Retry-After', String(throttle.retryAfter));
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  const { username, password } = req.body || {};
  const user = typeof username === 'string' ? q('SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)').get(username.trim(), username.trim()) : null;
  const ok = auth.verifyPassword(String(password ?? ''), user ? user.password_hash : auth.DUMMY_HASH);
  if (!user || !ok) {
    throttle.fail();
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  throttle.reset();
  q('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), user.id);
  auth.createSession(res, user.id, req.get('user-agent'));
  const signedIn = auth.toUser(user);
  res.json({ user: { ...publicUser(signedIn), backgroundUrl: signedIn.backgroundUrl } });
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// The signed-in user's own account

const me = express.Router();
me.use(auth.requireUser);

me.get('/', (req, res) => res.json({ ...publicUser(req.user), backgroundUrl: req.user.backgroundUrl }));

me.patch('/', (req, res) => {
  const { username, email, displayName } = req.body || {};
  if (username !== undefined && username !== req.user.username) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Ask the admin to change your username.' });
    const err = auth.validateUsername(username);
    if (err) return res.status(400).json({ error: err });
    if (q('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, req.user.id)) return res.status(409).json({ error: 'That username is taken.' });
    q('UPDATE users SET username = ? WHERE id = ?').run(username, req.user.id);
  }
  if (email !== undefined) {
    if (!validEmail(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
    q('UPDATE users SET email = ? WHERE id = ?').run(email || null, req.user.id);
  }
  if (displayName !== undefined) {
    q('UPDATE users SET display_name = ? WHERE id = ?').run(String(displayName).trim().slice(0, 64) || null, req.user.id);
  }
  res.json(publicUser(auth.toUser(q('SELECT * FROM users WHERE id = ?').get(req.user.id))));
});

/** Your personal folder: { used, quota, free, files } (bytes; quota null = no limit). */
me.get('/storage', async (req, res) => res.json(await require('../storage').summary(req.user.id)));

/**
 * What's new (CHANGELOG.md): the latest versions, and which of them you haven't seen yet.
 * ?limit= how many versions (default 10).
 */
me.get('/changelog', (req, res) => {
  const changelog = require('../changelog');
  const all = changelog.entries();
  const seen = req.user.prefs.changelogSeen;
  const unseen = seen ? all.filter((e) => changelog.compare(e.version, seen) > 0) : [];
  res.json({
    latest: changelog.latest(),
    seen: seen || null,
    unseen: unseen.slice(0, 5),
    entries: all.slice(0, Math.min(Math.max(Number(req.query.limit) || 10, 1), 100)),
  });
});

me.put('/prefs', (req, res) => {
  const incoming = req.body && typeof req.body === 'object' ? req.body : {};
  const next = { ...req.user.prefs };
  for (const [k, v] of Object.entries(incoming)) if (k in auth.PREF_DEFAULTS) next[k] = v;
  // A new account finishing the welcome steps starts from today's version: "What's new" is for
  // updates that come after.
  if (incoming.onboarded === true && !next.changelogSeen) next.changelogSeen = require('../changelog').latest();
  const raw = JSON.stringify(next);
  if (raw.length > 20000) return res.status(400).json({ error: 'Preferences are too large.' });
  q('UPDATE users SET prefs = ? WHERE id = ?').run(raw, req.user.id);
  res.json(next);
});

me.post('/password', (req, res) => {
  if (req.user.apiKey) return res.status(403).json({ error: 'Passwords can’t be changed with an API key.' });
  const { current, next } = req.body || {};
  const row = q('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(String(current ?? ''), row.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  const err = auth.validatePassword(next);
  if (err) return res.status(400).json({ error: err });
  q('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(next), req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// User management (admin only). Admin creates read-only guest accounts.

const users = express.Router();
users.use(auth.requireAdmin);

users.get('/', async (req, res) => {
  const rows = q(`
    SELECT u.*,
      (SELECT COALESCE(SUM(seconds), 0) FROM reading_log r WHERE r.user_id = u.id) AS seconds_read,
      (SELECT COUNT(*) FROM progress p WHERE p.user_id = u.id AND p.finished = 1) AS finished,
      (SELECT COUNT(*) FROM downloads d WHERE d.user_id = u.id AND d.status = 'done' AND d.file IS NOT NULL) AS downloaded,
      (SELECT COUNT(*) FROM uploads x WHERE x.user_id = u.id) AS uploaded
    FROM users u ORDER BY u.role, u.username`).all();
  // Per library, for the Users list: what each user downloaded or uploaded there.
  const perLibrary = new Map();
  for (const r of q(`SELECT user_id, library_id, l.name, SUM(dl) AS downloads, SUM(ul) AS uploads FROM (
                       SELECT user_id, library_id, 1 AS dl, 0 AS ul FROM downloads WHERE status = 'done' AND file IS NOT NULL
                       UNION ALL SELECT user_id, library_id, 0, 1 FROM uploads)
                     JOIN libraries l ON l.id = library_id GROUP BY user_id, library_id ORDER BY l.name COLLATE NOCASE`).all()) {
    if (!perLibrary.has(r.user_id)) perLibrary.set(r.user_id, []);
    perLibrary.get(r.user_id).push({ id: r.library_id, name: r.name, downloads: r.downloads, uploads: r.uploads });
  }
  // Personal folder usage and limits (folder sizes are cached, see storage.js).
  const storage = require('../storage');
  const usage = new Map();
  for (const u of rows) if (u.home_dir) usage.set(u.id, await storage.summary(u.id));
  res.json(
    rows.map((u) => ({
      ...publicUser(auth.toUser(u)),
      prefs: undefined,
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at,
      secondsRead: u.seconds_read,
      finished: u.finished,
      downloaded: u.downloaded,
      uploaded: u.uploaded,
      contributions: perLibrary.get(u.id) || [],
      quotaMb: u.quota_mb,
      storage: usage.get(u.id) || null,
    })),
  );
});

function ageFields(body) {
  const out = {};
  if (body.maxAgeRating !== undefined) {
    const v = body.maxAgeRating === null || body.maxAgeRating === '' ? null : Number(body.maxAgeRating);
    if (v != null && ![0, 1, 2, 3].includes(v)) throw new Error('Invalid age rating.');
    out.max_age_rating = v;
  }
  if (body.ageIncludeUnknown !== undefined) out.age_include_unknown = body.ageIncludeUnknown ? 1 : 0;
  // Libraries this user can see: null = all, or a list of library ids.
  if (body.libraryIds !== undefined) {
    if (body.libraryIds === null) out.library_ids = null;
    else {
      if (!Array.isArray(body.libraryIds)) throw new Error('libraryIds must be a list or null.');
      const ids = [...new Set(body.libraryIds.map(Number))];
      const known = new Set(q('SELECT id FROM libraries').all().map((l) => l.id));
      if (ids.some((x) => !known.has(x))) throw new Error('Unknown library.');
      out.library_ids = JSON.stringify(ids);
    }
  }
  // Personal folder: the user can create their own libraries inside it, and their
  // downloads and uploads go only there. null/'' removes it.
  if (body.homeDir !== undefined) {
    if (body.homeDir === null || body.homeDir === '') out.home_dir = null;
    else {
      const path = require('node:path');
      const fs = require('node:fs');
      const dir = String(body.homeDir).trim();
      if (!path.isAbsolute(dir)) throw new Error('The personal folder must be an absolute path, e.g. /srv/books/alex.');
      const resolved = path.resolve(dir);
      if (resolved === path.parse(resolved).root) throw new Error('Pick a folder, not the whole disk.');
      try {
        fs.mkdirSync(resolved, { recursive: true });
      } catch (e) {
        throw new Error(['EROFS', 'EACCES', 'EPERM'].includes(e.code)
          ? `Flyleaf can't create ${resolved}. Create it yourself and give the Flyleaf service user access (see “flyleaf allow-write” in the README).`
          : `Can't use ${resolved}: ${e.code || e.message}`);
      }
      if (!fs.statSync(resolved).isDirectory()) throw new Error(`${resolved} isn’t a folder.`);
      out.home_dir = resolved;
    }
  }
  // Storage limit for the personal folder, in MB: null = the server default, 0 = no limit.
  if (body.quotaMb !== undefined) {
    const v = body.quotaMb === null || body.quotaMb === '' ? null : Math.round(Number(body.quotaMb));
    if (v != null && !(v >= 0)) throw new Error('Storage limit must be a number of MB.');
    out.quota_mb = v;
  }
  if (body.permissions !== undefined) {
    if (!body.permissions || typeof body.permissions !== 'object') throw new Error('Invalid permissions.');
    const perms = {};
    for (const k of Object.keys(auth.PERMISSION_DEFAULTS)) if (body.permissions[k] !== undefined) perms[k] = Boolean(body.permissions[k]);
    out.permissions = perms;
  }
  return out;
}

/** Write access fields; permissions merge with what the user already has. */
function applyAccess(id, fields) {
  for (const [col, v] of Object.entries(fields)) {
    if (col === 'permissions') {
      const cur = JSON.parse(q('SELECT permissions FROM users WHERE id = ?').get(id)?.permissions || '{}');
      q('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify({ ...cur, ...v }), id);
    } else q(`UPDATE users SET ${col} = ? WHERE id = ?`).run(v, id);
  }
}

/**
 * Create a guest account, with a personal folder holding Books, Comics and Manga libraries:
 * the folder the admin chose, or <data>/content/<username>. `access` is from ageFields().
 */
async function createGuest({ username, password, displayName, email }, access = {}) {
  const { lastInsertRowid } = q(
    `INSERT INTO users (username, display_name, email, password_hash, role, created_at, max_age_rating, age_include_unknown, prefs)
     VALUES (?, ?, ?, ?, 'guest', ?, ?, ?, '{"onboarded":false}')`,
  ).run(
    username,
    String(displayName || '').trim().slice(0, 64) || null,
    email || null,
    auth.hashPassword(password),
    Date.now(),
    access.max_age_rating ?? null,
    access.age_include_unknown ?? 1,
  );
  const id = Number(lastInsertRowid);
  let home = access.home_dir ?? null;
  if (!home) {
    home = require('node:path').join(config.contentDir, username);
    try {
      require('node:fs').mkdirSync(home, { recursive: true });
    } catch (e) {
      require('../log').logger('users').warn(`Couldn't create ${home} for ${username}: ${e.message}`);
      home = null;
    }
  }
  applyAccess(id, { library_ids: access.library_ids ?? null, home_dir: home, permissions: access.permissions ?? {}, ...(access.quota_mb !== undefined ? { quota_mb: access.quota_mb } : {}) });
  const libraries = home ? await require('./my-libraries').createDefaultLibraries(id, home) : [];
  return { id, homeDir: home, libraries: libraries.length };
}

users.post('/', async (req, res) => {
  const { username, password, displayName, email } = req.body || {};
  const err = auth.validateUsername(username) || auth.validatePassword(password);
  if (err) return res.status(400).json({ error: err });
  if (!validEmail(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
  if (q('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'That username is taken.' });
  }
  let age;
  try {
    age = ageFields(req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const created = await createGuest({ username, password, displayName, email }, age);
  require('../events').emit('user.created', { userId: created.id, username });
  res.status(201).json(created);
});

users.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = q('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { password, displayName, email, username } = req.body || {};
  if (username !== undefined && username !== user.username) {
    const err = auth.validateUsername(username);
    if (err) return res.status(400).json({ error: err });
    if (q('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, id)) return res.status(409).json({ error: 'That username is taken.' });
    q('UPDATE users SET username = ? WHERE id = ?').run(username, id);
  }
  if (password !== undefined) {
    const err = auth.validatePassword(password);
    if (err) return res.status(400).json({ error: err });
    q('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), id);
    // Changing a password signs that user out everywhere else.
    if (id !== req.user.id) q('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (displayName !== undefined) {
    q('UPDATE users SET display_name = ? WHERE id = ?').run(String(displayName).trim().slice(0, 64) || null, id);
  }
  if (email !== undefined) {
    if (!validEmail(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
    q('UPDATE users SET email = ? WHERE id = ?').run(email || null, id);
  }
  try {
    const age = ageFields(req.body || {});
    if (user.role === 'admin' && (age.max_age_rating != null || age.library_ids || age.home_dir)) return res.status(400).json({ error: 'The admin account can’t be restricted.' });
    applyAccess(id, age);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json({ ok: true });
});

users.delete('/:id/sessions', (req, res) => {
  q('DELETE FROM sessions WHERE user_id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

users.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account." });
  const user = q('SELECT role FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.role === 'admin') return res.status(400).json({ error: 'The admin account cannot be deleted.' });
  q('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = { router, me, users, publicUser };
