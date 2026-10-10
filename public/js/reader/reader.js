import { api } from '../api.js';
import { onLeave, navigate, previousPath } from '../router.js';
import { h, icon, iconButton, sheet, syncThemeColor, store } from '../ui.js';
import { Tracker } from './tracker.js';

export async function readerView(view, params, stale) {
  const book = await api.book(params.id);
  if (stale()) return;

  const tracker = new Tracker(book.id);
  const shell = createShell(book, tracker);
  view.append(shell.root);

  let engine = null;
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
    engine?.destroy?.();
    tracker.destroy();
    shell.destroy();
    wakeLock?.release?.().catch(() => {});
    document.removeEventListener('visibilitychange', onVis);
    syncThemeColor(null);
  });

  try {
    if (book.format === 'epub') {
      const { EpubEngine } = await import('./epub.js');
      engine = new EpubEngine(book, shell, tracker);
    } else {
      const { PageEngine } = await import('./pages.js');
      engine = new PageEngine(book, shell, tracker);
    }
    if (stale()) return engine.destroy();
    shell.engine = engine;
    await engine.open();
  } catch (err) {
    console.error(err);
    shell.fail(err.message || 'This file could not be opened.');
  }
}

/** Builds the reader chrome shared by all engines. */
function createShell(book, tracker) {
  const titleSub = h('div.s');
  const tocBtn = iconButton('toc', 'Contents', () => shell.engine?.openToc?.());
  tocBtn.hidden = true;
  const settingsBtn = iconButton('tune', 'Reader settings', () => openSettings());
  const fsBtn = document.fullscreenEnabled
    ? iconButton('fullscreen', 'Full screen', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else root.requestFullscreen?.().catch(() => {});
      })
    : null;

  const top = h('div.chrome-top',
    iconButton('arrow_back', 'Close book', () => exit()),
    h('div.titles', h('div.t', book.title), titleSub),
    tocBtn,
    fsBtn,
    settingsBtn,
  );

  const slider = h('input.slider', { type: 'range', min: 0, max: 100, value: 0, step: 1, 'aria-label': 'Position in book' });
  const pageNo = h('span.pageno', '');
  const prevBtn = iconButton('chevron_left', 'Previous page', () => shell.engine?.left());
  const nextBtn = iconButton('chevron_right', 'Next page', () => shell.engine?.right());
  const bottom = h('div.chrome-bottom', h('div.row', prevBtn, slider, nextBtn), h('div.row', { style: { justifyContent: 'center' } }, pageNo));
  const mini = h('div.mini-progress');
  const stage = h('div.stage');
  const loadingEl = h('div.page-loading', h('div.spinner'));

  const root = h('div.reader', stage, loadingEl, mini, top, bottom);

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

  // Auto-hide chrome after opening.
  let hideTimer = setTimeout(() => shell.showChrome(false), 2500);

  const onKey = (e) => {
    if (e.target.closest?.('input, textarea, select, dialog')) return;
    shell.handleKey(e);
  };
  document.addEventListener('keydown', onKey);

  const onFsChange = () => fsBtn && (fsBtn.querySelector('.icon').textContent = document.fullscreenElement ? 'fullscreen_exit' : 'fullscreen');
  document.addEventListener('fullscreenchange', onFsChange);

  function exit() {
    if (previousPath() === `/book/${book.id}`) history.back();
    else navigate(`/book/${book.id}`, { replace: true });
  }

  let settingsBuilder = null;
  function openSettings() {
    if (!settingsBuilder) return;
    sheet((close) => settingsBuilder(close));
  }

  const shell = {
    root,
    stage,
    book,
    tracker,
    engine: null,
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
    setTocAvailable(on) {
      tocBtn.hidden = !on;
    },
    setSettings(builder) {
      settingsBuilder = builder;
    },
    setLoading(on) {
      loadingEl.hidden = !on;
    },
    setTheme(bg, fg) {
      root.style.setProperty('--reader-bg', bg);
      root.style.setProperty('--reader-fg', fg);
      syncThemeColor(chromeVisible() ? null : bg);
      shell._bg = bg;
    },
    showChrome(on) {
      clearTimeout(hideTimer);
      root.classList.toggle('chrome-hidden', !on);
      syncThemeColor(on ? null : shell._bg || '#000000');
    },
    toggleChrome() {
      shell.showChrome(!chromeVisible());
    },
    toast(text, ms = 1600) {
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
          h('a.btn.tonal', { href: `#/book/${book.id}` }, 'Back to details')),
      );
    },
    /** Shared keyboard handling; engines implement left()/right()/next()/prev(). */
    handleKey(e) {
      const eng = shell.engine;
      if (!eng) return;
      switch (e.key) {
        case 'ArrowLeft':
          eng.left();
          break;
        case 'ArrowRight':
          eng.right();
          break;
        case ' ':
        case 'PageDown':
          if (eng.scrollMode?.()) return;
          e.shiftKey ? eng.prev() : eng.next();
          break;
        case 'PageUp':
          if (eng.scrollMode?.()) return;
          eng.prev();
          break;
        case 'Home':
          eng.goToStart?.();
          break;
        case 'Escape':
          if (!document.fullscreenElement) exit();
          return;
        case 'm':
        case 'Enter':
          shell.toggleChrome();
          break;
        default:
          return;
      }
      e.preventDefault();
    },
    /** Tap zones: x is a 0–1 fraction across the screen. */
    handleTap(x) {
      const eng = shell.engine;
      if (x < 0.3) eng?.left();
      else if (x > 0.7) eng?.right();
      else shell.toggleChrome();
    },
    /** Called by engines when the reader moves past the last page. */
    showEnd() {
      shell.showChrome(true);
      if (root.querySelector('.end-card')) return;
      const nextBook = book.next;
      const card = h('dialog.dialog',
        h('div.dialog-head', icon('celebration'), h('h2.headline-small', 'You finished it!')),
        h('div.dialog-body', nextBook ? h('p', `Up next in ${book.series}: ${nextBook.title}`) : h('p', book.title)),
        h('div.dialog-actions',
          h('button.btn.text.state', { type: 'button', onclick: () => card.close() }, 'Stay here'),
          h('button.btn.text.state', { type: 'button', onclick: () => { card.close(); exit(); } }, 'Close book'),
          nextBook && h('button.btn.filled.state', {
            type: 'button',
            onclick: async () => {
              card.close();
              if (nextBook.progress?.finished) await api.setFinished(nextBook.id, false);
              navigate(`/read/${nextBook.id}`, { replace: true });
            },
          }, icon('skip_next'), 'Read next'),
        ),
      );
      card.classList.add('end-card');
      card.addEventListener('close', () => card.remove());
      root.append(card);
      card.showModal();
    },
    destroy() {
      clearTimeout(hideTimer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFsChange);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      document.querySelectorAll('dialog.sheet').forEach((d) => d.close());
    },
  };
  const chromeVisible = () => !root.classList.contains('chrome-hidden');
  return shell;
}

/** Per-kind reader defaults remembered on this device. */
export function loadDefaults(kind, fallback) {
  try {
    return { ...fallback, ...JSON.parse(store.get(`reader.${kind}`, '{}')) };
  } catch {
    return { ...fallback };
  }
}
export function saveDefaults(kind, settings) {
  store.set(`reader.${kind}`, JSON.stringify(settings));
}

