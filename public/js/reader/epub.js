// EPUB reader built on epub.js.

import { fileUrl } from '../api.js';
import { h, icon, segmented, sheet, isDark, store } from '../ui.js';
import { loadDefaults, saveDefaults } from './reader.js';

const THEMES = {
  light: { bg: '#fbfaf7', fg: '#1f1d1a', link: '#4a4fb5', label: 'Paper' },
  sepia: { bg: '#f3ead6', fg: '#4f3d2e', link: '#8a5a2b', label: 'Sepia' },
  dark: { bg: '#1b1c20', fg: '#dcdbe2', link: '#b9b8ff', label: 'Dark' },
  black: { bg: '#000000', fg: '#c8c8c8', link: '#a3a8ff', label: 'Black' },
};
const FONTS = {
  publisher: null,
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
  sans: '"Roboto Flex Reader", -apple-system, system-ui, "Segoe UI", Roboto, sans-serif',
};
const MARGINS = { narrow: 12, normal: 28, wide: 64 };

const scriptCache = new Map();
function loadScript(src) {
  if (!scriptCache.has(src)) {
    scriptCache.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.append(s);
    }));
  }
  return scriptCache.get(src);
}

export class EpubEngine {
  constructor(book, shell, tracker) {
    this.book = book;
    this.shell = shell;
    this.tracker = tracker;
    const defaults = { theme: 'auto', fontSize: 100, font: 'publisher', lineHeight: 1.5, margin: 'normal', flow: 'paginated' };
    this.settings = { ...loadDefaults('epub', defaults), ...(book.progress?.settings || {}) };
    this.cfi = book.progress && !book.progress.finished ? book.progress.position : null;
    this.percent = book.progress?.percent || 0;
    this.chapterBySpine = new Map();
    this.locationsKey = `loc.${book.id}.${book.version}`;
  }

  async open() {
    this.shell.setLoading(true);
    await loadScript('/vendor/jszip/jszip.min.js');
    await loadScript('/vendor/epub/epub.min.js');
    this.epub = window.ePub(fileUrl(this.book), { openAs: 'epub' });
    await this.epub.ready;

    this.shell.setSettings(() => this.settingsSheet());
    this.shell.setSlider({
      min: 0,
      max: 1000,
      value: Math.round(this.percent * 1000),
      onInput: (v) => this.shell.setPosition(`${(v / 10).toFixed(1)}%`),
      onChange: (v) => this.goToPercent(v / 1000),
    });

    // Clicks inside the book arrive via rendition events; clicks in the margins land here.
    this.shell.stage.addEventListener('click', (e) => {
      if (this.scrollMode()) this.shell.toggleChrome();
      else this.shell.handleTap(e.clientX / innerWidth);
    });

    await this.render(this.cfi);
    this.shell.setLoading(false);

    // Table of contents
    this.epub.loaded.navigation.then((nav) => {
      this.toc = flattenToc(nav.toc);
      for (const item of this.toc) {
        const section = this.epub.spine.get(item.href);
        if (section && !this.chapterBySpine.has(section.index)) this.chapterBySpine.set(section.index, item.label);
      }
      this.shell.setTocAvailable(this.toc.length > 0);
      if (this.location) this.onRelocated(this.location);
    });

    this.prepareLocations();
  }

  /** Locations give a stable percentage across the book; generating them is slow, so cache them. */
  async prepareLocations() {
    const cached = store.get(this.locationsKey);
    try {
      if (cached) this.epub.locations.load(cached);
      else {
        await this.epub.locations.generate(1200);
        store.set(this.locationsKey, this.epub.locations.save());
      }
    } catch {
      return;
    }
    this.locationsReady = true;
    if (this.location) this.onRelocated(this.location);
  }

