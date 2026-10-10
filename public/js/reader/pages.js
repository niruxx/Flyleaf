// Page-based reader for comics/manga (CBZ, CBR, image folders) and PDFs.

import { api, pageUrl, fileUrl } from '../api.js';
import { h, segmented, resolveColor } from '../ui.js';
import { loadDefaults, saveDefaults } from './reader.js';

const BACKGROUNDS = {
  black: ['#000000', '#ffffff'],
  gray: ['#3a3a3f', '#ffffff'],
  white: ['#ffffff', '#1b1b1f'],
};
const MAX_CANVAS_PIXELS = 12_000_000; // stay well under iOS Safari's canvas limits

// ---------------------------------------------------------------------------
// Sources

class ImageSource {
  constructor(book) {
    this.book = book;
    this.cache = new Map();
  }
  async init() {
    const { count } = await api.pages(this.book.id);
    this.count = count;
  }
  load(i) {
    if (!this.cache.has(i)) {
      const p = new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.draggable = false;
        img.alt = `Page ${i + 1}`;
        img.onload = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => resolve(img));
        img.onerror = () => reject(new Error(`Page ${i + 1} failed to load`));
        img.src = pageUrl(this.book, i);
      });
      p.catch(() => this.cache.delete(i));
      this.cache.set(i, p);
    }
    // Each caller gets its own element so the same page can appear in two places.
    return this.cache.get(i).then((img) => {
      if (!img.isConnected) return img;
      const copy = img.cloneNode();
      return copy;
    });
  }
  /** Keep only pages near `center` cached. */
  trim(center, keep = 8) {
    for (const i of this.cache.keys()) if (Math.abs(i - center) > keep) this.cache.delete(i);
  }
  destroy() {
    this.cache.clear();
  }
}

class PdfSource {
  constructor(book) {
    this.book = book;
    this.cache = new Map();
    this.sizes = new Map();
  }
  async init() {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    this.pdfjs = pdfjs;
    this.task = pdfjs.getDocument({ url: fileUrl(this.book), isEvalSupported: false, withCredentials: true });
    this.doc = await this.task.promise;
    this.count = this.doc.numPages;
  }
  async pageSize(i) {
    if (!this.sizes.has(i)) {
      const page = await this.doc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      this.sizes.set(i, { w: vp.width, h: vp.height });
    }
    return this.sizes.get(i);
  }
  /** Render page i so that it is `cssWidth` CSS pixels wide. */
  load(i, { cssWidth }) {
    const dpr = Math.min(devicePixelRatio || 1, 2.5);
    const key = `${i}@${Math.round(cssWidth)}`;
    if (!this.cache.has(key)) {
      const p = (async () => {
        const page = await this.doc.getPage(i + 1);
        const base = page.getViewport({ scale: 1 });
        let scale = (cssWidth / base.width) * dpr;
        const pixels = base.width * base.height * scale * scale;
        if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.aspectRatio = `${base.width} / ${base.height}`;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas }).promise;
        return canvas;
      })();
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
    }
    return this.cache.get(key);
  }
  trim(center, keep = 3) {
    for (const [key, p] of this.cache) {
      const i = Number(key.split('@')[0]);
      if (Math.abs(i - center) > keep) {
        this.cache.delete(key);
        p.then((c) => {
          if (!c.isConnected) c.width = c.height = 0; // release GPU memory on iOS
        }).catch(() => {});
      }
    }
  }
  async outline() {
    const items = await this.doc.getOutline().catch(() => null);
    if (!items?.length) return [];
    const flat = [];
    const walk = async (list, depth) => {
      for (const it of list) {
        let page = null;
        try {
          const dest = typeof it.dest === 'string' ? await this.doc.getDestination(it.dest) : it.dest;
          if (dest?.[0]) page = typeof dest[0] === 'object' ? await this.doc.getPageIndex(dest[0]) : dest[0];
        } catch {}
        flat.push({ label: it.title, page, depth });
        if (it.items?.length && depth < 3) await walk(it.items, depth + 1);
      }
    };
    await walk(items, 0);
    return flat.filter((x) => x.page != null);
  }
  async thumbnail() {
    const canvas = await this.load(0, { cssWidth: 480 / Math.min(devicePixelRatio || 1, 2.5) });
    return new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  }
  destroy() {
    for (const p of this.cache.values()) p.then((c) => (c.width = c.height = 0)).catch(() => {});
    this.cache.clear();
    this.task?.destroy();
  }
}

