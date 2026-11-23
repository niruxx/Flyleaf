import { t } from '../i18n.js';
// Text reader (EPUB, MOBI/AZW/AZW3, FB2, TXT→EPUB) built on foliate-js, with highlights & notes.

import { api, fileUrl } from '../api.js';
import { h, icon, iconButton, snackbar, dialog, field, copyText, menu } from '../ui.js';
import { isDark } from '../theme.js';
import { TEXT_THEMES, LOOKS, PAPER_GRAIN } from '../components/reader-settings.js';
import { fallingLeaf, reducedMotion } from './turn.js';
import { HIGHLIGHT_COLORS } from '../views/bookmarks.js';
import { SpeechPlayer, sentences, readAloudControls } from './read-aloud.js';

const EXT = { epub: 'epub', txt: 'epub', mobi: 'mobi', azw3: 'azw3', fb2: 'fb2' };
const MIME = { epub: 'application/epub+zip', mobi: 'application/x-mobipocket-ebook', azw3: 'application/vnd.amazon.ebook', fb2: 'application/x-fictionbook+xml' };
const MARGINS = { narrow: { inline: '960px', gap: '4%' }, normal: { inline: '720px', gap: '6%' }, wide: { inline: '600px', gap: '9%' } };

let fontCache = null;
async function fonts() {
  fontCache ??= api.fonts().catch(() => []);
  return fontCache;
}

// ---------------------------------------------------------------------------
// Footnotes: links to notes open in a pop-up instead of jumping to the notes page. A link is a
// note reference when the book says so (epub:type="noteref", role="doc-noteref"), or when it
// looks like one: a superscript, or a short marker such as "1", "[2]", "*" or "†".

const EPUB_NS = 'http://www.idpf.org/2007/ops';
const words = (el, attr) => new Set((attr === 'type' ? el?.getAttributeNS?.(EPUB_NS, 'type') : el?.getAttribute?.('role'))?.split(/\s+/) || []);
const NOTE_TYPES = { get footnote() { return t('Footnote'); }, get endnote() { return t('Endnote'); }, get rearnote() { return t('Endnote'); }, get note() { return t('Note'); }, get glossdef() { return t('Definition'); }, get biblioentry() { return t('Reference'); } };
const NOTE_ROLES = { get 'doc-footnote'() { return t('Footnote'); }, get 'doc-endnote'() { return t('Endnote'); }, get 'doc-biblioentry'() { return t('Reference'); }, get definition() { return t('Definition'); }, get note() { return t('Note'); } };

function isSuper(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.matches('sup')) return true;
  const v = el.ownerDocument.defaultView?.getComputedStyle(el).verticalAlign;
  return v === 'super' || v === 'top' || v === 'text-top';
}

/** 'yes', 'maybe' (looks like one; checked again once the target is found) or null. */
function noteRefKind(a) {
  const types = words(a, 'type');
  const roles = words(a, 'role');
  if (['noteref', 'glossref', 'biblioref'].some((localT) => types.has(localT)) || ['doc-noteref', 'doc-glossref', 'doc-biblioref'].some((r) => roles.has(r))) return 'yes';
  if (types.has('backlink') || roles.has('doc-backlink')) return null;
  const text = a.textContent.trim();
  const marker = /^[[(]?(\d{1,4}|[ivxlc]{1,6}|[a-z]|[*†‡§¶]+)[\])]?$/i.test(text);
  if (isSuper(a) || isSuper(a.parentElement) || (a.children.length === 1 && isSuper(a.children[0]))) return 'maybe';
  return marker && text.length <= 6 ? 'maybe' : null;
}

