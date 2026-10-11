// "Details" for one book or volume: file, metadata and your reading history.

import { api, can, downloadUrl } from '../api.js';
import { session, navigate, isAdmin } from '../router.js';
import { h, icon, button, cover, dialog, formatBytes, formatDuration, timeAgo, copyText, loading } from '../ui.js';

const FORMAT_LABEL = {
  epub: 'EPUB', mobi: 'MOBI', azw3: 'AZW3', fb2: 'FB2', txt: 'Plain text', docx: 'Word (DOCX)', rtf: 'Rich text (RTF)', pdf: 'PDF',
  cbz: 'Comic archive (CBZ)', cbr: 'Comic archive (CBR)', cb7: 'Comic archive (CB7)', cbt: 'Comic archive (CBT)', folder: 'Image folder',
};
const LANGS = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' });
  } catch {
    return null;
  }
})();
const language = (code) => {
  if (!code) return null;
  try {
    return LANGS?.of(code) || code;
  } catch {
    return code;
  }
};
const date = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const day = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

/** Circular progress that sweeps to its value. */
function ring(percent) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = Math.round(percent * 100);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 80 80');
  for (const cls of ['ring-track', 'ring-arc']) {
    const circle = document.createElementNS(NS, 'circle');
    for (const [k, v] of Object.entries({ class: cls, cx: 40, cy: 40, r })) circle.setAttribute(k, v);
    svg.append(circle);
  }
  const arc = svg.lastChild;
  arc.style.strokeDasharray = `${c}`;
  arc.style.strokeDashoffset = `${c}`;
  requestAnimationFrame(() => requestAnimationFrame(() => (arc.style.strokeDashoffset = `${c * (1 - percent)}`)));
  return h('div.ring', svg, h('div.ring-label', h('strong', `${pct}%`), h('span', pct >= 100 ? 'finished' : 'read')));
}

function facts(rows) {
  return h('div.info-facts', rows.filter(Boolean).map(([k, v, opts = {}]) =>
    h('div.info-fact', h('div.k', k), h('div.v', opts.mono ? h('span.mono', v) : v, opts.copy && h('button.copy-mini', { type: 'button', title: 'Copy', onclick: () => copyText(opts.copy) }, icon('content_copy'))))));
}

export async function showBookInfo(bookId) {
  const body = h('div.book-info', loading());
  await dialog({
    title: null,
    className: 'wide fullscreen-compact info-dialog',
    content: body,
    onOpen: async (dlg, close) => {
      let b;
      try {
        b = await api.bookInfo(bookId);
      } catch (e) {
        body.replaceChildren(h('div.form-error', icon('error'), e.message), h('div.dialog-actions', button('Close', { variant: 'text', onclick: () => close() })));
        return;
      }
      body.replaceChildren(render(b, close));
    },
  });
}

