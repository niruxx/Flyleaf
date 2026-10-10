import { api } from '../api.js';
import { onLeave, isAdmin, navigate, render } from '../router.js';
import {
  h, icon, iconButton, topBar, leading, cover, menu, dialog, field, formError, snackbar, formatBytes, timeAgo, confirmDialog,
} from '../ui.js';

const FORMAT_LABEL = { epub: 'EPUB', pdf: 'PDF', cbz: 'CBZ', cbr: 'CBR', folder: 'Image folder' };

export async function bookView(view, params, stale) {
  const book = await api.book(params.id);
  if (stale()) return;

  const p = book.progress;
  const back = leading(iconButton('arrow_back', 'Back', () => (history.length > 1 ? history.back() : navigate('/library'))));
  const more = iconButton('more_vert', 'More options', () => {
    const items = [
      p?.finished
        ? { label: 'Mark as unread', icon: 'remove_done', onClick: () => setFinished(false) }
        : { label: 'Mark as read', icon: 'done_all', onClick: () => setFinished(true) },
    ];
    if (p && !p.finished) items.push({ label: 'Reset progress', icon: 'restart_alt', onClick: () => setFinished(false) });
    if (isAdmin()) {
      items.push('-',
        { label: 'Edit details', icon: 'edit', onClick: () => editDetails(book) },
        { label: 'Change cover', icon: 'image', onClick: () => changeCover(book) },
        { label: 'Re-read metadata from file', icon: 'refresh', onClick: refresh },
      );
    }
    menu(more, items);
  });
  const bar = topBar('', back, more);
  onLeave(bar.cleanup);
  const page = h('div.page');
  view.append(bar, page);

  async function setFinished(finished) {
    await api.setFinished(book.id, finished);
    snackbar(finished ? 'Marked as read' : 'Progress cleared');
    render();
  }
  async function refresh() {
    const ok = await confirmDialog({
      title: 'Re-read metadata?',
      message: 'Title, author, series and cover will be read from the file again. Manual edits for this book will be replaced.',
      confirm: 'Re-read',
    });
    if (!ok) return;
    try {
      await api.refreshBook(book.id);
      snackbar('Metadata refreshed');
      render();
    } catch (e) {
      snackbar(e.message);
    }
  }

  const pct = Math.round((p?.percent || 0) * 100);
  const isImage = ['cbz', 'cbr', 'folder'].includes(book.format) || book.format === 'pdf';
  let readLabel = 'Read';
  let readIcon = 'menu_book';
  if (p?.finished) {
    readLabel = 'Read again';
    readIcon = 'replay';
  } else if (p && p.percent > 0) {
    readLabel = isImage && p.page != null ? `Continue · page ${p.page + 1}` : `Continue · ${pct}%`;
    readIcon = 'play_arrow';
  }

  const readBtn = h('button.btn.filled.large.state', {
    type: 'button',
    onclick: async () => {
      if (p?.finished) await api.setFinished(book.id, false);
      navigate(`/read/${book.id}`);
    },
  }, icon(readIcon, 'filled'), readLabel);

  const metaChips = [
    FORMAT_LABEL[book.format],
    book.pageCount ? `${book.pageCount} pages` : null,
    book.size && book.format !== 'folder' ? formatBytes(book.size) : null,
  ].filter(Boolean);

  const desc = book.description ? h('p.description.clamped.body-large', book.description) : null;
  if (desc) desc.addEventListener('click', () => desc.classList.toggle('clamped'));

  page.append(
    h('div.detail-hero',
      cover(book, { showProgress: false }),
      h('div.info',
        book.series && h('a.series-link', { href: `#/series/${book.libraryId}/${encodeURIComponent(book.series)}` },
          icon('collections_bookmark'), `${book.series}${book.seriesIndex != null ? ` · #${book.seriesIndex}` : ''}`),
        h('h1.headline-medium', book.title),
        book.author && h('p.title-medium.muted', book.author),
        h('div.meta', metaChips.map((c) => h('span.chip', c))),
        book.missing && h('div.form-error', icon('warning'), h('span', 'This file is no longer in the library folder.')),
        p && !p.finished && p.percent > 0 && h('div.progress-row',
          h('div.progress', h('span', { style: { width: `${pct}%` } })),
          h('span.body-small.muted', `${pct}% · ${timeAgo(p.updatedAt)}`)),
        p?.finished && h('p.body-medium.muted', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, icon('check_circle', 'filled'), 'Finished'),
        h('div.actions', !book.missing && readBtn,
          !p?.finished && h('button.btn.tonal.state', { type: 'button', onclick: () => setFinished(true) }, icon('done_all'), 'Mark read')),
      ),
    ),
  );

  if (desc) {
    page.append(h('section.section', h('div.section-head', h('h2', 'About')), desc));
  }

  if (book.prev || book.next) {
    const navCard = (b, cls, label) =>
      b
        ? h(`a.${cls}.state`, { href: `#/book/${b.id}` }, cover(b, { showProgress: false }),
            h('div', { style: { minWidth: 0 } }, h('div.lbl', label), h('div.nm', b.title)))
        : h('div');
    page.append(
      h('section.section',
        h('div.section-head', h('h2', 'In this series'),
          h('a.btn.text.state', { href: `#/series/${book.libraryId}/${encodeURIComponent(book.series)}` }, `All ${book.seriesCount}`)),
        h('div.series-nav', navCard(book.prev, 'prev', 'Previous'), navCard(book.next, 'next', 'Next')),
      ),
    );
  }

  if (isAdmin()) {
    page.append(h('p.body-small.muted', { style: { marginTop: '32px', overflowWrap: 'anywhere' } }, book.relPath));
  }
}

async function editDetails(book) {
  const title = field('Title', { value: book.title, required: true });
  const author = field('Author', { value: book.author || '' });
  const series = field('Series', { value: book.series || '' });
  const index = field('Number in series', { value: book.seriesIndex ?? '', type: 'number', step: 'any', inputmode: 'decimal' });
  const desc = field('Description', { value: book.description || '', multiline: true });
  const err = h('div');
  const formId = `edit-${book.id}`;
  const form = h('form', {
    id: formId,
    onsubmit: async (e) => {
      e.preventDefault();
      err.replaceChildren();
      try {
        await api.updateBook(book.id, {
          title: title.input.value,
          author: author.input.value,
          series: series.input.value,
          seriesIndex: index.input.value,
          description: desc.input.value,
        });
        form.closest('dialog').close();
        snackbar('Details saved');
        render();
      } catch (e2) {
        err.append(formError(e2.message));
      }
    },
  }, err, title, author, series, index, desc);
  await dialog({
    title: 'Edit details',
    className: 'fullscreen-compact',
    content: form,
    actions: [{ label: 'Cancel' }, { label: 'Save', submit: formId, variant: 'filled' }],
  });
}

function changeCover(book) {
  const input = h('input', { type: 'file', accept: 'image/*' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      await api.setCover(book.id, file);
      snackbar('Cover updated');
      render();
    } catch (e) {
      snackbar(e.message);
    }
  });
  input.click();
}
