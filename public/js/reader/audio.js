// Audiobook player: one file (M4B with chapters, MP3…) or a folder of tracks, played as one book.
// Progress is a position across all tracks ("track:seconds"), saved like reading progress, so
// stats, Continue reading and syncing between devices work the same as for books.

import { api } from '../api.js';
import { h, icon, iconButton, menu, cover, formatDuration } from '../ui.js';

const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
const SLEEP = [[15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], ['chapter', 'End of chapter']];
const SPEED_KEY = 'flyleaf.audioSpeed';

const clock = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
};

export class AudioEngine {
  constructor(book, shell, tracker) {
    this.book = book;
    this.shell = shell;
    this.tracker = tracker;
    this.toc = [];
    this.track = 0;
    this.durations = [];
    this.offsets = [];
    this.total = 0;
    this.sleep = null;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.cleanups = [];
  }

  scrollMode() {
    return false;
  }

  async open(startLocator) {
    this.shell.setLoading(true);
    const info = await api.audioTracks(this.book.id);
    this.tracks = info.tracks;
    if (!this.tracks.length) throw new Error('This audiobook has no audio files.');
    this.chapters = info.chapters;
    this.buildUi();
    await this.measure(info.duration);

    try {
      const speed = Number(localStorage.getItem(SPEED_KEY));
      if (SPEEDS.includes(speed)) this.setSpeed(speed);
    } catch {}

    const a = this.audio;
    const on = (ev, fn) => {
      a.addEventListener(ev, fn);
      this.cleanups.push(() => a.removeEventListener(ev, fn));
    };
    on('timeupdate', () => this.onTime());
    on('play', () => this.drawPlaying());
    on('pause', () => {
      this.drawPlaying();
      this.save();
    });
    on('ended', () => this.onEnded());
    on('error', () => {
      if (a.src) this.el.status.textContent = 'Couldn’t play this track.';
    });

    // Start where you left off.
    const saved = startLocator || (this.book.progress && !this.book.progress.finished ? this.book.progress.position : null);
    const [t, sec] = String(saved || '0:0').split(':').map(Number);
    await this.load(Number.isFinite(t) ? Math.min(t, this.tracks.length - 1) : 0, Number.isFinite(sec) ? sec : 0);

    this.shell.setSlider({
      min: 0,
      max: Math.max(1, Math.round(this.total)),
      value: Math.round(this.position()),
      onInput: (v) => this.shell.setPosition(`${clock(v)} / ${clock(this.total)}`),
      onChange: (v) => this.seekGlobal(v),
    });
    this.mediaSession();
    this.shell.setLoading(false);
    this.draw();
  }

  /** Track lengths, from the file (M4B) or by asking the browser for each track's metadata. */
  async measure(known) {
    if (this.tracks.length === 1 && known) this.durations = [known];
    else {
      this.el.status.textContent = this.tracks.length > 1 ? `Reading ${this.tracks.length} tracks…` : '';
      this.durations = [];
      for (const t of this.tracks) {
        this.durations.push(await new Promise((resolve) => {
          const probe = new Audio();
          probe.preload = 'metadata';
          const done = (d) => {
            probe.removeAttribute('src');
            resolve(Number.isFinite(d) ? d : 0);
          };
          probe.onloadedmetadata = () => done(probe.duration);
          probe.onerror = () => done(0);
          probe.src = this.trackUrl(t.n);
        }));
      }
      this.el.status.textContent = '';
    }
    this.offsets = [];
    let sum = 0;
    for (const d of this.durations) {
      this.offsets.push(sum);
      sum += d;
    }
    this.total = sum;
    // Contents: the file's chapters, or one entry per track.
    this.toc = this.chapters?.length
      ? this.chapters.map((c) => ({ label: c.title, target: c.start, depth: 0 }))
      : this.tracks.length > 1 ? this.tracks.map((t, i) => ({ label: t.title, target: this.offsets[i], depth: 0 })) : [];
  }

  trackUrl(n) {
    return `/api/books/${this.book.id}/tracks/${n}?v=${this.book.version}`;
  }

  async load(track, seconds = 0, play = false) {
    this.track = track;
    const a = this.audio;
    if (a.dataset.track !== String(track)) {
      a.src = this.trackUrl(track);
      a.dataset.track = String(track);
      await new Promise((resolve) => {
        const ok = () => {
          a.removeEventListener('loadedmetadata', ok);
          a.removeEventListener('error', ok);
          resolve();
        };
        a.addEventListener('loadedmetadata', ok);
        a.addEventListener('error', ok);
      });
    }
    a.currentTime = Math.max(0, Math.min(seconds, (this.durations[track] || a.duration || 0) - 0.5));
    if (play) await a.play().catch(() => {});
    this.draw();
  }