function render(b, close) {
  const r = b.reading;
  const m = b.meta;
  const writers = (m.people || []).filter((p) => /writer|author|story/i.test(p.role)).map((p) => p.name);
  const artists = (m.people || []).filter((p) => !/writer|author|story/i.test(p.role)).map((p) => `${p.name}${p.role ? ` (${p.role})` : ''}`);
  const started = r.percent > 0 || r.seconds > 0;
  const readLabel = r.finished ? 'Read again' : started ? 'Continue' : 'Read';

  const chips = [
    h('span.mini-chip', icon('description'), FORMAT_LABEL[b.format] || b.format.toUpperCase()),
    b.pageCount ? h('span.mini-chip', icon('auto_stories'), `${b.pageCount} pages`) : null,
    b.size ? h('span.mini-chip', icon('hard_drive'), formatBytes(b.size)) : null,
    language(m.language) && h('span.mini-chip', icon('translate'), language(m.language)),
  ];

  const readingFacts = facts([
    ['Started', r.startedAt ? date(r.startedAt) : 'Not yet'],
    ['Last read', r.lastReadAt ? timeAgo(r.lastReadAt) : '—'],
    ['Time spent', r.seconds ? formatDuration(r.seconds) : '—'],
    ['Reading days', r.days ? `${r.days} ${r.days === 1 ? 'day' : 'days'}${r.firstDay && r.firstDay !== r.lastDay ? ` · ${day(r.firstDay)} – ${day(r.lastDay)}` : ''}` : '—'],
    r.remainingSeconds && ['Time left', `about ${formatDuration(r.remainingSeconds)} at your pace`],
    b.engine === 'pages' && r.page != null && b.pageCount && ['Position', `Page ${r.page + 1} of ${b.pageCount}`],
    ['Highlights & notes', String(r.highlights)],
    ['Bookmarks', String(r.bookmarks)],
  ]);

  const metaFacts = facts([
    b.series && ['Series', b.series],
    b.volume != null && ['Volume', String(b.volume)],
    b.chapter != null && ['Chapter', String(b.chapter)],
    writers.length && ['Written by', writers.join(', ')],
    artists.length && ['Art & more', artists.join(', ')],
    m.publisher && ['Publisher', m.publisher],
    m.year && ['Published', String(m.year)],
    m.isbn && ['ISBN', h('a', { href: `https://openlibrary.org/isbn/${m.isbn}`, target: '_blank', rel: 'noopener noreferrer' }, m.isbn), { copy: m.isbn }],
    m.ageRating && ['Age rating', m.ageRating],
  ]);

  const fileFacts = facts([
    ['File name', b.file.name, { mono: true, copy: b.file.name }],
    isAdmin() && b.file.path && ['Location', b.file.path, { mono: true, copy: b.file.path }],
    !isAdmin() && ['Folder', b.file.relPath.split(/[\\/]/).slice(0, -1).join('/') || '/', { mono: true }],
    b.library && ['Library', h('a', { href: `#/library/${b.library.id}`, onclick: () => close() }, b.library.name)],
    ['Format', FORMAT_LABEL[b.format] || b.format],
    ['Size', b.size ? `${formatBytes(b.size)} (${b.size.toLocaleString()} bytes)` : '—'],
    ['Added', `${date(b.file.addedAt)} · ${timeAgo(b.file.addedAt)}`],
    ['File modified', date(b.file.modifiedAt)],
  ]);

  const genres = [...(m.genres || []), ...(m.tags || [])].slice(0, 16);

  return h('div.info-body',
    h('div.info-top',
      cover({ ...b, title: b.label }, { showProgress: false }),
      h('div.info-headline',
        b.series && b.series !== b.title && h('a.label-large.info-series', { href: `#/series/${b.seriesId}`, onclick: () => close() }, b.series),
        h('h2.headline-small', b.title),
        writers.length > 0 && h('p.title-small.muted', writers.join(', ')),
        h('div.info-chips', chips),
        h('div.info-actions',
          button(readLabel, { icon: r.finished ? 'replay' : 'play_arrow', onclick: () => {
            close();
            navigate(`/read/${b.id}`);
          } }),
          can(session.user, 'download') && h('a.btn.tonal.state', { href: downloadUrl(b), download: '' }, icon('download'), 'Download'),
        ),
      ),
      ring(r.finished ? 1 : r.percent),
    ),
    b.description && h('p.body-medium.info-desc', b.description),
    genres.length > 0 && h('div.chip-set.info-genres', genres.map((g) => h('span.chip.static', g))),
    h('div.info-grid',
      h('section.info-card', h('h3', icon('schedule'), 'Your reading'), readingFacts),
      metaFacts.children.length > 0 && h('section.info-card', h('h3', icon('library_books'), 'About this book'), metaFacts),
      h('section.info-card.wide', h('h3', icon('folder_open'), 'File'), fileFacts),
    ),
    h('div.dialog-actions', button('Close', { variant: 'text', onclick: () => close() })),
  );
}
