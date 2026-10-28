'use strict';
const express = require('express');
const tracking = require('../tracking');
const { DEFINITIONS } = require('../tracking-providers');
const router = express.Router();

// These operations manage credentials and require an interactive user session.
router.use((req, res, next) => {
  if (req.user.apiKey) return res.status(403).json({ error: 'Use an interactive sign-in to manage tracking connections.' });
  next();
});
router.param('provider', (req, res, next, provider) => {
  if (!Object.hasOwn(DEFINITIONS, provider)) return res.status(404).json({ error: 'Unknown tracking service.' });
  next();
});
router.get('/', (req, res) => res.json(tracking.accounts(req.user.id)));
router.post('/:provider/connect', (req, res) => {
  try { res.json({ url: tracking.begin(req.user.id, req.params.provider) }); }
  catch { res.status(400).json({ error: 'Configure the tracking application on the server first. See docs/tracking.md.' }); }
});
router.get('/:provider/callback', async (req, res) => {
  res.set('Referrer-Policy', 'no-referrer');
  try {
    if (DEFINITIONS[req.params.provider].login) throw new Error('Not an OAuth redirect provider.');
    await tracking.finish(req.user.id, req.params.provider, req.query.state, req.query.code, Boolean(req.query.error));
    res.redirect('/#/settings/account?tracking=connected');
  } catch { res.redirect('/#/settings/account?tracking=failed'); }
});
const attempts = new Map();
router.post('/:provider/login', async (req, res) => {
  if (!DEFINITIONS[req.params.provider].login) return res.status(400).json({ error: 'Use browser authorization for this service.' });
  if (!req.secure && !['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return res.status(400).json({ error: 'Use HTTPS to connect this tracking account.' });
  const key = `${req.user.id}:${req.params.provider}`;
  const now = Date.now();
  for (const [k, attempt] of attempts) if (attempt.until < now) attempts.delete(k);
  const limit = attempts.get(key) || { count: 0, until: now + 300_000 };
  if (limit.count >= 5) return res.status(429).json({ error: 'Too many connection attempts. Try again in five minutes.' });
  limit.count++;
  attempts.set(key, limit);
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !username.trim() || username.length > 320 || typeof password !== 'string' || !password || password.length > 1000) {
    return res.status(400).json({ error: 'Enter your tracking account username and password.' });
  }
  try {
    await tracking.login(req.user.id, req.params.provider, username.trim(), password);
    attempts.delete(key);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Could not connect. Check your credentials and try again.' }); }
});
router.delete('/:provider', (req, res) => { tracking.disconnect(req.user.id, req.params.provider); res.json({ ok: true }); });
router.patch('/:provider', (req, res) => {
  if (typeof req.body?.pullEnabled !== 'boolean') return res.status(400).json({ error: 'Choose whether to import score and status.' });
  tracking.setPull(req.user.id, req.params.provider, req.body.pullEnabled);
  res.json({ ok: true });
});
router.post('/:provider/pull', (req, res) => {
  try { res.json({ queued: tracking.pull(req.user.id, req.params.provider) }); }
  catch { res.status(400).json({ error: 'Connect this tracking account first.' }); }
});
module.exports = { router };