/** Copy a note's content into this page: text and simple formatting only (no scripts, styles, links or images). */
const KEEP = new Set(['P', 'DIV', 'SPAN', 'EM', 'STRONG', 'I', 'B', 'U', 'SMALL', 'SUP', 'SUB', 'BR', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CITE', 'CODE', 'Q', 'DL', 'DT', 'DD', 'ABBR', 'DFN', 'S']);
function cleanNote(node) {
  const out = document.createDocumentFragment();
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out.append(child.textContent);
    else if (child.nodeType === 1) {
      const tag = child.tagName.toUpperCase().replace(/^.*:/, '');
      if (/^(SCRIPT|STYLE|IMG|SVG|IMAGE|VIDEO|AUDIO|IFRAME|OBJECT|HEAD)$/.test(tag)) continue;
      // Links back to the text ("↩", "1.") are only noise in a pop-up.
      if (tag === 'A' && (words(child, 'type').has('backlink') || words(child, 'role').has('doc-backlink') || /^[\s↩↑⤴^]*$/.test(child.textContent))) continue;
      const el = document.createElement(KEEP.has(tag) ? tag.toLowerCase() : /^(H\d|SECTION|ASIDE|ARTICLE|HEADER|FOOTER)$/.test(tag) ? 'div' : 'span');
      el.append(cleanNote(child));
      out.append(el);
    }
  }
  return out;
}

export class TextEngine {
  constructor(book, shell, tracker) {
    this.book = book;
    this.shell = shell;
    this.tracker = tracker;
    this.s = shell.settings;
    this.toc = [];
    this.fraction = book.progress?.percent || 0;
    this.annotationsByValue = new Map();
    this.cleanups = [];
  }

  scrollMode() {
    return this.s.flow === 'scrolled';
  }

  async open(startLocator, file) {
    this.shell.setLoading(true);
    const [{ Overlayer }] = await Promise.all([import('/vendor/foliate/overlayer.js'), import('/vendor/foliate/view.js')]);
    this.Overlayer = Overlayer;

    if (!file) {
      const res = await fetch(fileUrl(this.book), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.status === 410 ? t('This file is no longer in the library folder.') : t('Couldn’t load the book ({status}).', { status: res.status }));
      const ext = EXT[this.book.format] || 'epub';
      file = new File([await res.blob()], `book.${ext}`, { type: MIME[ext] || 'application/octet-stream' });
    }
    if (this.destroyed) return;
    this.file = file;

    const view = document.createElement('foliate-view');
    this.view = view;
    this.shell.stage.replaceChildren(h('div.text-stage', view));
    await view.open(file);
    if (this.destroyed) return view.close();
    view.renderer.addEventListener('navigation-error', (event) => this.navigationError(event.detail));
    const onStageClick = (event) => {
      if (event.target !== view && event.target !== view.parentElement && event.target !== this.shell.stage) return;
      if (this.scrollMode()) this.shell.toggleChrome();
      else this.shell.handleTap((event.clientX - this.shell.stage.getBoundingClientRect().left) / this.shell.stage.clientWidth);
    };
    this.shell.stage.addEventListener('click', onStageClick);
    this.cleanups.push(() => this.shell.stage.removeEventListener('click', onStageClick));
    this.applyLayout();
    await this.applyStyles();
    if (this.destroyed) return;

    view.addEventListener('relocate', (e) => this.onRelocate(e.detail));
    view.addEventListener('load', (e) => this.onLoad(e.detail));
    view.addEventListener('create-overlay', (e) => this.onCreateOverlay(e.detail.index));
    view.addEventListener('draw-annotation', (e) => {
      const { draw, annotation } = e.detail;
      const color = annotation.color || 'yellow';
      if (color === 'underline') draw(this.Overlayer.underline, { color: HIGHLIGHT_COLORS.underline, width: 2 });
      else draw(this.Overlayer.highlight, { color: HIGHLIGHT_COLORS[color] || HIGHLIGHT_COLORS.yellow });
    });
    view.addEventListener('show-annotation', (e) => this.showAnnotation(e.detail.value));
    view.addEventListener('external-link', (e) => {
      e.preventDefault();
      window.open(e.detail.a.href, '_blank', 'noopener');
    });
    view.addEventListener('link', (e) => this.onLink(e));
    view.addEventListener('relocate', () => {
      this.closeFootnote();
      this.closeSelection();
    });

    this.toc = flattenToc(view.book.toc || []);
    this.setAnnotations(this.shell.annotations);

    this.shell.setSlider({
      min: 0,
      max: 1000,
      value: Math.round(this.fraction * 1000),
      rtl: view.book.dir === 'rtl',
      onInput: (v) => this.shell.setPosition(`${(v / 10).toFixed(1)}%`),
      onChange: (v) => { this.speech?.stop(); return view.goToFraction(v / 1000); },
    });

    const saved = this.book.progress && !this.book.progress.finished ? this.book.progress.position : null;
    const target = startLocator || saved;
    try {
      if (target && /^epubcfi\(/.test(target)) await view.init({ lastLocation: target });
      else if (startLocator) {
        // A chapter to open at (from full-text search): an href, or a section number for FB2.
        await view.init({ showTextStart: false });
        await view.goTo(/^\d+$/.test(startLocator) ? Number(startLocator) : startLocator).catch(() => {});
      } else {
        await view.init({ showTextStart: false });
        if (!saved && this.book.progress?.percent > 0) await view.goToFraction(this.book.progress.percent);
      }
    } catch {
      if (this.destroyed) return;
      await view.init({});
    }
    if (this.destroyed) return;
    this.shell.setLoading(false);

    const onTheme = () => this.s.textTheme === 'auto' && this.applyStyles();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', onTheme);
    this.cleanups.push(() => mq.removeEventListener('change', onTheme));
  }

  destroy() {
    this.destroyed = true;
    this.speech?.destroy();
    this.speechBar?.remove();
    clearTimeout(this.navigationTimer);
    this.turnLift?.cancel();
    this.closeFootnote();
    this.lookupCleanup?.();
    this.cleanups.forEach((fn) => fn());
    this.closeSelection();
    try {
      this.view?.close();
    } catch {}
    this.view?.remove();
  }

  get canReadAloud() {
    return Boolean(globalThis.speechSynthesis && globalThis.SpeechSynthesisUtterance && globalThis.Intl?.Segmenter
      && this.view?.renderer?.scrollToAnchor);
  }

  openReadAloud() {
    if (!this.canReadAloud || this.destroyed) return;
    if (!this.speech) {
      const key = 'foliate-search:flyleaf-read-aloud';
      const language = this.view.book.metadata?.language;
      const adapter = {
        language: Array.isArray(language) ? language[0] : language,
        load: async next => {
          if (next) {
            let index = this.speechSection + 1;
            while (this.view.book.sections[index]?.linear === 'no') index++;
            if (index >= this.view.book.sections.length) return null;
            adapter.clear();
            await this.view.goTo(index);
            if (this.destroyed) return null;
            if (!this.view.renderer.getContents().some(content => content.index === index)) throw new Error('Chapter navigation failed');
          }
          const contents = this.view.renderer.getContents();
          const visible = this.view.lastLocation?.range;
          const content = contents.find(item => item.doc === visible?.startContainer.ownerDocument) || contents[0];
          if (!content) throw new Error('No readable chapter');
          this.speechSection = content.index;
          const items = sentences(content.doc, adapter.language);
          let start = 0;
          if (!next && visible?.startContainer.ownerDocument === content.doc) {
            start = items.findIndex(item => item.range.comparePoint(visible.startContainer, visible.startOffset) <= 0);
            if (start < 0) start = items.length;
          }
          return { items, start };
        },
        show: async item => {
          await this.view.renderer.scrollToAnchor(item.range);
          adapter.clear();
          const content = this.view.renderer.getContents().find(c => c.doc === item.range.startContainer.ownerDocument);
          this.speechOverlay = content?.overlayer;
          this.speechOverlay?.add(key, item.sentenceRange, this.Overlayer.highlight, { color: '#ffd54f' });
          this.tracker.activity();
        },
        clear: () => { this.speechOverlay?.remove(key); this.speechOverlay = null; },
      };
      this.speech = new SpeechPlayer(adapter);
    }
    this.shell.showChrome(true);
    if (!this.speechBar?.isConnected) this.speechBar = readAloudControls(this.speech, this.shell.root);
  }

  // ----- appearance -----

  colors() {
    if (typeof document !== 'undefined' && document.documentElement?.classList?.contains('eink')) return { bg: '#fff', fg: '#000', link: '#000', surround: '#fff' };
    if (LOOKS[this.s.look]) return LOOKS[this.s.look];
    const key = this.s.textTheme === 'auto' ? (isDark() ? 'dark' : 'light') : this.s.textTheme;
    return TEXT_THEMES[key] || TEXT_THEMES.light;
  }

  applyLayout() {
    const r = this.view.renderer;
    const m = MARGINS[this.s.margin] || MARGINS.normal;
    r.setAttribute('flow', this.s.flow === 'scrolled' ? 'scrolled' : 'paginated');
    r.setAttribute('gap', m.gap);
    r.setAttribute('margin', '36px');
    r.setAttribute('max-inline-size', m.inline);
    r.setAttribute('max-column-count', this.s.columns === '1' || this.s.columns === 1 ? '1' : '2');
    // Slide between pages; Book turns are drawn by turnBook(); None jumps.
    if (!(typeof document !== 'undefined' && document.documentElement?.classList?.contains('eink')) && (this.s.pageTurn === 'slide' || !this.s.pageTurn)) r.setAttribute('animated', '');
    else r.removeAttribute('animated');
    if (this.s.columns === '2' || this.s.columns === 2) r.setAttribute('max-inline-size', `${parseInt(m.inline, 10) * 2}px`);
  }

  async applyStyles() {
    const c = this.colors();
    this.shell.setTheme(c.bg, c.fg);
    const s = this.s;
    let fontFace = '';
    let family = null;
    if (s.fontFamily && s.fontFamily !== 'publisher') {
      const f = (await fonts()).find((x) => x.id === s.fontFamily);
      if (f) {
        family = f.family;
        if (f.css) fontFace = `@import url("${location.origin}${f.css}");`;
        if (f.url) fontFace = `@font-face { font-family: "${f.family}"; src: url("${location.origin}${f.url}"); }`;
        if (f.url || f.css) family = `"${f.family}"`;
      }
    }
    const css = `
      ${fontFace}
      @namespace epub "http://www.idpf.org/2007/ops";
      html { color-scheme: ${this.colors() === TEXT_THEMES.dark || this.colors() === TEXT_THEMES.black ? 'dark' : 'light'}; font-size: ${s.fontSize}% !important; }
      html, body { background: ${c.bg} !important; color: ${c.fg} !important; }
      body * { color: inherit !important; background-color: transparent !important; ${family ? `font-family: ${family} !important;` : ''} }
      ${family ? `body { font-family: ${family} !important; }` : ''}
      p, li, blockquote, dd {
        line-height: ${s.lineHeight} !important;
        text-align: ${s.justify ? 'justify' : 'start'};
        -webkit-hyphens: ${s.hyphenate ? 'auto' : 'manual'};
        hyphens: ${s.hyphenate ? 'auto' : 'manual'};
        widows: 2;
        orphans: 2;
      }
      [align="left"] { text-align: left; } [align="right"] { text-align: right; } [align="center"] { text-align: center; }
      a, a * { color: ${c.link} !important; }
      pre { white-space: pre-wrap !important; }
      img, svg { max-width: 100%; height: auto; }
      ::selection { background: ${c.link}55; }
      aside[epub|type~="footnote"], aside[epub|type~="endnote"], aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
      ${s.look === 'book' ? `html { background: ${PAPER_GRAIN}, ${c.bg} !important; } body { background: transparent !important; }` : ''}
      ${s.look === 'eink' ? 'img, svg, video { filter: grayscale(1) contrast(1.15); } a, a * { text-decoration: underline !important; }' : ''}
    `;
    this.view.renderer.setStyles?.(css);
    // The Book look: the paper (with its grain) is painted once, behind the transparent pages.
    this.view.style.background = this.s.look === 'book' ? `${PAPER_GRAIN}, ${c.bg}` : c.bg;
  }

  applySetting(key) {
    if (['flow', 'margin', 'columns', 'pageTurn'].includes(key)) this.applyLayout();
    this.applyStyles();
  }

  // ----- navigation -----

  next() {
    this.speech?.stop();
    if (this.navigating || this.recovering || this.destroyed) return;
    if (this.view.renderer.atEnd && !this.scrollMode()) return this.shell.showEnd();
    return this.navigatePage('next');
  }
  prev() {
    this.speech?.stop();
    if (this.navigating || this.recovering || this.destroyed) return;
    if (this.view.renderer.atStart && !this.scrollMode()) return this.shell.toast(t('Start of book'));
    return this.navigatePage('prev');
  }

  async navigatePage(dir) {
    this.navigating = true;
    // Keep the controls reachable during a slow section load without unlocking the renderer.
    this.navigationTimer = setTimeout(() => {
      this.turnLift?.cancel();
      if (!this.destroyed) this.shell.showChrome(true);
    }, 1500);
    try {
      if (this.bookTurns()) await this.turnBook(dir);
      else await this.view[dir]();
    } catch (error) {
      await this.navigationError(error);
    } finally {
      clearTimeout(this.navigationTimer);
      this.navigating = false;
    }
  }

  async navigationError(error) {
    if (this.destroyed || this.recovering) return;
    this.recovering = true;
    this.turnLift?.cancel();
    this.shell.showChrome(true);
    this.shell.toast(t('Could not turn the page. Try again or choose a chapter from Contents.'));
    console.warn('Ebook page navigation failed:', error);
    try {
      const location = this.view.lastLocation?.cfi;
      if (location) await this.view.goTo(location);
    } catch (recoveryError) {
      console.warn('Could not restore the ebook location:', recoveryError);
    } finally {
      this.recovering = false;
      if (!this.destroyed) this.shell.showChrome(true);
    }
  }

  bookTurns() {
    return this.s.pageTurn === 'book' && !this.scrollMode() && !reducedMotion();
  }

  /**
   * A book-style page turn for ebooks. The page is an iframe that can't be copied, so the
   * page itself lifts on its spine until it's edge-on, the book moves on underneath, and a
   * blank leaf finishes falling over to the other side.
   */
  async turnBook(dir) {
    const view = this.view;
    if (this.turning || this.destroyed) return;
    this.turning = true;
    const toLeft = (dir === 'next') !== (view.book.dir === 'rtl');
    const stage = this.shell.stage;
    const host = view.parentElement;
    const rect = { left: 0, top: 0, width: host.clientWidth, height: host.clientHeight };
    let lift;
    try {
      // Two pages side by side: the book moves on, and a leaf peels off the page on the
      // turning side and lands on the other, hinged at the spine.
      if (this.shell.root.classList.contains('two-up')) {
        rect.width /= 2;
        if (toLeft) rect.left = rect.width;
        await (dir === 'next' ? view.next() : view.prev());
        fallingLeaf({ stage, rect, toLeft, paper: this.colors().bg, from: 0, grain: this.s.look === 'book' });
        return;
      }
      view.style.transformOrigin = `${toLeft ? rect.left : rect.left + rect.width}px 50%`;
      lift = this.turnLift = view.animate([
        { transform: 'perspective(2400px) rotateY(0deg)' },
        { transform: `perspective(2400px) rotateY(${toLeft ? -90 : 90}deg)` },
      ], { duration: 300, easing: 'cubic-bezier(0.5, 0, 0.75, 0.4)', fill: 'forwards' });
      await lift.finished;
      // Foliate measures getBoundingClientRect() while navigating. At 90 degrees the live
      // iframe has effectively zero width, so cancel the lift before it measures a page.
      lift.cancel();
      await (dir === 'next' ? view.next() : view.prev());
      fallingLeaf({ stage, rect, toLeft, paper: this.colors().bg, grain: this.s.look === 'book' });
    } finally {
      lift?.cancel();
      if (this.turnLift === lift) this.turnLift = null;
      view.style.transformOrigin = '';
      this.turning = false;
    }
  }
  left() {
    this.view.book.dir === 'rtl' ? this.next() : this.prev();
  }
  right() {
    this.view.book.dir === 'rtl' ? this.prev() : this.next();
  }
  goToStart() {
    this.speech?.stop();
    this.view.goToFraction(0);
  }
  goToEnd() {
    this.speech?.stop();
    this.view.goToFraction(0.9999);
  }
  goTo(target) {
    this.speech?.stop();
    this.view.goTo(target).catch(() => {});
  }

  /**
   * Search the whole book. Yields { progress } while it works and
   * { label, items: [{ target, pre, match, post }] } for each chapter with matches.
   */
  async *search(query) {
    for await (const r of this.view.search({ query, matchCase: false, matchDiacritics: false, matchWholeWords: false })) {
      if (r === 'done') return;
      if (r.subitems) {
        yield { label: r.label || '', items: r.subitems.map(({ cfi, excerpt }) => ({ target: cfi, pre: excerpt?.pre || '', match: excerpt?.match || query, post: excerpt?.post || '' })) };
      } else if (r.progress != null) {
        yield { progress: r.progress };
      }
    }
  }
  clearSearch() {
    this.view?.clearSearch();
  }
  goToLocator(loc) {
    this.speech?.stop();
    this.view.goTo(loc).catch(() => {});
  }
  currentLocator() {
    const loc = this.view?.lastLocation;
    if (!loc?.cfi) return null;
    return { locator: loc.cfi, percent: this.fraction, chapter: loc.tocItem?.label?.trim() || null };
  }

  parallelStart() {
    const current = this.view.lastLocation?.section?.current ?? 0;
    const sections = this.view.book.sections;
    const following = sections.findIndex((s, i) => i > current && s.linear !== 'no');
    const previous = sections.findLastIndex((s, i) => i < current && s.linear !== 'no');
    return String(following >= 0 ? following : previous >= 0 ? previous : current);
  }

  get parallelSource() { return this.file; }

  get parallelSections() {
    const chapters = this.toc.map(({ label, target, depth }) => ({
      label: `${'  '.repeat(depth)}${label}`,
      target,
      index: this.view.resolveNavigation(target)?.index,
    })).filter(({ index }) => Number.isInteger(index));
    const covered = new Set(chapters.map(({ index }) => index));
    this.view.book.sections.forEach((section, index) => {
      if (section.linear !== 'no' && !covered.has(index)) chapters.push({
        label: t('Section {number}', { number: index + 1 }), target: index, index,
      });
    });
    return chapters.sort((a, b) => a.index - b.index);
  }

  onRelocate(detail) {
    const { fraction, tocItem, pageItem, location, cfi } = detail;
    // Two pages side by side (wide screens): the Book look draws a spine between them.
    try {
      const doc = this.view.renderer.getContents()[0]?.doc;
      const col = parseFloat(doc?.documentElement.style.columnWidth) || 0;
      this.shell.root.classList.toggle('two-up', !this.scrollMode() && col > 0 && this.view.renderer.size >= col * 1.8);
    } catch {}
    this.fraction = fraction ?? this.fraction;
    this.currentHref = tocItem?.href;
    for (const localT of this.toc) localT.current = localT.target === tocItem?.href;
    this.shell.setSubtitle(tocItem?.label?.trim() || '');
    const pct = `${(this.fraction * 100).toFixed(this.fraction < 0.1 ? 1 : 0)}%`;
    const loc = pageItem ? t('Page {label}', { label: pageItem.label }) : location ? t('Loc {value} of {total}', { value: location.current + 1, total: location.total }) : '';
    this.shell.setPosition(pct, [loc, pct].filter(Boolean).join(' · '));
    this.shell.setSliderValue(Math.round(this.fraction * 1000));
    const atEnd = this.view.renderer.atEnd;
    this.tracker.update({ position: cfi, percent: atEnd ? 1 : this.fraction });
    this.shell.pageTurned();
  }

  // Each section document: taps, selection → highlight toolbar, keys, activity.
  onLoad({ doc, index }) {
    if (this.speech?.state === 'playing' && !this.speech.moving) this.speech.stop();
    const stopSpeech = () => { if (this.speech?.state === 'playing' || this.speech?.state === 'paused') this.speech.stop(); };
    doc.addEventListener('wheel', stopSpeech, { passive: true });
    doc.addEventListener('pointerdown', stopSpeech, { passive: true });
    doc.addEventListener('keydown', stopSpeech);
    const frameOf = () => doc.defaultView?.frameElement?.getBoundingClientRect() || { left: 0, top: 0 };
    let downAt = null;
    let selectionTimer;
    const selectedText = () => {
      const selection = doc.getSelection();
      const text = selection?.toString().trim();
      if (!text || !selection.rangeCount || selection.isCollapsed) return null;
      const range = selection.getRangeAt(0).cloneRange();
      const rect = range.getBoundingClientRect();
      const frame = frameOf();
      return { index, range, text, doc, x: frame.left + rect.left + rect.width / 2, y: frame.top + rect.top, bottom: frame.top + rect.bottom };
    };
    doc.addEventListener('pointerdown', (e) => {
      clearTimeout(selectionTimer);
      if (e.button === 0) this.closeSelection();
      downAt = { x: e.clientX, y: e.clientY };
      this.tracker.activity();
      if (!e.target.closest?.('a[href]')) this.closeFootnote();
    });
    doc.addEventListener('click', (e) => {
      if (e.target.closest?.('a[href]')) return;
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8) return;
      if (this.justShowedAnnotation) {
        this.justShowedAnnotation = false;
        return;
      }
      this.closeSelection();
      const x = frameOf().left + e.clientX;
      if (this.scrollMode()) this.shell.toggleChrome();
      else this.shell.handleTap(x / innerWidth);
    });
    doc.addEventListener('keydown', (e) => {
      this.tracker.activity();
      if (e.key === 'Escape' && (this.selectionMenu || this.selectionToolbar?.isConnected)) {
        e.preventDefault();
        return this.closeSelection();
      }
      if (e.key === 'Escape' && this.footnoteCleanup) return this.closeFootnote();
      this.shell.handleKey(e);
    });
    doc.addEventListener('contextmenu', (e) => {
      const selected = selectedText();
      if (!selected && e.pointerType === 'touch') return;
      if (!selected && e.target.closest?.('a[href], input, textarea, [contenteditable]')) return;
      clearTimeout(selectionTimer);
      e.preventDefault();
      const frame = frameOf();
      const at = e.clientX || e.clientY
        ? { x: frame.left + e.clientX, y: frame.top + e.clientY }
        : selected || { x: frame.left + (frame.width || innerWidth) / 2, y: frame.top + (frame.height || innerHeight) / 2 };
      this.openSelectionMenu(selected, at);
    });
    const checkSelection = () => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        if (this.destroyed || this.selectionMenu || !doc.defaultView?.frameElement?.isConnected) return;
        const selection = selectedText();
        if (selection) this.showSelectionToolbar(selection);
        else if (this.selectionToolbar?.selectionDoc === doc) this.closeSelection();
      }, 350);
    };
    doc.addEventListener('pointerup', checkSelection);
    doc.addEventListener('selectionchange', checkSelection);
  }

  // ----- footnotes -----

  onLink(e) {
    this.speech?.stop();
    const { a, href } = e.detail;
    const kind = noteRefKind(a);
    if (!kind) return; // an ordinary link: foliate follows it
    e.preventDefault();
    this.showFootnote(a, href, kind).catch(() => this.view.goTo(href).catch(() => {}));
  }

  async showFootnote(a, href, kind) {
    const book = this.view.book;
    const target = await book.resolveHref(href);
    const doc = await book.sections[target.index].createDocument();
    let el = target.anchor?.(doc);
    if (el?.startContainer) el = el.startContainer.nodeType === 1 ? el.startContainer : el.startContainer.parentElement;
    if (!el || el.nodeType !== 1) throw new Error(t('No note there'));
    // The anchor is often a span or link inside the note: take the note itself.
    while (el.matches('a, span, sup, sub, em, strong, i, b, small') && el.parentElement && el.parentElement !== doc.body) el = el.parentElement;
    if (el === doc.body) el = doc.getElementById(decodeURIComponent(href.split('#')[1] || ''))?.nextElementSibling || null;
    if (!el) throw new Error(t('No note there'));
    const type = Object.entries(NOTE_TYPES).find(([localT]) => words(el, 'type').has(localT))?.[1]
      || Object.entries(NOTE_ROLES).find(([r]) => words(el, 'role').has(r))?.[1];
    const text = el.textContent.trim();
    // A "maybe" that points at a heading or a whole chapter isn't a note: just go there.
    if (!text || (kind === 'maybe' && (!type && (/^H\d$/.test(el.tagName.toUpperCase()) || text.length > 2500)))) throw new Error(t('Not a note'));

    this.closeFootnote();
    const c = this.colors();
    const body = h('div.fn-body');
    body.append(cleanNote(el));
    const pop = h('div.fn-pop', { role: 'dialog', 'aria-label': type || t('Note'), style: { '--fn-bg': c.bg, '--fn-fg': c.fg, '--fn-link': c.link } },
      h('div.fn-head',
        h('span.fn-kind', icon('sticky_note_2'), type || t('Note')),
        h('button.btn.text.state.fn-go', { type: 'button', onclick: () => {
          this.closeFootnote();
          this.view.goTo(href).catch(() => {});
        } }, t('Go to note')),
        iconButton('close', t('Close'), () => this.closeFootnote())),
      body);
    this.shell.root.append(pop);
    // Next to the link on wide screens; a sheet at the bottom on phones.
    const frame = a.ownerDocument.defaultView?.frameElement?.getBoundingClientRect() || { left: 0, top: 0 };
    const r = a.getBoundingClientRect();
    const rect = { left: frame.left + r.left, top: frame.top + r.top, bottom: frame.top + r.bottom, width: r.width };
    if (innerWidth >= 600) {
      const w = Math.min(440, innerWidth - 32);
      pop.style.width = `${w}px`;
      pop.style.left = `${Math.max(16, Math.min(innerWidth - w - 16, rect.left + rect.width / 2 - w / 2))}px`;
      const below = innerHeight - rect.bottom > Math.min(pop.offsetHeight, innerHeight * 0.45) + 24;
      if (below) pop.style.top = `${rect.bottom + 10}px`;
      else pop.style.bottom = `${innerHeight - rect.top + 10}px`;
    } else pop.classList.add('sheet-like');
    // Escape closes the pop-up – before the reader sees it (where Escape closes the book).
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      this.closeFootnote();
    };
    const onDown = (ev) => !pop.contains(ev.target) && this.closeFootnote();
    window.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    this.footnoteCleanup = () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown);
      pop.classList.add('leaving');
      setTimeout(() => pop.remove(), 160);
    };
  }

  closeFootnote() {
    this.footnoteCleanup?.();
    this.footnoteCleanup = null;
  }

  // ----- annotations -----

  setAnnotations(list) {
    const highlights = list.filter((a) => a.kind === 'highlight');
    // Remove ones that disappeared.
    for (const value of this.annotationsByValue.keys()) {
      if (!highlights.some((x) => x.locator === value)) {
        this.view?.deleteAnnotation({ value }).catch?.(() => {});
        this.annotationsByValue.delete(value);
      }
    }
    for (const a of highlights) this.annotationsByValue.set(a.locator, a);
    for (const a of highlights) this.view?.addAnnotation({ value: a.locator, color: a.color }).catch?.(() => {});
  }

  onCreateOverlay(index) {
    for (const a of this.annotationsByValue.values()) {
      try {
        if (this.view.resolveNavigation(a.locator)?.index === index) this.view.addAnnotation({ value: a.locator, color: a.color });
      } catch {}
    }
  }

  closeSelection() {
    this.selectionMenu?.();
    this.selectionToolbar?.remove();
    this.selectionToolbar = null;
  }

  async saveSelection({ index, range, text, doc }, color, withNote = false) {
    try {
      const cfi = this.view.getCFI(index, range);
      let note = null;
      if (withNote) {
        const f = field(t('Note'), { multiline: true });
        const ok = await dialog({ title: t('Add note'), icon: 'edit_note', content: h('div', h('p.quote', { style: { fontStyle: 'italic', marginBottom: '8px' } }, `“${text.slice(0, 200)}”`), f), actions: [{ label: t('Cancel') }, { label: t('Save'), variant: 'filled', value: true }] });
        if (!ok) return;
        note = f.input.value.trim() || null;
      }
      const a = await api.addAnnotation(this.book.id, {
        kind: 'highlight',
        locator: cfi,
        text: text.slice(0, 5000),
        note,
        color,
        percent: this.fraction,
        chapter: this.view.lastLocation?.tocItem?.label?.trim() || null,
      });
      this.shell.annotations = [...this.shell.annotations, a];
      this.annotationsByValue.set(cfi, a);
      await this.view.addAnnotation({ value: cfi, color });
      doc.getSelection()?.removeAllRanges();
      snackbar(note ? t('Note saved') : t('Highlighted'));
    } catch (error) {
      snackbar(error.message);
    }
  }

  selectionActions(selection) {
    const copy = { label: t('Copy'), icon: 'content_copy', onClick: () => copyText(selection.text) };
    if (this.book.shareToken) return [copy];
    const lookup = async (tab) => {
      const { openLookup } = await import('./lookup.js');
      if (this.destroyed) return;
      const lang = [].concat(this.view.book.metadata?.language || [])[0] || this.book.language || null;
      this.lookupCleanup = openLookup({ text: selection.text.slice(0, 500), bookLang: lang, at: selection,
        root: this.shell.root.closest('.reader'), tab });
    };
    return [copy,
      { label: t('Highlight'), icon: 'ink_highlighter', onClick: () => this.saveSelection(selection, 'yellow') },
      { label: t('Underline'), icon: 'format_underlined', onClick: () => this.saveSelection(selection, 'underline') },
      { label: t('Add note'), icon: 'edit_note', onClick: () => this.saveSelection(selection, 'yellow', true) },
      { label: t('Look up'), icon: 'dictionary', onClick: () => lookup('define') },
      { label: t('Translate'), icon: 'translate', onClick: () => lookup('translate'), menuOnly: true },
      { label: 'Wikipedia', icon: 'travel_explore', onClick: () => lookup('wiki'), menuOnly: true },
      this.shell.openSearch && { label: t('Search in this book'), icon: 'search', onClick: () => this.shell.openSearch(selection.text.slice(0, 200)) },
    ].filter(Boolean);
  }

  openSelectionMenu(selection, at) {
    this.closeSelection();
    const shortcuts = [
      !selection && !this.book.shareToken && this.shell.toggleBookmark && { label: t('Bookmark this page'), icon: 'bookmark_add', onClick: this.shell.toggleBookmark },
      this.shell.openContents && { label: t('Contents & annotations'), icon: 'toc', onClick: this.shell.openContents },
      { label: t('Reader settings'), icon: 'tune', onClick: this.shell.openSettings },
    ];
    this.selectionMenu = menu(null, [
      ...(selection ? [...this.selectionActions(selection), '-'] : []), ...shortcuts,
    ], { at, label: t('Reader actions'), host: document.fullscreenElement || document.body,
      onClose: () => { this.selectionMenu = null; } });
  }

  showSelectionToolbar(selection) {
    this.closeSelection();
    const { x, y, bottom, doc } = selection;
    const run = (action) => {
      this.closeSelection();
      action();
    };
    const bar = h('div.sel-toolbar', { role: 'toolbar', 'aria-label': t('Text selection actions') },
      !this.book.shareToken && Object.entries(HIGHLIGHT_COLORS).filter(([k]) => k !== 'underline').map(([k, hex]) =>
        h('button.color', { type: 'button', title: t('Highlight {k}', { k }), 'aria-label': t('Highlight {k}', { k }), style: { background: hex }, onclick: () => run(() => this.saveSelection(selection, k)) })),
      this.selectionActions(selection).filter(({ icon, menuOnly }) => !menuOnly && icon !== 'ink_highlighter' && icon !== 'search')
        .map(({ label, icon, onClick }) => iconButton(icon, label, () => run(onClick))),
      iconButton('more_horiz', t('More actions'), () => this.openSelectionMenu(selection, { x, y: bottom })),
    );
    this.selectionToolbar = bar;
    bar.selectionDoc = doc;
    (document.fullscreenElement || document.body).append(bar);
    const w = bar.offsetWidth;
    const height = bar.offsetHeight;
    const above = y - height - 10;
    const top = above >= 8 ? above : Math.min(bottom + 10, innerHeight - height - 8);
    Object.assign(bar.style, { left: `${Math.max(8, Math.min(innerWidth - w - 8, x - w / 2))}px`, top: `${Math.max(8, top)}px` });
  }

  /** Tapping an existing highlight: view/edit its note, recolour or delete it. */
  async showAnnotation(value) {
    const a = this.annotationsByValue.get(value);
    if (!a) return;
    this.justShowedAnnotation = true;
    setTimeout(() => (this.justShowedAnnotation = false), 400);
    const note = field(t('Note'), { value: a.note || '', multiline: true });
    let color = a.color;
    const colors = h('div.swatches', Object.entries(HIGHLIGHT_COLORS).map(([k, hex]) =>
      h('button.swatch', { type: 'button', 'aria-label': k, 'aria-pressed': String(k === color), style: { background: hex, width: '32px', height: '32px' }, onclick: (e) => {
        color = k;
        for (const b of colors.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
      } }, k === 'underline' && icon('format_underlined'))));
    const result = await dialog({
      title: t('Highlight'),
      icon: 'ink_highlighter',
      content: h('div', h('p', { style: { fontFamily: 'Georgia, serif', fontStyle: 'italic', marginBottom: '12px', color: 'var(--md-on-surface)' } }, `“${a.text || ''}”`), colors, note),
      actions: [
        { label: t('Delete'), variant: 'text danger', value: 'delete' },
        { label: t('Copy'), value: 'copy' },
        { label: t('Save'), variant: 'filled', value: 'save' },
      ],
    });
    if (result === 'copy') return copyText(a.text || '');
    if (result === 'delete') {
      await api.deleteAnnotation(a.id);
      this.shell.annotations = this.shell.annotations.filter((x) => x.id !== a.id);
      this.annotationsByValue.delete(value);
      await this.view.deleteAnnotation({ value });
      snackbar(t('Highlight removed'));
      return;
    }
    if (result === 'save') {
      const updated = await api.updateAnnotation(a.id, { note: note.input.value, color });
      Object.assign(a, updated);
      this.shell.annotations = this.shell.annotations.map((x) => (x.id === a.id ? updated : x));
      this.annotationsByValue.set(value, updated);
      await this.view.addAnnotation({ value, color: updated.color });
    }
  }
}

function flattenToc(items, depth = 0, out = []) {
  for (const it of items || []) {
    out.push({ label: (it.label || '').trim(), target: it.href, depth });
    if (it.subitems?.length) flattenToc(it.subitems, depth + 1, out);
  }
  return out;
}

