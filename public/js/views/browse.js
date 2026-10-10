// Series grids: a library, all series, Want to read, a genre, a person, a tag,
// a collection, or search results – with filters, sorting and infinite scroll.

import { api } from '../api.js';
import { onLeave, isAdmin, navigate, render } from '../router.js';
import { h, icon, iconButton, button, loading, emptyState, menu, store, snackbar, stagger, pageHeader, confirmDialog, formDialog, field, STATUS_LABEL, USER_STATUS } from '../ui.js';
import { seriesCard } from '../components/cards.js';
import { refreshShell } from '../shell.js';
import { scanIndicator } from './scan.js';

const PAGE = 90;
const SORTS = [
  { value: 'name', label: 'Title' },
  { value: 'added', label: 'Recently added' },
  { value: 'read', label: 'Recently read' },
  { value: 'year', label: 'Release year' },
  { value: 'updated', label: 'Recently updated' },
];
const READ_FILTERS = [
  { value: '', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'reading', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
];

/** Build the route handler for one kind of series list. */
function browse(kind) {
  return async (view, params, stale) => {
    const page = h('div.page');
    view.append(page);
    const fixed = {};
    let title = 'All series';
    let sub = null;
    const headActions = [];

    switch (kind) {
      case 'library': {
        if (params.id) {
          const libs = await api.libraries();
          const lib = libs.find((l) => l.id === Number(params.id));
          if (!lib) return navigate('/library', { replace: true });
          fixed.library = lib.id;
          title = lib.name;
          sub = `${lib.seriesCount} series · ${lib.kind === 'books' ? 'Books' : lib.kind === 'manga' ? 'Manga' : 'Comics'} · ${lib.mode === 'kavita' ? 'Kavita-style (file names)' : 'Komga-style (folders)'}`;
          if (isAdmin()) {
            headActions.push(scanIndicator(() => load(true)));
            headActions.push(iconButton('sync', 'Scan for new files', async () => {
              await api.scanLibrary(lib.id);
              snackbar(`Scanning ${lib.name}…`);
            }));
            headActions.push(iconButton('travel_explore', 'Match metadata online', async () => {
              await api.matchLibrary(lib.id);
              snackbar('Looking up metadata for unmatched series…');
            }));
          }
        }
        break;
      }
      case 'want':
        fixed.want = 1;
        title = 'Want to read';
        sub = 'Series you’ve saved for later';
        break;
      case 'genre':
        fixed.genre = params.name;
        title = params.name;
        sub = 'Genre';
        break;
      case 'person':
        fixed.person = params.name;
        title = params.name;
        sub = 'Writer / artist';
        break;
      case 'tag':
        fixed.userTag = params.name;
        title = `#${params.name}`;
        sub = 'Your tag';
        break;
      case 'search':
        fixed.q = params.query.get('q') || '';
        title = `Results for “${fixed.q}”`;
        break;
      case 'collection': {
        const c = await api.collection(params.id).catch(() => null);
        if (!c) return page.append(emptyState('search_off', 'Collection not found'));
        fixed.collection = c.id;
        title = c.name;
        sub = c.summary || `${c.count} series${c.promoted ? ' · shared with everyone' : ''}`;
        if (c.owned) {
          headActions.push(iconButton('edit', 'Edit collection', async () => {
            const name = field('Name', { value: c.name, required: true });
            const summary = field('Description', { value: c.summary || '', multiline: true });
            const promote = h('input', { type: 'checkbox', checked: c.promoted });
            await formDialog({
              title: 'Edit collection',
              fields: [name, summary, isAdmin() && h('label.check', promote, 'Share with all users')],
              onSubmit: () => api.updateCollection(c.id, { name: name.input.value, summary: summary.input.value, promoted: promote.checked }),
            });
            refreshShell();
            render();
          }));
          headActions.push(iconButton('delete', 'Delete collection', async () => {
            if (!(await confirmDialog({ title: `Delete “${c.name}”?`, message: 'The series stay in your library.', confirm: 'Delete', danger: true }))) return;
            await api.deleteCollection(c.id);
            refreshShell();
            navigate('/collections', { replace: true });
          }));
        }
        break;
      }
    }
    if (stale()) return;

    const prefKey = `browse.${kind}`;
    const saved = JSON.parse(store.get(prefKey, 'null')) || {};
    const state = {
      sort: params.query.get('sort') || saved.sort || (kind === 'want' ? 'want' : 'name'),
      read: '',
      status: '',
      userStatus: '',
      genres: [],
      offset: 0,
    };
    const persist = () => store.set(prefKey, JSON.stringify({ sort: state.sort }));

    page.append(pageHeader(title, ...headActions), sub && h('p.muted.enter', { style: { marginTop: '-14px', marginBottom: '16px' } }, sub));

    // Toolbar
    const readRow = h('div.chip-row', READ_FILTERS.map((f) =>
      h('button.chip.state', { type: 'button', 'aria-pressed': String(f.value === state.read), onclick: (e) => {
        state.read = f.value;
        for (const c of readRow.children) c.setAttribute('aria-pressed', String(c === e.currentTarget));
        load();
      } }, f.label),
    ));
    const filterChip = (label, getLabel, items, onPick) => {
      const chip = h('button.chip.state.has-menu', { type: 'button' }, h('span', label), icon('arrow_drop_down'));
      chip.addEventListener('click', () => menu(chip, items().map((it) => ({ ...it, onClick: () => {
        onPick(it.value);
        chip.firstChild.textContent = getLabel();
        chip.setAttribute('aria-pressed', String(Boolean(it.value)));
        load();
      } }))));
      return chip;
    };
    const statusChip = filterChip('Publication', () => STATUS_LABEL[state.status] || 'Publication',
      () => [{ value: '', label: 'Any status', checked: !state.status }, ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label, checked: state.status === value }))],
      (v) => (state.status = v));
    const userStatusChip = filterChip('My status', () => USER_STATUS.find((u) => u.value === state.userStatus)?.label || 'My status',
      () => [{ value: '', label: 'Any', checked: !state.userStatus }, ...USER_STATUS.map((u) => ({ value: u.value, label: u.label, icon: u.icon, checked: state.userStatus === u.value }))],
      (v) => (state.userStatus = v));
    let genreList = [];
    api.genres().then((g) => (genreList = g)).catch(() => {});
    const genreChip = h('button.chip.state.has-menu', { type: 'button' }, h('span', 'Genres'), icon('arrow_drop_down'));
    genreChip.addEventListener('click', () => {
      menu(genreChip, [
        { label: 'Clear genres', icon: 'filter_alt_off', disabled: !state.genres.length, onClick: () => { state.genres = []; updateGenreChip(); load(); } },
        '-',
        ...genreList.map((g) => ({
          label: g.name,
          trailing: String(g.count),
          checked: state.genres.includes(g.name),
          onClick: () => {
            state.genres = state.genres.includes(g.name) ? state.genres.filter((x) => x !== g.name) : [...state.genres, g.name];
            updateGenreChip();
            load();
          },
        })),
      ]);
    });
    const updateGenreChip = () => {
      genreChip.firstChild.textContent = state.genres.length ? `Genres · ${state.genres.length}` : 'Genres';
      genreChip.setAttribute('aria-pressed', String(state.genres.length > 0));
    };
    const sortBtn = button((SORTS.find((s) => s.value === state.sort) || { label: 'Date added' }).label, { variant: 'text', icon: 'sort' });
    sortBtn.addEventListener('click', () =>
      menu(sortBtn, SORTS.map((s) => ({
        label: s.label,
        checked: s.value === state.sort,
        onClick: () => {
          state.sort = s.value;
          sortBtn.lastChild.textContent = s.label;
          persist();
          load();
        },
      }))),
    );
    const count = h('span.label-large.muted');
    page.append(h('div.toolbar.enter', readRow, statusChip, userStatusChip, kind !== 'genre' && genreChip, h('div.spacer'), count, sortBtn));

    const results = h('div');
    const sentinel = h('div', { style: { height: '1px' } });
    page.append(results, sentinel);

    let hasMore = false;
    let busy = false;
    let reqId = 0;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !busy) loadMore();
    }, { rootMargin: '800px' });
    io.observe(sentinel);
    onLeave(() => io.disconnect());

    const query = () => ({
      ...fixed,
      sort: state.sort,
      read: state.read,
      status: state.status,
      userStatus: state.userStatus,
      genre: fixed.genre ? [fixed.genre, ...state.genres] : state.genres,
      limit: PAGE,
    });

    async function load(quiet = false) {
      const id = ++reqId;
      state.offset = 0;
      if (!quiet) results.replaceChildren(loading());
      const data = await api.seriesList(query());
      if (id !== reqId || stale()) return;
      results.replaceChildren();
      count.textContent = data.items.length ? `${data.items.length}${data.hasMore ? '+' : ''} series` : '';
      if (!data.items.length) return results.append(noResults());
      results.append(stagger(h('div.grid', data.items.map((s) => seriesCard(s, { onChange: () => load(true) })))));
      hasMore = data.hasMore;
      state.offset = data.items.length;
    }

    async function loadMore() {
      busy = true;
      const id = reqId;
      const data = await api.seriesList({ ...query(), offset: state.offset });
      busy = false;
      if (id !== reqId || stale()) return;
      results.querySelector('.grid')?.append(...data.items.map((s) => seriesCard(s, { onChange: () => load(true) })));
      hasMore = data.hasMore;
      state.offset += data.items.length;
      count.textContent = `${state.offset}${hasMore ? '+' : ''} series`;
    }

    const noResults = () => {
      if (state.read || state.status || state.userStatus || state.genres.length) return emptyState('filter_alt_off', 'No matches', 'Try removing some filters.');
      switch (kind) {
        case 'want':
          return emptyState('bookmark_heart', 'Nothing saved yet', 'Use “Want to read” on any series to save it here.');
        case 'collection':
          return emptyState('collections_bookmark', 'This collection is empty', 'Add series from their ⋮ menu → “Add to category”.');
        case 'search':
          return emptyState('search_off', 'No results', 'Try another title, author or genre.');
        default:
          return emptyState('folder_open', 'Nothing here yet', isAdmin() ? 'Files are picked up when the library is scanned.' : 'Check back later.');
      }
    };

    await load();
  };
}

export const libraryView = browse('library');
export const wantView = browse('want');
export const genreView = browse('genre');
export const personView = browse('person');
export const tagView = browse('tag');
export const searchView = browse('search');
export const collectionView = browse('collection');
