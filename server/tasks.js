'use strict';

// Durable background-task history, separate from the security audit log.
const { q } = require('./db');
function start(kind, title, { userId = null, libraryId = null, total = null } = {}) {
  q("DELETE FROM background_tasks WHERE status IN ('done', 'failed', 'retried') AND id NOT IN (SELECT id FROM background_tasks WHERE status IN ('done', 'failed', 'retried') ORDER BY id DESC LIMIT 500)").run();
  return Number(q(`INSERT INTO background_tasks (kind, title, user_id, library_id, status, total, created_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?)`).run(kind, String(title).slice(0, 300), userId, libraryId, total, Date.now()).lastInsertRowid);
}
function progress(id, done, total = null) {
  q("UPDATE background_tasks SET done = ?, total = ? WHERE id = ? AND status = 'running'").run(done, total, id);
}
function finish(id, error = null) {
  q("UPDATE background_tasks SET status = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'")
    .run(error ? 'failed' : 'done', error ? String(error).slice(0, 500) : null, Date.now(), id);
}
function recover() {
  q("UPDATE background_tasks SET status = 'failed', error = TRIM('Interrupted by a server restart. ' || COALESCE(error, 'The original folder is still in use.')), finished_at = ? WHERE status = 'running' AND kind = 'storage-migration'").run(Date.now());
  q("UPDATE background_tasks SET status = 'failed', error = 'Interrupted by a server restart. Start the task again.', finished_at = ? WHERE status = 'running'").run(Date.now());
}
function list(user) {
  const admin = user.role === 'admin';
  return q(`SELECT * FROM background_tasks WHERE ${admin ? '1 = 1' : 'user_id = ?'}
    ORDER BY status = 'running' DESC, id DESC LIMIT 500`).all(...(admin ? [] : [user.id]));
}
module.exports = { start, progress, finish, recover, list };