// ---------------------------------------------------------------------------
// Engine

export class PageEngine {
  constructor(book, shell, tracker) {
    this.book = book;
    this.shell = shell;
    this.tracker = tracker;
    this.isPdf = book.format === 'pdf';
    this.source = this.isPdf ? new PdfSource(book) : new ImageSource(book);
    const kindKey = this.isPdf ? 'pdf' : book.kind;
    this.kindKey = kindKey;
    const defaults = {
      mode: 'single',
      dir: book.kind === 'manga' ? 'rtl' : 'ltr',
      fit: this.isPdf && innerWidth < 600 ? 'width' : 'height',
      bg: this.isPdf ? 'theme' : 'black',
    };
    this.settings = { ...loadDefaults(kindKey, defaults), ...(book.progress?.settings || {}) };
    this.page = 0;
    this.renderSeq = 0;
    this.cleanups = [];
  }

  async open() {
    this.shell.setLoading(true);
    await this.source.init();
    if (!this.source.count) throw new Error('This book has no pages.');
    const saved = this.book.progress;
    this.page = saved?.page != null && !saved.finished ? Math.min(saved.page, this.source.count - 1) : 0;
    this.applyTheme();
    this.shell.setSettings((close) => this.settingsSheet(close));
    this.build();

    // Only rebuild for real size changes: iOS Safari fires resize whenever its toolbar collapses.
    let lastW = innerWidth;
    let lastH = innerHeight;
    const onResize = debounce(() => {
      const widthChanged = innerWidth !== lastW;
      const heightChanged = Math.abs(innerHeight - lastH) > 120;
      lastW = innerWidth;
      lastH = innerHeight;
      if (widthChanged || (this.isPdf && !this.scrollMode() && heightChanged)) this.build();
    }, 200);
    addEventListener('resize', onResize);
    this.cleanups.push(() => removeEventListener('resize', onResize));

    if (this.isPdf) {
      this.source.outline().then((toc) => {
        this.toc = toc;
        this.shell.setTocAvailable(toc.length > 0);
      });
      if (!this.book.coverUrl) {
        this.source.thumbnail().then((blob) => blob && api.generatedCover(this.book.id, blob)).catch(() => {});
      }
    }
  }

  destroy() {
    this.cleanups.forEach((fn) => fn());
    this.source.destroy();
  }

  // ----- settings -----

  applyTheme() {
    let [bg, fg] = BACKGROUNDS[this.settings.bg] || [];
    if (!bg) {
      const css = getComputedStyle(document.documentElement);
      bg = resolveColor(css.getPropertyValue('--md-surface-container-lowest').trim());
      fg = resolveColor(css.getPropertyValue('--md-on-surface').trim());
    }
    this.shell.setTheme(bg, fg);
    const r = this.shell.root;
    r.classList.toggle('rtl', this.settings.dir === 'rtl');
    r.classList.toggle('double', this.settings.mode === 'double');
    for (const f of ['height', 'width', 'original']) r.classList.toggle(`fit-${f}`, this.settings.fit === f);
    this.shell.setArrows(this.settings.dir === 'rtl');
  }

  setSetting(key, value) {
    this.settings[key] = value;
    saveDefaults(this.kindKey, this.settings);
    this.tracker.saveSettings(this.settings);
    this.applyTheme();
    if (key !== 'bg') this.build();
  }

