import { h, icon, button } from '../ui.js';
import { t } from '../i18n.js';

export function spoilerGuard(book, index, build, { list = false, onReveal } = {}) {
  // The actual title, artwork URL and title attributes never enter the placeholder DOM.
  const label = book.chapter != null ? t('Chapter {n}', { n: book.chapter }) : book.volume != null ? t('Volume {n}', { n: book.volume }) : t('Book {n}', { n: index + 1 });
  const root = h(`div.spoiler-guard${list ? '.as-list' : ''}`,
    h('div.spoiler-placeholder', { 'aria-hidden': 'true' }, icon('visibility_off')),
    h('div.spoiler-copy', h('h3.title-small', label), h('p.body-small.muted', t('Future title and cover hidden')),
      button(t('Reveal'), { variant: 'outlined', icon: 'visibility', 'aria-label': t('Reveal {title}', { title: label }), onclick: () => { onReveal?.(); root.replaceChildren(build()); root.className = 'spoiler-revealed'; root.querySelector('a, button')?.focus(); } }),
      h('a.btn.text.state', { href: `#/read/${book.id}`, 'aria-label': t('Read {title}', { title: label }) }, icon('play_arrow'), t('Read'))));
  return root;
}
