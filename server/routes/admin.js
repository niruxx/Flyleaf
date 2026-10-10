'use strict';

const express = require('express');
const { requireAdmin } = require('../auth');
const settings = require('../settings');
const mailer = require('../mailer');

const router = express.Router();
router.use(requireAdmin);

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

module.exports = { router };
