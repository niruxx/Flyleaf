'use strict';

const express = require('express');
const { q } = require('../db');
const auth = require('../auth');

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
    prefs: u.prefs,
  };

const validEmail = (e) => e == null || e === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

router.get('/status', (req, res) => {
  res.json({ needsSetup: userCount() === 0, user: publicUser(req.user) || null });
});

// First-run: create the admin account. Only possible while no users exist.
router.post('/setup', (req, res) => {
  if (userCount() > 0) return res.status(409).json({ error: 'Flyleaf is already set up.' });
  const { username, password, displayName, email } = req.body || {};
  const err = auth.validateUsername(username) || auth.validatePassword(password);
  if (err) return res.status(400).json({ error: err });
  if (!validEmail(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
  const { lastInsertRowid } = q(
    `INSERT INTO users (username, display_name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)`,
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
  res.json({ user: publicUser(auth.toUser(user)) });
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// The signed-in user's own account

const me = express.Router();
me.use(auth.requireUser);

me.get('/', (req, res) => res.json(publicUser(req.user)));

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

me.put('/prefs', (req, res) => {
  const incoming = req.body && typeof req.body === 'object' ? req.body : {};
  const next = { ...req.user.prefs };
  for (const [k, v] of Object.entries(incoming)) if (k in auth.PREF_DEFAULTS) next[k] = v;
  const raw = JSON.stringify(next);
  if (raw.length > 20000) return res.status(400).json({ error: 'Preferences are too large.' });
  q('UPDATE users SET prefs = ? WHERE id = ?').run(raw, req.user.id);
  res.json(next);
});

me.post('/password', (req, res) => {
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

users.get('/', (req, res) => {
  const rows = q(`
    SELECT u.*,
      (SELECT COALESCE(SUM(seconds), 0) FROM reading_log r WHERE r.user_id = u.id) AS seconds_read,
      (SELECT COUNT(*) FROM progress p WHERE p.user_id = u.id AND p.finished = 1) AS finished
    FROM users u ORDER BY u.role, u.username`).all();
  res.json(
    rows.map((u) => ({
      ...publicUser(auth.toUser(u)),
      prefs: undefined,
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at,
      secondsRead: u.seconds_read,
      finished: u.finished,
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
  return out;
}

users.post('/', (req, res) => {
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
  const { lastInsertRowid } = q(
    `INSERT INTO users (username, display_name, email, password_hash, role, created_at, max_age_rating, age_include_unknown)
     VALUES (?, ?, ?, ?, 'guest', ?, ?, ?)`,
  ).run(
    username,
    String(displayName || '').trim().slice(0, 64) || null,
    email || null,
    auth.hashPassword(password),
    Date.now(),
    age.max_age_rating ?? null,
    age.age_include_unknown ?? 1,
  );
  res.status(201).json({ id: Number(lastInsertRowid) });
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
    if (user.role === 'admin' && age.max_age_rating != null) return res.status(400).json({ error: 'The admin account can’t be age-restricted.' });
    for (const [col, v] of Object.entries(age)) q(`UPDATE users SET ${col} = ? WHERE id = ?`).run(v, id);
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
