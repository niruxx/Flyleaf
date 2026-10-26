'use strict';

// The activity log: who signed in (or failed to), downloaded, uploaded, deleted or changed
// what, and when. One middleware watches the API and records the requests listed in RULES
// once they've succeeded; names (a book's title, a user's name) are looked up before the
// request runs, so a deletion still says what was deleted. Entries older than ACTIVITY_DAYS
// (default 180) are removed.
//
// Failed sign-ins also raise alerts: the admins get a notification when one address or one
// account keeps failing, at most once an hour for each.

const { q } = require('./db');
const log = require('./log').logger('activity');

const KEEP_DAYS = Math.max(1, Number(process.env.ACTIVITY_DAYS) || 180);
const ALERT_AFTER = 5; // failures in ALERT_WINDOW
const ALERT_WINDOW = 15 * 60_000;
const ALERT_EVERY = 3600_000;

// What a request is about, named before it runs.
const name = {
  book: (id) => {
    const b = q('SELECT title, series FROM books WHERE id = ?').get(Number(id));
    return b ? (b.series && b.series !== b.title ? `${b.series} · ${b.title}` : b.title) : `Book #${id}`;
  },
  series: (id) => q('SELECT name FROM series WHERE id = ?').get(Number(id))?.name || `Series #${id}`,
  user: (id) => q('SELECT username FROM users WHERE id = ?').get(Number(id))?.username || `User #${id}`,
  library: (id) => q('SELECT name FROM libraries WHERE id = ?').get(Number(id))?.name || `Library #${id}`,
};

/**
 * [method, path pattern, action, target(req, match) → text, details(req, res) → object]
 * Paths are relative to /api. Only successful requests (status < 400) are recorded, except
 * sign-ins, which are recorded either way.
 */
