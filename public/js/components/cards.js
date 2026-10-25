// Series cards, volume cards and "continue reading" cards.

import { h, icon, cover, markHero, onContext, timeAgo } from '../ui.js';
import { seriesActions, bookActions } from './actions.js';

function moreButton(onOpen) {
  return h('button.more', {
    type: 'button',
    'aria-label': 'More actions',
    title: 'More actions',
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      onOpen(e.currentTarget);
    },
  }, icon('more_vert'));
}

export function seriesCard(s, { onChange } = {}) {
  const unread = s.count != null ? s.count - (s.readCount || 0) : null;
  const finished = s.count > 0 && unread === 0;
  const coverEl = cover({ ...s, title: s.name }, { finished, count: unread > 0 && s.count > 1 ? unread : undefined });
  const sub = [s.authors?.[0], s.count != null ? `${s.count} ${s.count === 1 ? 'item' : 'items'}` : null].filter(Boolean).join(' · ');
  const el = h('a.tile', { href: `#/series/${s.id}`, title: s.name, onclick: () => markHero(coverEl) },
    coverEl,
    moreButton((btn) => seriesActions(btn, s, { onChange })),
    h('div.t-title', s.name),
    h('div.t-sub', sub || s.libraryName || ''),
  );
  onContext(el, (at) => seriesActions(el, s, { onChange, at }));
  return el;
}

export function volumeCard(b, { series, onChange } = {}) {
  const p = b.progress;
  let sub;
  if (p?.finished) sub = 'Finished';
  else if (p && p.percent > 0) sub = `${Math.round(p.percent * 100)}% · ${timeAgo(p.updatedAt)}`;
  else if (b.pageCount) sub = `${b.pageCount} pages`;
  else sub = b.format.toUpperCase();
  const el = h('a.tile', { href: `#/read/${b.id}`, title: b.title },
    cover({ ...b, title: b.label }),
    moreButton((btn) => bookActions(btn, b, { series, onChange })),
    h('div.t-title', b.label),
    h('div.t-sub', sub),
  );
  onContext(el, (at) => bookActions(el, b, { series, onChange, at }));
  return el;
}

export function resumeCard(book) {
  const p = book.progress;
  const pct = Math.round((p?.percent || 0) * 100);
  const where = book.engine === 'pages' && book.pageCount && p?.page != null ? `Page ${p.page + 1} of ${book.pageCount}` : `${pct}%`;
  // The cover, blurred, tints the card behind the text.
  return h('a.resume-card', { href: `#/series/${book.seriesId}`, style: book.coverUrl && !book.blur ? { '--art': `url("${book.coverUrl}")` } : null },
    cover({ ...book, title: book.label }, { showProgress: false }),
    h('div.info',
      h('div.t', book.series || book.title),
      h('div.s', book.series && book.label !== book.series ? book.label : book.author || ''),
      h('div.s', `${where} · ${timeAgo(p?.updatedAt)}`),
      h('div.grow'),
      h('div.row',
        h('div.progress', h('span', { style: { width: `${pct}%` } })),
        h('button.icon-btn.filled.state', {
          type: 'button',
          title: 'Resume',
          'aria-label': `Resume ${book.title}`,
          onclick: (e) => {
            e.preventDefault();
            location.hash = `#/read/${book.id}`;
          },
        }, icon('play_arrow', 'filled')),
      ),
    ),
  );
}
