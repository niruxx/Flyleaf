// Bookmarks, highlights and notes across the whole library.

import { api, pageUrl } from '../api.js';
import { h, icon, iconButton, button, menu, store, cover, loading, emptyState, stagger, pageHeader, timeAgo, segmented, snackbar, confirmDialog, formDialog, field } from '../ui.js';

const EXPORTS = [
  { format: 'markdown', label: 'Markdown (.md)', icon: 'description' },
  { format: 'obsidian', label: 'Obsidian vault (one note per book)', icon: 'hub' },
  { format: 'csv', label: 'Spreadsheet (.csv)', icon: 'table_view' },
  { format: 'readwise', label: 'Readwise import file (.csv)', icon: 'upload_file' },
];

function saveFile(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

/** Send highlights to Readwise with the reader's own access token (remembered on this device). */
async function sendToReadwise(bookId) {
  let saved = '';
  try {
    saved = localStorage.getItem('flyleaf.readwiseToken') || '';
  } catch {}
  const token = field('Readwise access token', { value: saved, required: true, autocomplete: 'off', support: 'Get it at readwise.io/access_token. It’s kept on this device only. Highlights Readwise already has are skipped.' });
  await formDialog({
    title: 'Send to Readwise',
    icon: 'send',
    fields: [token],
    submit: 'Send',
    onSubmit: async () => {
      const r = await api.sendToReadwise(token.input.value.trim(), bookId);
      try {
        localStorage.setItem('flyleaf.readwiseToken', token.input.value.trim());
      } catch {}
      snackbar(`Sent ${r.sent} ${r.sent === 1 ? 'highlight' : 'highlights'} from ${r.books} ${r.books === 1 ? 'book' : 'books'} to Readwise`, { duration: 5000 });
    },
  });
}

/** The export menu: every book, or one (bookId). */
export function exportMenu(anchor, bookId) {
  menu(anchor, [
    ...EXPORTS.map((e) => ({ label: e.label, icon: e.icon, onClick: () => saveFile(api.annotationsExportUrl(e.format, bookId)) })),
    '-',
    { label: 'Send to Readwise…', icon: 'send', onClick: () => sendToReadwise(bookId) },
  ]);
}

export const HIGHLIGHT_COLORS = {
  yellow: '#f5d34f',
  green: '#7ad38a',
  blue: '#7ab8f5',
  pink: '#f59ac2',
  purple: '#b79cf5',
  underline: '#9aa0a6',
};

const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'title', label: 'Book title A–Z' },
  { value: 'position', label: 'Position in book' },
];
const time = (a) => Number(a.updatedAt || a.createdAt) || 0;
const position = (a) => (a.percent != null ? a.percent : a.page != null ? a.page / 1e6 : 0);
const bookName = (b) => String(b.series || b.title || '').replace(/^(the|an|a)\s+/i, '');

