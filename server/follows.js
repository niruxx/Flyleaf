'use strict';

// Following Content Finder series: every few hours each followed series' details() is
// fetched again, and files (chapters, volumes) that weren't there before become updates.
// With auto-download on they go straight into the download queue, into the library the
// user picked when they followed it.

const { q, tx } = require('./db');
const { json, similarity } = require('./util');
const manager = require('./plugins/manager');
const downloads = require('./plugins/downloads');
const events = require('./events');
const log = require('./log').logger('follows');

const CHECK_HOURS = Math.max(0, Number(process.env.FOLLOW_CHECK_HOURS ?? 6));
const MAX_NEW_PER_CHECK = 200;
let running = null;

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** The parts of a details() file worth keeping (and queueing). */
const cleanFile = (f) => ({
  id: String(f.id).slice(0, 2000),
  title: f.title == null ? null : String(f.title).slice(0, 200),
  format: f.format == null ? null : String(f.format).slice(0, 20).toLowerCase(),
  volume: num(f.volume),
  chapter: num(f.chapter),
  date: f.date == null ? null : String(f.date).slice(0, 40),
});

/** "Chapter 12", "Vol. 3", or the file's own title. */
function fileLabel(f) {
  if (f.title) return f.title;
  if (f.chapter != null) return `Chapter ${f.chapter}`;
  if (f.volume != null) return `Volume ${f.volume}`;
  return 'New file';
}

/** Whether the follower may still save into the follow's library. */
function canSave(follow) {
  if (!follow.library_id) return false;
  const row = q('SELECT * FROM users WHERE id = ?').get(follow.user_id);
  if (!row) return false;
  const user = require('./auth').toUser(row);
  return user.permissions.contentFinder && require('./util').canWriteLibrary(user, follow.library_id);
}

/**
 * Check one follow: fetch the source again, record files that weren't there, and queue
 * them when auto-download is on. Returns the new files.
 */
