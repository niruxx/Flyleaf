import { t } from '../i18n.js';
// Page-based reader for manga/comics (CBZ, CBR, CB7, CBT, image folders) and PDFs.

import { api, pageUrl, fileUrl } from '../api.js';
import { h, resolveColor, iconButton } from '../ui.js';
import { LOOKS } from '../components/reader-settings.js';
import { turnPages, measure, reducedMotion, finishTurn } from './turn.js';

import { PageZoom } from './zoom.js';

const MAX_CANVAS_PIXELS = 12_000_000; // stay well under iOS Safari's canvas limits
// Auto-scroll speeds (levels 1–10) in pixels per second on an 800px-tall screen.
const AUTO_SPEEDS = [0, 25, 40, 60, 85, 115, 150, 195, 250, 320, 400];
const isWide = (el) => (el.naturalWidth || el.width) > (el.naturalHeight || el.height) * 1.1;

// ---------------------------------------------------------------------------
// Page analysis, for auto-crop and "whiten yellowed paper": each page is looked at once, small.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * { crop: { x, y, w, h } as fractions of the page (null when there's nothing to trim), paper: [r, g, b] }.
 * The border colour is the median of the outermost pixels; rows and columns that are almost all
 * that colour are margin. The paper colour is the average of the brightest 15% of pixels.
 */
