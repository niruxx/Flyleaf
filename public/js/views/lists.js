// Reading lists: books from any series in a set order (comic events and reading orders),
// made by hand or imported from ComicRack .cbl files.

import { api } from '../api.js';
import { isAdmin, navigate, render } from '../router.js';
import { h, icon, iconButton, button, cover, loading, emptyState, stagger, pageBanner, snackbar, confirmDialog, formDialog, field, timeAgo } from '../ui.js';
import { newReadingList } from '../components/actions.js';
import { refreshShell } from '../shell.js';

/** Pick a .cbl file and import it. */
function importCbl() {
  const input = h('input', { type: 'file', accept: '.cbl,application/xml,text/xml', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    try {
      const r = await api.importCbl(file);
      snackbar(r.unmatched
        ? `Imported “${r.name}”: ${r.matched} of ${r.total} found in your libraries`
        : `Imported “${r.name}” – all ${r.total} found`, { duration: 6000 });
      refreshShell();
      navigate(`/reading-list/${r.id}`);
    } catch (e) {
      snackbar(e.message, { duration: 6000 });
    }
  });
  document.body.append(input);
  input.click();
}

export async function readingListsView(view, params, stale) {
  const page = h('div.page');
  view.append(page);
  page.append(loading());
  const lists = await api.readingLists();
  if (stale()) return;
  const banner = pageBanner({
    icon: 'format_list_numbered',
    eyebrow: 'Reading lists',
    title: 'Reading lists',
    sub: 'Read across series in order – events, crossovers and reading orders',
    actions: [
      button('New list', { variant: 'tonal', icon: 'add', onclick: async () => {
        const id = await newReadingList();
        if (id) navigate(`/reading-list/${id}`);
      } }),
      button('Import .cbl', { variant: 'text', icon: 'upload_file', onclick: importCbl }),
    ],
  });
  banner.setArt(lists.flatMap((l) => l.covers).slice(0, 5));
  page.replaceChildren(banner);
  if (!lists.length) {
    page.append(emptyState('format_list_numbered', 'No reading lists yet',
      'Make one from any book or series menu (“Add to reading list”), or import a ComicRack .cbl reading order – the kind Kavita, Komga and the CBL community share for events like Civil War or Secret Wars.'));
    return;
  }
  page.append(stagger(h('div.rl-grid', lists.map(listCard))));
}

function listCard(l) {
  const pct = l.count ? l.read / l.count : 0;
  return h('a.rl-card.state', { href: `#/reading-list/${l.id}` },
    h('div.rl-art', l.covers.length ? l.covers.slice(0, 4).map((url, i) => h('span', { style: { '--i': String(i), backgroundImage: `url("${url}")` } })) : icon('format_list_numbered')),
    h('div.rl-body',
      h('div.rl-name', l.promoted ? [icon('public'), ' ', l.name] : l.name),
      h('div.rl-meta', `${l.count} ${l.count === 1 ? 'book' : 'books'}${l.read ? ` · ${l.read} read` : ''}${l.owned ? '' : ' · shared'}${l.source === 'cbl' ? ' · from .cbl' : ''}`),
      h('div.progress.rl-progress', h('span', { style: { width: `${pct * 100}%` } }))));
}