  settingsSheet() {
    const s = this.settings;
    return h('div',
      h('div.sheet-section', h('h3', 'Layout'),
        segmented([
          { value: 'single', label: 'Single', icon: 'crop_portrait' },
          { value: 'double', label: 'Double', icon: 'menu_book' },
          { value: 'strip', label: 'Scroll', icon: 'view_day' },
        ], s.mode, (v) => this.setSetting('mode', v))),
      h('div.sheet-section', h('h3', 'Reading direction'),
        segmented([
          { value: 'ltr', label: 'Left to right', icon: 'arrow_forward' },
          { value: 'rtl', label: 'Right to left', icon: 'arrow_back' },
        ], s.dir, (v) => this.setSetting('dir', v))),
      h('div.sheet-section', h('h3', 'Page fit'),
        segmented([
          { value: 'height', label: 'Screen', icon: 'fit_screen' },
          { value: 'width', label: 'Width', icon: 'width' },
          { value: 'original', label: 'Original', icon: 'zoom_in' },
        ], s.fit, (v) => this.setSetting('fit', v))),
      h('div.sheet-section', h('h3', 'Background'),
        segmented([
          { value: 'black', label: 'Black' },
          { value: 'gray', label: 'Gray' },
          { value: 'white', label: 'White' },
          { value: 'theme', label: 'Theme' },
        ], s.bg, (v) => this.setSetting('bg', v))),
      h('p.body-small.muted', { style: { padding: '4px 24px 8px' } },
        `Saved for this book and used as the default for other ${this.isPdf ? 'PDFs' : this.book.kind}.`),
    );
  }

  openToc() {
    if (!this.toc?.length) return;
    import('../ui.js').then(({ sheet }) =>
      sheet((close) =>
        h('div.toc', h('div.sheet-section', h('h3', 'Contents')),
          this.toc.map((t) =>
            h(`button.list-item.state.depth-${Math.min(t.depth, 3)}`, {
              type: 'button',
              onclick: () => {
                close();
                this.go(t.page);
              },
            }, h('span.text', t.label), h('span.trailing', String(t.page + 1))),
          ),
        ),
      ),
    );
  }

  // ----- navigation -----

  get count() {
    return this.source.count;
  }
  scrollMode() {
    return this.settings.mode === 'strip';
  }
  /** Pages shown together with page p. */
  spreadOf(p) {
    if (this.settings.mode !== 'double' || p === 0) return [p];
    const start = p % 2 === 1 ? p : p - 1;
    return [start, start + 1].filter((x) => x < this.count);
  }
  next() {
    if (this.scrollMode()) return this.scrollBy(1);
    // In fit-width mode, scroll down through a tall page before turning.
    if (this.container && this.settings.fit !== 'height') {
      const c = this.container;
      if (c.scrollTop + c.clientHeight < c.scrollHeight - 4) {
        c.scrollBy({ top: c.clientHeight * 0.85, behavior: 'smooth' });
        return;
      }
    }
    const spread = this.spreadOf(this.page);
    const nextPage = spread[spread.length - 1] + 1;
    if (nextPage >= this.count) return this.shell.showEnd();
    this.go(nextPage);
  }
  prev() {
    if (this.scrollMode()) return this.scrollBy(-1);
    if (this.container && this.settings.fit !== 'height' && this.container.scrollTop > 4) {
      this.container.scrollBy({ top: -this.container.clientHeight * 0.85, behavior: 'smooth' });
      return;
    }
    const spread = this.spreadOf(this.page);
    if (spread[0] === 0) return this.shell.toast('Start of book');
    this.go(this.spreadOf(spread[0] - 1)[0], { fromEnd: true });
  }
  left() {
    this.settings.dir === 'rtl' ? this.next() : this.prev();
  }
  right() {
    this.settings.dir === 'rtl' ? this.prev() : this.next();
  }
  goToStart() {
    this.go(0);
  }
  scrollBy(dir) {
    this.container?.scrollBy({ top: dir * this.container.clientHeight * 0.85, behavior: 'smooth' });
  }

  go(p, { fromEnd = false } = {}) {
    p = Math.max(0, Math.min(this.count - 1, p));
    if (this.scrollMode()) {
      this.page = p;
      this.stripJump(p);
      return;
    }
    this.page = this.spreadOf(p)[0];
    this.renderPaged(fromEnd);
  }

