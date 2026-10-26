'use strict';

const express = require('express');
const { requireAdmin } = require('../auth');
const settings = require('../settings');
const mailer = require('../mailer');

const router = express.Router();
router.use(requireAdmin);

// Storage limits (see storage.js): defaults for personal folders, upload size, free space to keep.
router.get('/storage', (req, res) => {
  const storage = require('../storage');
  const config = require('../config');
  res.json({ ...storage.limits(), envMaxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 4096, disk: { free: storage.diskFree(config.dataDir), total: storage.diskTotal(config.dataDir) } });
});
router.put('/storage', (req, res) => res.json(require('../storage').setLimits(req.body || {})));

router.get('/settings', (req, res) => {
  const s = settings.all();
  // Never send the SMTP password back to the browser.
  res.json({ ...s, smtp: { ...s.smtp, pass: s.smtp?.pass ? '••••••••' : '' } });
});

router.put('/settings', (req, res) => {
  const b = req.body || {};
  for (const k of ['comicvineKey', 'googleBooksKey', 'malClientId']) if (b[k] !== undefined) settings.set(k, String(b[k]).trim());
  if (b.publicUrl !== undefined) {
    const url = String(b.publicUrl).trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Public URL must start with http:// or https://' });
    settings.set('publicUrl', url);
  }
  if (b.opdsEnabled !== undefined) settings.set('opdsEnabled', Boolean(b.opdsEnabled));
  if (b.registration) {
    const cur = { ...settings.DEFAULTS.registration, ...(settings.get('registration') || {}) };
    const r = b.registration;
    const code = r.inviteCode === undefined ? cur.inviteCode : String(r.inviteCode).trim().slice(0, 100);
    const perms = {};
    for (const k of Object.keys(require('../auth').PERMISSION_DEFAULTS)) if (r.permissions?.[k] !== undefined) perms[k] = Boolean(r.permissions[k]);
    settings.set('registration', {
      enabled: r.enabled === undefined ? cur.enabled : Boolean(r.enabled),
      inviteCode: code,
      sharedLibraries: r.sharedLibraries === 'none' ? 'none' : r.sharedLibraries === 'all' ? 'all' : cur.sharedLibraries,
      permissions: r.permissions ? { ...(cur.permissions || {}), ...perms } : cur.permissions,
    });
  }
  if (b.smtp) {
    const cur = settings.get('smtp') || {};
    const next = {
      host: String(b.smtp.host ?? cur.host ?? '').trim(),
      port: Number(b.smtp.port ?? cur.port) || 587,
      secure: Boolean(b.smtp.secure ?? cur.secure),
      user: String(b.smtp.user ?? cur.user ?? '').trim(),
      // The masked placeholder means "unchanged".
      pass: b.smtp.pass === undefined || b.smtp.pass === '••••••••' ? cur.pass || '' : String(b.smtp.pass),
      from: String(b.smtp.from ?? cur.from ?? '').trim(),
    };
    settings.set('smtp', next);
  }
  res.json({ ok: true });
});

router.post('/smtp/test', async (req, res) => {
  const to = String(req.body?.to || req.user.email || '').trim();
  if (!to) return res.status(400).json({ error: 'Enter an address to send the test to.' });
  try {
    await mailer.sendTest(to);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Activity log and failed sign-ins (see activity.js)

const activity = require('../activity');

router.get('/activity', (req, res) => {
  const { user, group, action, q: text, before, limit } = req.query;
  res.json({ entries: activity.list({ user, group, action, q: text, before, limit }), actions: activity.ACTIONS, groups: Object.keys(activity.GROUPS), keepDays: activity.KEEP_DAYS });
});

router.get('/activity.csv', (req, res) => {
  const { user, group, action, q: text } = req.query;
  const rows = activity.list({ user, group, action, q: text, limit: 500 });
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Time', 'User', 'Action', 'About', 'IP', 'Details'].map(cell).join(',')];
  for (const r of rows) lines.push([new Date(r.at).toISOString(), r.username, r.label, r.target, r.ip, r.details ? JSON.stringify(r.details) : ''].map(cell).join(','));
  res.attachment(`flyleaf-activity-${new Date().toISOString().slice(0, 10)}.csv`).type('text/csv').send(`${lines.join('\n')}\n`);
});

router.get('/activity/security', (req, res) => res.json(activity.security()));

/** Let a blocked address try signing in again straight away. */
router.post('/activity/unblock', (req, res) => {
  require('../auth').loginThrottle(String(req.body?.ip || '')).reset();
  res.json(activity.security());
});

// ---------------------------------------------------------------------------
// Webhooks

const crypto = require('node:crypto');
const { q } = require('../db');
const events = require('../events');

const hookRow = (h) => ({
  id: h.id,
  url: h.url,
  secret: h.secret,
  events: JSON.parse(h.events),
  enabled: Boolean(h.enabled),
  createdAt: h.created_at,
  lastStatus: h.last_status,
  lastError: h.last_error,
  lastAt: h.last_at,
});

function hookFields(body, current = {}) {
  const url = body.url !== undefined ? String(body.url).trim() : current.url;
  if (!/^https?:\/\/\S+$/i.test(url || '')) throw new Error('Webhook URL must start with http:// or https://');
  let list = body.events !== undefined ? body.events : JSON.parse(current.events || '["*"]');
  if (!Array.isArray(list) || !list.length) throw new Error('Pick at least one event.');
  list = [...new Set(list.map(String))];
  if (list.some((e) => e !== '*' && !events.EVENTS[e])) throw new Error('Unknown event.');
  return { url, events: JSON.stringify(list), enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : current.enabled ?? 1 };
}

router.get('/webhooks', (req, res) => {
  res.json({ hooks: q('SELECT * FROM webhooks ORDER BY created_at').all().map(hookRow), events: events.EVENTS });
});

router.post('/webhooks', (req, res) => {
  let f;
  try {
    f = hookFields(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const secret = crypto.randomBytes(24).toString('base64url');
  const { lastInsertRowid } = q('INSERT INTO webhooks (url, secret, events, enabled, created_at) VALUES (?, ?, ?, ?, ?)').run(f.url, secret, f.events, f.enabled, Date.now());
  res.status(201).json(hookRow(q('SELECT * FROM webhooks WHERE id = ?').get(Number(lastInsertRowid))));
});

router.patch('/webhooks/:id', (req, res) => {
  const h = q('SELECT * FROM webhooks WHERE id = ?').get(Number(req.params.id));
  if (!h) return res.status(404).json({ error: 'Webhook not found.' });
  let f;
  try {
    f = hookFields(req.body || {}, h);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  q('UPDATE webhooks SET url = ?, events = ?, enabled = ? WHERE id = ?').run(f.url, f.events, f.enabled, h.id);
  res.json(hookRow(q('SELECT * FROM webhooks WHERE id = ?').get(h.id)));
});

router.delete('/webhooks/:id', (req, res) => {
  q('DELETE FROM webhooks WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

const RETRY_NONE = 99; // an attempt index past the retry schedule: deliver once, no retries

/** Send a `ping` delivery right away and report the result. */
router.post('/webhooks/:id/test', async (req, res) => {
  const h = q('SELECT * FROM webhooks WHERE id = ?').get(Number(req.params.id));
  if (!h) return res.status(404).json({ error: 'Webhook not found.' });
  const body = JSON.stringify({ event: 'ping', at: new Date().toISOString(), data: { message: 'Hello from Flyleaf' } });
  res.json(await events.deliver({ ...h, id: h.id }, 'ping', body, RETRY_NONE));
});
module.exports = { router };
