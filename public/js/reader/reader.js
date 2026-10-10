// Reader shell: chrome, settings sheet, contents/annotations, bookmarks, key binds.
// Engines: pages.js (manga, comics, PDF) and text.js (EPUB, MOBI/AZW3, FB2, TXT).

import { api } from '../api.js';
import { onLeave, navigate, previousPath } from '../router.js';
import { h, icon, iconButton, button, sheet, syncThemeColor, snackbar, segmented } from '../ui.js';
import { Tracker } from './tracker.js';
import { readerSettingsForm } from '../components/reader-settings.js';
import { resolveKeybinds, actionFor } from '../keybinds.js';
import { annotationRow } from '../views/bookmarks.js';

export async function readerView(view, params, stale) {
  const data = await api.reader(params.id);
  if (stale()) return;
  const { book } = data;

  const tracker = new Tracker(book.id);
  const shell = createShell(data, tracker);
  view.append(shell.root);

  let wakeLock = null;
  const requestWakeLock = async () => {
    try {
      if (document.visibilityState === 'visible' && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch {}
  };
  const onVis = () => document.visibilityState === 'visible' && requestWakeLock();
  document.addEventListener('visibilitychange', onVis);
  requestWakeLock();

  onLeave(() => {
    shell.engine?.destroy?.();
    tracker.destroy();
    shell.destroy();
    wakeLock?.release?.().catch(() => {});
    document.removeEventListener('visibilitychange', onVis);
    syncThemeColor(null);
  });

  try {
    const mod = book.engine === 'text' ? await import('./text.js') : await import('./pages.js');
    const Engine = mod.TextEngine || mod.PageEngine;
    const engine = new Engine(book, shell, tracker, data);
    if (stale()) return engine.destroy();
    shell.engine = engine;
    await engine.open(params.query.get('loc'));
    shell.refreshBookmark();
  } catch (err) {
    console.error(err);
    shell.fail(err.message || 'This file could not be opened.');
  }
}

/** Builds the reader chrome shared by all engines. */
function createShell(data, tracker) {
  const { book } = data;
  const settings = { ...data.settings };
  if (settings.direction === 'auto') settings.resolvedDir = book.kind === 'manga' ? 'rtl' : 'ltr';
  const binds = resolveKeybinds(data.keybinds);
  let annotations = data.annotations;
  let overridden = data.overridden;

  const titleSub = h('div.s');
  const bookmarkBtn = iconButton('bookmark_add', 'Bookmark this page (B)', () => toggleBookmark());
  const tocBtn = iconButton('toc', 'Contents & annotations (T)', () => openContents());
  const settingsBtn = iconButton('tune', 'Reader settings (S)', () => openSettings());
  const fsBtn = document.fullscreenEnabled
    ? iconButton('fullscreen', 'Full screen (F)', () => toggleFullscreen())
    : null;

  const top = h('div.chrome-top',
    iconButton('arrow_back', 'Close book', () => exit()),
    h('div.titles', h('div.t', book.series && book.series !== book.label ? `${book.series} · ${book.label}` : book.title), titleSub),
    bookmarkBtn,
    tocBtn,
    fsBtn,
    settingsBtn,
  );

  const slider = h('input.slider', { type: 'range', min: 0, max: 100, value: 0, step: 1, 'aria-label': 'Position in book' });
  const pageNo = h('span.pageno', '');
  const prevBtn = iconButton('chevron_left', 'Previous page', () => shell.engine?.left());
  const nextBtn = iconButton('chevron_right', 'Next page', () => shell.engine?.right());
  const prevBook = book.prev && iconButton('skip_previous', `Previous: ${book.prev.label}`, () => openBook(book.prev));
  const nextBook = book.next && iconButton('skip_next', `Next: ${book.next.label}`, () => openBook(book.next));
  const bottom = h('div.chrome-bottom',
    h('div.row', prevBtn, slider, nextBtn),
    h('div.row', { style: { justifyContent: 'space-between' } }, prevBook || h('span', { style: { width: '40px' } }), pageNo, nextBook || h('span', { style: { width: '40px' } })),
  );
  const mini = h('div.mini-progress');
  const flag = h('div.bookmark-flag');
  const stage = h('div.stage');
  const loadingEl = h('div.page-loading', h('div.spinner'));
  const root = h(`div.reader${book.engine === 'text' ? '.text' : ''}`, stage, loadingEl, mini, flag, top, bottom);

  let sliderHandlers = {};
  slider.addEventListener('input', () => {
    updateFill();
    sliderHandlers.onInput?.(Number(slider.value));
  });
  slider.addEventListener('change', () => sliderHandlers.onChange?.(Number(slider.value)));
  function updateFill() {
    const pct = ((Number(slider.value) - Number(slider.min)) / Math.max(1, Number(slider.max) - Number(slider.min))) * 100;
    slider.style.setProperty('--fill', `${pct}%`);
  }

  let hideTimer = setTimeout(() => shell.showChrome(false), settings.immersive ? 600 : 2500);

  const onKey = (e) => {
    if (e.target.closest?.('input, textarea, select, dialog, .sel-toolbar')) return;
    if (document.querySelector('dialog[open]')) return;
    shell.handleKey(e);
  };
  document.addEventListener('keydown', onKey);
  const onFsChange = () => fsBtn && (fsBtn.querySelector('.icon').textContent = document.fullscreenElement ? 'fullscreen_exit' : 'fullscreen');
  document.addEventListener('fullscreenchange', onFsChange);

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen?.().catch(() => {});
  }

  function exit() {
    const back = `/series/${book.seriesId}`;
    if (previousPath()?.startsWith(back)) history.back();
    else navigate(back, { replace: true });
  }

  async function openBook(b) {
    if (b.progress?.finished) await api.setFinished(b.id, false);
    navigate(`/read/${b.id}`, { replace: true });
  }

  // ----- settings -----
  let saveTimer;
  function openSettings() {
    const show = book.engine === 'text' ? 'text' : 'pages';
    sheet((close) => {
      const fontsBox = h('div');
      const footer = h('div.sheet-footer',
        h('div.who', overridden ? `Custom settings for this series (based on “${data.profile?.name || 'Default'}”)` : `Using reading profile “${data.profile?.name || 'Default'}”`),
        button('Reset to profile', { variant: 'text', icon: 'restart_alt', onclick: async () => {
          await api.saveReaderSettings(book.seriesId, null);
          close();
          navigate(`/read/${book.id}`, { replace: true });
        } }),
        data.profile && button(`Save to “${data.profile.name}”`, { variant: 'tonal', icon: 'save', onclick: async () => {
          const { resolvedDir, ...clean } = settings;
          await api.updateProfile(data.profile.id, { settings: clean });
          await api.saveReaderSettings(book.seriesId, null);
          overridden = false;
          snackbar(`Saved to “${data.profile.name}”`);
          close();
        } }),
      );
      const render = (fonts) =>
        fontsBox.replaceChildren(readerSettingsForm(settings, (key, value) => {
          if (key === 'direction') settings.resolvedDir = value === 'auto' ? (book.kind === 'manga' ? 'rtl' : 'ltr') : value;
          shell.applyBehaviour();
          shell.engine?.applySetting?.(key, value);
          overridden = true;
          clearTimeout(saveTimer);
          const { resolvedDir, ...clean } = settings;
          saveTimer = setTimeout(() => book.seriesId && api.saveReaderSettings(book.seriesId, clean).catch(() => {}), 600);
          if (key === 'layout') render(fonts);
        }, { show, fonts }));
      const enabled = data.enabledFonts;
      api.fonts().then((fonts) => render(fonts.filter((f) => !enabled || f.id === 'publisher' || enabled.includes(f.id) || f.id === settings.fontFamily))).catch(() => render([]));
      return h('div', fontsBox, footer);
    });
  }

  // ----- contents & annotations -----
  function openContents() {
    const toc = shell.engine?.toc || [];
    sheet((close) => {
      const body = h('div');
      const views = {
        toc: () =>
          toc.length
            ? toc.map((t) => h(`button.list-item.state.depth-${Math.min(t.depth || 0, 3)}${t.current ? '.current' : ''}`, { type: 'button', onclick: () => {
                close();
                shell.engine.goTo(t.target);
              } }, h('span.text', t.label), t.page != null && h('span.trailing', String(t.page + 1))))
            : [h('p.muted', { style: { padding: '16px 24px' } }, 'This book has no table of contents.')],
        bookmarks: () => listOf('bookmark'),
        highlights: () => listOf('highlight'),
      };
      function listOf(kind) {
        const list = annotations.filter((a) => a.kind === kind);
        if (!list.length) return [h('p.muted', { style: { padding: '16px 24px' } }, kind === 'bookmark' ? 'No bookmarks yet – tap the bookmark icon to add one.' : 'No highlights yet – select some text to highlight it.')];
        return list.map((a) => annotationRow(a, book, async () => {
          annotations = (await api.reader(book.id)).annotations;
          shell.engine?.setAnnotations?.(annotations);
          shell.refreshBookmark();
          show(kind === 'bookmark' ? 'bookmarks' : 'highlights');
        }, { onOpen: (x) => {
          close();
          shell.engine.goToLocator(x.locator);
        } }));
      }
      const tabs = [['toc', 'Contents', 'toc'], ['bookmarks', 'Bookmarks', 'bookmark'], book.engine === 'text' && ['highlights', 'Highlights', 'ink_highlighter']].filter(Boolean);
      const seg = segmented(tabs.map(([value, label, ic]) => ({ value, label, icon: ic })), 'toc', (v) => show(v));
      function show(v) {
        seg.setValue(v);
        body.replaceChildren(...views[v]());
      }
      show(toc.length ? 'toc' : 'bookmarks');
      return h('div.toc', h('div.sheet-section', seg), body);
    });
  }

  // ----- bookmarks -----
  function currentBookmark() {
    const loc = shell.engine?.currentLocator?.();
    if (!loc) return null;
    return annotations.find((a) => a.kind === 'bookmark' && (loc.page != null ? a.page === loc.page : a.locator === loc.locator || (a.percent != null && loc.percent != null && Math.abs(a.percent - loc.percent) < 0.002)));
  }
  async function toggleBookmark() {
    const loc = shell.engine?.currentLocator?.();
    if (!loc) return;
    const existing = currentBookmark();
    if (existing) {
      await api.deleteAnnotation(existing.id);
      annotations = annotations.filter((a) => a.id !== existing.id);
      shell.toast('Bookmark removed');
    } else {
      const a = await api.addAnnotation(book.id, { kind: 'bookmark', ...loc });
      annotations = [...annotations, a];
      shell.toast('Page bookmarked');
    }
    shell.refreshBookmark();
  }

  const shell = {
    root,
    stage,
    book,
    tracker,
    settings,
    engine: null,
    get annotations() {
      return annotations;
    },
    set annotations(v) {
      annotations = v;
    },
    exit,
    setSubtitle(text) {
      titleSub.textContent = text || '';
    },
    setPosition(label, miniLabel) {
      pageNo.textContent = label;
      mini.textContent = miniLabel ?? label;
    },
    setSlider({ min = 0, max, value, rtl = false, onInput, onChange, step = 1 }) {
      Object.assign(slider, { min, max, step });
      slider.value = value;
      slider.classList.toggle('rtl', rtl);
      sliderHandlers = { onInput, onChange };
      updateFill();
    },
    setSliderValue(v) {
      slider.value = v;
      updateFill();
    },
    setArrows(rtl) {
      prevBtn.title = rtl ? 'Next page' : 'Previous page';
      nextBtn.title = rtl ? 'Previous page' : 'Next page';
    },
    setLoading(on) {
      loadingEl.hidden = !on;
    },
    setTheme(bg, fg) {
      root.style.setProperty('--reader-bg', bg);
      root.style.setProperty('--reader-fg', fg);
      shell._bg = bg;
      syncThemeColor(chromeVisible() ? null : bg);
    },
    applyBehaviour() {
      root.classList.toggle('immersive', Boolean(settings.immersive));
    },
    showChrome(on) {
      clearTimeout(hideTimer);
      root.classList.toggle('chrome-hidden', !on);
      syncThemeColor(on ? null : shell._bg || '#000000');
      if (!on) document.querySelector('.sel-toolbar')?.remove();
    },
    toggleChrome() {
      shell.showChrome(!chromeVisible());
    },
    /** Engines call this after turning a page. */
    pageTurned() {
      if (settings.autoCloseMenu && chromeVisible()) shell.showChrome(false);
      shell.refreshBookmark();
    },
    refreshBookmark() {
      const on = Boolean(currentBookmark());
      bookmarkBtn.querySelector('.icon').textContent = on ? 'bookmark_added' : 'bookmark_add';
      bookmarkBtn.classList.toggle('selected', on);
      flag.classList.toggle('on', on);
    },
    toast(text, ms = 1400) {
      root.querySelector('.toast')?.remove();
      const t = h('div.toast', text);
      root.append(t);
      setTimeout(() => t.remove(), ms);
    },
    fail(message) {
      shell.setLoading(false);
      shell.showChrome(true);
      stage.replaceChildren(
        h('div.empty', { style: { color: 'var(--md-on-surface)', background: 'var(--md-surface)', height: '100%', justifyContent: 'center' } },
          icon('error'), h('h2.title-large', 'Couldn’t open this book'), h('p.body-medium', message),
          h('a.btn.tonal', { href: `#/series/${book.seriesId}` }, 'Back to series')),
      );
    },
    /** Keyboard → configured action. */
    handleKey(e) {
      const eng = shell.engine;
      const action = actionFor(e, binds);
      if (!action) return;
      if ((action === 'next' || action === 'prev') && eng?.scrollMode?.()) return;
      e.preventDefault();
      switch (action) {
        case 'pageRight': return eng?.right();
        case 'pageLeft': return eng?.left();
        case 'next': return eng?.next();
        case 'prev': return eng?.prev();
        case 'first': return eng?.goToStart?.();
        case 'last': return eng?.goToEnd?.();
        case 'toggleMenu': return shell.toggleChrome();
        case 'bookmark': return toggleBookmark();
        case 'contents': return openContents();
        case 'settings': return openSettings();
        case 'fullscreen': return toggleFullscreen();
        case 'nextBook': return book.next && openBook(book.next);
        case 'prevBook': return book.prev && openBook(book.prev);
        case 'close': return document.fullscreenElement ? document.exitFullscreen() : exit();
      }
    },
    /** Tap zones: x is a 0–1 fraction across the screen. */
    handleTap(x) {
      const eng = shell.engine;
      if (!settings.tapToPaginate || x >= 0.3 && x <= 0.7) return shell.toggleChrome();
      if (x < 0.3) eng?.left();
      else eng?.right();
    },
    swipeEnabled: () => settings.swipeToPaginate !== false,
    /** Called by engines when the reader moves past the last page. */
    showEnd() {
      shell.showChrome(true);
      if (root.querySelector('.end-card')) return;
      const nextB = book.next;
      const card = h('dialog.dialog.end-card',
        h('div.dialog-head', icon('celebration'), h('h2.headline-small', 'You finished it!')),
        h('div.dialog-body', nextB ? h('p', `Up next in ${book.series}: ${nextB.label}`) : h('p', book.title)),
        h('div.dialog-actions',
          h('button.btn.text.state', { type: 'button', onclick: () => card.close() }, 'Stay here'),
          h('button.btn.text.state', { type: 'button', onclick: () => { card.close(); exit(); } }, 'Close book'),
          nextB && h('button.btn.filled.state', { type: 'button', onclick: () => { card.close(); openBook(nextB); } }, icon('skip_next'), 'Read next'),
        ),
      );
      card.addEventListener('close', () => card.remove());
      root.append(card);
      card.showModal();
    },
    destroy() {
      clearTimeout(hideTimer);
      clearTimeout(saveTimer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFsChange);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      document.querySelectorAll('dialog.sheet').forEach((d) => d.close());
      document.querySelector('.sel-toolbar')?.remove();
    },
  };
  const chromeVisible = () => !root.classList.contains('chrome-hidden');
  shell.applyBehaviour();
  return shell;
}