  report() {
    const spread = this.scrollMode() ? [this.page] : this.spreadOf(this.page);
    const last = spread[spread.length - 1];
    const label = spread.length > 1 ? `${spread[0] + 1}–${last + 1} / ${this.count}` : `${spread[0] + 1} / ${this.count}`;
    this.shell.setPosition(label, `${spread[0] + 1} / ${this.count}`);
    this.shell.setSliderValue(this.page);
    this.shell.setSubtitle(`Page ${spread[0] + 1} of ${this.count}`);
    this.tracker.update({ page: this.page, position: String(this.page), percent: (last + 1) / this.count });
  }

  // ----- layout -----

  build() {
    const stage = this.shell.stage;
    this.stripCleanup?.();
    stage.replaceChildren();
    this.shell.setSlider({
      min: 0,
      max: this.count - 1,
      value: this.page,
      rtl: this.settings.dir === 'rtl',
      onInput: (v) => this.shell.setPosition(`${v + 1} / ${this.count}`),
      onChange: (v) => this.go(v),
    });
    if (this.scrollMode()) this.buildStrip();
    else this.buildPaged();
  }

  buildPaged() {
    const container = h('div.paged');
    this.container = container;
    this.shell.stage.append(container);
    this.attachGestures(container);
    this.renderPaged();
  }

  async renderPaged(fromEnd = false) {
    const seq = ++this.renderSeq;
    const spread = this.spreadOf(this.page);
    this.report();
    const loadingTimer = setTimeout(() => this.shell.setLoading(true), 150);
    const opts = await this.sizeOpts(spread);
    let els;
    try {
      els = await Promise.all(spread.map((i) => this.source.load(i, opts)));
    } catch (e) {
      clearTimeout(loadingTimer);
      this.shell.setLoading(false);
      this.shell.toast(e.message);
      return;
    }
    clearTimeout(loadingTimer);
    if (seq !== this.renderSeq) return;
    this.shell.setLoading(false);
    const wrap = h('div.spread', els);
    this.container.replaceChildren(wrap);
    this.container.scrollTop = fromEnd && this.settings.fit !== 'height' ? this.container.scrollHeight : 0;
    this.container.scrollLeft = this.settings.dir === 'rtl' ? this.container.scrollWidth : 0;
    this.preload(spread);
  }

  async sizeOpts(spread) {
    if (!this.isPdf) return {};
    const W = this.shell.stage.clientWidth || innerWidth;
    const H = this.shell.stage.clientHeight || innerHeight;
    const perPage = this.settings.mode === 'double' && spread.length > 1 ? W / 2 : W;
    if (this.settings.fit === 'width') return { cssWidth: perPage };
    const size = await this.source.pageSize(spread[0]);
    if (this.settings.fit === 'original') return { cssWidth: size.w * 1.5 };
    return { cssWidth: Math.min(perPage, (H * size.w) / size.h) };
  }

  preload(spread) {
    const last = spread[spread.length - 1];
    const ahead = this.isPdf ? 2 : 4;
    const tasks = [];
    for (let i = 1; i <= ahead; i++) if (last + i < this.count) tasks.push(last + i);
    if (spread[0] > 0) tasks.push(spread[0] - 1);
    // Preload sequentially so the next page is ready first.
    (async () => {
      for (const i of tasks) {
        try {
          await this.source.load(i, await this.sizeOpts(this.spreadOf(i)));
        } catch {}
      }
    })();
    this.source.trim(this.page, this.isPdf ? 3 : 8);
  }