function analysePage(el) {
  const W = el.naturalWidth || el.width;
  const H = el.naturalHeight || el.height;
  if (!W || !H) return null;
  const scale = Math.min(1, 240 / Math.max(W, H));
  const w = Math.max(8, Math.round(W * scale));
  const hh = Math.max(8, Math.round(H * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let data;
  try {
    ctx.drawImage(el, 0, 0, w, hh);
    data = ctx.getImageData(0, 0, w, hh).data;
  } catch {
    return null;
  }
  const at = (x, y) => (y * w + x) * 4;
  const ring = [];
  for (let x = 0; x < w; x++) ring.push(at(x, 0), at(x, hh - 1));
  for (let y = 0; y < hh; y++) ring.push(at(0, y), at(w - 1, y));
  const median = (ch) => ring.map((i) => data[i + ch]).sort((a, b) => a - b)[ring.length >> 1];
  const bg = [median(0), median(1), median(2)];
  const off = (i) => Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 60;
  const blankRow = (y) => {
    let n = 0;
    for (let x = 0; x < w; x++) if (off(at(x, y)) && ++n > w * 0.012) return false;
    return true;
  };
  const blankCol = (x, top, bottom) => {
    let n = 0;
    for (let y = top; y <= bottom; y++) if (off(at(x, y)) && ++n > (bottom - top) * 0.012) return false;
    return true;
  };
  let top = 0;
  while (top < hh - 1 && blankRow(top)) top++;
  let bottom = hh - 1;
  while (bottom > top && blankRow(bottom)) bottom--;
  let left = 0;
  while (left < w - 1 && blankCol(left, top, bottom)) left++;
  let right = w - 1;
  while (right > left && blankCol(right, top, bottom)) right--;
  // Keep a hair of margin so lettering never touches the edge.
  top = Math.max(0, top - 1);
  left = Math.max(0, left - 1);
  bottom = Math.min(hh - 1, bottom + 1);
  right = Math.min(w - 1, right + 1);
  let crop = { x: left / w, y: top / hh, w: (right - left + 1) / w, h: (bottom - top + 1) / hh };
  // Nothing worth trimming, or a mostly blank page (a title page, a fade to white): leave it.
  if ((crop.w > 0.97 && crop.h > 0.97) || crop.w < 0.5 || crop.h < 0.5) crop = null;

  const lum = [];
  for (let i = 0; i < data.length; i += 16) lum.push([data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11, i]);
  lum.sort((a, b) => b[0] - a[0]);
  const bright = lum.slice(0, Math.max(1, Math.round(lum.length * 0.15)));
  const paper = [0, 1, 2].map((ch) => bright.reduce((a, [, i]) => a + data[i + ch], 0) / bright.length);
  return { crop, paper };
}

/** Per-channel gains that turn the paper colour white (none for dark or already-white pages). */
function paperGains(paper) {
  const lum = paper[0] * 0.3 + paper[1] * 0.59 + paper[2] * 0.11;
  if (lum < 140) return null; // dark pages: nothing to whiten
  const gains = paper.map((v) => Math.min(1.6, Math.max(1, 252 / Math.max(1, v))));
  return gains.every((g) => g < 1.02) ? null : gains;
}

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
        img.alt = t('Page {value}', { value: i + 1 });
        img.onload = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => resolve(img));
        img.onerror = () => reject(new Error(t('Page {value} failed to load', { value: i + 1 })));
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
    // A PDF saved for offline reading is read whole from the cache (PDF.js would otherwise
    // ask for byte ranges, which the cached copy can't answer).
    const { isSaved } = await import('../offline.js');
    this.task = isSaved(this.book.id)
      ? pdfjs.getDocument({ data: await (await fetch(fileUrl(this.book), { credentials: 'same-origin' })).arrayBuffer(), isEvalSupported: false })
      : pdfjs.getDocument({ url: fileUrl(this.book), isEvalSupported: false, withCredentials: true });
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
  /** Find `query` in each page's text layer, ignoring case and accents. */
  async *search(query) {
    const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const needle = fold(query.trim());
    if (!needle) return;
    for (let i = 0; i < this.count; i++) {
      const page = await this.doc.getPage(i + 1);
      const text = (await page.getTextContent()).items.map((localT) => localT.str).join(' ').replace(/\s+/g, ' ');
      // Folding keeps lengths for Latin text, so positions line up with the original well enough for excerpts.
      const hay = fold(text);
      const items = [];
      for (let at = hay.indexOf(needle); at !== -1 && items.length < 50; at = hay.indexOf(needle, at + needle.length)) {
        items.push({ target: i, pre: text.slice(Math.max(0, at - 50), at), match: text.slice(at, at + needle.length), post: text.slice(at + needle.length, at + needle.length + 50) });
      }
      if (items.length) yield { label: t('Page {value}', { value: i + 1 }), items };
      if (i % 5 === 4 || i === this.count - 1) yield { progress: (i + 1) / this.count };
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
    this.wide = new Map(); // page → wide (a two-page scan), once it has loaded
    this.spreadList = null;
    this.atEnd = false; // showing the chapter end screen after the last page
    this.analysis = new Map(); // page → analysePage() result (auto-crop, paper colour)
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
    if (!this.source.count) throw new Error(t('This book has no pages.'));
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
    this.zoomCleanup?.();
    this.stopAutoScroll();
    this.cleanups.forEach((fn) => fn());
    this.source.destroy();
  }

  // ----- settings -----

  applyTheme() {
    let bg = LOOKS[this.s.look]?.surround || this.s.background || '#000000';
    if (!/^#[0-9a-f]{6}$/i.test(bg)) bg = resolveColor(bg);
    const lum = parseInt(bg.slice(1, 3), 16) * 0.3 + parseInt(bg.slice(3, 5), 16) * 0.59 + parseInt(bg.slice(5, 7), 16) * 0.11;
    this.shell.setTheme(bg, lum > 140 ? '#1b1b1f' : '#ffffff');
    const r = this.shell.root;
    r.classList.toggle('rtl', this.dir === 'rtl');
    r.classList.toggle('double', this.s.layout === 'double');
    for (const f of ['screen', 'width', 'height', 'original']) r.classList.toggle(`fit-${f}`, this.s.scaling === f);
    r.style.setProperty('--strip-gap', `${this.s.webtoonGap || 0}px`);
    r.style.setProperty('--page-filter', this.pageFilter());
    this.shell.setArrows(this.dir === 'rtl');
  }

  applySetting(key) {
    this.applyTheme();
    if (['layout', 'direction', 'scaling', 'pageSplit', 'webtoonGap', 'smartSpreads', 'coverAlone', 'autoCrop', 'whitenPaper', 'look'].includes(key)) {
      this.half = 0;
      this.spreadList = null;
      this.build();
    }
    if (key === 'autoScrollSpeed') this.shell.autoScrollChanged(this.autoScrolling);
  }

  // ----- image filters & auto-crop -----

  /** Brightness, contrast, greyscale and invert as a CSS filter (applied to every page). */
  pageFilter() {
    const s = this.s;
    const f = [];
    const b = Number(s.filterBrightness) || 100;
    const c = Number(s.filterContrast) || 100;
    if (b !== 100) f.push(`brightness(${b / 100})`);
    if (c !== 100) f.push(`contrast(${c / 100})`);
    if (s.filterGreyscale || s.look === 'eink') f.push('grayscale(1)');
    if (s.look === 'eink') f.push('contrast(1.12)');
    // Invert for night reading; turning the hues back keeps colour pages' colours.
    if (s.filterInvert) f.push('invert(1) hue-rotate(180deg)');
    return f.join(' ') || 'brightness(1)';
  }

  /** An SVG filter that maps this page's paper colour to white; returns its id. */
  paperFilter(i, gains) {
    const id = `flp-${this.book.id}-${i}`;
    if (document.getElementById(id)) return id;
    let svg = this.shell.root.querySelector('svg.page-filters');
    if (!svg) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'page-filters');
      svg.setAttribute('aria-hidden', 'true');
      this.shell.root.append(svg);
    }
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.id = id;
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const transfer = document.createElementNS(SVG_NS, 'feComponentTransfer');
    ['R', 'G', 'B'].forEach((ch, n) => {
      const fn = document.createElementNS(SVG_NS, `feFunc${ch}`);
      fn.setAttribute('type', 'linear');
      fn.setAttribute('slope', gains[n].toFixed(3));
      transfer.append(fn);
    });
    filter.append(transfer);
    svg.append(filter);
    return id;
  }

  /**
   * Auto-crop and paper whitening for one loaded page. Returns the element to show: a cropped
   * canvas, or the page itself. Webtoon strips are only trimmed at the sides (top and bottom
   * would break the strip).
   */
  prepare(el, i, { sidesOnly = false } = {}) {
    const s = this.s;
    const whiten = s.whitenPaper || s.look === 'book' || s.look === 'eink';
    if (!s.autoCrop && !whiten) return el;
    if (!this.analysis.has(i)) this.analysis.set(i, analysePage(el));
    const a = this.analysis.get(i);
    if (!a) return el;
    let out = el;
    const crop = a.crop && (sidesOnly ? { x: a.crop.x, y: 0, w: a.crop.w, h: 1 } : a.crop);
    if (s.autoCrop && crop && crop.w * crop.h < 0.97) {
      const W = el.naturalWidth || el.width;
      const H = el.naturalHeight || el.height;
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(crop.w * W));
      c.height = Math.max(1, Math.round(crop.h * H));
      c.getContext('2d').drawImage(el, Math.round(crop.x * W), Math.round(crop.y * H), c.width, c.height, 0, 0, c.width, c.height);
      c.style.aspectRatio = `${c.width} / ${c.height}`;
      c.setAttribute('role', 'img');
      c.setAttribute('aria-label', el.alt || t('Page {value}', { value: i + 1 }));
      c.dataset.alt = el.alt || t('Page {value}', { value: i + 1 });
      out = c;
    }
    const gains = whiten && paperGains(a.paper);
    if (gains) out.style.setProperty('--paper', `url(#${this.paperFilter(i, gains)})`);
    return out;
  }

  // ----- navigation -----

  /**
   * Double-page spreads. The cover can sit alone, and with smart spreads a wide page (a scan
   * of two pages) is shown on its own and pairing starts again after it, so the spreads that
   * follow stay aligned. Pages count as narrow until they've loaded.
   */
  spreads() {
    if (this.spreadList) return this.spreadList;
    const smart = this.s.smartSpreads !== false;
    const wide = (i) => smart && this.wide.get(i) === true;
    const list = [];
    const index = [];
    let i = 0;
    if (this.s.coverAlone !== false && this.count) {
      list.push([0]);
      i = 1;
    }
    while (i < this.count) {
      if (!wide(i) && i + 1 < this.count && !wide(i + 1)) {
        list.push([i, i + 1]);
        i += 2;
      } else list.push([i++]);
    }
    list.forEach((sp, n) => sp.forEach((p) => (index[p] = n)));
    this.spreadIndex = index;
    return (this.spreadList = list);
  }
  spreadOf(p) {
    if (this.s.layout !== 'double') return [p];
    const list = this.spreads();
    return list[this.spreadIndex[p] ?? 0] || [p];
  }
  /** Remember whether a page is wide; true when that changes the spreads. */
  noteSize(i, el) {
    const wide = isWide(el);
    if (this.wide.get(i) === wide) return false;
    this.wide.set(i, wide);
    if (this.s.layout !== 'double' || this.s.smartSpreads === false) return false;
    this.spreadList = null;
    return true;
  }

  next() {
    if (this.scrollMode()) return this.scrollBy(1);
    if (this.atEnd) return this.shell.openNext();
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
    if (nextPage >= this.count) return this.showEndPage();
    this.half = 0;
    this.go(nextPage, { dir: 'next' });
  }
  prev() {
    if (this.scrollMode()) return this.scrollBy(-1);
    if (this.atEnd) {
      this.atEnd = false;
      return this.renderPaged('prev');
    }
    if (this.container && this.s.scaling !== 'screen' && this.container.scrollTop > 4) {
      this.container.scrollBy({ top: -this.container.clientHeight * 0.85, behavior: 'smooth' });
      return;
    }
    if (this.splitting() && this.currentWide && this.half === 1) {
      this.half = 0;
      return this.renderPaged('prev');
    }
    const spread = this.spreadOf(this.page);
    if (spread[0] === 0) return this.shell.toast(t('Start of book'));
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

  /** Text search, for PDFs with a text layer (comic pages are images). Same results as TextEngine.search. */
  get search() {
    return this.isPdf ? (query) => this.source.search(query) : null;
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
    this.atEnd = false;
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
    this.shell.setSubtitle(t('Page {value} of {count}', { value: spread[0] + 1, count: this.count }));
    this.tracker.update({ page: this.page, position: String(this.page), percent: (last + 1) / this.count });
    this.shell.pageTurned();
  }

  // ----- layout -----

  build() {
    const stage = this.shell.stage;
    this.stripCleanup?.();
    this.zoomCleanup?.();
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
    this.shell.setAutoScrollAvailable(this.canAutoScroll);
  }

  buildPaged() {
    const container = h('div.paged');
    this.container = container;
    this.shell.stage.append(container);
    const reset = iconButton('zoom_out_map', t('Reset zoom'), () => this.zoom.reset());
    reset.classList.add('zoom-reset');
    reset.hidden = true;
    this.shell.stage.append(reset);
    this.zoom = new PageZoom(container, (active) => { reset.hidden = !active; });
    this.attachGestures(container);
    this.renderPaged();
  }

  async renderPaged(dir) {
    this.zoom?.reset();
    const seq = ++this.renderSeq;
    this.atEnd = false;
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
    els = els.map((el, n) => this.prepare(el, spread[n]));
    // A page turned out to be wide: the spreads changed, so show the right pair instead.
    if (els.map((el, n) => this.noteSize(spread[n], el)).some(Boolean)) {
      const now = this.spreadOf(this.page);
      if (now.join() !== spread.join()) {
        this.page = now[0];
        return this.renderPaged(dir);
      }
    }

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

    const solo = this.s.layout === 'double' && spread.length === 1;
    const turn = dir ? this.s.pageTurn || 'slide' : 'none';
    const wrap = h(`div.spread${this.wideFit ? '.fit-wide' : ''}${solo ? '.solo' : ''}${turn === 'slide' ? `.turn-${dir}` : ''}${els.length > 1 ? '.pair' : ''}`, els);
    // The Book look: a spine between two pages, or a soft fold on the bound side of one.
    if (this.s.look === 'book') wrap.append(h(`div.spine${els.length > 1 ? '' : '.single'}`));
    // Book page turn: the old pages go onto a leaf that swings over the new ones.
    const old = this.container.querySelector(':scope > .spread:not(.end-spread)');
    const bookTurn = turn === 'book' && old && !reducedMotion();
    const oldRects = bookTurn ? measure(old, this.shell.stage) : null;
    finishTurn();
    this.container.replaceChildren(wrap);
    this.container.scrollTop = dir === 'prev' && this.s.scaling !== 'screen' ? this.container.scrollHeight : 0;
    this.container.scrollLeft = this.dir === 'rtl' ? this.container.scrollWidth : 0;
    if (bookTurn) {
      turnPages({
        stage: this.shell.stage,
        oldWrap: old,
        oldRects,
        newWrap: wrap,
        toLeft: (dir === 'next') !== (this.dir === 'rtl'),
        paper: this.s.look === 'eink' ? LOOKS.eink.bg : '#fbf8f1',
      });
    }
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
          const el = await this.source.load(i, await this.sizeOpts(this.spreadOf(i)));
          const shown = this.spreadOf(this.page).join();
          if (this.noteSize(i, el) && !this.atEnd && !this.scrollMode() && this.spreadOf(this.page).join() !== shown) {
            this.page = this.spreadOf(this.page)[0];
            this.renderPaged();
          }
        } catch {}
      }
    })();
    this.source.trim(this.page, this.isPdf ? 3 : 8);
  }

  attachGestures(el) {
    const pointers = new Map();
    let start = null;
    let moved = false;
    let pinched = false;
    let pair = null;
    let tap = null;
    let timer;
    const clearTap = () => { clearTimeout(timer); tap = null; };
    const geometry = () => {
      const [a, b] = [...pointers.values()];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('button, a')) return;
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        start = { x: e.clientX, y: e.clientY, t: Date.now() };
        moved = false;
        pinched = false;
      } else {
        clearTap();
        pinched = moved = true;
        pair = geometry();
        finishTurn();
      }
    });
    el.addEventListener('pointermove', (e) => {
      const previous = pointers.get(e.pointerId);
      if (!previous) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2) {
        const next = geometry();
        if (pair?.distance > 0) {
          this.zoom.zoom(this.zoom.scale * next.distance / pair.distance, pair.x, pair.y);
          this.zoom.pan(next.x - pair.x, next.y - pair.y);
        }
        pair = next;
      } else {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) moved = true;
        if (this.zoom.active) this.zoom.pan(e.clientX - previous.x, e.clientY - previous.y);
        else if (moved && this.s.scaling !== 'screen') {
          el.scrollLeft -= e.clientX - previous.x;
          el.scrollTop -= e.clientY - previous.y;
        }
      }
      if (moved) clearTap();
    });
    const release = (e) => {
      if (!pointers.delete(e.pointerId)) return;
      pair = pointers.size >= 2 ? geometry() : null;
      if (pointers.size || !start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (e.type === 'pointerup' && !pinched) {
        if (!this.zoom.active && this.shell.swipeEnabled() && el.scrollWidth <= el.clientWidth + 4 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - start.t < 800) {
          dx < 0 ? this.right() : this.left();
        } else if (!moved && Date.now() - start.t < 500) {
          const now = Date.now();
          if (tap && now - tap.t < 300 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 40) {
            clearTap();
            finishTurn();
            this.zoom.active ? this.zoom.reset() : this.zoom.zoom(2.5, e.clientX, e.clientY);
          } else {
            clearTap();
            tap = { x: e.clientX, y: e.clientY, t: now };
            const x = (e.clientX - el.getBoundingClientRect().left) / el.clientWidth;
            timer = setTimeout(() => {
              tap = null;
              this.zoom.active ? this.shell.toggleChrome() : this.shell.handleTap(x);
            }, 300);
          }
        }
      }
      start = null;
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        clearTap();
        finishTurn();
        this.zoom.zoom(this.zoom.scale * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
        return;
      }
      if (this.zoom.active) {
        e.preventDefault();
        this.zoom.pan(-e.deltaX, -e.deltaY);
        return;
      }
      if (this.s.scaling !== 'screen' || Math.abs(e.deltaY) < 20) return;
      e.preventDefault();
      const now = Date.now();
      if (now - (this.lastWheel || 0) < 350) return;
      this.lastWheel = now;
      e.deltaY > 0 ? this.next() : this.prev();
    }, { passive: false });
    this.zoomCleanup = () => { clearTap(); this.zoom.reset(); };
  }

  /** The chapter end screen, one "page" after the last. */
  showEndPage() {
    this.zoom?.reset();
    this.atEnd = true;
    this.renderSeq++;
    this.container.replaceChildren(h(`div.spread.end-spread${this.s.pageTurn === 'none' ? '' : '.turn-next'}`, this.shell.endPanel({ paged: true })));
    this.container.scrollTop = 0;
    this.shell.setPosition(this.shell.endLabel, this.shell.endLabel);
    this.shell.setSliderValue(this.count - 1);
    this.shell.pageTurned();
  }

  // ----- webtoon (continuous scroll) -----

  buildStrip() {
    const strip = h('div.strip');
    this.container = strip;
    const W = () => Math.min(strip.clientWidth || innerWidth, 800);
    strip.style.setProperty('--strip-width', this.s.scaling === 'width' || this.isPdf ? '100%' : '800px');
    const pages = [];
    for (let i = 0; i < this.count; i++) pages.push(h('div.pg', { dataset: { i: String(i) } }));
    strip.append(...pages, h('div.strip-end', this.shell.endPanel({ paged: false })));
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
        const el = this.prepare(await this.source.load(i, { cssWidth: pg.clientWidth || W() }), i, { sidesOnly: true });
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
        // Reached the end screen at the bottom: the chapter's finished.
        if ((userScrolled || this.autoScrolling) && this.page >= this.count - 1 && !this.endShown && strip.scrollTop + strip.clientHeight >= pages[pages.length - 1].offsetTop + pages[pages.length - 1].offsetHeight) {
          this.endShown = true;
          this.report();
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
      this.autoHeldUntil = Infinity; // auto-scroll waits while a finger (or mouse button) is down
    });
    const release = () => (this.autoHeldUntil = performance.now() + 700);
    strip.addEventListener('pointerup', release);
    strip.addEventListener('pointercancel', release);
    strip.addEventListener('wheel', () => (this.autoHeldUntil = performance.now() + 1200), { passive: true });
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
      this.stopAutoScroll();
    };
    this.cleanups.push(() => this.stripCleanup?.());
    this.report();
    this.stripJump(this.page, true);
  }

  // ----- auto-scroll (webtoon) -----

  get canAutoScroll() {
    return this.scrollMode();
  }
  toggleAutoScroll(on = !this.autoScrolling) {
    if (on) this.startAutoScroll();
    else this.stopAutoScroll();
  }
  startAutoScroll() {
    const c = this.container;
    if (!this.scrollMode() || this.autoScrolling || !c) return;
    if (c.scrollTop + c.clientHeight >= c.scrollHeight - 2) return this.shell.toast(t('End of chapter'));
    this.autoScrolling = true;
    this.autoHeldUntil = 0;
    let pos = c.scrollTop;
    let last = performance.now();
    let lastActivity = last;
    const step = (now) => {
      if (!this.autoScrolling) return;
      const dt = Math.min(now - last, 100) / 1000; // a stalled tab doesn't jump ahead
      last = now;
      if (!c.isConnected) return this.stopAutoScroll();
      const held = now < this.autoHeldUntil || document.querySelector('dialog[open]');
      if (held || Math.abs(c.scrollTop - pos) > 3) pos = c.scrollTop; // scrolled by hand: carry on from there
      if (!held) {
        const level = Math.max(1, Math.min(10, Number(this.s.autoScrollSpeed) || 3));
        pos += AUTO_SPEEDS[level] * Math.max(0.6, Math.min(1.6, c.clientHeight / 800)) * dt;
        c.scrollTop = pos;
        if (now - lastActivity > 20_000) {
          this.tracker.activity(); // reading hands-free still counts as reading
          lastActivity = now;
        }
        if (c.scrollTop + c.clientHeight >= c.scrollHeight - 1) return this.stopAutoScroll();
      }
      this.autoRaf = requestAnimationFrame(step);
    };
    this.autoRaf = requestAnimationFrame(step);
    this.shell.autoScrollChanged(true);
  }
  stopAutoScroll() {
    if (!this.autoScrolling) return;
    this.autoScrolling = false;
    cancelAnimationFrame(this.autoRaf);
    this.shell.autoScrollChanged(false);
  }
  /** Faster (+1) or slower (-1); saved with the reader settings. */
  autoScrollSpeed(delta) {
    const level = Math.max(1, Math.min(10, (Number(this.s.autoScrollSpeed) || 3) + delta));
    this.shell.changeSetting('autoScrollSpeed', level);
    this.shell.toast(t('Speed {level}', { level: level }));
  }

  async stripJump(p, initial = false) {
    const pages = this.stripPages;
    if (!pages) return;
    this.page = p;
    const pg = pages[p];
    pg.scrollIntoView({ block: 'start' });
    const loadedEl = await this.source.load(p, { cssWidth: pg.clientWidth || innerWidth }).catch(() => null);
    const el = loadedEl && this.prepare(loadedEl, p, { sidesOnly: true });
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
  let localT;
  return (...a) => {
    clearTimeout(localT);
    localT = setTimeout(() => fn(...a), ms);
  };
}
