'use strict';
const express = require('express');
const { q } = require('../db');
const tasks = require('../tasks');
const { json } = require('../util');
const router = express.Router();
const retryable = new Set(['scan', 'metadata', 'index', 'backup']);

router.get('/tasks', (req, res) => {
  const admin = req.user.role === 'admin';
  const items = tasks.list(req.user).map(row => ({
    id: `task-${row.id}`, taskId: row.id, kind: row.kind, title: row.title, status: row.status,
    ...(row.kind === 'storage-migration' && { destination: row.destination, userId: row.user_id,
      retryMove: row.status === 'failed' && Boolean(row.destination) && !req.user.apiKey }),
    done: row.done, total: row.total, error: row.error, createdAt: row.created_at, finishedAt: row.finished_at,
    retry: admin && row.status === 'failed' && retryable.has(row.kind) && (!['scan', 'metadata'].includes(row.kind) || Boolean(q('SELECT id FROM libraries WHERE id = ?').get(row.library_id))),
  }));
  if (items.some(item => item.kind === 'storage-migration')) {
    const migration = require('../storage-migration').live();
    const moving = migration && items.find(item => item.taskId === migration.id);
    if (moving) Object.assign(moving, { status: 'running', phase: migration.phase, done: migration.percent, finishedAt: null, error: null, retryMove: false });
  }
  // Reuse the existing durable queue and its owner boundary; never copy queue state.
  if (admin || req.user.permissions?.contentFinder) {
    const scope = admin ? '' : 'AND user_id = ?';
    const args = admin ? [] : [req.user.id];
    const current = q(`SELECT * FROM downloads WHERE status != 'done' AND NOT (status = 'failed' AND COALESCE(error, '') = 'Cancelled') ${scope} ORDER BY id DESC LIMIT 1000`).all(...args);
    const history = q(`SELECT * FROM downloads WHERE (status = 'done' OR (status = 'failed' AND error = 'Cancelled')) ${scope} ORDER BY id DESC LIMIT 100`).all(...args);
    for (const row of [...current, ...history]) {
      const item = json(row.item, {});
      items.push({ id: `download-${row.id}`, downloadId: row.id, kind: 'download',
        title: [row.title, item.fileTitle].filter(Boolean).join(' · '),
        status: row.error === 'Cancelled' ? 'cancelled' : row.status === 'downloading' ? 'running' : row.status,
        done: row.received, total: row.total, error: row.error === 'Cancelled' ? null : row.error,
        createdAt: row.created_at, finishedAt: row.finished_at,
        retry: row.status === 'failed', cancel: ['queued', 'downloading'].includes(row.status),
      });
    }
  }
  // Scans update frequently in memory; keep the displayed progress current without extra writes.
  const scan = require('../scanner').state;
  if (admin && scan.running) {
    const active = items.find(item => item.kind === 'scan' && item.status === 'running');
    if (active) { active.done = scan.phase === 'metadata' ? scan.processed : scan.found; active.total = scan.phase === 'metadata' ? scan.total : null; active.phase = scan.phase; }
  }
  items.sort((a, b) => Number(['running', 'queued'].includes(b.status)) - Number(['running', 'queued'].includes(a.status)) || b.createdAt - a.createdAt);
  res.json({ items });
});

router.post('/tasks/:id/retry', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  const row = q('SELECT * FROM background_tasks WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Task not found.' });
  if (row.status !== 'failed' || !retryable.has(row.kind)) return res.status(409).json({ error: 'This task cannot be retried.' });
  if (['scan', 'metadata'].includes(row.kind) && !q('SELECT id FROM libraries WHERE id = ?').get(row.library_id)) return res.status(404).json({ error: 'The library no longer exists.' });
  if (row.kind === 'scan') require('../scanner').requestScan(row.library_id);
  if (row.kind === 'metadata') require('../metadata-service').queueAuto(row.library_id);
  if (row.kind === 'index') {
    q('DELETE FROM book_text_state WHERE error IS NOT NULL').run();
    require('../fulltext').indexPending().catch(() => {});
  }
  if (row.kind === 'backup') require('../backup').runScheduled({ manual: true }).catch(() => {});
  q("UPDATE background_tasks SET status = 'retried' WHERE id = ? AND status = 'failed'").run(row.id);
  res.status(202).json({ ok: true });
});
module.exports = { router };
