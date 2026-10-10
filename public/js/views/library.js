import { api } from '../api.js';
import { onLeave, isAdmin, navigate, render } from '../router.js';
import {
  h, icon, iconButton, button, topBar, leading, bookTile, seriesTile, loading, emptyState, menu, segmented, store, snackbar,
} from '../ui.js';
import { accountButton, scanIndicator } from './common.js';

const PAGE = 120;
const SORTS = [
  { value: 'title', label: 'Title' },
  { value: 'added', label: 'Recently added' },
  { value: 'recent', label: 'Recently read' },
  { value: 'author', label: 'Author' },
  { value: 'series', label: 'Series' },
];
const STATUSES = [
  { value: '', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'reading', label: 'In progress' },
  { value: 'finished', label: 'Finished' },
];

export async function libraryView(view, params, stale) {
  const libraries = await api.libraries();
  if (stale()) return;
  const libId = params.id ? Number(params.id) : null;
  const lib = libraries.find((l) => l.id === libId) || null;
  if (params.id && !lib) return navigate('/library', { replace: true });

  const prefKey = `lib.${libId ?? 'all'}`;
  const prefs = JSON.parse(store.get(prefKey, 'null')) || {};
  const state = {
    mode: prefs.mode || (lib && lib.kind !== 'books' ? 'series' : 'all'),
    sort: prefs.sort || 'title',
    status: '',
    q: '',
    offset: 0,
  };
  const savePrefs = () => store.set(prefKey, JSON.stringify({ mode: state.mode, sort: state.sort }));

  const actions = [];
  if (isAdmin()) {
    actions.push(scanIndicator(() => reload()));
    actions.push(
      iconButton('sync', 'Rescan library', async () => {
        await (lib ? api.scanLibrary(lib.id) : api.scanAll());
        snackbar('Scanning for new files…');
      }),
    );
  }
  actions.push(accountButton());
  const bar = topBar(lib ? lib.name : 'Library', ...actions);
  onLeave(bar.cleanup);

  const page = h('div.page');
  view.append(bar, page);

  if (!libraries.length) {
    page.append(
      isAdmin()
        ? emptyState('library_add', 'No libraries yet', 'Add a folder in Settings to start building your library.',
            h('a.btn.filled.state', { href: '#/settings' }, icon('create_new_folder'), 'Add a library'))
        : emptyState('shelves', 'Nothing here yet', 'The owner hasn’t added any libraries yet.'),
    );
    return;
  }

  // Library tabs
  if (libraries.length > 1) {
    page.append(
      h('div.tabs', { role: 'tablist' },
        h('button', { role: 'tab', 'aria-selected': String(!lib), onclick: () => navigate('/library') }, 'All'),
        libraries.map((l) => h('button', { role: 'tab', 'aria-selected': String(l.id === libId), onclick: () => navigate(`/library/${l.id}`) }, l.name)),
      ),
    );
  }

  // Toolbar
  const search = h('input', { type: 'search', placeholder: lib ? `Search ${lib.name}` : 'Search all libraries', enterkeyhint: 'search', 'aria-label': 'Search' });
  const clearBtn = iconButton('close', 'Clear search', () => {
    search.value = '';
    onSearch();
    search.focus();
  });
  clearBtn.hidden = true;
  let debounce;
  const onSearch = () => {
    clearBtn.hidden = !search.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.q = search.value.trim();
      reload();
    }, 250);
  };
  search.addEventListener('input', onSearch);

  const modeSeg = segmented(
    [
      { value: 'series', label: 'Series', icon: 'collections_bookmark' },
      { value: 'all', label: 'All', icon: 'grid_view' },
    ],
    state.mode,
    (v) => {
      state.mode = v;
      savePrefs();
      reload();
    },
  );

  const sortBtn = button(SORTS.find((s) => s.value === state.sort).label, { variant: 'text', icon: 'sort' });
  sortBtn.addEventListener('click', () =>
    menu(sortBtn, SORTS.map((s) => ({
      label: s.label,
      checked: s.value === state.sort,
      onClick: () => {
        state.sort = s.value;
        sortBtn.lastChild.textContent = s.label;
        savePrefs();
        reload();
      },
    }))),
  );

  const statusRow = h('div.chip-row', STATUSES.map((s) =>
    h('button.chip.state', {
      type: 'button',
      'aria-pressed': String(s.value === state.status),
      onclick: (e) => {
        state.status = s.value;
        for (const c of statusRow.children) c.setAttribute('aria-pressed', String(c === e.currentTarget));
        reload();
      },
    }, s.label),
  ));

  const toolbar = h('div.toolbar',
    h('div.search-bar', icon('search'), search, clearBtn),
    modeSeg,
    sortBtn,
    statusRow,
  );
  page.append(toolbar);

  const results = h('div');
  const sentinel = h('div', { style: { height: '1px' } });
  page.append(results, sentinel);

  let hasMore = false;
  let busy = false;
  const io = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && hasMore && !busy) loadMore();
  }, { rootMargin: '600px' });
  io.observe(sentinel);
  onLeave(() => io.disconnect());

  function updateControls() {
    const seriesMode = state.mode === 'series' && !state.status;
    sortBtn.hidden = seriesMode;
    statusRow.hidden = false;
  }

  let reqId = 0;
  async function reload() {
    const id = ++reqId;
    state.offset = 0;
    hasMore = false;
    updateControls();
    results.replaceChildren(loading());
    // Series mode shows series cards; filters by status fall back to individual books.
    if (state.mode === 'series' && !state.status) {
      const series = await api.series({ library: libId, q: state.q });
      if (id !== reqId || stale()) return;
      // Books outside any series are listed after the series.
      const loose = await api.books({ library: libId, q: state.q, sort: state.sort, limit: 1000, standalone: 1 });
      if (id !== reqId || stale()) return;
      const standalone = loose.books;
      results.replaceChildren();
      if (!series.length && !standalone.length) return results.append(noResults());
      if (series.length) results.append(h('div.grid', series.map(seriesTile)));
      if (standalone.length) {
        results.append(
          h('div.section-head', { style: { marginTop: '32px' } }, h('h2', series.length ? 'Standalone' : 'All items')),
          h('div.grid', standalone.map((b) => bookTile(b))),
        );
      }
      return;
    }
    const data = await api.books(query());
    if (id !== reqId || stale()) return;
    results.replaceChildren();
    if (!data.books.length) return results.append(noResults());
    results.append(h('div.grid', data.books.map((b) => bookTile(b))));
    hasMore = data.hasMore;
    state.offset = data.books.length;
  }

  async function loadMore() {
    busy = true;
    const id = reqId;
    const data = await api.books({ ...query(), offset: state.offset });
    busy = false;
    if (id !== reqId || stale()) return;
    results.querySelector('.grid')?.append(...data.books.map((b) => bookTile(b)));
    hasMore = data.hasMore;
    state.offset += data.books.length;
  }

  const query = () => ({ library: libId, q: state.q, sort: state.sort, status: state.status, limit: PAGE });

  const noResults = () =>
    state.q || state.status
      ? emptyState('search_off', 'No matches', 'Try a different search or filter.')
      : emptyState('folder_open', 'This library is empty', isAdmin() ? 'Files are picked up when the library is scanned. Use the refresh button to scan now.' : 'Check back later.');

  await reload();
  if (params.query.has('search')) search.focus();
}

