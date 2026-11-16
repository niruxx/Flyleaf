// Reader shell: chrome, settings sheet, contents/annotations, bookmarks, key binds.
// Engines: pages.js (manga, comics, PDF) and text.js (EPUB, MOBI/AZW3, FB2, TXT).

import { api } from '../api.js';
import { onLeave, navigate, previousPath } from '../router.js';
import { h, icon, iconButton, button, sheet, syncThemeColor, snackbar, segmented } from '../ui.js';
import { Tracker } from './tracker.js';
import { autoSaveNext } from '../offline.js';
import { readerSettingsForm, PAPER_GRAIN } from '../components/reader-settings.js';
import { resolveKeybinds, actionFor } from '../keybinds.js';
import { annotationRow } from '../views/bookmarks.js';
import { t, plural } from '../i18n.js';

export async function readerView(view, params, stale) {
  const data = await api.reader(params.id, params.query.get('list'));
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
  // Listening doesn't need the screen kept on.
  if (book.engine !== 'audio') {
    document.addEventListener('visibilitychange', onVis);
    requestWakeLock();
  }

  onLeave(() => {
    shell.engine?.destroy?.();
    tracker.destroy();
    shell.destroy();
    wakeLock?.release?.().catch(() => {});
    document.removeEventListener('visibilitychange', onVis);
    syncThemeColor(null);
  });

  try {
    const mod = book.engine === 'text' ? await import('./text.js') : book.engine === 'audio' ? await import('./audio.js') : await import('./pages.js');
    const Engine = mod.TextEngine || mod.AudioEngine || mod.PageEngine;
    const engine = new Engine(book, shell, tracker, data);
    if (stale()) return engine.destroy();
    shell.engine = engine;
    await engine.open(params.query.get('loc'));
    shell.refreshBookmark();
    shell.engineReady();
    autoSaveNext(book).catch((e) => snackbar(t('Could not auto-save the next chapter: {message}', { message: e.message })));
    // From full-text search results: show the matches in this book.
    const q = params.query.get('q');
    if (q && engine.search) shell.openSearch(q);
  } catch (err) {
    console.error(err);
    shell.fail(err.message || t('This file could not be opened.'));
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
  const bookmarkBtn = iconButton('bookmark_add', t('Bookmark this page (B)'), () => toggleBookmark());
  const tocBtn = iconButton('toc', t('Contents & annotations (T)'), () => openContents());
  const settingsBtn = iconButton('tune', t('Reader settings (S)'), () => openSettings());
  const fsBtn = document.fullscreenEnabled
    ? iconButton('fullscreen', t('Full screen (F)'), () => toggleFullscreen())
    : null;
  // Shown once the engine says it can search (EPUB-type books, PDFs with text).
  const searchBtn = iconButton('search', t('Search in book (/)'), () => openSearch());
  searchBtn.hidden = true;

  const top = h('div.chrome-top',
    iconButton('arrow_back', t('Close book'), () => exit()),
    h('div.titles', h('div.t', book.series && book.series !== book.label ? `${book.series} · ${book.label}` : book.title), titleSub),
    searchBtn,
    bookmarkBtn,
    tocBtn,
    fsBtn,
    settingsBtn,
  );

  const slider = h('input.slider', { type: 'range', min: 0, max: 100, value: 0, step: 1, 'aria-label': t('Position in book') });
  const pageNo = h('span.pageno', '');
  const prevBtn = iconButton('chevron_left', t('Previous page'), () => shell.engine?.left());
  const nextBtn = iconButton('chevron_right', t('Next page'), () => shell.engine?.right());
  const prevBook = book.prev && iconButton('skip_previous', t('Previous: {label}', { label: book.prev.label }), () => openBook(book.prev));
  const nextBook = book.next && iconButton('skip_next', t('Next: {label}', { label: book.next.label }), () => openBook(book.next));
  // Auto-scroll (webtoon mode): play/pause and speed.
  const autoBtn = iconButton('play_arrow', t('Auto-scroll (P)'), () => shell.engine?.toggleAutoScroll?.());
  const autoSpeed = h('span.auto-speed.label-large');
  const autoRow = h('div.row.auto-row', { hidden: true },
    autoBtn,
    h('span.label-medium.auto-label', t('Auto-scroll')),
    iconButton('remove', t('Slower (-)'), () => shell.engine?.autoScrollSpeed?.(-1)),
    autoSpeed,
    iconButton('add', t('Faster (=)'), () => shell.engine?.autoScrollSpeed?.(1)));
  const bottom = h('div.chrome-bottom',
    autoRow,
    h('div.row', prevBtn, slider, nextBtn),
    h('div.row', { style: { justifyContent: 'space-between' } }, prevBook || h('span', { style: { width: '40px' } }), pageNo, nextBook || h('span', { style: { width: '40px' } })),
  );
  const mini = h('div.mini-progress');
  const flag = h('div.bookmark-flag');
  const stage = h('div.stage');
  const loadingEl = h('div.page-loading', h('div.spinner'));
  const root = h(`div.reader${book.engine === 'text' ? '.text' : book.engine === 'audio' ? '.audio' : ''}`, stage, loadingEl, mini, flag, top, bottom);

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

  // With auto-hide off, the menu stays put until a tap in the middle of the page hides it.
  const autoHide = () => settings.autoCloseMenu !== false;
  let hideTimer = autoHide() ? setTimeout(() => shell.showChrome(false), settings.immersive ? 600 : 2500) : null;

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
    // Without a connection the series page can't load; go back to the saved books.
    if (!navigator.onLine || document.body.classList.contains('is-offline')) return navigate('/offline', { replace: true });
    const back = `/series/${book.seriesId}`;
    if (previousPath()?.startsWith(back)) history.back();
    else navigate(back, { replace: true });
  }

  async function openBook(b) {
    if (b.progress?.finished) await api.setFinished(b.id, false);
    // Reading from a reading list: keep following the list.
    navigate(`/read/${b.id}${book.readingList ? `?list=${book.readingList.id}` : ''}`, { replace: true });
  }

  // ----- settings -----
  let saveTimer;
  /** Settings changed in the reader are saved for this series (a custom override of the profile). */
  function persistSettings() {
    overridden = true;
    clearTimeout(saveTimer);
    const { resolvedDir, ...clean } = settings;
    saveTimer = setTimeout(() => book.seriesId && api.saveReaderSettings(book.seriesId, clean).catch(() => {}), 600);
  }
  function openSettings() {
    // Audiobooks only have the behaviour settings.
    const show = book.engine === 'text' ? 'text' : book.engine === 'audio' ? 'none' : 'pages';
    sheet((close) => {
      const fontsBox = h('div');
      const footer = h('div.sheet-footer',
        h('div.who', overridden ? t('Custom settings for this series (based on “{value}”)', { value: data.profile?.name || t('Default') }) : t('Using reading profile “{value}”', { value: data.profile?.name || t('Default') })),
        button(t('Reset to profile'), { variant: 'text', icon: 'restart_alt', onclick: async () => {
          await api.saveReaderSettings(book.seriesId, null);
          close();
          navigate(`/read/${book.id}`, { replace: true });
        } }),
        data.profile && button(t('Save to “{name}”', { name: data.profile.name }), { variant: 'tonal', icon: 'save', onclick: async () => {
          const { resolvedDir, ...clean } = settings;
          await api.updateProfile(data.profile.id, { settings: clean });
          await api.saveReaderSettings(book.seriesId, null);
          overridden = false;
          snackbar(t('Saved to “{name}”', { name: data.profile.name }));
          close();
        } }),
      );
      const render = (fonts) =>
        fontsBox.replaceChildren(readerSettingsForm(settings, (key, value) => {
          if (key === 'direction') settings.resolvedDir = value === 'auto' ? (book.kind === 'manga' ? 'rtl' : 'ltr') : value;
          shell.applyBehaviour();
          shell.engine?.applySetting?.(key, value);
          persistSettings();
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
            ? toc.map((localT) => h(`button.list-item.state.depth-${Math.min(localT.depth || 0, 3)}${localT.current ? '.current' : ''}`, { type: 'button', onclick: () => {
                close();
                shell.engine.goTo(localT.target);
              } }, h('span.text', localT.label), localT.page != null && h('span.trailing', String(localT.page + 1))))
            : [h('p.muted', { style: { padding: '16px 24px' } }, t('This book has no table of contents.'))],
        bookmarks: () => listOf('bookmark'),
        highlights: () => listOf('highlight'),
      };
      function listOf(kind) {
        const list = annotations.filter((a) => a.kind === kind);
        if (!list.length) return [h('p.muted', { style: { padding: '16px 24px' } }, kind === 'bookmark' ? t('No bookmarks yet – tap the bookmark icon to add one.') : t('No highlights yet – select some text to highlight it.'))];
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
      const tabs = [['toc', t('Contents'), 'toc'], ['bookmarks', t('Bookmarks'), 'bookmark'], book.engine === 'text' && ['highlights', t('Highlights'), 'ink_highlighter']].filter(Boolean);
      const seg = segmented(tabs.map(([value, label, ic]) => ({ value, label, icon: ic })), 'toc', (v) => show(v));
      function show(v) {
        seg.setValue(v);
        body.replaceChildren(...views[v]());
      }
      show(toc.length ? 'toc' : 'bookmarks');
      return h('div.toc', h('div.sheet-section', seg), body);
    });
  }

  // ----- search inside the book -----
  // “…” only where the excerpt is cut mid-sentence.
  const excerptPre = (s = '') => (s.trim() ? `…${s.trimStart()}` : '');
  const excerptPost = (s = '') => (!s.trim() ? '' : /[.!?…"”’)\]]\s*$/.test(s) ? s.trimEnd() : `${s.trimEnd()}…`);
  // The last search stays, so reopening the sheet shows the same results.
  const found = { query: '', groups: [], done: true };
  let searchRun = 0;
  /** Open the search sheet; with `initial`, search for it straight away (links from full-text search). */
  function openSearch(initial) {
    const eng = shell.engine;
    if (!eng?.search) return;
    sheet((close) => {
      const input = h('input.search-input', { type: 'search', placeholder: t('Search in this book'), value: initial || found.query, enterkeyhint: 'search', autocomplete: 'off', 'aria-label': t('Search in this book') });
      const status = h('div.search-status.body-small.muted');
      const bar = h('div.progress.search-progress', { hidden: true }, h('span', { style: { width: '0%' } }));
      const list = h('div.search-results');
      const total = () => found.groups.reduce((a, g) => a + g.items.length, 0);

      const item = (r) => h('button.search-hit.list-item.state', { type: 'button', onclick: () => {
        close();
        eng.goTo(r.target);
        shell.toast(t('Search result'));
      } }, h('span.excerpt', excerptPre(r.pre), h('mark', r.match), excerptPost(r.post)));
      const group = (g) => h('div.search-group', h('div.search-chapter', g.label || t('Text')), g.items.map(item));
      const draw = () => {
        list.replaceChildren(...found.groups.map(group));
        const n = total();
        const where = book.engine === 'text' ? plural(found.groups.length, '{n} section', '{n} sections') : plural(found.groups.length, '{n} page', '{n} pages');
        status.textContent = !found.query ? t('Type a word or phrase and press Enter.') : found.done
          ? (n ? t('{matches} in {where}', { matches: plural(n, '{n} match', '{n} matches', { n: `${n}${n >= 500 ? '+' : ''}` }), where }) : t('No matches for “{query}”', { query: found.query }))
          : t('Searching… {n} so far', { n });
      };

      async function run() {
        const query = input.value.trim();
        if (!query) return;
        const id = ++searchRun;
        eng.clearSearch?.();
        Object.assign(found, { query, groups: [], done: false });
        bar.hidden = false;
        draw();
        try {
          for await (const r of eng.search(query)) {
            if (id !== searchRun) return;
            if (r.progress != null) bar.firstChild.style.width = `${Math.round(r.progress * 100)}%`;
            if (r.items) {
              found.groups.push(r);
              list.append(group(r));
              draw();
              if (total() >= 500) break; // enough to scroll through
            }
          }
        } catch (e) {
          status.textContent = e.message || t('Search failed.');
        }
        if (id !== searchRun) return;
        found.done = true;
        bar.hidden = true;
        draw();
      }
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          run();
        }
      });
      draw();
      if (initial && initial !== found.query) run();
      else setTimeout(() => input.focus(), 50);
      return h('div.search-sheet',
        h('div.sheet-section', h('div.search-field', icon('search'), input,
          iconButton('close', t('Clear search'), () => {
            searchRun++;
            input.value = '';
            eng.clearSearch?.();
            Object.assign(found, { query: '', groups: [], done: true });
            bar.hidden = true;
            draw();
            input.focus();
          })), bar, status),
        list);
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
      shell.toast(t('Bookmark removed'));
    } else {
      const a = await api.addAnnotation(book.id, { kind: 'bookmark', ...loc });
      annotations = [...annotations, a];
      shell.toast(t('Page bookmarked'));
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
      prevBtn.title = rtl ? t('Next page') : t('Previous page');
      nextBtn.title = rtl ? t('Previous page') : t('Next page');
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
      root.classList.toggle('look-book', settings.look === 'book');
      root.classList.toggle('look-eink', settings.look === 'eink');
      root.style.setProperty('--paper-grain', PAPER_GRAIN);
    },
    /** Change one setting from inside the reader (like the settings sheet does). */
    changeSetting(key, value) {
      settings[key] = value;
      shell.applyBehaviour();
      shell.engine?.applySetting?.(key, value);
      persistSettings();
    },
    /** Engines say whether auto-scroll is available (webtoon mode) after building. */
    setAutoScrollAvailable(on) {
      autoRow.hidden = !on;
      shell.autoScrollChanged(false);
    },
    autoScrollChanged(on) {
      autoBtn.querySelector('.icon').textContent = on ? 'pause' : 'play_arrow';
      autoBtn.title = on ? t('Pause auto-scroll (P)') : t('Auto-scroll (P)');
      autoBtn.setAttribute('aria-label', autoBtn.title);
      autoBtn.classList.toggle('selected', on);
      autoSpeed.textContent = String(Math.max(1, Math.min(10, Number(settings.autoScrollSpeed) || 3)));
      root.classList.toggle('auto-scrolling', on);
      if (on && autoHide()) shell.showChrome(false);
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
      if (autoHide() && chromeVisible()) shell.showChrome(false);
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
      const localT = h('div.toast', text);
      root.append(localT);
      setTimeout(() => localT.remove(), ms);
    },
    fail(message) {
      shell.setLoading(false);
      shell.showChrome(true);
      stage.replaceChildren(
        h('div.empty', { style: { color: 'var(--md-on-surface)', background: 'var(--md-surface)', height: '100%', justifyContent: 'center' } },
          icon('error'), h('h2.title-large', t('Couldn’t open this book')), h('p.body-medium', message),
          h('a.btn.tonal', { href: `#/series/${book.seriesId}` }, t('Back to series'))),
      );
    },
    /** Keyboard → configured action. */
    /** After the book opens: show what this engine supports. */
    engineReady() {
      searchBtn.hidden = !shell.engine?.search;
    },
    openSearch,
    handleKey(e) {
      const eng = shell.engine;
      if (e.key === 'Escape' && eng?.zoom?.active) {
        e.preventDefault();
        return eng.zoom.reset();
      }
      // "/" or Ctrl/⌘+F: search in the book (instead of the browser's find, which can't see inside it).
      if (eng?.search && (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f'))) {
        e.preventDefault();
        return openSearch();
      }
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
        case 'autoScroll': return eng?.toggleAutoScroll?.();
        case 'scrollFaster': return eng?.autoScrollSpeed?.(1);
        case 'scrollSlower': return eng?.autoScrollSpeed?.(-1);
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
    endLabel: t('End'),
    /** Open the next volume or chapter (from the end screen). */
    openNext() {
      if (book.next) return openBook(book.next);
      shell.toast(t('That’s the last one in this series'));
    },
    /**
     * The chapter end screen: what you finished, and the next volume or chapter with its cover.
     * Page engines show it as a page after the last one; webtoon mode at the bottom of the strip.
     */
    endPanel({ paged = false, onStay } = {}) {
      const nextB = book.next;
      const where = book.label || book.title;
      const art = (b) => {
        const box = h('div.ce-cover', h('span.ce-cover-label', b.label));
        if (b.coverUrl) {
          const img = h('img', { src: b.coverUrl, alt: '', loading: 'lazy', decoding: 'async' });
          img.addEventListener('load', () => box.classList.add('loaded'));
          img.addEventListener('error', () => img.remove());
          box.prepend(img);
        }
        return box;
      };
      const nextInfo = nextB && [
        nextB.pageCount ? plural(nextB.pageCount, '{n} page', '{n} pages') : null,
        nextB.progress?.finished ? t('read before') : nextB.progress?.page ? t('continue from page {n}', { n: nextB.progress.page + 1 }) : null,
      ].filter(Boolean).join(' · ');
      const panel = h('div.chapter-end',
        h('div.ce-done', icon('check_circle', 'filled'), h('div', h('div.ce-kicker', t('Finished')), h('div.ce-title', where))),
        nextB
          ? h('button.ce-next.state', { type: 'button', onclick: () => openBook(nextB) },
            art(nextB),
            h('div.ce-next-text',
              h('div.ce-kicker', book.readingList ? t('Up next in {list}', { list: book.readingList.name }) : t('Up next')),
              h('div.ce-next-title', nextB.label),
              nextInfo && h('div.ce-next-meta', nextInfo),
              h('span.btn.filled.ce-read', icon('skip_next'), t('Read next'))))
          : h('div.ce-last', icon('done_all'), h('div', h('div.ce-next-title', t('You’re all caught up')), h('div.ce-next-meta', book.series ? t('That’s the last one in {series}.', { series: book.series }) : book.title))),
        h('div.ce-actions',
          onStay && h('button.btn.text.state', { type: 'button', onclick: onStay }, t('Stay here')),
          h('button.btn.text.state', { type: 'button', onclick: () => exit() }, icon('arrow_back'), book.seriesId ? t('Back to series') : t('Close book'))),
        paged && nextB && h('div.ce-hint', t('Turn the page again to keep reading')),
      );
      // Taps on the panel are for its buttons, not page turns.
      panel.addEventListener('click', (e) => e.stopPropagation());
      panel.addEventListener('pointerdown', (e) => e.stopPropagation());
      return panel;
    },
    /** Called by engines (ebooks, audiobooks) when the reader moves past the end. */
    showEnd() {
      shell.showChrome(true);
      if (root.querySelector('.end-card')) return;
      const card = h('dialog.dialog.end-card');
      card.append(shell.endPanel({ onStay: () => card.close() }));
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
