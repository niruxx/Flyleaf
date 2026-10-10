'use strict';

const express = require('express');
const { q } = require('../db');
const auth = require('../auth');

const router = express.Router();

const userCount = () => q('SELECT COUNT(*) AS n FROM users').get().n;

const publicUser = (u) => u && { id: u.id, username: u.username, displayName: u.displayName || u.username, role: u.role };

router.get('/status', (req, res) => {
  res.json({ needsSetup: userCount() === 0, user: publicUser(req.user) || null });
});

// First-run: create the admin account. Only possible while no users exist.
router.post('/setup', (req, res) => {
  if (userCount() > 0) return res.status(409).json({ error: 'Flyleaf is already set up.' });
  const { username, password, displayName } = req.body || {};
  const err = auth.validateUsername(username) || auth.validatePassword(password);
  if (err) return res.status(400).json({ error: err });
  const { lastInsertRowid } = q(
    `INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)`,
  ).run(username, String(displayName || '').trim().slice(0, 64) || null, auth.hashPassword(password), Date.now());
  auth.createSession(res, Number(lastInsertRowid), req.get('user-agent'));
  res.status(201).json({ user: { id: Number(lastInsertRowid), username, displayName: displayName || username, role: 'admin' } });
});

router.post('/login', (req, res) => {
  const throttle = auth.loginThrottle(req.ip);
  if (throttle.blocked) {
    res.set('Retry-After', String(throttle.retryAfter));
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  const { username, password } = req.body || {};
  const user = typeof username === 'string' ? q('SELECT * FROM users WHERE username = ?').get(username.trim()) : null;
  const ok = auth.verifyPassword(String(password ?? ''), user ? user.password_hash : auth.DUMMY_HASH);
  if (!user || !ok) {
    throttle.fail();
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  throttle.reset();
  q('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), user.id);
  auth.createSession(res, user.id, req.get('user-agent'));
  res.json({ user: publicUser({ ...user, displayName: user.display_name }) });
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

router.post('/me/password', auth.requireAdmin, (req, res) => {
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
    SELECT u.id, u.username, u.display_name, u.role, u.created_at, u.last_seen_at,
      (SELECT COALESCE(SUM(seconds), 0) FROM reading_log r WHERE r.user_id = u.id) AS seconds_read,
      (SELECT COUNT(*) FROM progress p WHERE p.user_id = u.id AND p.finished = 1) AS finished
    FROM users u ORDER BY u.role, u.username`).all();
  res.json(
    rows.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name || u.username,
      role: u.role,
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at,
      secondsRead: u.seconds_read,
      finished: u.finished,
    })),
  );
});

users.post('/', (req, res) => {
  const { username, password, displayName } = req.body || {};
  const err = auth.validateUsername(username) || auth.validatePassword(password);
  if (err) return res.status(400).json({ error: err });
  if (q('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'That username is taken.' });
  }
  const { lastInsertRowid } = q(
    `INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, 'guest', ?)`,
  ).run(username, String(displayName || '').trim().slice(0, 64) || null, auth.hashPassword(password), Date.now());
  res.status(201).json({ id: Number(lastInsertRowid) });
});

users.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = q('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { password, displayName } = req.body || {};
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

module.exports = { router, users };