  async render(target) {
    this.rendition?.destroy();
    this.shell.stage.replaceChildren();
    const s = this.settings;
    const host = h('div.epub-stage');
    host.style.left = host.style.right = `calc(${MARGINS[s.margin] ?? 28}px + env(safe-area-inset-left, 0px))`;
    this.shell.stage.append(host);
    this.host = host;

    const scrolled = s.flow === 'scrolled';
    this.rendition = this.epub.renderTo(host, {
      width: '100%',
      height: '100%',
      flow: scrolled ? 'scrolled' : 'paginated',
      manager: scrolled ? 'continuous' : 'default',
      spread: innerWidth >= 1000 && !scrolled ? 'auto' : 'none',
      minSpreadWidth: 1000,
      allowScriptedContent: false,
    });

    this.rendition.hooks.content.register((contents) => this.styleContents(contents));
    this.rendition.on('relocated', (loc) => this.onRelocated(loc));
    this.rendition.on('click', (e) => this.onClick(e));
    this.rendition.on('touchstart', (e) => this.onTouchStart(e));
    this.rendition.on('touchend', (e) => this.onTouchEnd(e));
    this.rendition.on('keydown', (e) => {
      this.tracker.activity();
      this.shell.handleKey(e);
    });
    this.rendition.on('mousedown', () => this.tracker.activity());

    this.applyTheme();
    try {
      await this.rendition.display(target || undefined);
    } catch {
      await this.rendition.display();
    }
  }

  destroy() {
    try {
      this.rendition?.destroy();
      this.epub?.destroy();
    } catch {}
  }

  // ----- appearance -----

  colors() {
    const t = this.settings.theme === 'auto' ? (isDark() ? 'dark' : 'light') : this.settings.theme;
    return THEMES[t] || THEMES.light;
  }

  applyTheme() {
    const c = this.colors();
    this.shell.setTheme(c.bg, c.fg);
    this.rendition?.themes.fontSize(`${this.settings.fontSize}%`);
    for (const contents of this.rendition?.getContents() || []) this.styleContents(contents);
  }

