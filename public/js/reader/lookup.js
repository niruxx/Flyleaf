// Look up selected text in an ebook: a definition (Wiktionary), a Wikipedia summary, or a
// translation. Results come through the Flyleaf server (see server/routes/lookup.js).

import { api } from '../api.js';
import { h, icon, iconButton, segmented, copyText } from '../ui.js';
import { t, currentLanguage } from '../i18n.js';

const LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'tr', 'ar', 'he', 'hi', 'ja', 'ko', 'zh', 'sv', 'da', 'no', 'fi', 'cs', 'el', 'ro', 'hu', 'id', 'vi', 'th'];
const base = (l) => String(l || '').toLowerCase().split(/[-_]/)[0];
const langName = (code) => {
  try {
    return new Intl.DisplayNames([currentLanguage()], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
};
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
const outLink = (href, label) => h('a.lk-out', { href, target: '_blank', rel: 'noopener' }, label, icon('open_in_new'));

let current = null;
export function closeLookup() {
  current?.();
  current = null;
}

/**
 * Open the look-up pop-up for `text` (from a book in `bookLang`), near the selection
 * ({ x, y, bottom } in page coordinates), inside the reader's `root`.
 */
export function openLookup({ text, bookLang, at, root, tab: initialTab }) {
  closeLookup();
  const words = text.trim().split(/\s+/).length;
  const source = base(bookLang);
  const from = source || 'en';
  const tabs = [
    words <= 3 && { value: 'define', label: t('Define'), icon: 'dictionary' },
    { value: 'wiki', label: 'Wikipedia', icon: 'travel_explore' },
    { value: 'translate', label: t('Translate'), icon: 'translate' },
  ].filter(Boolean);
  const body = h('div.lk-body');
  const show = (tab) => {
    store.set('flyleaf.lookupTab', tab);
    const panel = h('div', h('div.lk-loading', h('div.spinner')));
    body.replaceChildren(panel);
    ({ define, wiki, translate })[tab](panel).catch((e) => panel.replaceChildren(h('p.lk-error', e.message || t('Couldn’t look that up.'))));
  };
  const remembered = initialTab || store.get('flyleaf.lookupTab');
  const first = tabs.some((x) => x.value === remembered) ? remembered : tabs[0].value;
  const seg = segmented(tabs, first, show);
  seg.classList.add('compact');

  async function define(panel) {
    const r = await api.lookupDefine(text, from);
    if (!r.entries.length) {
      panel.replaceChildren(h('p.lk-empty', t('No definition found for “{word}”.', { word: r.word })), outLink(r.url, t('Search Wiktionary')));
      return;
    }
    panel.replaceChildren(
      h('div.lk-word', r.word),
      ...r.entries.map((e) => h('div.lk-entry',
        h('div.lk-pos', [e.partOfSpeech, e.language].filter(Boolean).join(' · ')),
        h('ol', e.definitions.map((d) => h('li', d.text, d.examples.map((x) => h('div.lk-example', x))))))),
      outLink(r.url, 'Wiktionary'));
  }

  function wiki(panel) {
    const query = h('input.lk-select', { type: 'search', value: text.slice(0, 200), maxlength: 200, required: true,
      'aria-label': t('Search Wikipedia'), placeholder: t('Search Wikipedia') });
    const result = h('div');
    let searchId = 0;
    async function search() {
      const value = query.value.trim();
      if (!value) return;
      const id = ++searchId;
      result.replaceChildren(h('div.lk-loading', h('div.spinner')));
      try {
        const r = await api.lookupWiki(value, from);
        if (id !== searchId) return;
        const p = r.result;
        if (p) result.replaceChildren(h('div',
          p.thumbnail && h('img.lk-thumb', { src: p.thumbnail, alt: '', referrerpolicy: 'no-referrer' }),
          h('div.lk-word', p.title), p.description && h('div.lk-pos', p.description),
          h('p.lk-extract', p.extract), outLink(p.url, t('Read on Wikipedia'))));
        else result.replaceChildren(h('p.lk-empty', t('Wikipedia has no article for “{q}”.', { q: value.slice(0, 80) })),
          outLink(r.searchUrl, t('Search Wikipedia')));
      } catch (error) {
        if (id === searchId) result.replaceChildren(h('p.lk-error', error.message));
      }
    }
    panel.replaceChildren(h('form.lk-langs', { onsubmit: (e) => { e.preventDefault(); search(); } }, query,
      h('button.icon-btn.state', { type: 'submit', 'aria-label': t('Search Wikipedia') }, icon('search'))), result);
    return search();
  }

  async function translate(panel) {
    let to = store.get('flyleaf.translateTo') || base(currentLanguage()) || base(navigator.language) || 'en';
    if (to === source) to = source === 'en' ? 'es' : 'en';
    const pick = h('select.lk-select', { 'aria-label': t('Translate into') },
      [...new Set([to, ...LANGS])].filter((c) => c !== source).map((c) => h('option', { value: c, selected: c === to }, langName(c))));
    const out = h('div.lk-translation', h('div.lk-loading', h('div.spinner')));
    const external = () => outLink('https://www.deepl.com/translator', t('Open in DeepL'));
    let requestId = 0;
    const run = async () => {
      const id = ++requestId;
      store.set('flyleaf.translateTo', pick.value);
      out.replaceChildren(h('div.lk-loading', h('div.spinner')));
      try {
        const r = await api.lookupTranslate(text, source || undefined, pick.value);
        if (id !== requestId) return;
        out.replaceChildren(h('div', r.provider && h('div.lk-pos', r.provider), h('p.lk-extract', r.text), h('div.lk-actions',
          h('button.btn.text.state', { type: 'button', onclick: () => copyText(r.text) }, icon('content_copy'), t('Copy')), external())));
      } catch (e) {
        if (id === requestId) out.replaceChildren(h('p.lk-error', e.message), external());
      }
    };
    pick.addEventListener('change', run);
    panel.replaceChildren(h('div.lk-langs', h('span', source ? langName(source) : t('Detect language')), icon('arrow_forward'), pick), h('p.lk-source', text.slice(0, 500)), out);
    await run();
  }

  const pop = h('div.fn-pop.lk-pop', { role: 'dialog', 'aria-label': t('Look up') },
    h('div.fn-head', seg, h('span', { style: { flex: '1' } }), iconButton('close', t('Close'), () => closeLookup())),
    body);
  root.append(pop);
  if (innerWidth >= 600) {
    const w = Math.min(460, innerWidth - 32);
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(16, Math.min(innerWidth - w - 16, at.x - w / 2))}px`;
    if (innerHeight - at.bottom > 340) pop.style.top = `${at.bottom + 12}px`;
    else pop.style.bottom = `${Math.max(16, innerHeight - at.y + 12)}px`;
  } else pop.classList.add('sheet-like');

  const onKey = (ev) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    closeLookup();
  };
  const onDown = (ev) => !pop.contains(ev.target) && closeLookup();
  window.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
  const cleanup = current = () => {
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown);
    pop.classList.add('leaving');
    setTimeout(() => pop.remove(), 160);
  };
  show(first);
  return () => {
    if (current === cleanup) closeLookup();
  };
}
