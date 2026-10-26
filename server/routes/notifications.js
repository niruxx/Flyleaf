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

// ---------------------------------------------------------------------------
// The bell: in-app notifications.
//   GET    /api/notifications?limit=        newest first, with the unread count
//   GET    /api/notifications/unread        { unread } (polled by the top bar)
//   POST   /api/notifications/read          { ids } or {} for all
//   DELETE /api/notifications               clear them all

const toNote = (n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, url: n.url, image: n.image, read: Boolean(n.read_at), createdAt: n.created_at });
const unread = (userId) => q('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;

router.get('/notifications', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 300);
  const rows = q('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(req.user.id, limit);
  res.json({ unread: unread(req.user.id), items: rows.map(toNote) });
});

router.get('/notifications/unread', (req, res) => res.json({ unread: unread(req.user.id) }));

router.post('/notifications/read', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 500) : null;
  if (ids) for (const id of ids) q('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(Date.now(), id, req.user.id);
  else q('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(Date.now(), req.user.id);
  res.json({ unread: unread(req.user.id) });
});

router.delete('/notifications', (req, res) => {
  q('DELETE FROM notifications WHERE user_id = ?').run(req.user.id);
  res.json({ unread: 0 });
});

module.exports = { router };