  position() {
    return (this.offsets[this.track] || 0) + (this.audio.currentTime || 0);
  }

  /** Jump to a point across the whole book (seconds). */
  async seekGlobal(seconds) {
    seconds = Math.max(0, Math.min(seconds, this.total - 0.5));
    let t = this.offsets.length - 1;
    while (t > 0 && this.offsets[t] > seconds) t--;
    await this.load(t, seconds - this.offsets[t], !this.audio.paused);
    this.save();
  }

  chapterAt(seconds) {
    if (!this.toc.length) return null;
    let i = this.toc.length - 1;
    while (i > 0 && this.toc[i].target > seconds + 0.5) i--;
    return i;
  }

  togglePlay() {
    if (this.audio.paused) this.audio.play().catch(() => {});
    else this.audio.pause();
  }

  skip(by) {
    return this.seekGlobal(this.position() + by);
  }

  setSpeed(v) {
    this.audio.playbackRate = v;
    this.audio.defaultPlaybackRate = v;
    try {
      localStorage.setItem(SPEED_KEY, String(v));
    } catch {}
    if (this.el) this.el.speed.textContent = `${v}×`;
  }

  setSleep(choice) {
    clearTimeout(this.sleepTimer);
    this.sleep = null;
    if (choice === 'chapter') this.sleep = { chapter: this.chapterAt(this.position()) };
    else if (choice) {
      this.sleep = { until: Date.now() + choice * 60_000 };
      this.sleepTimer = setTimeout(() => {
        this.audio.pause();
        this.sleep = null;
        this.draw();
      }, choice * 60_000);
    }
    this.draw();
  }

  onTime() {
    // Listening counts as reading time, even without touching the screen.
    this.tracker.activity();
    const pos = this.position();
    if (this.sleep?.chapter != null && this.chapterAt(pos) !== this.sleep.chapter) {
      this.audio.pause();
      this.sleep = null;
    }
    if (Date.now() - (this.lastSave || 0) > 5000) this.save();
    this.draw();
  }

  async onEnded() {
    if (this.track < this.tracks.length - 1) {
      await this.load(this.track + 1, 0, true);
    } else {
      this.tracker.update({ position: `${this.track}:${Math.floor(this.audio.currentTime)}`, percent: 1 });
      this.shell.showEnd();
    }
  }

  save() {
    this.lastSave = Date.now();
    const pos = this.position();
    this.tracker.update({ position: `${this.track}:${Math.floor(this.audio.currentTime || 0)}`, percent: this.total ? Math.min(0.998, pos / this.total) : 0 });
  }

  // ----- what the reader shell calls -----
  left() { this.skip(-30); }
  right() { this.skip(30); }
  next() { this.togglePlay(); }
  prev() { this.skip(-30); }
  goToStart() { this.seekGlobal(0); }
  goToEnd() { this.seekGlobal(this.total - 5); }
  goTo(target) { this.seekGlobal(Number(target)); }
  goToLocator(loc) {
    const [t, sec] = String(loc).split(':').map(Number);
    this.load(t || 0, sec || 0, !this.audio.paused);
  }
  currentLocator() {
    const pos = this.position();
    const ch = this.chapterAt(pos);
    return { locator: `${this.track}:${Math.floor(this.audio.currentTime || 0)}`, percent: this.total ? pos / this.total : 0, chapter: ch != null ? this.toc[ch].label : null };
  }
  get search() {
    return null;
  }

