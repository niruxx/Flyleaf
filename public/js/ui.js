// DOM helpers and Material 3 component behaviours.

import { leave } from './motion.js';

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
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    } else if (k === 'dataset') Object.assign(el.dataset, v);
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
  return h(`button.icon-btn.state${variant ? `.${variant.split(' ').join('.')}` : ''}`, { type: 'button', title: label, 'aria-label': label, onclick }, icon(name));
}

export function button(label, { variant = 'filled', icon: ic, onclick, type = 'button', ...rest } = {}) {
  return h(`button.btn.state.${variant.split(' ').join('.')}`, { type, onclick, ...rest }, ic && icon(ic), label);
}

/** Change a button()'s label. Not lastChild: a click appends a ripple after the text. */
export function setButtonLabel(btn, text) {
  const node = [...btn.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE);
  if (node) node.textContent = text;
  else btn.append(text);
}

/** Give children a staggered entrance animation. */
export function stagger(el) {
  el.classList.add('stagger');
  [...el.children].forEach((c, i) => c.style.setProperty('--i', i));
  return el;
}

// ---------------------------------------------------------------------------
// Ripples

document.addEventListener(
  'pointerdown',
  (e) => {
    const target = e.target.closest('.btn, .icon-btn, .chip, .list-item, .fab, .menu button, .segmented button, .tabs button, .pill, .nav-item, .setting-row.state');
    if (!target || target.disabled || document.documentElement.classList.contains('no-motion')) return;
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
// Local storage

export const store = {
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
  host.replaceChildren();
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
  setTimeout(() => leave(bar, () => bar.remove()), duration);
}

// ---------------------------------------------------------------------------
// Dialogs

/**
 * Open a modal dialog. `content` may be a node or a function receiving `close`.
 * Returns a promise resolving to the value passed to close().
 */
export function dialog({ title, icon: ic, content, actions = [], className = '', dismissible = true, onOpen }) {
  return new Promise((resolve) => {
    const dlg = h(`dialog.dialog${className ? `.${className.split(' ').join('.')}` : ''}`);
    let result;
    const close = (value) => {
      result = value;
      leave(dlg, () => dlg.open && dlg.close());
    };
    const body = typeof content === 'function' ? content(close) : content;
    // The append() helper skips false/0/null; the DOM method would print them.
    append(dlg, [
      h('div.dialog-head', ic && icon(ic), title && h('h2.headline-small', title)),
      body && h('div.dialog-body', body),
      actions.length > 0 &&
        h(
          'div.dialog-actions',
          actions.map((a) =>
            button(a.label, {
              variant: a.variant || 'text',
              type: a.submit ? 'submit' : 'button',
              form: a.submit || undefined,
              icon: a.icon,
              onclick: a.submit
                ? undefined
                : async () => {
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
    ]);
    dlg.addEventListener('cancel', (e) => {
      // Escape: play the closing animation instead of vanishing.
      e.preventDefault();
      if (dismissible) close(undefined);
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
      { label: confirm, value: true, variant: danger ? 'text danger' : 'filled' },
    ],
  }).then(Boolean);
}

/** A form inside a dialog. `onSubmit` returns/throws; errors show inline. */
export function formDialog({ title, fields, submit = 'Save', onSubmit, className = '', icon: ic, extra }) {
  const id = `form-${Math.random().toString(36).slice(2, 8)}`;
  const err = h('div');
  const form = h('form', { id }, err, fields, extra);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.replaceChildren();
    const btn = form.closest('dialog')?.querySelector(`button[form="${id}"]`);
    if (btn) btn.disabled = true;
    try {
      const v = await onSubmit();
      form.closest('dialog').close();
      return v;
    } catch (e2) {
      err.append(formError(e2.message));
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  return dialog({ title, icon: ic, className, content: form, actions: [{ label: 'Cancel' }, { label: submit, submit: id, variant: 'filled' }] });
}

/** Outlined text field. */
export function field(label, { type = 'text', value = '', name, support, required, autocomplete, multiline, options, ...rest } = {}) {
  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  let input;
  if (options) {
    const opt = (o) => h('option', { value: o.value ?? '', selected: String(o.value ?? '') === String(value ?? '') }, o.label);
    // Options with a `group` are shown under that heading (in order of first appearance).
    const groups = [];
    for (const o of options) {
      const g = o.group || '';
      let entry = groups.find((x) => x.label === g);
      if (!entry) groups.push((entry = { label: g, items: [] }));
      entry.items.push(o);
    }
    input = h('select', { id, name, required, ...rest }, groups.map((g) => (g.label ? h('optgroup', { label: g.label }, g.items.map(opt)) : g.items.map(opt))));
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

/** Editable chip list (genres, tags). Returns element with .value getter. */
export function chipInput(label, values = [], { suggestions = [] } = {}) {
  let list = [...values];
  const set = h('div.chip-set', { style: { marginTop: '8px' } });
  const listId = `dl-${Math.random().toString(36).slice(2, 8)}`;
  const f = field(label, { support: 'Press Enter or comma to add', list: listId });
  f.input.setAttribute('list', listId);
  const dl = h('datalist', { id: listId }, suggestions.map((s) => h('option', { value: s })));
  const render = () =>
    set.replaceChildren(
      ...list.map((v, i) =>
        h('span.chip.input-chip.selected', v, h('button', { type: 'button', 'aria-label': `Remove ${v}`, onclick: () => { list.splice(i, 1); render(); } }, icon('close'))),
      ),
    );
  const add = () => {
    for (const part of f.input.value.split(',')) {
      const v = part.trim();
      if (v && !list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
    }
    f.input.value = '';
    render();
  };
  f.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !f.input.value && list.length) {
      list.pop();
      render();
    }
  });
  f.input.addEventListener('change', () => f.input.value.trim() && add());
  render();
  const wrap = h('div', f, dl, set);
  Object.defineProperty(wrap, 'value', { get: () => (f.input.value.trim() && add(), list) });
  return wrap;
}

// ---------------------------------------------------------------------------
// Menus & action sheets

export function menu(anchor, items, { at } = {}) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const el = h(
    'div.menu',
    { role: 'menu' },
    items.filter(Boolean).map((it) =>
      it === '-'
        ? h('hr')
        : it.header
          ? h('div.label-medium', { style: { padding: '8px 16px 4px', color: 'var(--md-on-surface-variant)' } }, it.header)
          : h(
              'button.state',
              {
                role: it.checked !== undefined ? 'menuitemradio' : 'menuitem',
                'aria-checked': it.checked !== undefined ? String(Boolean(it.checked)) : null,
                disabled: it.disabled,
                onclick: () => {
                  close();
                  it.onClick?.();
                },
              },
              it.icon && icon(it.icon),
              h('span', { style: { flex: '1' } }, it.label),
              it.trailing && h('span.label-small', { style: { color: 'var(--md-on-surface-variant)' } }, it.trailing),
            ),
    ),
  );
  document.body.append(el);
  const r = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : anchor.getBoundingClientRect();
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let left = Math.min(r.right - mw, innerWidth - mw - 8);
  if (left < 8) left = Math.min(r.left, innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  Object.assign(el.style, { left: `${Math.max(8, left)}px`, top: `${top}px`, maxHeight: `${innerHeight - 16}px`, overflowY: 'auto' });
  const onDoc = (e) => {
    if (!el.contains(e.target)) close();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  function close() {
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey);
    leave(el, () => el.remove());
  }
  setTimeout(() => {
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey);
  });
  el.querySelector('button')?.focus({ preventScroll: true });
  return close;
}

/** Bottom sheet on touch/compact screens, dropdown menu elsewhere. */
export function actions(anchor, items, { title, at } = {}) {
  const compact = matchMedia('(pointer: coarse)').matches || innerWidth < 600;
  if (!compact) return menu(anchor, items, { at });
  return sheet((close) =>
    h('div',
      title && h('div.title-medium', { style: { padding: '4px 24px 8px' } }, title),
      h('div.list', items.filter(Boolean).map((it) =>
        it === '-'
          ? h('hr.divider', { style: { margin: '4px 0' } })
          : it.header
            ? h('div.label-medium', { style: { padding: '12px 24px 4px', color: 'var(--md-on-surface-variant)' } }, it.header)
            : h('button.list-item.state', {
                type: 'button',
                disabled: it.disabled,
                onclick: () => {
                  close();
                  it.onClick?.();
                },
              }, it.icon && icon(it.icon), h('span.text', it.label), it.checked && icon('check')),
      )),
    ),
  );
}

export function sheet(build) {
  const dlg = h('dialog.sheet', h('div.handle'));
  const close = () => leave(dlg, () => dlg.open && dlg.close());
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  append(dlg, [build(close)]);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) {
      const r = dlg.getBoundingClientRect();
      if (e.clientY < r.top) close();
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
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
      h('button', {
        type: 'button',
        dataset: { value: String(o.value) },
        title: o.title || o.label || '',
        onclick: () => {
          render(o.value);
          onChange(o.value);
        },
      }, o.icon && icon(o.icon), o.label),
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

/** Long-press (touch) or right-click → callback with coordinates. */
export function onContext(el, fn) {
  let timer = null;
  let start = null;
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    fn({ x: e.clientX, y: e.clientY });
  });
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    timer = setTimeout(() => {
      timer = null;
      navigator.vibrate?.(10);
      el.dataset.longpress = '1';
      fn(start);
    }, 520);
  }, { passive: true });
  const cancel = () => clearTimeout(timer);
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel();
  }, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('click', (e) => {
    if (el.dataset.longpress) {
      e.preventDefault();
      delete el.dataset.longpress;
    }
  }, true);
}

// ---------------------------------------------------------------------------
// Covers

const FORMAT_ICON = { epub: 'menu_book', mobi: 'menu_book', azw3: 'menu_book', fb2: 'menu_book', txt: 'article', pdf: 'picture_as_pdf' };

export function cover(item, { showProgress = true, count, blur = item.blur, finished } = {}) {
  const el = h(`div.cover${blur ? '.blurred' : ''}`);
  const ph = h('div.placeholder', h('div.ph-title', item.title || item.name || ''), icon(FORMAT_ICON[item.format] || 'collections_bookmark'));
  el.append(ph);
  if (item.coverUrl) {
    const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('load', () => {
      img.classList.add('loaded');
      ph.remove();
    });
    img.addEventListener('error', () => img.remove());
    // External artwork (Content Finder) shouldn't learn which page you're on.
    if (/^https?:/i.test(item.coverUrl)) img.referrerPolicy = 'no-referrer';
    img.src = item.coverUrl;
    el.prepend(img);
  }
  if (blur) el.append(h('div.nsfw', icon('visibility_off')));
  const p = item.progress;
  const done = finished ?? (typeof p === 'object' ? p?.finished : false);
  if (showProgress && done) {
    el.append(h('div.corner', { title: 'Finished' }, icon('check', 'filled')));
  } else if (count != null) {
    el.append(h('div.corner.count', { title: `${count} unread` }, String(count)));
  }
  const pct = typeof p === 'number' ? p : p?.percent;
  if (showProgress && !done && pct > 0) {
    el.append(h('div.bar', h('span', { style: { width: `${Math.max(3, pct * 100)}%` } })));
  }
  return el;
}

/** Name the clicked cover so the View Transition morphs it into the hero artwork. */
export function markHero(coverEl) {
  document.querySelectorAll('[style*="view-transition-name"]').forEach((e) => (e.style.viewTransitionName = ''));
  if (coverEl) coverEl.style.viewTransitionName = 'hero-cover';
}

// ---------------------------------------------------------------------------
// Formatting

export function formatDuration(seconds, { short = false } = {}) {
  seconds = Math.round(seconds || 0);
  const hrs = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (short) return hrs ? `${hrs}h ${m}m` : m ? `${m}m` : `${seconds}s`;
  if (hrs) return `${hrs} hr ${m} min`;
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

export function pageHeader(title, ...actions) {
  return h('div.page-head.enter', h('h1', title), ...actions.filter(Boolean));
}

/**
 * Library picker options, grouped: your own libraries, the shared ones, then (admin only)
 * each user's personal libraries.
 */
export function libraryOptions(libraries, label = (l) => l.name) {
  const rank = (l) => (l.own ? 0 : l.personal ? 2 : 1);
  return [...libraries]
    .sort((a, b) => rank(a) - rank(b) || String(a.ownerName || '').localeCompare(String(b.ownerName || '')))
    .map((l) => ({ value: l.id, label: label(l), group: l.own ? 'My libraries' : l.personal ? `${l.ownerName}’s libraries` : 'Shared libraries' }));
}

/** Fill an .avatar element with someone's profile picture, or their initial. */
export function fillAvatar(el, user) {
  const initial = (user?.displayName || user?.username || '?').trim()[0] || '?';
  el.replaceChildren(initial);
  el.classList.remove('has-img');
  if (user?.avatarUrl) {
    const img = h('img', { src: user.avatarUrl, alt: '', decoding: 'async' });
    img.addEventListener('load', () => {
      el.replaceChildren(img);
      el.classList.add('has-img');
    });
  }
  return el;
}

/** A round profile picture (or initial). */
export const avatar = (user, size = 36) => fillAvatar(h('span.avatar', { style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, cursor: 'default' } }), user);

/** M3 Expressive-style loading indicator: a morphing, rotating shape. */
export function loading() {
  return h('div.center-load', h('div.loader', { role: 'progressbar', 'aria-label': 'Loading' }, h('span')));
}

/**
 * Shimmering placeholders shaped like the content that's coming, so pages
 * transition into something that already looks right.
 *   'grid' – cover tiles · 'home' – greeting + shelves · 'series' – series page · 'list' – rows
 */
export function skeleton(kind = 'grid', count = 12) {
  const tiles = (n) => h('div.grid.sk-grid', Array.from({ length: n }, () => h('div.sk-tile', h('div.sk.sk-cover'), h('div.sk.sk-line'), h('div.sk.sk-line.short'))));
  const shelf = () => h('div.shelf', Array.from({ length: 8 }, () => h('div.sk-tile', h('div.sk.sk-cover'), h('div.sk.sk-line'))));
  let body;
  if (kind === 'home') {
    body = [h('div.sk.sk-title'), h('div.sk.sk-line.wide'), h('div.sk.sk-card'), h('div.sk.sk-heading'), shelf(), h('div.sk.sk-heading'), shelf()];
  } else if (kind === 'series') {
    body = [h('div.sk-series', h('div.sk.sk-cover.big'), h('div.sk-col', h('div.sk.sk-line.short'), h('div.sk.sk-title'), h('div.sk.sk-line'), h('div.sk.sk-pill'), h('div.sk.sk-block'))), h('div.sk.sk-heading'), tiles(6)];
  } else if (kind === 'list') {
    body = Array.from({ length: count }, () => h('div.sk-row', h('div.sk.sk-dot'), h('div.sk-col', h('div.sk.sk-line'), h('div.sk.sk-line.short'))));
  } else {
    body = [tiles(count)];
  }
  return h('div.skeleton', { 'aria-busy': 'true', 'aria-label': 'Loading' }, body);
}

export function emptyState(ic, title, text, action) {
  return h('div.empty', icon(ic), h('h2.title-large', title), text && h('p.body-medium', text), action);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  snackbar('Copied to clipboard');
}

export const STATUS_LABEL = { ongoing: 'Ongoing', completed: 'Completed', hiatus: 'On hiatus', cancelled: 'Cancelled', upcoming: 'Upcoming' };
export const USER_STATUS = [
  { value: 'reading', label: 'Reading', icon: 'auto_stories' },
  { value: 'plan', label: 'Plan to read', icon: 'schedule' },
  { value: 'completed', label: 'Completed', icon: 'task_alt' },
  { value: 'on_hold', label: 'On hold', icon: 'pause_circle' },
  { value: 'dropped', label: 'Dropped', icon: 'do_not_disturb_on' },
];
export const AGE_RATINGS = [
  { value: '', label: 'Unknown' },
  { value: 0, label: 'Everyone' },
  { value: 1, label: 'Teen (13+)' },
  { value: 2, label: 'Mature (17+)' },
  { value: 3, label: 'Adults only (18+)' },
];