  attachGestures(el) {
    let start = null;
    let moved = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
      moved = false;
    });
    el.addEventListener('pointermove', (e) => {
      if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) moved = true;
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const zoomed = (window.visualViewport?.scale || 1) > 1.05;
      const canScrollX = el.scrollWidth > el.clientWidth + 4;
      if (!zoomed && !canScrollX && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - start.t < 800) {
        dx < 0 ? this.right() : this.left();
      }
      start = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => (start = null));
    el.addEventListener('click', (e) => {
      if (moved) return;
      const r = el.getBoundingClientRect();
      this.shell.handleTap((e.clientX - r.left) / r.width);
    });
    // Mouse wheel / trackpad turns pages when the page fits the screen.
    el.addEventListener('wheel', (e) => {
      if (this.settings.fit !== 'height' || Math.abs(e.deltaY) < 20 || e.ctrlKey) return;
      e.preventDefault();
      const now = Date.now();
      if (now - (this.lastWheel || 0) < 350) return;
      this.lastWheel = now;
      e.deltaY > 0 ? this.next() : this.prev();
    }, { passive: false });
  }

  // ----- strip (webtoon) mode -----

  buildStrip() {
    const strip = h('div.strip');
    this.container = strip;
    const W = () => Math.min(strip.clientWidth || innerWidth, 800);
    strip.style.setProperty('--strip-width', this.settings.fit === 'width' || this.isPdf ? '100%' : '800px');
    const pages = [];
    for (let i = 0; i < this.count; i++) pages.push(h('div.pg', { dataset: { i: String(i) } }));
    strip.append(...pages);
    this.shell.stage.append(strip);
    this.stripPages = pages;
    this.shell.setLoading(false);

    const loaded = new Set();
    const loadPage = async (i) => {
      if (loaded.has(i)) return;
      loaded.add(i);
      const pg = pages[i];
      try {
        const el = await this.source.load(i, { cssWidth: pg.clientWidth || W() });
        if (!loaded.has(i) || !pg.isConnected) return;
        const above = pg.getBoundingClientRect().bottom <= strip.getBoundingClientRect().top + 1;
        const before = pg.offsetHeight;
        pg.replaceChildren(el);
        pg.classList.add('ready');
        pg.style.height = '';
        // Keep the view steady when a page above the viewport changes height (Safari lacks scroll anchoring).
        if (above) strip.scrollTop += pg.offsetHeight - before;
      } catch {
        loaded.delete(i);
      }
    };
    const unloadPage = (i) => {
      if (!loaded.has(i)) return;
      const pg = pages[i];
      pg.style.height = `${pg.offsetHeight}px`;
      const c = pg.querySelector('canvas');
      if (c) c.width = c.height = 0;
      pg.replaceChildren();
      loaded.delete(i);
    };

    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) loadPage(Number(en.target.dataset.i));
    }, { root: strip, rootMargin: '150% 0px' });
    pages.forEach((p) => io.observe(p));

    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const mid = strip.scrollTop + strip.clientHeight * 0.33;
        let i = Math.min(this.page, pages.length - 1);
        while (i > 0 && pages[i].offsetTop > mid) i--;
        while (i < pages.length - 1 && pages[i + 1].offsetTop <= mid) i++;
        if (i !== this.page) {
          this.page = i;
          this.report();
          for (const j of loaded) if (Math.abs(j - i) > 12) unloadPage(j);
          this.source.trim(i, 14);
        }
        if (strip.scrollTop + strip.clientHeight >= strip.scrollHeight - 2 && this.page >= this.count - 1 && !this.endShown) {
          this.endShown = true;
          this.report();
          this.shell.showEnd();
        }
      });
    };
    strip.addEventListener('scroll', onScroll, { passive: true });

    let moved = false;
    let sx = 0;
    let sy = 0;
    strip.addEventListener('pointerdown', (e) => {
      moved = false;
      sx = e.clientX;
      sy = e.clientY;
    });
    strip.addEventListener('pointermove', (e) => {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) moved = true;
    });
    strip.addEventListener('click', (e) => {
      if (moved) return;
      const r = strip.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      // In scroll mode, side taps scroll by a screen; the centre toggles the menu.
      if (x < 0.3) this.scrollBy(-1);
      else if (x > 0.7) this.scrollBy(1);
      else this.shell.toggleChrome();
    });

    this.stripCleanup = () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
    this.cleanups.push(() => this.stripCleanup?.());
    this.report();
    this.stripJump(this.page, true);
  }

  async stripJump(p, initial = false) {
    const pages = this.stripPages;
    if (!pages) return;
    this.page = p;
    // Load the target first so it has a real height, then scroll to it.
    const pg = pages[p];
    pg.scrollIntoView({ block: 'start' });
    const el = await this.source.load(p, { cssWidth: pg.clientWidth || innerWidth }).catch(() => null);
    if (el && !pg.classList.contains('ready')) {
      pg.replaceChildren(el);
      pg.classList.add('ready');
      pg.style.height = '';
    }
    pg.scrollIntoView({ block: 'start' });
    if (!initial) this.report();
  }
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