export async function bookmarksView(view, params, stale) {
  const page = h('div.page', { style: { maxWidth: '980px' } });
  view.append(page);
  let kind = params.query.get('kind') || '';
  let sort = SORTS.some((s) => s.value === store.get('bookmarks.sort')) ? store.get('bookmarks.sort') : 'newest';
  let list = [];
  const body = h('div');
  const sortLabel = h('span', SORTS.find((s) => s.value === sort).label);
  const sortBtn = button(sortLabel, { variant: 'text', icon: 'sort' });
  sortBtn.addEventListener('click', () => menu(sortBtn, SORTS.map((s) => ({
    label: s.label,
    checked: s.value === sort,
    onClick: () => {
      sort = s.value;
      store.set('bookmarks.sort', sort);
      sortLabel.textContent = s.label;
      draw();
    },
  }))));
  page.append(
    pageHeader('Bookmarks & notes', (() => {
      const b = button('Export', { variant: 'tonal', icon: 'ios_share' });
      b.addEventListener('click', () => exportMenu(b));
      return b;
    })()),
    h('div.toolbar.enter', { style: { marginBottom: '16px' } }, segmented([
      { value: '', label: 'All', icon: 'select_all' },
      { value: 'bookmark', label: 'Bookmarks', icon: 'bookmark' },
      { value: 'highlight', label: 'Highlights', icon: 'ink_highlighter' },
    ], kind, (v) => {
      kind = v;
      load();
    }), h('div.spacer'), sortBtn),
    body,
  );

  async function load() {
    body.replaceChildren(loading());
    list = await api.annotations(kind || undefined);
    if (stale()) return;
    draw();
  }

  function draw() {
    if (!list.length) {
      body.replaceChildren(emptyState('bookmarks', 'Nothing saved yet', 'While reading, tap the bookmark button to save a page, or select text in an ebook to highlight it and add a note.'));
      return;
    }
    // Group by book, then order the books and the notes inside each one.
    const groups = new Map();
    for (const a of list) {
      if (!groups.has(a.book.id)) groups.set(a.book.id, { book: a.book, items: [] });
      groups.get(a.book.id).items.push(a);
    }
    const sorted = [...groups.values()];
    for (const g of sorted) {
      g.items.sort(sort === 'newest' ? (a, b) => time(b) - time(a) : sort === 'oldest' ? (a, b) => time(a) - time(b) : (a, b) => position(a) - position(b));
      g.newest = Math.max(...g.items.map(time));
      g.oldest = Math.min(...g.items.map(time));
    }
    if (sort === 'title') sorted.sort((a, b) => bookName(a.book).localeCompare(bookName(b.book), undefined, { numeric: true, sensitivity: 'base' }));
    else if (sort === 'oldest') sorted.sort((a, b) => a.oldest - b.oldest);
    else sorted.sort((a, b) => b.newest - a.newest);
    body.replaceChildren(
      stagger(h('div', sorted.map(({ book, items }) =>
        h('section', { style: { marginBottom: '28px' } },
          h('a', { href: `#/series/${book.seriesId}`, style: { display: 'flex', alignItems: 'center', gap: '12px', textDecoration: 'none', color: 'inherit', marginBottom: '10px' } },
            h('div', { style: { width: '36px' } }, cover(book, { showProgress: false })),
            h('div', { style: { flex: '1', minWidth: '0' } }, h('div.title-medium', book.series || book.title), book.series && book.series !== book.title && h('div.body-small.muted', book.title)),
            (() => {
              const b = iconButton('ios_share', 'Export this book’s notes', (e) => {
                e.preventDefault();
                e.stopPropagation();
                exportMenu(b, book.id);
              });
              return b;
            })()),
          items.map((a) => annotationRow(a, book, load)),
        ),
      ))),
    );
  }
  await load();
}

export function annotationRow(a, book, onChange, { onOpen } = {}) {
  const href = `#/read/${book.id}?loc=${encodeURIComponent(a.locator)}`;
  const thumb = a.kind === 'bookmark' && a.page != null && book.format !== 'pdf' && !['epub', 'mobi', 'azw3', 'fb2', 'txt'].includes(book.format)
    ? h('div.thumb', h('div.cover', h('img.loaded', { src: pageUrl(book, a.page, 160), alt: '', loading: 'lazy' })))
    : null;
  const where = a.kind === 'bookmark'
    ? [a.page != null ? `Page ${a.page + 1}` : a.percent != null ? `${Math.round(a.percent * 100)}%` : null, a.chapter].filter(Boolean).join(' · ')
    : a.chapter || '';
  const el = h('a.annot', { href, style: { '--hl': a.kind === 'highlight' ? HIGHLIGHT_COLORS[a.color] || HIGHLIGHT_COLORS.yellow : 'var(--md-tertiary)' }, onclick: onOpen ? (e) => { e.preventDefault(); onOpen(a); } : null },
    thumb || h('div.swatch-bar'),
    h('div.body',
      h('div.label-medium', { style: { display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--md-on-surface-variant)' } },
        icon(a.kind === 'bookmark' ? 'bookmark' : 'ink_highlighter'), a.kind === 'bookmark' ? 'Bookmark' : 'Highlight', '·', timeAgo(a.updatedAt)),
      a.text && h('div.quote', `“${a.text}”`),
      a.note && h('div.note', a.note),
      where && h('div.where', where),
    ),
    h('div', { style: { display: 'flex', flexDirection: 'column' } },
      iconButton('edit_note', a.note ? 'Edit note' : 'Add note', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const note = field('Note', { value: a.note || '', multiline: true });
        await formDialog({ title: a.note ? 'Edit note' : 'Add note', fields: [note], onSubmit: () => api.updateAnnotation(a.id, { note: note.input.value }) });
        onChange?.();
      }),
      iconButton('delete', 'Delete', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!(await confirmDialog({ title: 'Delete this?', message: a.text ? `“${a.text.slice(0, 120)}”` : 'This bookmark will be removed.', confirm: 'Delete', danger: true }))) return;
        await api.deleteAnnotation(a.id);
        snackbar('Deleted');
        onChange?.();
      }),
    ),
  );
  return el;
}