const RULES = [
  ['POST', /^\/login$/, 'login', (req) => String(req.body?.username || '').slice(0, 100)],
  ['POST', /^\/logout$/, 'logout'],
  ['POST', /^\/register$/, 'signup', (req) => String(req.body?.username || '').slice(0, 100)],
  ['POST', /^\/setup$/, 'setup', (req) => String(req.body?.username || '').slice(0, 100)],
  ['POST', /^\/me\/password$/, 'password.changed'],
  ['POST', /^\/users$/, 'user.created', (req) => String(req.body?.username || '')],
  ['PATCH', /^\/users\/(\d+)$/, 'user.updated', (req, m) => name.user(m[1]), (req) => ({ fields: Object.keys(req.body || {}).filter((k) => k !== 'password') })],
  ['DELETE', /^\/users\/(\d+)$/, 'user.deleted', (req, m) => name.user(m[1])],
  ['DELETE', /^\/users\/(\d+)\/sessions$/, 'user.signed_out', (req, m) => name.user(m[1])],
  ['POST', /^\/users\/(\d+)\/files\/delete$/, 'moderation.deleted', (req, m) => name.user(m[1]), (req, res) => ({ count: res.locals.body?.deleted })],
  ['GET', /^\/books\/(\d+)\/download$/, 'book.downloaded', (req, m) => name.book(m[1])],
  ['GET', /^\/series\/(\d+)\/download$/, 'series.downloaded', (req, m) => name.series(m[1])],
  ['POST', /^\/books\/(\d+)\/send$/, 'book.sent', (req, m) => name.book(m[1])],
  ['POST', /^\/series\/(\d+)\/send$/, 'series.sent', (req, m) => name.series(m[1])],
  ['DELETE', /^\/books\/(\d+)$/, 'book.deleted', (req, m) => name.book(m[1])],
  ['DELETE', /^\/series\/(\d+)$/, 'series.deleted', (req, m) => name.series(m[1])],
  ['POST', /^\/books\/(\d+)\/move$/, 'book.moved', (req, m) => name.book(m[1]), (req) => ({ to: name.library(req.body?.libraryId) })],
  ['POST', /^\/series\/(\d+)\/move$/, 'series.moved', (req, m) => name.series(m[1]), (req) => ({ to: name.library(req.body?.libraryId) })],
  ['POST', /^\/finder\/([^/]+)\/download$/, 'finder.download', (req) => String(req.body?.book?.title || ''),
    (req, res, m) => ({ source: decodeURIComponent(m[1]), files: req.body?.files?.length || 0, library: name.library(req.body?.libraryId) })],
  ['POST', /^\/uploads\/done$/, 'upload', (req) => name.library(req.body?.libraryId), (req) => ({ files: (req.body?.files || []).length, sample: (req.body?.files || []).slice(0, 5) })],
  ['POST', /^\/libraries$/, 'library.created', (req) => String(req.body?.name || ''), (req) => ({ path: req.body?.path })],
  ['PATCH', /^\/libraries\/(\d+)$/, 'library.updated', (req, m) => name.library(m[1])],
  ['DELETE', /^\/libraries\/(\d+)$/, 'library.deleted', (req, m) => name.library(m[1])],
  ['POST', /^\/me\/libraries$/, 'library.created', (req) => String(req.body?.name || '')],
  ['DELETE', /^\/me\/libraries\/(\d+)$/, 'library.deleted', (req, m) => name.library(m[1])],
  ['PUT', /^\/admin\/settings$/, 'settings.changed', () => 'Server settings', (req) => ({ sections: Object.keys(req.body || {}) })],
  ['POST', /^\/api-keys$/, 'apikey.created', (req) => String(req.body?.name || '')],
  ['DELETE', /^\/api-keys\/(\d+)$/, 'apikey.deleted'],
  ['GET', /^\/admin\/backup$/, 'backup.downloaded', (req) => (req.query.books === '1' ? 'With books' : 'Database')],
  ['POST', /^\/admin\/backups\/run$/, 'backup.created'],
  ['POST', /^\/admin\/restore\/[^/]+$/, 'backup.restored'],
  ['POST', /^\/admin\/backups\/([^/]+)\/restore$/, 'backup.restored', (req, m) => decodeURIComponent(m[1])],
  ['POST', /^\/admin\/duplicates\/merge$/, 'duplicates.merged', (req) => name.book(req.body?.keep), (req) => ({ removed: (req.body?.remove || []).length })],
  ['POST', /^\/admin\/plugins$/, 'plugin.installed', (req) => String(req.body?.id || req.body?.url || 'uploaded file')],
  ['DELETE', /^\/admin\/plugins\/([^/]+)$/, 'plugin.removed', (req, m) => decodeURIComponent(m[1])],
  ['POST', /^\/finder\/follows$/, 'follow.added', (req) => String(req.body?.book?.series || req.body?.book?.title || '')],
  ['POST', /^\/finder\/series\/(\d+)\/follow$/, 'follow.added', (req, m) => name.series(m[1]), (req) => ({ autoDownload: req.body?.autoDownload !== false })],
];

const insert = (entry) => {
  try {
    q('INSERT INTO activity_log (at, user_id, username, ip, action, target, details) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      Date.now(), entry.userId ?? null, entry.username ?? null, entry.ip ?? null, entry.action,
      entry.target == null ? null : String(entry.target).slice(0, 300),
      entry.details && Object.keys(entry.details).length ? JSON.stringify(entry.details).slice(0, 2000) : null,
    );
  } catch (e) {
    log.file(`Couldn't record ${entry.action}: ${e.message}`);
  }
};

/** Record something that didn't come through the API (OPDS downloads, scheduled jobs…). */
function record(user, action, target = null, details = null, ip = null) {
  insert({ userId: user?.id ?? null, username: user?.username ?? null, ip, action, target, details });
}

