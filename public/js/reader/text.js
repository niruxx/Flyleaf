// Text reader (EPUB, MOBI/AZW/AZW3, FB2, TXT→EPUB) built on foliate-js, with highlights & notes.

import { api, fileUrl } from '../api.js';
import { h, icon, iconButton, snackbar, dialog, field, copyText } from '../ui.js';
import { isDark } from '../theme.js';
import { TEXT_THEMES } from '../components/reader-settings.js';
import { HIGHLIGHT_COLORS } from '../views/bookmarks.js';

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
const NOTE_TYPES = { footnote: 'Footnote', endnote: 'Endnote', rearnote: 'Endnote', note: 'Note', glossdef: 'Definition', biblioentry: 'Reference' };
const NOTE_ROLES = { 'doc-footnote': 'Footnote', 'doc-endnote': 'Endnote', 'doc-biblioentry': 'Reference', definition: 'Definition', note: 'Note' };

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
  if (['noteref', 'glossref', 'biblioref'].some((t) => types.has(t)) || ['doc-noteref', 'doc-glossref', 'doc-biblioref'].some((r) => roles.has(r))) return 'yes';
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

  async open(startLocator) {
    this.shell.setLoading(true);
    const [{ Overlayer }] = await Promise.all([import('/vendor/foliate/overlayer.js'), import('/vendor/foliate/view.js')]);
    this.Overlayer = Overlayer;

    const res = await fetch(fileUrl(this.book), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(res.status === 410 ? 'This file is no longer in the library folder.' : `Couldn’t load the book (${res.status}).`);
    const ext = EXT[this.book.format] || 'epub';
    const file = new File([await res.blob()], `book.${ext}`, { type: MIME[ext] || 'application/octet-stream' });

    const view = document.createElement('foliate-view');
    this.view = view;
    this.shell.stage.replaceChildren(h('div.text-stage', view));
    await view.open(file);
    this.applyLayout();
    await this.applyStyles();

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
    view.addEventListener('relocate', () => this.closeFootnote());

    this.toc = flattenToc(view.book.toc || []);
    this.setAnnotations(this.shell.annotations);

    this.shell.setSlider({
      min: 0,
      max: 1000,
      value: Math.round(this.fraction * 1000),
      rtl: view.book.dir === 'rtl',
      onInput: (v) => this.shell.setPosition(`${(v / 10).toFixed(1)}%`),
      onChange: (v) => view.goToFraction(v / 1000),
    });

    const saved = this.book.progress && !this.book.progress.finished ? this.book.progress.position : null;
    const target = startLocator || saved;
    try {
      if (target && /^epubcfi\(/.test(target)) await view.init({ lastLocation: target });
      else if (startLocator) {
        // A chapter to open at (from full-text search): an href, or a section number for FB2.
        await view.init({ showTextStart: false });
        await view.goTo(/^\d+$/.test(startLocator) ? Number(startLocator) : startLocator).catch(() => {});
      } else await view.init({ showTextStart: false });
    } catch {
      await view.init({});
    }
    this.shell.setLoading(false);

    const onTheme = () => this.s.textTheme === 'auto' && this.applyStyles();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', onTheme);
    this.cleanups.push(() => mq.removeEventListener('change', onTheme));
  }

  destroy() {
    this.closeFootnote();
    import('./lookup.js').then((m) => m.closeLookup()).catch(() => {});
    this.cleanups.forEach((fn) => fn());
    document.querySelector('.sel-toolbar')?.remove();
    try {
      this.view?.close();
      this.view?.remove();
    } catch {}
  }

  // ----- appearance -----

  colors() {
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
    `;
    this.view.renderer.setStyles?.(css);
    this.view.style.background = c.bg;
  }

  applySetting(key) {
    if (['flow', 'margin', 'columns'].includes(key)) this.applyLayout();
    this.applyStyles();
  }

  // ----- navigation -----

  next() {
    if (this.view.renderer.atEnd && !this.scrollMode()) return this.shell.showEnd();
    this.view.next();
  }
  prev() {
    if (this.view.renderer.atStart && !this.scrollMode()) return this.shell.toast('Start of book');
    this.view.prev();
  }
  left() {
    this.view.book.dir === 'rtl' ? this.next() : this.prev();
  }
  right() {
    this.view.book.dir === 'rtl' ? this.prev() : this.next();
  }
  goToStart() {
    this.view.goToFraction(0);
  }
  goToEnd() {
    this.view.goToFraction(0.9999);
  }
  goTo(target) {
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
    this.view.goTo(loc).catch(() => {});
  }
  currentLocator() {
    const loc = this.view?.lastLocation;
    if (!loc?.cfi) return null;
    return { locator: loc.cfi, percent: this.fraction, chapter: loc.tocItem?.label?.trim() || null };
  }

  onRelocate(detail) {
    const { fraction, tocItem, pageItem, location, cfi } = detail;
    this.fraction = fraction ?? this.fraction;
    this.currentHref = tocItem?.href;
    for (const t of this.toc) t.current = t.target === tocItem?.href;
    this.shell.setSubtitle(tocItem?.label?.trim() || '');
    const pct = `${(this.fraction * 100).toFixed(this.fraction < 0.1 ? 1 : 0)}%`;
    const loc = pageItem ? `Page ${pageItem.label}` : location ? `Loc ${location.current + 1} of ${location.total}` : '';
    this.shell.setPosition(pct, [loc, pct].filter(Boolean).join(' · '));
    this.shell.setSliderValue(Math.round(this.fraction * 1000));
    const atEnd = this.view.renderer.atEnd;
    this.tracker.update({ position: cfi, percent: atEnd ? 1 : this.fraction });
    this.shell.pageTurned();
  }

  // Each section document: taps, selection → highlight toolbar, keys, activity.
  onLoad({ doc, index }) {
    const frameOf = () => doc.defaultView?.frameElement?.getBoundingClientRect() || { left: 0, top: 0 };
    let downAt = null;
    doc.addEventListener('pointerdown', (e) => {
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
      document.querySelector('.sel-toolbar')?.remove();
      const x = frameOf().left + e.clientX;
      if (this.scrollMode()) this.shell.toggleChrome();
      else this.shell.handleTap(x / innerWidth);
    });
    doc.addEventListener('keydown', (e) => {
      this.tracker.activity();
      if (e.key === 'Escape' && this.footnoteCleanup) return this.closeFootnote();
      this.shell.handleKey(e);
    });
    let selTimer;
    const checkSelection = () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        const sel = doc.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const fr = frameOf();
        this.showSelectionToolbar({ index, range, text: sel.toString().trim(), x: fr.left + rect.left + rect.width / 2, y: fr.top + rect.top, bottom: fr.top + rect.bottom, doc });
      }, 350);
    };
    doc.addEventListener('pointerup', checkSelection);
    doc.addEventListener('selectionchange', checkSelection);
  }

  // ----- footnotes -----

  onLink(e) {
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
    if (!el || el.nodeType !== 1) throw new Error('No note there');
    // The anchor is often a span or link inside the note: take the note itself.
    while (el.matches('a, span, sup, sub, em, strong, i, b, small') && el.parentElement && el.parentElement !== doc.body) el = el.parentElement;
    if (el === doc.body) el = doc.getElementById(decodeURIComponent(href.split('#')[1] || ''))?.nextElementSibling || null;
    if (!el) throw new Error('No note there');
    const type = Object.entries(NOTE_TYPES).find(([t]) => words(el, 'type').has(t))?.[1]
      || Object.entries(NOTE_ROLES).find(([r]) => words(el, 'role').has(r))?.[1];
    const text = el.textContent.trim();
    // A "maybe" that points at a heading or a whole chapter isn't a note: just go there.
    if (!text || (kind === 'maybe' && (!type && (/^H\d$/.test(el.tagName.toUpperCase()) || text.length > 2500)))) throw new Error('Not a note');

    this.closeFootnote();
    const c = this.colors();
    const body = h('div.fn-body');
    body.append(cleanNote(el));
    const pop = h('div.fn-pop', { role: 'dialog', 'aria-label': type || 'Note', style: { '--fn-bg': c.bg, '--fn-fg': c.fg, '--fn-link': c.link } },
      h('div.fn-head',
        h('span.fn-kind', icon('sticky_note_2'), type || 'Note'),
        h('button.btn.text.state.fn-go', { type: 'button', onclick: () => {
          this.closeFootnote();
          this.view.goTo(href).catch(() => {});
        } }, 'Go to note'),
        iconButton('close', 'Close', () => this.closeFootnote())),
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

  showSelectionToolbar({ index, range, text, x, y, bottom, doc }) {
    document.querySelector('.sel-toolbar')?.remove();
    const create = async (color, withNote = false) => {
      const cfi = this.view.getCFI(index, range);
      let note = null;
      if (withNote) {
        const f = field('Note', { multiline: true });
        const ok = await dialog({ title: 'Add note', icon: 'edit_note', content: h('div', h('p.quote', { style: { fontStyle: 'italic', marginBottom: '8px' } }, `“${text.slice(0, 200)}”`), f), actions: [{ label: 'Cancel' }, { label: 'Save', variant: 'filled', value: true }] });
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
      bar.remove();
      snackbar(note ? 'Note saved' : 'Highlighted');
    };
    const bar = h('div.sel-toolbar', { role: 'toolbar' },
      Object.entries(HIGHLIGHT_COLORS).filter(([k]) => k !== 'underline').map(([k, hex]) =>
        h('button.color', { type: 'button', title: `Highlight ${k}`, 'aria-label': `Highlight ${k}`, style: { background: hex }, onclick: () => create(k) })),
      iconButton('format_underlined', 'Underline', () => create('underline')),
      h('span.divider-v'),
      iconButton('edit_note', 'Highlight with note', () => create('yellow', true)),
      iconButton('content_copy', 'Copy', () => {
        copyText(text);
        bar.remove();
      }),
      iconButton('dictionary', 'Look up (define, Wikipedia, translate)', async () => {
        bar.remove();
        const { openLookup } = await import('./lookup.js');
        const lang = [].concat(this.view.book.metadata?.language || [])[0] || this.book.language || null;
        openLookup({ text: text.slice(0, 500), bookLang: lang, at: { x, y, bottom }, root: this.shell.root });
      }),
    );
    document.body.append(bar);
    const w = bar.offsetWidth;
    const top = y - bar.offsetHeight - 10 < 8 ? bottom + 10 : y - bar.offsetHeight - 10;
    Object.assign(bar.style, { left: `${Math.max(8, Math.min(innerWidth - w - 8, x - w / 2))}px`, top: `${Math.max(8, top)}px` });
  }

  /** Tapping an existing highlight: view/edit its note, recolour or delete it. */
  async showAnnotation(value) {
    const a = this.annotationsByValue.get(value);
    if (!a) return;
    this.justShowedAnnotation = true;
    setTimeout(() => (this.justShowedAnnotation = false), 400);
    const note = field('Note', { value: a.note || '', multiline: true });
    let color = a.color;
    const colors = h('div.swatches', Object.entries(HIGHLIGHT_COLORS).map(([k, hex]) =>
      h('button.swatch', { type: 'button', 'aria-label': k, 'aria-pressed': String(k === color), style: { background: hex, width: '32px', height: '32px' }, onclick: (e) => {
        color = k;
        for (const b of colors.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
      } }, k === 'underline' && icon('format_underlined'))));
    const result = await dialog({
      title: 'Highlight',
      icon: 'ink_highlighter',
      content: h('div', h('p', { style: { fontFamily: 'Georgia, serif', fontStyle: 'italic', marginBottom: '12px', color: 'var(--md-on-surface)' } }, `“${a.text || ''}”`), colors, note),
      actions: [
        { label: 'Delete', variant: 'text danger', value: 'delete' },
        { label: 'Copy', value: 'copy' },
        { label: 'Save', variant: 'filled', value: 'save' },
      ],
    });
    if (result === 'copy') return copyText(a.text || '');
    if (result === 'delete') {
      await api.deleteAnnotation(a.id);
      this.shell.annotations = this.shell.annotations.filter((x) => x.id !== a.id);
      this.annotationsByValue.delete(value);
      await this.view.deleteAnnotation({ value });
      snackbar('Highlight removed');
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

