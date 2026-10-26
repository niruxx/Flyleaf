'use strict';

// Server events and outgoing webhooks. Scripts subscribe to events in
// Settings → Webhooks; each delivery is a JSON POST signed with the hook's secret:
//   X-Flyleaf-Event: book.added
//   X-Flyleaf-Signature: sha256=<hex HMAC of the raw body>

const crypto = require('node:crypto');
const { q } = require('./db');
const log = require('./log').logger('webhooks');

const EVENTS = {
  'library.scanned': 'A library scan finished with changes',
  'book.added': 'A new book or comic was found during a scan',
  'book.deleted': 'A user deleted a book and its file',
  'book.finished': 'A user finished a book',
  'progress.updated': 'A user’s reading position changed',
  'download.completed': 'A Content Finder download was added to a library',
  'download.failed': 'A Content Finder download failed',
  'user.created': 'The admin created a user',
  'upload.completed': 'Someone uploaded files into a library',
  'series.updated': 'A followed series has new chapters or volumes',
};

// In-process listeners (e.g. uploads waiting for their files to be scanned).
const listeners = new Map();
/** Run `fn(data)` whenever `event` happens in this process. Returns an unsubscribe function. */
function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

const RETRY_DELAYS = [0, 10_000, 60_000];

const sign = (secret, body) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

async function deliver(hook, event, body, attempt = 0) {
  let status = null;
  let error = null;
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Flyleaf-Webhooks',
        'X-Flyleaf-Event': event,
        'X-Flyleaf-Delivery': crypto.randomUUID(),
        'X-Flyleaf-Signature': sign(hook.secret, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = e.name === 'TimeoutError' ? 'Timed out' : e.message;
  }
  q('UPDATE webhooks SET last_status = ?, last_error = ?, last_at = ? WHERE id = ?').run(status, error, Date.now(), hook.id);
  if (error && attempt + 1 < RETRY_DELAYS.length) {
    setTimeout(() => deliver(hook, event, body, attempt + 1), RETRY_DELAYS[attempt + 1]).unref();
  } else if (error) {
    log.file(`${event} → ${hook.url} failed: ${error}`);
  }
  return { status, error };
}

/** Fire an event to in-process listeners and every enabled webhook subscribed to it. Never throws. */
function emit(event, data) {
  for (const fn of listeners.get(event) || []) {
    try {
      fn(data);
    } catch {}
  }
  let hooks;
  try {
    hooks = q('SELECT * FROM webhooks WHERE enabled = 1').all();
  } catch {
    return;
  }
  const subscribed = hooks.filter((h) => {
    const events = JSON.parse(h.events || '[]');
    return events.includes('*') || events.includes(event);
  });
  if (!subscribed.length) return;
  const body = JSON.stringify({ event, at: new Date().toISOString(), data });
  for (const h of subscribed) deliver(h, event, body).catch(() => {});
}

module.exports = { EVENTS, emit, on, deliver, sign };
