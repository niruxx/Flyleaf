// DOM helpers and Material 3 component behaviours.

/** Hyperscript: h('div.card#id', {onclick, ...attrs}, ...children) */
export function h(tag, props, ...children) {
  const [, name = 'div', rest = ''] = tag.match(/^([\w-]*)(.*)$/);
  const el = document.createElement(name || 'div');
  for (const m of rest.matchAll(/([.#])([\w-]+)/g)) {
    if (m[1] === '.') el.classList.add(m[2]);
    else el.id = m[2];
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && k !== 'form' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const icon = (name, cls = '') => h(`span.icon${cls ? `.${cls}` : ''}`, { 'aria-hidden': 'true' }, name);

export function iconButton(name, label, onclick, variant = '') {
  return h(`button.icon-btn.state${variant ? `.${variant}` : ''}`, { type: 'button', title: label, 'aria-label': label, onclick }, icon(name));
}

export function button(label, { variant = 'filled', icon: ic, onclick, type = 'button', ...rest } = {}) {
  return h(`button.btn.state.${variant.split(' ').join('.')}`, { type, onclick, ...rest }, ic && icon(ic), label);
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

// ---------------------------------------------------------------------------
// Ripples on buttons/chips/list items.

document.addEventListener(
  'pointerdown',
  (e) => {
    const target = e.target.closest('.btn, .icon-btn, .chip, .list-item, .fab, .menu button, .segmented button, .tabs button, .pill');
    if (!target || target.disabled) return;
    if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
    target.style.overflow = 'hidden';
    target.style.isolation = 'isolate';
    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const r = h('span.ripple', {
      style: { width: `${size}px`, height: `${size}px`, left: `${e.clientX - rect.left - size / 2}px`, top: `${e.clientY - rect.top - size / 2}px` },
    });
    target.append(r);
    setTimeout(() => r.remove(), 500);
  },
  { passive: true },
);

// ---------------------------------------------------------------------------
// Theme

export const HUES = [
  { name: 'Indigo', hue: 268 },
  { name: 'Ocean', hue: 230 },
  { name: 'Teal', hue: 190 },
  { name: 'Forest', hue: 145 },
  { name: 'Amber', hue: 70 },
  { name: 'Rose', hue: 10 },
  { name: 'Orchid', hue: 320 },
];

const store = {
  get(k, d = null) {
    try {
      return localStorage.getItem(`flyleaf.${k}`) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(`flyleaf.${k}`);
      else localStorage.setItem(`flyleaf.${k}`, v);
    } catch {}
  },
};
export { store };

export function getTheme() {
  return store.get('theme', 'system');
}
export function setTheme(mode) {
  store.set('theme', mode === 'system' ? null : mode);
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  syncThemeColor();
}
export function getHue() {
  return Number(store.get('hue', 268));
}
export function setHue(hue) {
  store.set('hue', String(hue));
  document.documentElement.style.setProperty('--seed-hue', hue);
  syncThemeColor();
}
export function isDark() {
  const t = getTheme();
  return t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}

/** Resolve any CSS colour (incl. oklch) to #rrggbb via canvas. */
export function resolveColor(css) {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

let themeOverride = null;
/** Update the browser/status bar colour to match the current surface. */
export function syncThemeColor(override = themeOverride) {
  themeOverride = override;
  requestAnimationFrame(() => {
    const color = override || resolveColor(getComputedStyle(document.documentElement).getPropertyValue('--md-surface').trim());
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', color));
  });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => syncThemeColor());

// ---------------------------------------------------------------------------
// Snackbar

export function snackbar(message, { action, onAction, duration = 4000 } = {}) {
  const host = document.querySelector('.snackbar-host');
  clear(host);
  const bar = h(
    'div.snackbar',
    { role: 'status' },
    h('span.msg', message),
    action &&
      button(action, {
        variant: 'text',
        onclick: () => {
          bar.remove();
          onAction?.();
        },
      }),
  );
  host.append(bar);
  setTimeout(() => bar.remove(), duration);
}

// ---------------------------------------------------------------------------
// Dialogs

/**
 * Open a modal dialog. `content` may be a node or a function receiving `close`.
 * Returns a promise resolving to the value passed to close().
 */
export function dialog({ title, icon: ic, content, actions = [], className = '', dismissible = true, onOpen }) {
  return new Promise((resolve) => {
    const dlg = h(`dialog.dialog${className ? `.${className}` : ''}`);
    let result;
    const close = (value) => {
      result = value;
      dlg.close();
    };
    const body = typeof content === 'function' ? content(close) : content;
    dlg.append(
      h('div.dialog-head', ic && icon(ic), title && h('h2.headline-small', title)),
      body && h('div.dialog-body', body),
      actions.length &&
        h(
          'div.dialog-actions',
          actions.map((a) =>
            button(a.label, {
              variant: a.variant || 'text',
              type: a.submit ? 'submit' : 'button',
              form: a.submit || undefined,
              onclick: a.submit ? undefined : async () => {
                if (a.onClick) {
                  const v = await a.onClick(close);
                  if (v === false) return;
                  if (v !== undefined) return close(v);
                }
                if (a.value !== undefined || !a.onClick) close(a.value);
              },
            }),
          ),
        ),
    );
    dlg.addEventListener('cancel', (e) => {
      if (!dismissible) e.preventDefault();
    });
    dlg.addEventListener('click', (e) => {
      if (dismissible && e.target === dlg) {
        const r = dlg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(undefined);
      }
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    document.body.append(dlg);
    dlg.showModal();
    onOpen?.(dlg, close);
  });
}

export function confirmDialog({ title, message, confirm = 'Confirm', danger = false, icon: ic }) {
  return dialog({
    title,
    icon: ic,
    content: h('p', message),
    actions: [
      { label: 'Cancel', value: false },
      { label: confirm, value: true, variant: danger ? 'text danger' : 'text' },
    ],
  }).then(Boolean);
}

/** Outlined text field. */
export function field(label, { type = 'text', value = '', name, support, required, autocomplete, multiline, options, ...rest } = {}) {
  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  let input;
  if (options) {
    input = h('select', { id, name, required, ...rest }, options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
  } else if (multiline) {
    input = h('textarea', { id, name, placeholder: ' ', required, ...rest });
    input.value = value ?? '';
  } else {
    input = h('input', { id, name, type, placeholder: ' ', required, autocomplete, ...rest });
    input.value = value ?? '';
  }
  const wrap = h('div.field', input, h('label', { for: id }, label), support && h('span.support', support));
  if (type === 'password') {
    const toggle = iconButton('visibility', 'Show password', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.querySelector('.icon').textContent = show ? 'visibility_off' : 'visibility';
    });
    wrap.append(h('div.trailing', toggle));
  }
  wrap.input = input;
  return wrap;
}

export function formError(message) {
  return h('div.form-error', { role: 'alert' }, icon('error'), h('span', message));
}

// ---------------------------------------------------------------------------
// Menus

export function menu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const el = h(
    'div.menu',
    { role: 'menu' },
    items.map((it) =>
      it === '-'
        ? h('hr')
        : h(
            'button.state',
            {
              role: it.checked !== undefined ? 'menuitemradio' : 'menuitem',
              'aria-checked': it.checked !== undefined ? String(Boolean(it.checked)) : null,
              onclick: () => {
                close();
                it.onClick?.();
              },
            },
            it.icon && icon(it.icon),
            h('span', it.label),
          ),
    ),
  );
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let left = Math.min(r.right - mw, innerWidth - mw - 8);
  if (left < 8) left = Math.min(r.left, innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  Object.assign(el.style, { left: `${Math.max(8, left)}px`, top: `${top}px` });
  const onDoc = (e) => {
    if (!el.contains(e.target)) close();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  function close() {
    el.remove();
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey);
  }
  setTimeout(() => {
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey);
  });
  el.querySelector('button')?.focus({ preventScroll: true });
  return close;
}

// ---------------------------------------------------------------------------
// Bottom sheet

export function sheet(build) {
  const dlg = h('dialog.sheet', h('div.handle'));
  const close = () => dlg.close();
  append(dlg, [build(close)]);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) {
      const r = dlg.getBoundingClientRect();
      if (e.clientY < r.top) close();
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  // Swipe down on the handle area to dismiss.
  let startY = null;
  dlg.addEventListener('touchstart', (e) => {
    startY = dlg.scrollTop <= 0 ? e.touches[0].clientY : null;
  }, { passive: true });
  dlg.addEventListener('touchend', (e) => {
    if (startY != null && e.changedTouches[0].clientY - startY > 90) close();
    startY = null;
  });
  document.body.append(dlg);
  dlg.showModal();
  return close;
}

export function segmented(options, value, onChange) {
  const wrap = h('div.segmented', { role: 'group' });
  const render = (v) => {
    for (const b of wrap.children) b.setAttribute('aria-pressed', String(b.dataset.value === String(v)));
  };
  for (const o of options) {
    wrap.append(
      h(
        'button',
        {
          type: 'button',
          dataset: { value: String(o.value) },
          title: o.title || o.label || '',
          onclick: () => {
            render(o.value);
            onChange(o.value);
          },
        },
        o.icon && icon(o.icon),
        o.label,
      ),
    );
  }
  render(value);
  wrap.setValue = render;
  return wrap;
}

export function toggleSwitch(checked, onChange, label) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked, 'aria-label': label, onchange: () => onChange(input.checked) });
  return h('label.switch', input, h('span.track'));
}

// ---------------------------------------------------------------------------
// Covers & tiles

const FORMAT_ICON = { epub: 'menu_book', pdf: 'picture_as_pdf', cbz: 'photo_library', cbr: 'photo_library', folder: 'photo_library' };

export function cover(item, { showProgress = true, count } = {}) {
  const el = h('div.cover');
  const ph = h('div.placeholder', h('div.ph-title', item.title || item.name || ''), icon(FORMAT_ICON[item.format] || 'collections_bookmark'));
  el.append(ph);
  if (item.coverUrl) {
    const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: false });
    img.addEventListener('load', () => {
      img.classList.add('loaded');
      ph.remove();
    });
    img.addEventListener('error', () => img.remove());
    img.src = item.coverUrl;
    el.prepend(img);
  }
  const p = item.progress;
  if (showProgress && p?.finished) {
    el.append(h('div.corner', { title: 'Finished' }, icon('check', 'filled')));
  } else if (count != null) {
    el.append(h('div.corner.count', String(count)));
  }
  if (showProgress && p && !p.finished && p.percent > 0) {
    el.append(h('div.bar', h('span', { style: { width: `${Math.max(3, p.percent * 100)}%` } })));
  }
  return el;
}

export function bookTile(book, { sub } = {}) {
  return h(
    'a.tile',
    { href: `#/book/${book.id}`, title: book.title },
    cover(book),
    h('div.t-title', book.title),
    h('div.t-sub', sub ?? bookSubtitle(book)),
  );
}

export function seriesTile(s) {
  const unread = s.count - (s.finished || 0);
  return h(
    'a.tile',
    { href: `#/series/${s.libraryId}/${encodeURIComponent(s.name)}`, title: s.name },
    cover({ ...s, title: s.name }, { showProgress: false, count: unread > 0 ? unread : undefined }),
    h('div.t-title', s.name),
    h('div.t-sub', `${s.count} ${s.count === 1 ? 'item' : 'items'}${unread === 0 ? ' · read' : ''}`),
  );
}

export function bookSubtitle(book) {
  const p = book.progress;
  if (p?.finished) return 'Finished';
  if (p && p.percent > 0) return `${Math.round(p.percent * 100)}% read`;
  if (book.author) return book.author;
  if (book.series && book.seriesIndex != null) return `${book.series} · ${book.seriesIndex}`;
  return book.format.toUpperCase();
}

// ---------------------------------------------------------------------------
// Formatting

export function formatDuration(seconds, { short = false } = {}) {
  seconds = Math.round(seconds || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (short) return h ? `${h}h ${m}m` : m ? `${m}m` : `${seconds}s`;
  if (h) return `${h} hr ${m} min`;
  if (m) return `${m} min`;
  return seconds ? `${seconds} sec` : '0 min';
}

export function timeAgo(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 60) return 'just now';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 86400 * 30) return rtf.format(-Math.round(s / 86400), 'day');
  return new Date(ts).toLocaleDateString();
}

export function formatBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Sticky top bar that tints when the page scrolls. */
export function topBar(title, ...actions) {
  const bar = h('header.top-bar', ...actions.filter((a) => a?.dataset?.lead === '1'), h('h1.title', title), ...actions.filter((a) => a?.dataset?.lead !== '1'));
  const onScroll = () => bar.classList.toggle('scrolled', scrollY > 4);
  addEventListener('scroll', onScroll, { passive: true });
  bar.cleanup = () => removeEventListener('scroll', onScroll);
  return bar;
}

export function leading(el) {
  el.dataset.lead = '1';
  return el;
}

export function loading() {
  return h('div.center-load', h('div.spinner', { role: 'progressbar', 'aria-label': 'Loading' }));
}

export function emptyState(ic, title, text, action) {
  return h('div.empty', icon(ic), h('h2.title-large', title), text && h('p.body-medium', text), action);
}
