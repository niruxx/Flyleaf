'use strict';

// Monitoring.
//   GET /api/health    no sign-in needed: { status, version, uptime } (503 if the database is unreachable)
//   GET /api/metrics   Prometheus text format; admin only (session or an admin's API key)

const express = require('express');
const { q } = require('../db');
const { requireAdmin } = require('../auth');

const started = Date.now();
const version = require('../../package.json').version;

const health = express.Router();
health.get('/health', (req, res) => {
  let dbOk = true;
  try {
    q('SELECT 1').get();
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'error', version, uptime: Math.round((Date.now() - started) / 1000), database: dbOk ? 'ok' : 'unreachable' });
});

const metrics = express.Router();
metrics.get('/metrics', requireAdmin, (req, res) => {
  const lines = [];
  const metric = (name, help, type, samples) => {
    lines.push(`# HELP flyleaf_${name} ${help}`, `# TYPE flyleaf_${name} ${type}`);
    for (const [labels, value] of samples) {
      const l = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`).join(',');
      lines.push(`flyleaf_${name}${l ? `{${l}}` : ''} ${value}`);
    }
  };
  const one = (sql, ...args) => Object.values(q(sql).get(...args))[0] ?? 0;

  metric('info', 'Flyleaf version', 'gauge', [[{ version }, 1]]);
  metric('uptime_seconds', 'Seconds since the server started', 'gauge', [[{}, Math.round((Date.now() - started) / 1000)]]);
  metric('users', 'User accounts by role', 'gauge', q('SELECT role, COUNT(*) AS n FROM users GROUP BY role').all().map((r) => [{ role: r.role }, r.n]));
  metric('active_sessions', 'Signed-in sessions that have not expired', 'gauge', [[{}, one('SELECT COUNT(*) FROM sessions WHERE expires_at > ?', Date.now())]]);
  const libs = q(`SELECT l.id, l.name, l.kind, COUNT(b.id) AS books, COALESCE(SUM(b.size), 0) AS bytes
                  FROM libraries l LEFT JOIN books b ON b.library_id = l.id AND b.missing = 0 GROUP BY l.id`).all();
  metric('library_books', 'Book files per library', 'gauge', libs.map((l) => [{ library: l.name, kind: l.kind }, l.books]));
  metric('library_bytes', 'Size of book files per library', 'gauge', libs.map((l) => [{ library: l.name, kind: l.kind }, l.bytes]));
  metric('series', 'Series across all libraries', 'gauge', [[{}, one('SELECT COUNT(*) FROM series')]]);
  metric('books_missing', 'Books whose files are gone', 'gauge', [[{}, one('SELECT COUNT(*) FROM books WHERE missing = 1')]]);
  metric('downloads', 'Content Finder downloads by status', 'gauge', q('SELECT status, COUNT(*) AS n FROM downloads GROUP BY status').all().map((r) => [{ status: r.status }, r.n]));
  metric('reading_seconds_total', 'Reading time recorded, all users', 'counter', [[{}, one('SELECT COALESCE(SUM(seconds), 0) FROM reading_log')]]);
  metric('books_finished_total', 'Books marked finished, all users', 'counter', [[{}, one('SELECT COUNT(*) FROM progress WHERE finished = 1')]]);
  const scan = require('../scanner').state || {};
  metric('scan_running', 'Whether a library scan is running', 'gauge', [[{}, scan.running ? 1 : 0]]);
  const mem = process.memoryUsage();
  metric('process_resident_bytes', 'Resident memory of the server process', 'gauge', [[{}, mem.rss]]);
  metric('process_heap_bytes', 'JavaScript heap in use', 'gauge', [[{}, mem.heapUsed]]);

  res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
});

module.exports = { health, metrics };
