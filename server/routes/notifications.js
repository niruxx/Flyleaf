'use strict';

// Push notification subscriptions for the signed-in user.
//   GET  /api/push            { publicKey, devices }
//   POST /api/push            { subscription }   (PushSubscription.toJSON())
//   POST /api/push/remove     { endpoint }
//   POST /api/push/test       send a test notification to your devices

const express = require('express');
const { q } = require('../db');
const push = require('../push');

const router = express.Router();

const devices = (userId) => q('SELECT id, endpoint, user_agent, created_at, last_error FROM push_subscriptions WHERE user_id = ? ORDER BY created_at').all(userId)
  .map((d) => ({ id: d.id, endpoint: d.endpoint, userAgent: d.user_agent, createdAt: d.created_at, lastError: d.last_error }));

router.get('/push', (req, res) => res.json({ publicKey: push.publicKey(), devices: devices(req.user.id) }));

router.post('/push', (req, res) => {
  push.subscribe(req.user.id, req.body?.subscription, req.get('user-agent'));
  res.json({ devices: devices(req.user.id) });
});

router.post('/push/remove', (req, res) => {
  if (req.body?.id) q('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(Number(req.body.id), req.user.id);
  else q('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(req.body?.endpoint || ''), req.user.id);
  res.json({ devices: devices(req.user.id) });
});

router.post('/push/test', async (req, res) => {
  const results = await push.notifyUser(req.user.id, { title: 'Flyleaf', body: 'Notifications are working.', url: '/#/settings/notifications', tag: 'test' });
  if (!results.length) return res.status(400).json({ error: 'No devices are subscribed yet.' });
  const failed = results.filter((r) => !r.ok);
  res.json({ sent: results.length - failed.length, failed: failed.length, error: failed[0]?.error || null });
});

module.exports = { router };