// ---------------------------------------------------------------------------

export async function seriesView(view, params, stale) {
  const libId = Number(params.lib);
  const name = params.name;
  const [{ books }, libraries] = await Promise.all([api.books({ library: libId, series: name, limit: 1000 }), api.libraries()]);
  if (stale()) return;
  const lib = libraries.find((l) => l.id === libId);

  const more = iconButton('more_vert', 'More options', () =>
    menu(more, [
      { label: 'Mark all as read', icon: 'done_all', onClick: () => markAll(true) },
      { label: 'Mark all as unread', icon: 'remove_done', onClick: () => markAll(false) },
    ]),
  );
  const back = leading(iconButton('arrow_back', 'Back', () => (history.length > 1 ? history.back() : navigate(`/library/${libId}`))));
  const bar = topBar(name, back, more);
  onLeave(bar.cleanup);
  const page = h('div.page');
  view.append(bar, page);

  async function markAll(finished) {
    await api.setSeriesFinished(libId, name, finished);
    snackbar(finished ? 'Marked as read' : 'Marked as unread');
    render();
  }

  if (!books.length) {
    page.append(emptyState('search_off', 'Series not found', 'It may have been renamed or removed.'));
    return;
  }

  const finished = books.filter((b) => b.progress?.finished).length;
  const next = books.find((b) => !b.progress?.finished) || books[0];
  const started = books.some((b) => b.progress);
  const label = !started ? 'Start reading' : next.progress && !next.progress.finished ? 'Continue' : 'Read next';
  const isComic = lib?.kind !== 'books';

  page.append(
    h('div.section', { style: { marginTop: '8px' } },
      h('p.body-medium.muted', `${lib?.name || ''} · ${books.length} ${isComic ? 'volumes/chapters' : 'books'} · ${finished} read`),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap' } },
        h('a.btn.filled.state', { href: `#/read/${next.id}` }, icon('play_arrow', 'filled'), `${label}: ${next.seriesIndex != null ? `#${next.seriesIndex}` : next.title}`),
      ),
    ),
    h('div.section', h('div.grid', books.map((b) => bookTile(b, { sub: tileSub(b) })))),
  );
}

function tileSub(b) {
  const p = b.progress;
  if (p?.finished) return 'Finished';
  if (p && p.percent > 0) return `${Math.round(p.percent * 100)}% read`;
  if (b.pageCount) return `${b.pageCount} pages`;
  return b.format.toUpperCase();
}