/** Express middleware: put it after the session middleware so req.user is known. */
function middleware(req, res, next) {
  const rule = RULES.find(([method, re]) => method === req.method && re.test(req.path));
  if (!rule) return next();
  const [, re, action, target, details] = rule;
  const m = req.path.match(re);
  let targetText = null;
  try {
    targetText = target ? target(req, m) : null;
  } catch {}
  // Keep a copy of JSON responses for details that depend on the result.
  const json = res.json.bind(res);
  res.json = (body) => {
    res.locals.body = body;
    return json(body);
  };
  res.on('finish', () => {
    const ok = res.statusCode < 400;
    const base = { ip: req.ip, target: targetText };
    if (action === 'login') {
      const who = res.statusCode < 400 ? q('SELECT id, username FROM users WHERE username = ? OR email = ?').get(targetText, targetText) : null;
      if (ok) insert({ ...base, action: 'login', userId: who?.id, username: who?.username || targetText, details: { agent: String(req.get('user-agent') || '').slice(0, 200) } });
      else if (res.statusCode === 429) {
        insert({ ...base, action: 'login.blocked', username: targetText });
        failedLogin(req.ip, targetText, true);
      } else {
        insert({ ...base, action: 'login.failed', username: targetText });
        failedLogin(req.ip, targetText, false);
      }
      return;
    }
    if (!ok) return;
    let extra = null;
    try {
      extra = details ? details(req, res, m) : null;
    } catch {}
    insert({ ...base, action, userId: req.user?.id, username: req.user?.username || (action === 'signup' || action === 'setup' ? targetText : null), details: extra });
  });
  next();
}

// ---------------------------------------------------------------------------
// Failed sign-in alerts

const lastAlert = new Map(); // key → time

function failedLogin(ip, username, blocked) {
  const since = Date.now() - ALERT_WINDOW;
  const byIp = q("SELECT COUNT(*) AS n FROM activity_log WHERE action IN ('login.failed', 'login.blocked') AND ip = ? AND at > ?").get(ip, since).n;
  const byUser = username
    ? q("SELECT COUNT(*) AS n FROM activity_log WHERE action IN ('login.failed', 'login.blocked') AND username = ? AND at > ?").get(username, since).n
    : 0;
  const alerts = [];
  if (blocked || byIp >= ALERT_AFTER) {
    alerts.push([`ip:${ip}`, blocked ? `Sign-ins blocked for ${ip}` : `${byIp} failed sign-ins from ${ip}`,
      `In the last 15 minutes${username ? `, most recently as “${username}”` : ''}. ${blocked ? 'That address is blocked for 15 minutes.' : 'It’s blocked after 10.'}`]);
  }
  const account = username && q('SELECT id FROM users WHERE username = ? OR email = ?').get(username, username);
  if (account && byUser >= ALERT_AFTER) {
    alerts.push([`user:${username}`, `${byUser} failed sign-ins to “${username}”`, 'Someone may be guessing this account’s password. Check Settings → Activity.']);
  }
  for (const [key, title, body] of alerts) {
    if (Date.now() - (lastAlert.get(key) || 0) < ALERT_EVERY) continue;
    lastAlert.set(key, Date.now());
    const push = require('./push');
    for (const admin of q("SELECT id FROM users WHERE role = 'admin'").all()) {
      push.notify(admin.id, { title, body, url: '/#/settings/activity', tag: key }, 'security');
    }
  }
}

// ---------------------------------------------------------------------------
// Reading the log

