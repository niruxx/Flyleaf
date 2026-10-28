'use strict';

// Shared progress writes for clients whose native locators cannot be used by Foliate.
const { q } = require('./db');
const events = require('./events');

function saveProgress(user, book, { percent, page = null, finished = percent >= 0.999 }) {
  const before = q('SELECT * FROM progress WHERE user_id = ? AND book_id = ?').get(user.id, book.id);
  const now = Math.max(Date.now(), (before?.updated_at || 0) + 1);
  q(`INSERT INTO progress (user_id, book_id, percent, page, finished, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, book_id) DO UPDATE SET
    percent = excluded.percent, page = excluded.page, position = NULL, finished = excluded.finished, updated_at = excluded.updated_at`)
    .run(user.id, book.id, percent, page, finished ? 1 : 0, now, now);
  events.emit('progress.updated', { userId: user.id, username: user.username, bookId: book.id, percent, page, finished });
  if (finished && !before?.finished) events.emit('book.finished', { userId: user.id, username: user.username, bookId: book.id });
  return now;
}

function store(user, client, document, bookId, data, now = Date.now()) {
  q(`INSERT INTO client_positions (user_id, client, document, book_id, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, client, document) DO UPDATE SET book_id = excluded.book_id, data = excluded.data, updated_at = excluded.updated_at`)
    .run(user.id, client, document, bookId, JSON.stringify(data), now);
}

const load = (user, client, document) => q('SELECT * FROM client_positions WHERE user_id = ? AND client = ? AND document = ?').get(user.id, client, document);
module.exports = { saveProgress, store, load };