  // ----- UI -----
  buildUi() {
    const playBtn = h('button.audio-play.state', { type: 'button', 'aria-label': 'Play', onclick: () => this.togglePlay() }, icon('play_arrow', 'filled'));
    const speed = h('button.audio-chip.state', { type: 'button', title: 'Playback speed' }, '1×');
    speed.addEventListener('click', () => menu(speed, SPEEDS.map((v) => ({ label: `${v}×`, checked: this.audio.playbackRate === v, onClick: () => this.setSpeed(v) }))));
    const sleepBtn = h('button.audio-chip.state', { type: 'button', title: 'Sleep timer' }, icon('bedtime'), h('span', 'Sleep'));
    sleepBtn.addEventListener('click', () => menu(sleepBtn, [
      { header: 'Stop playing after' },
      ...SLEEP.filter(([v]) => v !== 'chapter' || this.toc.length).map(([v, label]) => ({ label, onClick: () => this.setSleep(v) })),
      this.sleep && { label: 'Turn off', icon: 'close', onClick: () => this.setSleep(null) },
    ].filter(Boolean)));
    const art = cover({ ...this.book, title: this.book.title }, { showProgress: false });
    this.el = {
      playBtn,
      speed,
      sleepBtn,
      chapter: h('div.audio-chapter'),
      elapsed: h('span'),
      remaining: h('span'),
      bar: h('div.progress.audio-bar', h('span')),
      status: h('div.audio-status'),
    };
    const people = (this.book.author ? [this.book.author] : []).join(', ');
    this.shell.stage.replaceChildren(h('div.audio-stage',
      h('div.audio-art', art),
      h('div.audio-info',
        h('div.audio-title', this.book.series && this.book.series !== this.book.title ? this.book.series : this.book.title),
        people && h('div.audio-author', people),
        this.el.chapter),
      h('div.audio-time', this.el.elapsed, this.el.bar, this.el.remaining),
      h('div.audio-controls',
        iconButton('skip_previous', 'Previous chapter', () => this.jumpChapter(-1)),
        iconButton('replay_30', 'Back 30 seconds', () => this.skip(-30)),
        playBtn,
        iconButton('forward_30', 'Forward 30 seconds', () => this.skip(30)),
        iconButton('skip_next', 'Next chapter', () => this.jumpChapter(1))),
      h('div.audio-extras', speed, sleepBtn),
      this.el.status));
    // A tap anywhere but the controls shows or hides the reader menu (bookmarks, contents, settings).
    const onTap = (e) => {
      if (!e.target.closest('button, .audio-time')) this.shell.toggleChrome();
    };
    this.shell.stage.addEventListener('click', onTap);
    this.cleanups.push(() => this.shell.stage.removeEventListener('click', onTap));
  }

  jumpChapter(dir) {
    const pos = this.position();
    if (!this.toc.length) return this.skip(dir * 300);
    const i = this.chapterAt(pos);
    // "Previous" restarts the current chapter unless you're near its start.
    const target = dir < 0 && pos - this.toc[i].target > 4 ? i : i + dir;
    if (target < 0) return this.seekGlobal(0);
    if (target >= this.toc.length) return this.seekGlobal(this.total - 1);
    return this.seekGlobal(this.toc[target].target);
  }

  drawPlaying() {
    const playing = !this.audio.paused;
    this.el.playBtn.querySelector('.icon').textContent = playing ? 'pause' : 'play_arrow';
    this.el.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.shell.root.classList.toggle('audio-playing', playing);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  draw() {
    if (!this.el) return;
    const pos = this.position();
    const ch = this.chapterAt(pos);
    this.el.chapter.textContent = ch != null ? this.toc[ch].label : this.tracks.length > 1 ? this.tracks[this.track].title : '';
    this.el.elapsed.textContent = clock(pos);
    this.el.remaining.textContent = this.total ? `-${clock(this.total - pos)}` : '';
    this.el.bar.firstChild.style.width = `${this.total ? (pos / this.total) * 100 : 0}%`;
    const left = this.total ? formatDuration((this.total - pos) / this.audio.playbackRate, { short: true }) : '';
    this.shell.setSubtitle(this.el.chapter.textContent);
    this.shell.setPosition(`${clock(pos)} / ${clock(this.total)}`, left ? `${left} left` : '');
    this.shell.setSliderValue(Math.round(pos));
    this.el.sleepBtn.classList.toggle('selected', Boolean(this.sleep));
    this.el.sleepBtn.querySelector('span').textContent = this.sleep?.until
      ? `${Math.max(1, Math.round((this.sleep.until - Date.now()) / 60_000))} min`
      : this.sleep?.chapter != null ? 'End of chapter' : 'Sleep';
    for (const t of this.toc) t.current = false;
    if (ch != null && this.toc[ch]) this.toc[ch].current = true;
    this.drawPlaying();
  }

  /** Lock-screen and headphone controls. */
  mediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({
        title: this.book.series && this.book.series !== this.book.title ? this.book.series : this.book.title,
        artist: this.book.author || '',
        album: this.book.title,
        artwork: this.book.coverUrl ? [{ src: this.book.coverUrl, sizes: '512x768' }] : [],
      });
    } catch {}
    const handlers = {
      play: () => this.audio.play(),
      pause: () => this.audio.pause(),
      seekbackward: () => this.skip(-30),
      seekforward: () => this.skip(30),
      previoustrack: () => this.jumpChapter(-1),
      nexttrack: () => this.jumpChapter(1),
      seekto: (d) => this.seekGlobal(d.seekTime),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try {
        ms.setActionHandler(action, fn);
      } catch {}
    }
    this.cleanups.push(() => {
      for (const action of Object.keys(handlers)) {
        try {
          ms.setActionHandler(action, null);
        } catch {}
      }
    });
  }

  destroy() {
    this.save();
    clearTimeout(this.sleepTimer);
    this.cleanups.forEach((fn) => fn());
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }
}