const ACTIONS = {
  login: 'Signed in', 'login.failed': 'Failed sign-in', 'login.blocked': 'Sign-in blocked', logout: 'Signed out', signup: 'Signed up', setup: 'Set up Flyleaf',
  'password.changed': 'Changed password', 'user.created': 'Created user', 'user.updated': 'Edited user', 'user.deleted': 'Deleted user', 'user.signed_out': 'Signed a user out',
  'moderation.deleted': 'Deleted a user’s files', 'book.downloaded': 'Downloaded', 'series.downloaded': 'Downloaded series', 'book.sent': 'Sent to device', 'series.sent': 'Sent series to device',
  'book.deleted': 'Deleted book', 'series.deleted': 'Deleted series', 'book.moved': 'Moved book', 'series.moved': 'Moved series',
  'finder.download': 'Content Finder download', upload: 'Uploaded', 'library.created': 'Added library', 'library.updated': 'Edited library', 'library.deleted': 'Removed library',
  'settings.changed': 'Changed settings', 'apikey.created': 'Created API key', 'apikey.deleted': 'Deleted API key',
  'backup.downloaded': 'Downloaded backup', 'backup.created': 'Made backup', 'backup.restored': 'Restored backup', 'duplicates.merged': 'Merged duplicates',
  'plugin.installed': 'Installed plugin', 'plugin.removed': 'Removed plugin', 'follow.added': 'Followed series', 'opds.download': 'Downloaded (OPDS)',
};
const GROUPS = {
  security: ['login', 'login.failed', 'login.blocked', 'logout', 'signup', 'setup', 'password.changed', 'apikey.created', 'apikey.deleted', 'user.signed_out'],
  downloads: ['book.downloaded', 'series.downloaded', 'book.sent', 'series.sent', 'finder.download', 'opds.download', 'follow.added'],
  changes: ['upload', 'book.deleted', 'series.deleted', 'book.moved', 'series.moved', 'moderation.deleted', 'duplicates.merged'],
  admin: ['user.created', 'user.updated', 'user.deleted', 'library.created', 'library.updated', 'library.deleted', 'settings.changed', 'backup.downloaded', 'backup.created', 'backup.restored', 'plugin.installed', 'plugin.removed'],
};

/** Entries, newest first. Filters: user (id), group, action, q (text), before (id, for paging). */
function list({ user, group, action, q: text, before, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (user) {
    where.push('user_id = ?');
    args.push(Number(user));
  }
  const actions = action ? [action] : GROUPS[group];
  if (actions) {
    where.push(`action IN (${actions.map(() => '?').join(',')})`);
    args.push(...actions);
  }
  if (text) {
    where.push("(target LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\')");
    const like = `%${String(text).replace(/[\\%_]/g, '\\$&')}%`;
    args.push(like, like, like);
  }
  if (before) {
    where.push('id < ?');
    args.push(Number(before));
  }
  const rows = q(`SELECT * FROM activity_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(Number(limit) || 100, 500));
  return rows.map((r) => ({
    id: r.id, at: r.at, userId: r.user_id, username: r.username, ip: r.ip, action: r.action, label: ACTIONS[r.action] || r.action,
    target: r.target, details: r.details ? JSON.parse(r.details) : null,
  }));
}

/** Failed sign-ins in the last day, by address and by name, plus who's blocked right now. */
function security() {
  const since = Date.now() - 86400_000;
  const failed = "action IN ('login.failed', 'login.blocked') AND at > ?";
  return {
    failed24h: q(`SELECT COUNT(*) AS n FROM activity_log WHERE ${failed}`).get(since).n,
    signins24h: q("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'login' AND at > ?").get(since).n,
    byIp: q(`SELECT ip, COUNT(*) AS n, MAX(at) AS last, GROUP_CONCAT(DISTINCT username) AS names FROM activity_log WHERE ${failed} GROUP BY ip ORDER BY n DESC LIMIT 10`).all(since)
      .map((r) => ({ ip: r.ip, count: r.n, last: r.last, usernames: (r.names || '').split(',').filter(Boolean).slice(0, 5) })),
    byUsername: q(`SELECT username, COUNT(*) AS n, MAX(at) AS last, (SELECT 1 FROM users u WHERE u.username = a.username) AS real FROM activity_log a WHERE ${failed} AND username IS NOT NULL AND username != '' GROUP BY username ORDER BY n DESC LIMIT 10`).all(since)
      .map((r) => ({ username: r.username, count: r.n, last: r.last, exists: Boolean(r.real) })),
    blocked: require('./auth').blockedIps(),
  };
}

function prune() {
  q('DELETE FROM activity_log WHERE at < ?').run(Date.now() - KEEP_DAYS * 86400_000);
}
function start() {
  prune();
  setInterval(prune, 86400_000).unref();
}

module.exports = { middleware, record, list, security, start, ACTIONS, GROUPS, KEEP_DAYS };
