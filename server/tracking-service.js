'use strict';

const crypto = require('node:crypto');

// Dependencies are explicit so migrations, delivery and races can be tested without accounts.
function createTracking({ q, tx, providers, events, getUser, canRead }) {
  let timer = null, busy = false, unsubscribe = [];
  const refreshing = new Map();
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const account = (uid, provider) => q('SELECT * FROM tracking_accounts WHERE user_id = ? AND provider = ?').get(uid, provider);
  const connected = (a) => account(a.user_id, a.provider)?.generation === a.generation;
  function accounts(uid) {
    return Object.entries(providers.DEFINITIONS).map(([id, def]) => {
      const a = account(uid, id);
      return { provider: id, name: def.name, auth: def.login ? 'login' : 'oauth', configured: providers.configured(id),
        connected: Boolean(a), username: a?.username || null, pullEnabled: Boolean(a?.pull_enabled),
        lastSyncAt: a?.last_sync_at || null, lastError: a?.last_error || null,
        pending: q('SELECT COUNT(*) AS n FROM tracking_queue WHERE user_id = ? AND provider = ?').get(uid, id).n };
    });
  }
  function begin(uid, provider) {
    if (!providers.configured(provider) || providers.DEFINITIONS[provider]?.login) throw new Error('Configure this tracking service on the server first.');
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(64).toString('base64url');
    tx(() => {
      q('DELETE FROM tracking_oauth WHERE expires_at < ? OR (user_id = ? AND provider = ?)').run(Date.now(), uid, provider);
      q('INSERT INTO tracking_oauth (state_hash, user_id, provider, verifier, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(hash(state), uid, provider, verifier, Date.now() + 600_000);
    });
    return providers.authorizationUrl(provider, state, verifier);
  }
  function saveAccount(uid, provider, identity, tokens) {
    q(`INSERT INTO tracking_accounts (user_id, provider, remote_id, username, access_token, refresh_token, expires_at, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, provider) DO UPDATE SET remote_id=excluded.remote_id, username=excluded.username,
       access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at,
       generation=excluded.generation, last_error=NULL, pull_enabled=0, last_sync_at=NULL`)
      .run(uid, provider, identity.id, identity.name, tokens.accessToken, tokens.refreshToken, tokens.expiresAt, crypto.randomUUID());
    q('DELETE FROM tracking_queue WHERE user_id = ? AND provider = ?').run(uid, provider);
  }
  async function finish(uid, provider, state, code, denied = false) {
    if (typeof state !== 'string' || state.length > 200 || (!denied && (typeof code !== 'string' || !code || code.length > 4000))) throw new Error('Invalid tracking authorization response.');
    const pending = q(`UPDATE tracking_oauth SET claimed=1 WHERE state_hash=? AND user_id=? AND provider=? AND expires_at>? AND claimed=0 RETURNING *`)
      .get(hash(state), uid, provider, Date.now());
    if (!pending) throw new Error('Authorization expired or already used. Try connecting again.');
    try {
      if (denied) throw new Error('Authorization was cancelled.');
      const tokens = await providers.redeem(provider, code, pending.verifier);
      const user = await providers.identity(provider, tokens.accessToken);
      tx(() => {
        const consumed = q('DELETE FROM tracking_oauth WHERE state_hash=? AND user_id=? AND expires_at>? RETURNING state_hash').get(pending.state_hash, uid, Date.now());
        if (!consumed) throw new Error('Authorization expired or was cancelled.');
        saveAccount(uid, provider, user, tokens);
      });
    } finally { q('DELETE FROM tracking_oauth WHERE state_hash=?').run(pending.state_hash); }
  }
  async function login(uid, provider, username, password) {
    const state = crypto.randomBytes(32).toString('base64url');
    tx(() => {
      q('DELETE FROM tracking_oauth WHERE user_id=? AND provider=?').run(uid, provider);
      q('INSERT INTO tracking_oauth (state_hash,user_id,provider,expires_at,claimed) VALUES (?,?,?,?,1)')
        .run(hash(state), uid, provider, Date.now() + 600_000);
    });
    try {
      const tokens = await providers.login(provider, username, password);
      const user = await providers.identity(provider, tokens.accessToken);
      tx(() => {
        if (!q('DELETE FROM tracking_oauth WHERE state_hash=? AND expires_at>? RETURNING state_hash').get(hash(state), Date.now())) throw new Error('Connection cancelled.');
        saveAccount(uid, provider, user, tokens);
      });
    } finally { q('DELETE FROM tracking_oauth WHERE state_hash=?').run(hash(state)); }
  }
  function disconnect(uid, provider) {
    tx(() => {
      q('DELETE FROM tracking_oauth WHERE user_id=? AND provider=?').run(uid, provider);
      q('DELETE FROM tracking_accounts WHERE user_id=? AND provider=?').run(uid, provider);
    });
  }
  function setPull(uid, provider, enabled) {
    q('UPDATE tracking_accounts SET pull_enabled=? WHERE user_id=? AND provider=?').run(enabled ? 1 : 0, uid, provider);
  }
  function enqueue(uid, seriesId, provider = null, pullOnly = false) {
    const s = q('SELECT * FROM series WHERE id=?').get(seriesId);
    const user = getUser(uid);
    if (!s || !user || !canRead(s.id, user)) return 0;
    let count = 0;
    for (const a of q('SELECT provider FROM tracking_accounts WHERE user_id=?').all(uid)) {
      if ((provider && a.provider !== provider) || !providers.mediaId(s, a.provider)) continue;
      q(`INSERT INTO tracking_queue (user_id,provider,series_id,next_at,pull_only) VALUES (?,?,?,?,?)
         ON CONFLICT (user_id,provider,series_id) DO UPDATE SET revision=revision+1,attempts=0,next_at=excluded.next_at,
         pull_only=MIN(pull_only,excluded.pull_only)`).run(uid, a.provider, seriesId, Date.now(), pullOnly ? 1 : 0);
      count++;
    }
    return count;
  }
  function pull(uid, provider) {
    if (!account(uid, provider)) throw new Error('Connect this tracking account first.');
    let count = 0;
    for (const s of q('SELECT id FROM series').all()) count += enqueue(uid, s.id, provider, true);
    return count;
  }
  async function fresh(a, force = false) {
    if (!force && (!a.expires_at || a.expires_at > Date.now() + 60_000)) return a;
    if (!a.refresh_token) throw new providers.TrackerError(401);
    const key = `${a.user_id}:${a.provider}:${a.generation}`;
    if (!refreshing.has(key)) refreshing.set(key, (async () => {
      const tokens = await providers.refresh(a.provider, a.refresh_token);
      q(`UPDATE tracking_accounts SET access_token=?,refresh_token=?,expires_at=? WHERE user_id=? AND provider=? AND generation=?`)
        .run(tokens.accessToken, tokens.refreshToken || a.refresh_token, tokens.expiresAt, a.user_id, a.provider, a.generation);
      return { ...a, access_token: tokens.accessToken, refresh_token: tokens.refreshToken || a.refresh_token, expires_at: tokens.expiresAt };
    })().finally(() => refreshing.delete(key)));
    return refreshing.get(key);
  }
  function importEntry(a, sid, entry) {
    if (!connected(a)) return;
    const status = providers.importedStatus(a.provider, entry.status);
    const score = Number(entry.score);
    tx(() => {
      if (status) q(`INSERT INTO user_series (user_id,series_id,status,updated_at) VALUES (?,?,?,?)
        ON CONFLICT (user_id,series_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at`).run(a.user_id, sid, status, Date.now());
      // Both local half-stars and normalized remote scores use a 1..10 scale.
      if (score > 0 && score <= 10) q(`INSERT INTO series_reviews (user_id,series_id,rating,created_at,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT (user_id,series_id) DO UPDATE SET rating=excluded.rating,updated_at=excluded.updated_at`)
        .run(a.user_id, sid, Math.max(1, Math.round(score)), Date.now(), Date.now());
    });
  }
  async function sync(job) {
    let a = account(job.user_id, job.provider);
    const s = q('SELECT * FROM series WHERE id=?').get(job.series_id);
    const user = getUser(job.user_id);
    const id = s && providers.mediaId(s, job.provider);
    if (!a || !id || !user || !canRead(s.id, user)) return;
    a = await fresh(a);
    if (!connected(a)) return;
    let remote;
    try { remote = await providers.readEntry(job.provider, a, id); }
    catch (e) {
      if (e.status !== 401 || !a.refresh_token || !connected(a)) throw e;
      a = await fresh(a, true);
      if (!connected(a)) return;
      remote = await providers.readEntry(job.provider, a, id);
    }
    if (!connected(a)) return;
    if (job.pull_only) importEntry(a, s.id, remote);
    else {
      const books = q(`SELECT b.chapter,b.volume,b.special,b.missing,p.finished FROM books b
        LEFT JOIN progress p ON p.book_id=b.id AND p.user_id=? WHERE b.series_id=?`).all(a.user_id, s.id);
      const local = providers.localProgress(books);
      if (local.chapters || local.volumes) {
        const update = providers.progressUpdate(a.provider, local, remote);
        await providers.writeEntry(a.provider, a, id, update, remote);
        if (account(a.user_id, a.provider)?.pull_enabled) importEntry(a, s.id, { ...remote, status: update.status });
      }
    }
    q('UPDATE tracking_accounts SET last_sync_at=?,last_error=NULL WHERE user_id=? AND provider=? AND generation=?')
      .run(Date.now(), a.user_id, a.provider, a.generation);
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const job = q('SELECT * FROM tracking_queue WHERE next_at<=? ORDER BY next_at LIMIT 1').get(Date.now());
      if (!job) return;
      const generation = account(job.user_id, job.provider)?.generation;
      try {
        await sync(job);
        if (account(job.user_id, job.provider)?.generation !== generation) return;
        q('DELETE FROM tracking_queue WHERE user_id=? AND provider=? AND series_id=? AND revision=?').run(job.user_id, job.provider, job.series_id, job.revision);
      } catch (e) {
        if (account(job.user_id, job.provider)?.generation !== generation) return;
        // Never store upstream response bodies or token-bearing error messages.
        const message = e instanceof providers.TrackerError ? e.message : 'Tracking service unavailable. Delivery will retry.';
        q('UPDATE tracking_accounts SET last_error=? WHERE user_id=? AND provider=? AND generation=?').run(message, job.user_id, job.provider, generation);
        const delay = Math.max(e.retryAfter || 0, Math.min(3600_000, 30_000 * 2 ** Math.min(job.attempts, 7)));
        q('UPDATE tracking_queue SET attempts=attempts+1,next_at=? WHERE user_id=? AND provider=? AND series_id=? AND revision=?')
          .run(Date.now() + delay, job.user_id, job.provider, job.series_id, job.revision);
      }
    } finally { busy = false; }
  }
  function start() {
    if (timer) return;
    unsubscribe = [events.on('book.finished', ({ userId, bookId }) => {
      const sid = q('SELECT series_id FROM books WHERE id=?').get(bookId)?.series_id;
      if (sid) enqueue(userId, sid);
    })];
    timer = setInterval(() => tick().catch(() => {}), 8000);
    timer.unref();
    tick().catch(() => {});
  }
  function stop() { clearInterval(timer); timer = null; unsubscribe.forEach((fn) => fn()); unsubscribe = []; }
  return { accounts, begin, finish, login, disconnect, setPull, enqueue, pull, tick, start, stop };
}
module.exports = { createTracking };