  styleContents(contents) {
    const doc = contents.document;
    if (!doc) return;
    const s = this.settings;
    const c = this.colors();
    const font = FONTS[s.font];
    let style = doc.getElementById('flyleaf-style');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'flyleaf-style';
      doc.head.append(style);
    }
    style.textContent = `
      @font-face { font-family: "Roboto Flex Reader"; src: url("${location.origin}/vendor/roboto-flex/files/roboto-flex-latin-wght-normal.woff2") format("woff2"); font-weight: 100 1000; }
      html, body { background: ${c.bg} !important; color: ${c.fg} !important; }
      body { -webkit-text-size-adjust: 100%; line-height: ${s.lineHeight} !important; ${font ? `font-family: ${font} !important;` : ''} }
      p, li, dd, dt, blockquote, div, span, section, td, th, h1, h2, h3, h4, h5, h6 { color: inherit !important; background-color: transparent !important; ${font ? `font-family: ${font} !important;` : ''} }
      p, li, blockquote { line-height: ${s.lineHeight} !important; }
      a, a * { color: ${c.link} !important; }
      img, svg, video { max-width: 100% !important; height: auto; }
      ::selection { background: ${c.link}55; }
    `;
    // Activity inside the iframe counts toward reading time.
    doc.addEventListener('scroll', () => this.tracker.activity(), { passive: true });
  }

  setSetting(key, value) {
    this.settings[key] = value;
    saveDefaults('epub', this.settings);
    this.tracker.saveSettings(this.settings);
    if (key === 'flow' || key === 'margin') {
      this.render(this.cfi);
    } else {
      this.applyTheme();
    }
  }

  settingsSheet() {
    const s = this.settings;
    const sizeLabel = h('span.label-large', { style: { minWidth: '48px', textAlign: 'center' } }, `${s.fontSize}%`);
    const sizeSlider = h('input.slider', { type: 'range', min: 70, max: 220, step: 5, value: s.fontSize, 'aria-label': 'Text size' });
    const setSize = (v) => {
      v = Math.max(70, Math.min(220, v));
      sizeSlider.value = v;
      sizeSlider.style.setProperty('--fill', `${((v - 70) / 150) * 100}%`);
      sizeLabel.textContent = `${v}%`;
      this.setSetting('fontSize', v);
    };
    sizeSlider.style.setProperty('--fill', `${((s.fontSize - 70) / 150) * 100}%`);
    sizeSlider.addEventListener('input', () => {
      sizeSlider.style.setProperty('--fill', `${((sizeSlider.value - 70) / 150) * 100}%`);
      sizeLabel.textContent = `${sizeSlider.value}%`;
    });
    sizeSlider.addEventListener('change', () => setSize(Number(sizeSlider.value)));

    const themeSwatches = h('div.swatches', { style: { justifyContent: 'space-between' } },
      [['auto', 'Auto'], ...Object.entries(THEMES).map(([k, v]) => [k, v.label])].map(([key, label]) => {
        const t = key === 'auto' ? null : THEMES[key];
        return h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' } },
          h('button.swatch', {
            type: 'button',
            'aria-label': label,
            'aria-pressed': String(s.theme === key),
            style: {
              background: t ? t.bg : 'linear-gradient(135deg, #fbfaf7 50%, #1b1c20 50%)',
              color: t ? t.fg : '#888',
              boxShadow: 'inset 0 0 0 1px rgb(127 127 127 / 0.5)',
              fontWeight: '600',
            },
            onclick: (e) => {
              for (const b of themeSwatches.querySelectorAll('.swatch')) b.setAttribute('aria-pressed', String(b === e.currentTarget));
              this.setSetting('theme', key);
            },
          }, 'Aa'),
          h('span.label-small', label));
      }),
    );

    return h('div',
      h('div.sheet-section', h('h3', 'Theme'), themeSwatches),
      h('div.sheet-section', h('h3', 'Text size'),
        h('div.row',
          h('button.icon-btn.state', { type: 'button', 'aria-label': 'Smaller text', onclick: () => setSize(this.settings.fontSize - 10) }, icon('text_decrease')),
          sizeSlider,
          h('button.icon-btn.state', { type: 'button', 'aria-label': 'Larger text', onclick: () => setSize(this.settings.fontSize + 10) }, icon('text_increase')),
          sizeLabel)),
      h('div.sheet-section', h('h3', 'Font'),
        segmented([
          { value: 'publisher', label: 'Original' },
          { value: 'serif', label: 'Serif' },
          { value: 'sans', label: 'Sans' },
        ], s.font, (v) => this.setSetting('font', v))),
      h('div.sheet-section', h('h3', 'Line spacing'),
        segmented([
          { value: 1.3, label: 'Tight', icon: 'density_small' },
          { value: 1.5, label: 'Normal', icon: 'density_medium' },
          { value: 1.8, label: 'Loose', icon: 'density_large' },
        ], s.lineHeight, (v) => this.setSetting('lineHeight', v))),
      h('div.sheet-section', h('h3', 'Margins'),
        segmented([
          { value: 'narrow', label: 'Narrow' },
          { value: 'normal', label: 'Normal' },
          { value: 'wide', label: 'Wide' },
        ], s.margin, (v) => this.setSetting('margin', v))),
      h('div.sheet-section', h('h3', 'Layout'),
        segmented([
          { value: 'paginated', label: 'Pages', icon: 'auto_stories' },
          { value: 'scrolled', label: 'Scroll', icon: 'swap_vert' },
        ], s.flow, (v) => this.setSetting('flow', v))),
    );
  }

  openToc() {
    if (!this.toc?.length) return;
    const currentIndex = this.location ? this.epub.spine.get(this.location.start.cfi)?.index : null;
    sheet((close) =>
      h('div.toc', h('div.sheet-section', h('h3', 'Contents')),
        this.toc.map((t) => {
          const idx = this.epub.spine.get(t.href)?.index;
          return h(`button.list-item.state.depth-${Math.min(t.depth, 3)}${idx === currentIndex && idx != null ? '.current' : ''}`, {
            type: 'button',
            onclick: () => {
              close();
              this.rendition.display(t.href);
            },
          }, h('span.text', t.label));
        }),
      ),
    );
  }

  // ----- navigation -----

  scrollMode() {
    return this.settings.flow === 'scrolled';
  }
  next() {
    if (this.location?.atEnd) return this.shell.showEnd();
    this.rendition.next();
  }
  prev() {
    if (this.location?.atStart) return this.shell.toast('Start of book');
    this.rendition.prev();
  }
  left() {
    this.prev();
  }
  right() {
    this.next();
  }
  goToStart() {
    this.rendition.display(this.epub.spine.first()?.href);
  }
  goToPercent(p) {
    if (!this.locationsReady) {
      this.shell.toast('Still indexing this book…');
      return;
    }
    const cfi = this.epub.locations.cfiFromPercentage(p);
    if (cfi) this.rendition.display(cfi);
  }

  onRelocated(loc) {
    this.location = loc;
    if (!loc?.start) return;
    this.cfi = loc.start.cfi;
    let percent = this.percent;
    if (this.locationsReady) percent = this.epub.locations.percentageFromCfi(this.cfi) ?? percent;
    if (loc.atEnd) percent = 1;
    this.percent = percent;

    const spineIndex = loc.start.index;
    let chapter = null;
    for (let i = spineIndex; i >= 0 && !chapter; i--) chapter = this.chapterBySpine.get(i);
    this.shell.setSubtitle(chapter || '');

    const pct = `${(percent * 100).toFixed(percent < 0.1 ? 1 : 0)}%`;
    const disp = loc.start.displayed;
    const left = disp && !this.scrollMode() ? disp.total - disp.page : null;
    this.shell.setPosition(
      this.locationsReady ? pct : 'Indexing…',
      left != null && left > 0 ? `${left} ${left === 1 ? 'page' : 'pages'} left in chapter · ${pct}` : pct,
    );
    this.shell.setSliderValue(Math.round(percent * 1000));
    this.tracker.update({ position: this.cfi, percent: this.locationsReady || loc.atEnd ? percent : undefined });
  }

  // Taps and swipes arrive from inside the iframe.
  onClick(e) {
    this.tracker.activity();
    if (e.target?.closest?.('a[href]')) return;
    const sel = e.view?.getSelection?.();
    if (sel && String(sel).length > 0) return;
    if (this.swiped) {
      this.swiped = false;
      return;
    }
    const frame = e.view?.frameElement;
    const fr = frame?.getBoundingClientRect();
    const x = (fr ? fr.left + e.clientX : e.clientX) / innerWidth;
    if (this.scrollMode()) this.shell.toggleChrome();
    else this.shell.handleTap(x);
  }
  onTouchStart(e) {
    this.tracker.activity();
    const t = e.changedTouches?.[0];
    if (t) this.touch = { x: t.screenX, y: t.screenY, time: Date.now() };
  }
  onTouchEnd(e) {
    const t = e.changedTouches?.[0];
    const s = this.touch;
    this.touch = null;
    if (!t || !s || this.scrollMode()) return;
    const dx = t.screenX - s.x;
    const dy = t.screenY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - s.time < 800) {
      this.swiped = true;
      setTimeout(() => (this.swiped = false), 400);
      dx < 0 ? this.next() : this.prev();
    }
  }
}

function flattenToc(items, depth = 0, out = []) {
  for (const it of items || []) {
    out.push({ label: (it.label || '').trim(), href: it.href, depth });
    if (it.subitems?.length) flattenToc(it.subitems, depth + 1, out);
  }
  return out;
}
