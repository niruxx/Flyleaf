import { api, localDay } from '../api.js';
import { queueProgress, flushProgress } from '../offline.js';
import { session } from '../router.js';

const HEARTBEAT = 30_000;
const IDLE_AFTER = 3 * 60_000; // stop counting after 3 minutes without interaction

/**
 * Tracks active reading time and persists the reading position.
 * Time only counts while the page is visible and the reader has interacted recently.
 */
export class Tracker {
  constructor(bookId, { shared = false, progress } = {}) {
    this.bookId = bookId;
    this.userId = session.user?.id;
    this.shared = shared;
    this.position = null; // { position, page, percent }
    this.savedLocator = progress?.position;
    this.positionAt = progress?.updatedAt;
    this.settings = null;
    this.pendingSeconds = 0;
    this.lastTick = performance.now();
    this.lastActivity = Date.now();
    this.dirty = false;
    this.saveTimer = null;
    if (shared) return;

    this.onActivity = () => {
      this.lastActivity = Date.now();
    };
    this.onVisibility = () => {
      if (document.visibilityState === 'hidden') this.flush(true);
      else {
        this.lastTick = performance.now();
        this.lastActivity = Date.now();
      }
    };
    this.onPageHide = () => this.flush(true);

    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, this.onActivity, { passive: true, capture: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    addEventListener('pagehide', this.onPageHide);
    this.interval = setInterval(() => this.flush(), HEARTBEAT);
  }

  /** Engines call this for activity that happens inside iframes (EPUB). */
  activity() {
    this.lastActivity = Date.now();
  }

  tick() {
    const now = performance.now();
    const elapsed = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - this.lastActivity > IDLE_AFTER) return;
    // Guard against long timer stalls (device sleep).
    this.pendingSeconds += Math.min(elapsed, HEARTBEAT / 1000 + 5);
  }

  /** Record a new position; saved after a short debounce. */
  update(pos) {
    this.position = pos;
    if (pos.position !== this.savedLocator) {
      this.positionAt = Date.now();
      this.savedLocator = pos.position;
    }
    if (this.shared) return;
    this.dirty = true;
    this.lastActivity = Date.now();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 2000);
  }

  saveSettings(settings) {
    if (this.shared) return;
    this.settings = settings;
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 1000);
  }

  async flush(keepalive = false) {
    if (this.shared) return;
    this.tick();
    const seconds = Math.floor(this.pendingSeconds);
    if (!this.dirty && seconds < 1) return;
    const body = { ...(this.position || {}), seconds, syncUserId: this.userId, recordedAt: this.position ? this.positionAt : undefined };
    if (this.settings) body.settings = this.settings;
    this.pendingSeconds -= seconds;
    this.dirty = false;
    try {
      const r = await api.saveProgress(this.bookId, body, { keepalive });
      flushProgress();
      return r;
    } catch (e) {
      if (e.status === 0) {
        // Offline: keep it on this device and send it when the connection's back.
        queueProgress(this.userId, this.bookId, { ...body, day: localDay() });
        return;
      }
      // Put the time back so it's retried on the next heartbeat.
      this.pendingSeconds += seconds;
      this.dirty = true;
    }
  }

  destroy() {
    if (this.shared) return;
    clearInterval(this.interval);
    clearTimeout(this.saveTimer);
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) removeEventListener(ev, this.onActivity, { capture: true });
    document.removeEventListener('visibilitychange', this.onVisibility);
    removeEventListener('pagehide', this.onPageHide);
    return this.flush(true);
  }
}
