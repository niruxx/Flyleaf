// Page-based reader for manga/comics (CBZ, CBR, CB7, CBT, image folders) and PDFs.

import { api, pageUrl, fileUrl } from '../api.js';
import { h, resolveColor } from '../ui.js';

const MAX_CANVAS_PIXELS = 12_000_000; // stay well under iOS Safari's canvas limits

// ---------------------------------------------------------------------------
// Sources

class ImageSource {
  constructor(book, { dataSaver }) {
    this.book = book;
    this.cache = new Map();
    // Data saver: ask the server for screen-sized, compressed pages.
    this.width = dataSaver ? Math.min(1280, Math.round(Math.max(screen.width, screen.height) * Math.min(devicePixelRatio || 1, 2))) : null;
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
        img.src = pageUrl(this.book, i, this.width);
      });
      p.catch(() => this.cache.delete(i));
      this.cache.set(i, p);
    }
    return this.cache.get(i).then((img) => (img.isConnected ? img.cloneNode() : img));
  }
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
        flat.push({ label: it.title, page, depth, target: page });
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
  constructor(book, shell, tracker, data) {
    this.book = book;
    this.shell = shell;
    this.tracker = tracker;
    this.s = shell.settings;
    this.isPdf = book.format === 'pdf';
    this.source = this.isPdf ? new PdfSource(book) : new ImageSource(book, { dataSaver: data.dataSaver });
    this.page = 0;
    this.half = 0; // 0/1 when a wide page is split in two
    this.renderSeq = 0;
    this.cleanups = [];
    this.toc = [];
  }

  get dir() {
    return this.s.resolvedDir || this.s.direction;
  }
  get count() {
    return this.source.count;
  }
  scrollMode() {
    return this.s.layout === 'webtoon';
  }
  splitting() {
    return this.s.layout === 'single' && (this.s.pageSplit === 'split' || this.s.pageSplit === 'split-reverse');
  }

  async open(startLocator) {
    this.shell.setLoading(true);
    await this.source.init();
    if (!this.source.count) throw new Error('This book has no pages.');
    const saved = this.book.progress;
    let start = saved?.page != null && !saved.finished ? saved.page : 0;
    if (startLocator != null && /^\d+$/.test(startLocator)) start = Number(startLocator);
    this.page = Math.min(start, this.count - 1);
    this.applyTheme();
    this.build();

    let lastW = innerWidth;
    let lastH = innerHeight;
    const onResize = debounce(() => {
      const widthChanged = innerWidth !== lastW;
      const heightChanged = Math.abs(innerHeight - lastH) > 120;
      lastW = innerWidth;
      lastH = innerHeight;
      // iOS Safari fires resize when its toolbar collapses – only rebuild for real changes.
      if (widthChanged || (this.isPdf && !this.scrollMode() && heightChanged)) this.build();
    }, 200);
    addEventListener('resize', onResize);
    this.cleanups.push(() => removeEventListener('resize', onResize));

    if (this.isPdf) {
      this.source.outline().then((toc) => (this.toc = toc));
      if (!this.book.coverUrl) this.source.thumbnail().then((blob) => blob && api.generatedCover(this.book.id, blob)).catch(() => {});
    }
  }

  destroy() {
    this.cleanups.forEach((fn) => fn());
    this.source.destroy();
  }

  // ----- settings -----

  applyTheme() {
    let bg = this.s.background || '#000000';
    if (!/^#[0-9a-f]{6}$/i.test(bg)) bg = resolveColor(bg);
    const lum = parseInt(bg.slice(1, 3), 16) * 0.3 + parseInt(bg.slice(3, 5), 16) * 0.59 + parseInt(bg.slice(5, 7), 16) * 0.11;
    this.shell.setTheme(bg, lum > 140 ? '#1b1b1f' : '#ffffff');
    const r = this.shell.root;
    r.classList.toggle('rtl', this.dir === 'rtl');
    r.classList.toggle('double', this.s.layout === 'double');
    for (const f of ['screen', 'width', 'height', 'original']) r.classList.toggle(`fit-${f}`, this.s.scaling === f);
    r.style.setProperty('--strip-gap', `${this.s.webtoonGap || 0}px`);
    this.shell.setArrows(this.dir === 'rtl');
  }

  applySetting(key) {
    this.applyTheme();
    if (['layout', 'direction', 'scaling', 'pageSplit', 'webtoonGap'].includes(key)) {
      this.half = 0;
      this.build();
    }
  }

  // ----- navigation -----

  spreadOf(p) {
    if (this.s.layout !== 'double' || p === 0) return [p];
    const start = p % 2 === 1 ? p : p - 1;
    return [start, start + 1].filter((x) => x < this.count);
  }
  next() {
    if (this.scrollMode()) return this.scrollBy(1);
    if (this.container && this.s.scaling !== 'screen' && !this.wideFit) {
      const c = this.container;
      if (c.scrollTop + c.clientHeight < c.scrollHeight - 4) {
        c.scrollBy({ top: c.clientHeight * 0.85, behavior: 'smooth' });
        return;
      }
    }
    if (this.splitting() && this.currentWide && this.half === 0) {
      this.half = 1;
      return this.renderPaged('next');
    }
    const spread = this.spreadOf(this.page);
    const nextPage = spread[spread.length - 1] + 1;
    if (nextPage >= this.count) return this.shell.showEnd();
    this.half = 0;
    this.go(nextPage, { dir: 'next' });
  }
  prev() {
    if (this.scrollMode()) return this.scrollBy(-1);
    if (this.container && this.s.scaling !== 'screen' && this.container.scrollTop > 4) {
      this.container.scrollBy({ top: -this.container.clientHeight * 0.85, behavior: 'smooth' });
      return;
    }
    if (this.splitting() && this.currentWide && this.half === 1) {
      this.half = 0;
      return this.renderPaged('prev');
    }
    const spread = this.spreadOf(this.page);
    if (spread[0] === 0) return this.shell.toast('Start of book');
    this.half = 0;
    this.wantSecondHalf = true;
    this.go(this.spreadOf(spread[0] - 1)[0], { dir: 'prev' });
  }
  left() {
    this.dir === 'rtl' ? this.next() : this.prev();
  }
  right() {
    this.dir === 'rtl' ? this.prev() : this.next();
  }
  goToStart() {
    this.go(0);
  }
  goToEnd() {
    this.go(this.count - 1);
  }
  goTo(target) {
    this.go(Number(target));
  }
  goToLocator(loc) {
    this.go(Number(loc));
  }
  scrollBy(dir) {
    this.container?.scrollBy({ top: dir * this.container.clientHeight * 0.85, behavior: 'smooth' });
  }
  currentLocator() {
    return { locator: String(this.page), page: this.page, percent: (this.page + 1) / this.count };
  }

  go(p, { dir } = {}) {
    p = Math.max(0, Math.min(this.count - 1, p));
    if (this.scrollMode()) {
      this.page = p;
      this.stripJump(p);
      return;
    }
    this.page = this.spreadOf(p)[0];
    this.renderPaged(dir);
  }

  report() {
    const spread = this.scrollMode() ? [this.page] : this.spreadOf(this.page);
    const last = spread[spread.length - 1];
    const label = spread.length > 1 ? `${spread[0] + 1}–${last + 1} / ${this.count}` : `${spread[0] + 1} / ${this.count}`;
    this.shell.setPosition(label, `${spread[0] + 1} / ${this.count}`);
    this.shell.setSliderValue(this.page);
    this.shell.setSubtitle(`Page ${spread[0] + 1} of ${this.count}`);
    this.tracker.update({ page: this.page, position: String(this.page), percent: (last + 1) / this.count });
    this.shell.pageTurned();
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
      rtl: this.dir === 'rtl',
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

  async renderPaged(dir) {
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

    // Wide (double-page) scans: split into halves or force-fit, per the page-splitting setting.
    const el0 = els[0];
    const w = el0.naturalWidth || el0.width;
    const hgt = el0.naturalHeight || el0.height;
    this.currentWide = spread.length === 1 && w > hgt * 1.1;
    this.wideFit = this.currentWide && this.s.pageSplit === 'fit';
    if (this.wantSecondHalf) {
      if (this.currentWide && this.splitting()) this.half = 1;
      this.wantSecondHalf = false;
    }
    if (this.currentWide && this.splitting()) {
      const firstIsRight = (this.dir === 'rtl') !== (this.s.pageSplit === 'split-reverse');
      const leftHalf = this.half === 0 ? !firstIsRight : firstIsRight;
      const half = Math.floor(w / 2);
      const c = document.createElement('canvas');
      c.width = half;
      c.height = hgt;
      c.getContext('2d').drawImage(el0, leftHalf ? 0 : half, 0, half, hgt, 0, 0, half, hgt);
      els = [c];
    }

    const wrap = h(`div.spread${this.wideFit ? '.fit-wide' : ''}${dir ? `.turn-${dir}` : ''}`, els);
    this.container.replaceChildren(wrap);
    this.container.scrollTop = dir === 'prev' && this.s.scaling !== 'screen' ? this.container.scrollHeight : 0;
    this.container.scrollLeft = this.dir === 'rtl' ? this.container.scrollWidth : 0;
    this.preload(spread);
  }

  async sizeOpts(spread) {
    if (!this.isPdf) return {};
    const W = this.shell.stage.clientWidth || innerWidth;
    const H = this.shell.stage.clientHeight || innerHeight;
    const perPage = this.s.layout === 'double' && spread.length > 1 ? W / 2 : W;
    const size = await this.source.pageSize(spread[0]);
    if (this.s.scaling === 'width') return { cssWidth: perPage };
    if (this.s.scaling === 'height') return { cssWidth: (H * size.w) / size.h };
    if (this.s.scaling === 'original') return { cssWidth: size.w * 1.5 };
    return { cssWidth: Math.min(perPage, (H * size.w) / size.h) };
  }

  preload(spread) {
    const last = spread[spread.length - 1];
    const ahead = this.isPdf ? 2 : this.source.width ? 2 : 4;
    const tasks = [];
    for (let i = 1; i <= ahead; i++) if (last + i < this.count) tasks.push(last + i);
    if (spread[0] > 0) tasks.push(spread[0] - 1);
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
    el.addEventListener('pointerup', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const zoomed = (window.visualViewport?.scale || 1) > 1.05;
      const canScrollX = el.scrollWidth > el.clientWidth + 4;
      if (this.shell.swipeEnabled() && !zoomed && !canScrollX && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - start.t < 800) {
        dx < 0 ? this.right() : this.left();
      }
      start = null;
    });
    el.addEventListener('pointercancel', () => (start = null));
    el.addEventListener('click', (e) => {
      if (moved) return;
      const r = el.getBoundingClientRect();
      this.shell.handleTap((e.clientX - r.left) / r.width);
    });
    el.addEventListener('wheel', (e) => {
      if (this.s.scaling !== 'screen' || Math.abs(e.deltaY) < 20 || e.ctrlKey) return;
      e.preventDefault();
      const now = Date.now();
      if (now - (this.lastWheel || 0) < 350) return;
      this.lastWheel = now;
      e.deltaY > 0 ? this.next() : this.prev();
    }, { passive: false });
  }

  // ----- webtoon (continuous scroll) -----

  buildStrip() {
    const strip = h('div.strip');
    this.container = strip;
    const W = () => Math.min(strip.clientWidth || innerWidth, 800);
    strip.style.setProperty('--strip-width', this.s.scaling === 'width' || this.isPdf ? '100%' : '800px');
    const pages = [];
    for (let i = 0; i < this.count; i++) pages.push(h('div.pg', { dataset: { i: String(i) } }));
    strip.append(...pages);
    this.shell.stage.append(strip);
    this.stripPages = pages;
    this.shell.setLoading(false);

    const loaded = new Set();
    this.stripLoaded = loaded;
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
      pg.classList.remove('ready');
      loaded.delete(i);
    };

    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) loadPage(Number(en.target.dataset.i));
    }, { root: strip, rootMargin: '150% 0px' });
    pages.forEach((p) => io.observe(p));

    // Only celebrate the end after the reader actually scrolls there (not after a jump or layout switch).
    let userScrolled = false;
    for (const ev of ['wheel', 'touchmove', 'keydown', 'pointerdown']) strip.addEventListener(ev, () => (userScrolled = true), { passive: true });
    let raf = 0;
    strip.addEventListener('scroll', () => {
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
        if (userScrolled && strip.scrollTop + strip.clientHeight >= strip.scrollHeight - 2 && this.page >= this.count - 1 && !this.endShown) {
          this.endShown = true;
          this.report();
          this.shell.showEnd();
        }
      });
    }, { passive: true });

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
      if (!this.s.tapToPaginate || (x >= 0.3 && x <= 0.7)) return this.shell.toggleChrome();
      this.scrollBy(x < 0.3 ? -1 : 1);
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
    const pg = pages[p];
    pg.scrollIntoView({ block: 'start' });
    const el = await this.source.load(p, { cssWidth: pg.clientWidth || innerWidth }).catch(() => null);
    if (el && !pg.classList.contains('ready')) {
      pg.replaceChildren(el);
      pg.classList.add('ready');
      pg.style.height = '';
      this.stripLoaded?.add(p);
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