async function check(follow) {
  const now = Date.now();
  let details;
  try {
    details = await manager.run(follow.plugin_id, 'details', [follow.source_id]);
  } catch (e) {
    q('UPDATE follows SET last_checked_at = ?, last_error = ? WHERE id = ?').run(now, String(e.message || e).slice(0, 300), follow.id);
    throw e;
  }
  const files = (Array.isArray(details?.files) ? details.files : []).filter((f) => f && f.id != null).map(cleanFile);
  const known = new Set(json(follow.known, []));
  const fresh = files.filter((f) => !known.has(f.id)).slice(0, MAX_NEW_PER_CHECK);
  for (const f of files) known.add(f.id);

  const auto = Boolean(follow.auto_download) && fresh.length > 0 && canSave(follow);
  let ids = [];
  if (auto) {
    ids = downloads.enqueue({
      userId: follow.user_id,
      pluginId: follow.plugin_id,
      libraryId: follow.library_id,
      book: { ...json(follow.book, {}), sourceId: follow.source_id },
      files: fresh,
    });
  }
  tx(() => {
    fresh.forEach((f, i) => {
      q('INSERT INTO follow_updates (follow_id, user_id, file, download_id, queued, found_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(follow.id, follow.user_id, JSON.stringify(f), ids[i] ?? null, ids[i] ? 1 : 0, now);
    });
    q(`UPDATE follows SET known = ?, last_checked_at = ?, last_error = NULL, cover = COALESCE(?, cover)
       ${fresh.length ? ', last_new_at = ?' : ''} WHERE id = ?`)
      .run(JSON.stringify([...known]), now, typeof details?.cover === 'string' ? details.cover.slice(0, 4000) : null, ...(fresh.length ? [now] : []), follow.id);
  });
  if (fresh.length) {
    log.file(`${follow.title}: ${fresh.length} new (${auto ? 'queued' : 'not downloaded'})`);
    events.emit('series.updated', {
      userId: follow.user_id,
      followId: follow.id,
      title: follow.title,
      plugin: follow.plugin_id,
      count: fresh.length,
      files: fresh.slice(0, 20).map(fileLabel),
      downloading: auto,
    });
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// Matching downloads to their sources: everything a user downloaded with Content Finder
// becomes a follow, so chapters newer than the newest one they have show up as updates.

const numberOf = (f) => f.chapter ?? f.volume ?? null;

/** Find a series on its source by title (for downloads made before sources were remembered). */
async function findOnSource(pluginId, title) {
  const r = await manager.run(pluginId, 'search', [title, 1]);
  const items = (Array.isArray(r?.items) ? r.items : []).filter((i) => i && i.id != null && !i.folder);
  let best = null;
  for (const i of items.slice(0, 20)) {
    const score = similarity(i.title, title);
    if (!best || score > best.score) best = { id: String(i.id), title: i.title, score };
  }
  return best && best.score >= 0.85 ? best : null;
}

/**
 * Follow one downloaded series: g = { pluginId, sourceId, title, items (the downloads' items),
 * libraryId }. Files newer than the newest one downloaded become updates straight away (and
 * download, with auto-download on). Returns { id, found }.
 */
async function followGroup(userId, g, { autoDownload = false } = {}) {
  const details = await manager.run(g.pluginId, 'details', [g.sourceId]);
  const files = (Array.isArray(details?.files) ? details.files : []).filter((f) => f && f.id != null).map(cleanFile);
  const have = new Set(g.items.map((i) => i.fileId).filter(Boolean).map(String));
  const newest = Math.max(-Infinity, ...g.items.map(numberOf).filter((n) => n != null));
  // Already have it, or it's older than what they have: seen. Newer and not downloaded: an update.
  const fresh = Number.isFinite(newest) ? files.filter((f) => !have.has(f.id) && numberOf(f) != null && numberOf(f) > newest) : [];
  const freshIds = new Set(fresh.map((f) => f.id));
  const last = g.items.at(-1) || {};
  const book = { title: last.bookTitle || last.title || g.title, author: last.author || null, series: last.series || null, ageRating: last.ageRating ?? null, layout: last.layout || null };
  const { lastInsertRowid } = q(`INSERT INTO follows (user_id, plugin_id, source_id, library_id, title, cover, book, known, auto_download, created_at, last_checked_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                 ON CONFLICT (user_id, plugin_id, source_id) DO UPDATE SET auto_download = excluded.auto_download, library_id = COALESCE(excluded.library_id, library_id)`).run(
    userId, g.pluginId, g.sourceId, g.libraryId ?? null, String(details?.series || details?.title || g.title).slice(0, 300),
    typeof details?.cover === 'string' ? details.cover.slice(0, 4000) : null, JSON.stringify(book),
    // Unseen newer files stay out of "known" so check() reports them as updates right away.
    JSON.stringify(files.filter((f) => !freshIds.has(f.id)).map((f) => f.id)),
    autoDownload ? 1 : 0, Date.now(), Date.now(),
  );
  const row = q('SELECT * FROM follows WHERE user_id = ? AND plugin_id = ? AND source_id = ?').get(userId, g.pluginId, g.sourceId);
  const found = fresh.length ? (await check(row)).length : 0;
  return { id: row?.id ?? Number(lastInsertRowid), found };
}

/**
 * Turn a user's downloaded series into follows. For each one, files newer than the newest
 * chapter (or volume) they downloaded become updates; older files they skipped don't.
 * Returns { series, followed, found, unmatched: [titles] }.
 */
async function syncDownloads(userId, { autoDownload = false } = {}) {
  const rows = q("SELECT * FROM downloads WHERE user_id = ? AND status = 'done' ORDER BY id").all(userId);
  const groups = new Map();
  for (const d of rows) {
    const item = json(d.item, {});
    const title = item.series || item.bookTitle || item.title || d.title;
    const key = `${d.plugin_id}\n${item.sourceId || `title:${String(title).toLowerCase()}`}`;
    const g = groups.get(key) || { pluginId: d.plugin_id, sourceId: item.sourceId || null, title, items: [], libraryId: d.library_id };
    g.items.push(item);
    g.libraryId = d.library_id ?? g.libraryId;
    groups.set(key, g);
  }

  const result = { series: groups.size, followed: 0, found: 0, unmatched: [], created: [] };
  for (const g of groups.values()) {
    try {
      // Books (one file each) have no chapters to wait for.
      if (g.items.every((i) => numberOf(i) == null) && g.items.length < 2) continue;
      if (!g.sourceId) {
        const hit = await findOnSource(g.pluginId, g.title);
        if (!hit) {
          result.unmatched.push(g.title);
          continue;
        }
        g.sourceId = hit.id;
      }
      if (q('SELECT 1 FROM follows WHERE user_id = ? AND plugin_id = ? AND source_id = ?').get(userId, g.pluginId, g.sourceId)) continue;
      const r = await followGroup(userId, g, { autoDownload });
      result.followed++;
      result.created.push(r.id);
      result.found += r.found;
    } catch (e) {
      log.file(`Couldn't match ${g.title} on ${g.pluginId}: ${e.message}`);
      result.unmatched.push(g.title);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return result;
}

const wantsWatch = (row) => {
  try {
    return JSON.parse(row.prefs || '{}').watchDownloads !== false;
  } catch {
    return true;
  }
};

/**
 * Check every follow (or one user's), one at a time so sources aren't hammered. People who
 * keep "Watch my downloads" on also get their newly downloaded series matched first.
 */
async function checkAll(userId = null) {
  if (running) return running;
  running = (async () => {
    const users = q(`SELECT id, prefs FROM users ${userId ? 'WHERE id = ?' : ''}`).all(...(userId ? [userId] : []));
    let found = 0;
    const fresh = new Set();
    for (const u of users.filter(wantsWatch)) {
      try {
        const r = await syncDownloads(u.id);
        found += r.found;
        r.created.forEach((id) => fresh.add(id));
      } catch (e) {
        log.file(`Couldn't match downloads for user ${u.id}: ${e.message}`);
      }
    }
    // Follows just created by the sync were checked already.
    const list = q(`SELECT * FROM follows ${userId ? 'WHERE user_id = ?' : ''} ORDER BY COALESCE(last_checked_at, 0)`).all(...(userId ? [userId] : [])).filter((f) => !fresh.has(f.id));
    for (const f of list) {
      try {
        found += (await check(f)).length;
      } catch (e) {
        log.file(`Couldn't check ${f.title}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { checked: list.length, found };
  })().finally(() => {
    running = null;
  });
  return running;
}

function start() {
  if (!CHECK_HOURS) return;
  // First check a few minutes after start-up, then on the schedule.
  setTimeout(() => checkAll().catch(() => {}), 3 * 60_000).unref();
  setInterval(() => checkAll().catch(() => {}), CHECK_HOURS * 3600_000).unref();
}

module.exports = { check, checkAll, syncDownloads, followGroup, start, cleanFile, fileLabel, CHECK_HOURS, isRunning: () => Boolean(running) };
