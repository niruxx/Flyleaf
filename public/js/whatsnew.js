// What's new: after an update, a small card with the newest CHANGELOG.md entries (once per
// version), and a page with the whole list (#/whats-new, also in the account menu).

import { api } from './api.js';
import { session, navigate } from './router.js';
import { h, icon, iconButton, button, loading, emptyState, stagger, pageBanner } from './ui.js';
import { t, currentLanguage } from './i18n.js';

/** Inline Markdown: **bold**, *italic*, `code` and [links](https://…), as DOM nodes (never HTML). */
export function inlineMd(text) {
  const out = document.createDocumentFragment();
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  for (const m of String(text).matchAll(re)) {
    out.append(text.slice(last, m.index));
    if (m[1] != null) out.append(h('strong', m[1]));
    else if (m[2] != null) out.append(h('em', m[2]));
    else if (m[3] != null) out.append(h('code', m[3]));
    else out.append(h('a', { href: m[5], target: '_blank', rel: 'noopener' }, m[4]));
    last = m.index + m[0].length;
  }
  out.append(text.slice(last));
  return out;
}

const niceDate = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(currentLanguage(), { year: 'numeric', month: 'long', day: 'numeric' }) : '');

async function markSeen(version) {
  if (!version || session.user?.prefs?.changelogSeen === version) return;
  session.user.prefs = await api.savePrefs({ changelogSeen: version }).catch(() => session.user.prefs);
}

let shown = false;

/**
 * Show the card if there's something you haven't seen. Not during first-run setup, and not over
 * an open book (it waits until you leave the reader).
 */
export async function maybeShowWhatsNew() {
  const user = session.user;
  if (shown || !user || user.prefs?.onboarded === false) return;
  if (location.hash.startsWith('#/read/')) {
    const later = () => {
      if (location.hash.startsWith('#/read/')) return;
      removeEventListener('hashchange', later);
      maybeShowWhatsNew();
    };
    addEventListener('hashchange', later);
    return;
  }
  let data;
  try {
    data = await api.changelog(5);
  } catch {
    return;
  }
  // Someone who used Flyleaf before "What's new" existed: show the newest version once.
  const list = data.seen ? data.unseen : data.entries.slice(0, 1);
  if (!list.length || shown) return;
  shown = true;
  showCard(list, data.latest);
}

function showCard(list, latest) {
  const [newest, ...older] = list;
  const items = newest.sections.flatMap((s) => s.items);
  const card = h('aside.whatsnew', { role: 'dialog', 'aria-label': t('What’s new') },
    h('div.wn-glow'),
    h('div.wn-head',
      h('span.wn-badge', icon('campaign', 'filled')),
      h('div.wn-titles',
        h('div.wn-eyebrow', t('Updated to {version}', { version: newest.version })),
        h('div.wn-title', t('What’s new'))),
      iconButton('close', t('Close'), () => close())),
    newest.summary && h('p.wn-summary', newest.summary),
    h('ul.wn-items', items.slice(0, 4).map((it) => h('li', inlineMd(it)))),
    (items.length > 4 || older.length > 0) && h('p.wn-more', [
      items.length > 4 ? t('…and {n} more', { n: items.length - 4 }) : null,
      older.length ? t('Also new since your last visit: {versions}', { versions: older.map((e) => e.version).join(', ') }) : null,
    ].filter(Boolean).join(' · ')),
    h('div.wn-actions',
      button(t('See everything'), { variant: 'text', onclick: () => {
        close();
        navigate('/whats-new');
      } }),
      button(t('Got it'), { variant: 'tonal', onclick: () => close() })));
  function close() {
    markSeen(latest);
    card.classList.add('leaving');
    setTimeout(() => card.remove(), 220);
  }
  document.body.append(card);
}

/** #/whats-new: every version, newest first. */
export async function whatsNewView(view, params, stale) {
  const page = h('div.page', { style: { maxWidth: '880px' } });
  view.append(page);
  page.append(loading());
  const data = await api.changelog(50);
  if (stale()) return;
  const banner = pageBanner({ icon: 'campaign', eyebrow: t('Flyleaf {version}', { version: data.latest }), title: t('What’s new'), sub: t('Recent changes, newest first') });
  page.replaceChildren(banner);
  if (!data.entries.length) {
    page.append(emptyState('campaign', t('Nothing here yet'), t('The changelog is empty.')));
    return;
  }
  const seen = data.seen;
  page.append(stagger(h('div.wn-page', data.entries.map((e, i) => {
    const isNew = seen ? data.unseen.some((u) => u.version === e.version) : i === 0;
    return h(`section.wn-version${isNew ? '.new' : ''}`,
      h('div.wn-version-head',
        h('h2', e.version),
        isNew && h('span.wn-new', t('New')),
        h('span.wn-date', niceDate(e.date))),
      e.summary && h('p.wn-version-summary', e.summary),
      e.sections.map((s) => h('div.wn-section',
        e.sections.length > 1 || s.title !== 'Added' ? h('h3', s.title) : null,
        h('ul', s.items.map((it) => h('li', inlineMd(it)))))));
  }))));
  markSeen(data.latest);
}