export async function readingListView(view, params, stale) {
  const page = h('div.page');
  view.append(page);
  page.append(loading());
  let l;
  try {
    l = await api.readingList(params.id);
  } catch {
    page.replaceChildren(emptyState('search_off', 'Reading list not found', 'It may have been deleted.', h('a.btn.tonal', { href: '#/reading-lists' }, 'All reading lists')));
    return;
  }
  if (stale()) return;
  const reload = () => render();
  const next = l.books.find((b) => b.id === l.nextBookId);
  const open = (b) => navigate(`/read/${b.id}?list=${l.id}`);

  const actions = [
    next && button(l.read ? 'Continue' : 'Start reading', { icon: 'play_arrow', onclick: () => open(next) }),
    l.owned && iconButton('edit', 'Edit reading list', async () => {
      const name = field('Name', { value: l.name, required: true });
      const summary = field('Description', { value: l.summary || '', multiline: true });
      const shared = h('input', { type: 'checkbox', checked: l.promoted });
      await formDialog({
        title: 'Edit reading list',
        icon: 'edit',
        fields: [name, summary, isAdmin() && h('label.check', shared, 'Share with all users')],
        onSubmit: () => api.updateReadingList(l.id, { name: name.input.value, summary: summary.input.value, promoted: shared.checked }),
      });
      refreshShell();
      reload();
    }),
    iconButton('download', 'Export as .cbl', () => {
      const a = h('a', { href: api.readingListCblUrl(l.id), download: '' });
      document.body.append(a);
      a.click();
      a.remove();
    }),
    l.owned && iconButton('delete', 'Delete reading list', async () => {
      if (!(await confirmDialog({ title: `Delete “${l.name}”?`, message: 'The books stay in your libraries.', confirm: 'Delete', danger: true, icon: 'delete' }))) return;
      await api.deleteReadingList(l.id);
      refreshShell();
      navigate('/reading-lists', { replace: true });
    }),
  ];
  const banner = pageBanner({
    icon: 'format_list_numbered',
    eyebrow: l.promoted ? 'Shared reading list' : 'Reading list',
    title: l.name,
    sub: [l.summary, `${l.count} ${l.count === 1 ? 'book' : 'books'} · ${l.read} read`].filter(Boolean).join(' · '),
    actions,
  });
  banner.setArt(l.covers);
  page.replaceChildren(banner);

  if (l.unmatched.length) {
    const details = h('details.rl-unmatched',
      h('summary', icon('help'), `${l.unmatched.length} ${l.unmatched.length === 1 ? 'entry' : 'entries'} from the .cbl aren’t in your libraries`),
      h('ul', l.unmatched.slice(0, 200).map((e) => h('li', [e.series, e.number != null && e.number !== '' ? `#${e.number}` : null, e.volume ? `(${e.volume})` : null].filter(Boolean).join(' ')))),
      l.owned && h('div.rl-unmatched-actions',
        button('Look again', { variant: 'text', icon: 'refresh', onclick: async () => {
          const r = await api.rematchReadingList(l.id);
          snackbar(r.matched ? `Found ${r.matched} more` : 'Still not found');
          if (r.matched) reload();
        } }),
        button('Forget them', { variant: 'text', icon: 'clear_all', onclick: async () => {
          await api.updateReadingList(l.id, { clearUnmatched: true });
          reload();
        } })));
    page.append(details);
  }

  if (!l.books.length) {
    page.append(emptyState('playlist_add', 'This list is empty', 'Use “Add to reading list” from any book or series menu.'));
    return;
  }

  let order = l.books.map((b) => b.id);
  const listEl = h('ol.rl-items');
  const move = async (id, delta) => {
    const i = order.indexOf(id);
    const j = i + delta;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    draw();
    await api.updateReadingList(l.id, { order });
  };
  const row = (b, i) => {
    const done = b.progress?.finished;
    const pct = b.progress && !done ? Math.round((b.progress.percent || 0) * 100) : null;
    const title = b.series && b.series !== b.label ? `${b.series} · ${b.label}` : b.title;
    const li = h(`li.rl-item${b.id === l.nextBookId ? '.next' : ''}${done ? '.done' : ''}`, { draggable: l.owned ? 'true' : null, dataset: { id: String(b.id) } },
      h('span.rl-num', done ? icon('check') : String(i + 1)),
      h('a.rl-cover', { href: `#/read/${b.id}?list=${l.id}` }, cover(b, { showProgress: false })),
      h('div.rl-text',
        h('a.rl-title', { href: `#/read/${b.id}?list=${l.id}` }, title),
        h('div.rl-sub', [b.author, b.pageCount ? `${b.pageCount} pages` : null, done ? 'Read' : pct != null ? `${pct}% read` : null, b.id === l.nextBookId ? 'Up next' : null].filter(Boolean).join(' · '))),
      b.seriesId && iconButton('open_in_new', 'Series page', () => navigate(`/series/${b.seriesId}`)),
      l.owned && h('div.rl-move',
        iconButton('arrow_upward', 'Move up', () => move(b.id, -1)),
        iconButton('arrow_downward', 'Move down', () => move(b.id, 1))),
      l.owned && iconButton('remove_circle_outline', 'Remove from list', async () => {
        await api.removeFromReadingList(l.id, b.id);
        reload();
      }));
    return li;
  };
  const byId = new Map(l.books.map((b) => [b.id, b]));
  function draw() {
    listEl.replaceChildren(...order.map((id, i) => row(byId.get(id), i)));
  }
  // Drag to reorder (desktop); the arrows work everywhere.
  let dragging = null;
  listEl.addEventListener('dragstart', (e) => {
    dragging = e.target.closest('.rl-item');
    dragging?.classList.add('dragging');
  });
  listEl.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const over = e.target.closest('.rl-item');
    if (!over || over === dragging) return;
    const r = over.getBoundingClientRect();
    over[e.clientY > r.top + r.height / 2 ? 'after' : 'before'](dragging);
  });
  listEl.addEventListener('dragend', async () => {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    const fresh = [...listEl.children].map((li) => Number(li.dataset.id));
    if (fresh.join() === order.join()) return;
    order = fresh;
    draw();
    await api.updateReadingList(l.id, { order });
  });
  draw();
  page.append(h('section.section', listEl));
}
