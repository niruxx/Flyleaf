import { t, plural } from '../i18n.js';
// Bookmarks, highlights and notes across the whole library.

import { api, pageUrl } from '../api.js';
import { h, icon, iconButton, button, menu, store, cover, loading, emptyState, stagger, pageHeader, timeAgo, segmented, snackbar, confirmDialog, formDialog, field } from '../ui.js';

const EXPORTS = [
  { format: 'markdown', get label() { return t('Markdown (.md)'); }, icon: 'description' },
  { format: 'obsidian', get label() { return t('Obsidian vault (one note per book)'); }, icon: 'hub' },
  { format: 'csv', get label() { return t('Spreadsheet (.csv)'); }, icon: 'table_view' },
  { format: 'readwise', get label() { return t('Readwise import file (.csv)'); }, icon: 'upload_file' },
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
  const token = field(t('Readwise access token'), { value: saved, required: true, autocomplete: 'off', support: t('Get it at readwise.io/access_token. It’s kept on this device only. Highlights Readwise already has are skipped.') });
  await formDialog({
    title: t('Send to Readwise'),
    icon: 'send',
    fields: [token],
    submit: t('Send'),
    onSubmit: async () => {
      const r = await api.sendToReadwise(token.input.value.trim(), bookId);
      try {
        localStorage.setItem('flyleaf.readwiseToken', token.input.value.trim());
      } catch {}
      snackbar(plural(r.sent, 'Sent {sent} highlight from {books} {value2} to Readwise', 'Sent {sent} highlights from {books} {value2} to Readwise', { sent: r.sent, books: r.books, value2: r.books === 1 ? 'book' : 'books' }), { duration: 5000 });
    },
  });
}

/** The export menu: every book, or one (bookId). */
export function exportMenu(anchor, bookId) {
  menu(anchor, [
    ...EXPORTS.map((e) => ({ label: e.label, icon: e.icon, onClick: () => saveFile(api.annotationsExportUrl(e.format, bookId)) })),
    '-',
    { label: t('Send to Readwise…'), icon: 'send', onClick: () => sendToReadwise(bookId) },
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
  { value: 'newest', get label() { return t('Newest first'); } },
  { value: 'oldest', get label() { return t('Oldest first'); } },
  { value: 'title', get label() { return t('Book title A–Z'); } },
  { value: 'position', get label() { return t('Position in book'); } },
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
    pageHeader(t('Bookmarks & notes'), (() => {
      const b = button(t('Export'), { variant: 'tonal', icon: 'ios_share' });
      b.addEventListener('click', () => exportMenu(b));
      return b;
    })()),
    h('div.toolbar.enter', { style: { marginBottom: '16px' } }, segmented([
      { value: '', label: t('All'), icon: 'select_all' },
      { value: 'bookmark', label: t('Bookmarks'), icon: 'bookmark' },
      { value: 'highlight', label: t('Highlights'), icon: 'ink_highlighter' },
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
      body.replaceChildren(emptyState('bookmarks', t('Nothing saved yet'), t('While reading, tap the bookmark button to save a page, or select text in an ebook to highlight it and add a note.')));
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
              const b = iconButton('ios_share', t('Export this book’s notes'), (e) => {
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
    ? [a.page != null ? t('Page {value}', { value: a.page + 1 }) : a.percent != null ? `${Math.round(a.percent * 100)}%` : null, a.chapter].filter(Boolean).join(' · ')
    : a.chapter || '';
  const el = h('a.annot', { href, style: { '--hl': a.kind === 'highlight' ? HIGHLIGHT_COLORS[a.color] || HIGHLIGHT_COLORS.yellow : 'var(--md-tertiary)' }, onclick: onOpen ? (e) => { e.preventDefault(); onOpen(a); } : null },
    thumb || h('div.swatch-bar'),
    h('div.body',
      h('div.label-medium', { style: { display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--md-on-surface-variant)' } },
        icon(a.kind === 'bookmark' ? 'bookmark' : 'ink_highlighter'), a.kind === 'bookmark' ? t('Bookmark') : t('Highlight'), '·', timeAgo(a.updatedAt)),
      a.text && h('div.quote', `“${a.text}”`),
      a.note && h('div.note', a.note),
      where && h('div.where', where),
    ),
    h('div', { style: { display: 'flex', flexDirection: 'column' } },
      iconButton('edit_note', a.note ? t('Edit note') : t('Add note'), async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const note = field(t('Note'), { value: a.note || '', multiline: true });
        await formDialog({ title: a.note ? t('Edit note') : t('Add note'), fields: [note], onSubmit: () => api.updateAnnotation(a.id, { note: note.input.value }) });
        onChange?.();
      }),
      iconButton('delete', t('Delete'), async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!(await confirmDialog({ title: t('Delete this?'), message: a.text ? `“${a.text.slice(0, 120)}”` : t('This bookmark will be removed.'), confirm: t('Delete'), danger: true }))) return;
        await api.deleteAnnotation(a.id);
        snackbar(t('Deleted'));
        onChange?.();
      }),
    ),
  );
  return el;
}
