// Series grids: a library, all series, Want to read, a genre, a person, a tag,
// a collection, or search results – with filters, sorting and infinite scroll.

import { api } from '../api.js';
import { onLeave, isAdmin, navigate, render } from '../router.js';
import { h, icon, iconButton, button, emptyState, menu, store, snackbar, stagger, pageBanner, confirmDialog, formDialog, field, STATUS_LABEL, USER_STATUS, skeleton, cover } from '../ui.js';
import { seriesCard } from '../components/cards.js';
import { refreshShell } from '../shell.js';
import { scanIndicator } from './scan.js';

const PAGE = 90;
const SORTS = [
  { value: 'relevance', label: 'Best match', search: true },
  { value: 'name', label: 'Title A–Z' },
  { value: 'name_desc', label: 'Title Z–A' },
  { value: 'author', label: 'Author' },
  { value: 'added', label: 'Recently added' },
  { value: 'read', label: 'Recently read' },
  { value: 'year', label: 'Release year' },
  { value: 'updated', label: 'Recently updated' },
];
const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
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
          // The admin can open users' personal libraries from the admin panel.
          const libs = await api.libraries(isAdmin() ? 'all' : undefined);
          const lib = libs.find((l) => l.id === Number(params.id));
          if (!lib) return navigate('/library', { replace: true });
          fixed.library = lib.id;
          title = lib.name;
          sub = `${lib.personal ? (lib.own ? 'Your library · ' : `${lib.ownerName}’s personal library · `) : ''}${lib.seriesCount} series · ${lib.kind === 'books' ? 'Books' : lib.kind === 'manga' ? 'Manga' : 'Comics'} · ${{ books: 'Regular books', kavita: 'Kavita-style (file names)', komga: 'Komga-style (folders)' }[lib.mode] || lib.mode}`;
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
    const sorts = SORTS.filter((s) => !s.search || kind === 'search');
    const state = {
      // Search results start with the best matches; other lists remember the last sort.
      sort: params.query.get('sort') || (kind === 'search' ? 'relevance' : saved.sort) || (kind === 'want' ? 'want' : 'name'),
      letter: '',
      read: '',
      status: '',
      userStatus: '',
      genres: [],
      offset: 0,
    };
    const persist = () => kind !== 'search' && store.set(prefKey, JSON.stringify({ sort: state.sort }));

    const BANNER = {
      library: params.id ? ['local_library', 'Library'] : ['collections_bookmark', 'Everything you can read'],
      want: ['bookmark_heart', 'Saved for later'],
      genre: ['category', 'Genre'],
      person: ['person', 'Writer / artist'],
      tag: ['sell', 'Your tag'],
      search: ['search', 'Search'],
      collection: ['collections_bookmark', 'Collection'],
    }[kind];
    // The eyebrow already names genres, people and tags, so their detail line is the count.
    const banner = pageBanner({ icon: BANNER[0], eyebrow: BANNER[1], title, sub: ['genre', 'person', 'tag'].includes(kind) ? null : sub, actions: headActions });
    page.append(banner);

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
    // The label is its own node: clicks append a ripple, so lastChild isn't the text.
    const sortLabel = h('span', (sorts.find((s) => s.value === state.sort) || { label: 'Date added' }).label);
    const sortBtn = button(sortLabel, { variant: 'text', icon: 'sort' });
    sortBtn.addEventListener('click', () =>
      menu(sortBtn, sorts.map((s) => ({
        label: s.label,
        checked: s.value === state.sort,
        onClick: () => {
          state.sort = s.value;
          sortLabel.textContent = s.label;
          persist();
          updateLetters();
          load();
        },
      }))),
    );
    const count = h('span.label-large.muted');
    page.append(h('div.toolbar.enter', readRow, statusChip, userStatusChip, kind !== 'genre' && genreChip, h('div.spacer'), count, sortBtn));

    // A–Z jump bar, shown while sorted by title.
    const letterBar = h('nav.letter-bar.enter', { 'aria-label': 'Jump to letter' },
      h('button.letter.state', { type: 'button', 'aria-pressed': 'true', title: 'All', onclick: () => pickLetter('') }, 'All'),
      LETTERS.map((l) => h('button.letter.state', { type: 'button', 'aria-pressed': 'false', 'data-letter': l, onclick: () => pickLetter(l) }, l)));
    const pickLetter = (l) => {
      state.letter = state.letter === l ? '' : l;
      for (const b of letterBar.children) b.setAttribute('aria-pressed', String((b.dataset.letter || '') === state.letter));
      load();
    };
    const updateLetters = () => {
      letterBar.hidden = !['name', 'name_desc'].includes(state.sort);
      if (letterBar.hidden && state.letter) pickLetter(state.letter);
    };
    updateLetters();
    page.append(letterBar);

    const results = h('div');
    const sentinel = h('div', { style: { height: '1px' } });
    // Search: matches inside the books' text, above the series that match by name.
    if (kind === 'search' && fixed.q) page.append(insideBooks(fixed.q));
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
      letter: state.letter || undefined,
      read: state.read,
      status: state.status,
      userStatus: state.userStatus,
      genre: fixed.genre ? [fixed.genre, ...state.genres] : state.genres,
      limit: PAGE,
    });

    async function load(quiet = false) {
      const id = ++reqId;
      state.offset = 0;
      if (!quiet) results.replaceChildren(skeleton('grid'));
      const data = await api.seriesList(query());
      if (id !== reqId || stale()) return;
      results.replaceChildren();
      count.textContent = data.items.length ? `${data.items.length}${data.hasMore ? '+' : ''} series` : '';
      if (!state.offset && !banner.dataset.art) {
        banner.dataset.art = '1';
        banner.setArt(data.items.filter((s) => !s.blur).map((s) => s.coverUrl));
        if (['genre', 'person', 'tag', 'search'].includes(kind) || (kind === 'library' && !params.id)) banner.setSub(data.items.length ? `${data.items.length}${data.hasMore ? '+' : ''} series` : kind === 'search' ? null : 'Nothing yet');
      }
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
      if (state.letter) return emptyState('sort_by_alpha', `Nothing under “${state.letter}”`, 'Pick another letter, or All.');
      if (state.read || state.status || state.userStatus || state.genres.length) return emptyState('filter_alt_off', 'No matches', 'Try removing some filters.');
      switch (kind) {
        case 'want':
          return emptyState('bookmark_heart', 'Nothing saved yet', 'Use “Want to read” on any series to save it here.');
        case 'collection':
          return emptyState('collections_bookmark', 'This collection is empty', 'Add series from their ⋮ menu → “Add to category”.');
        case 'search':
          return emptyState('search_off', 'No series match', 'Try another title, author or genre.');
        default:
          return emptyState('folder_open', 'Nothing here yet', isAdmin() ? 'Files are picked up when the library is scanned.' : 'Check back later.');
      }
    };

    await load();
  };
}

/** A snippet from the server, with \u0001…\u0002 around the matches, as text and <mark>s. */
function snippetEl(s) {
  const out = h('span.ft-snippet');
  for (const [i, part] of String(s).split(/\u0001|\u0002/).entries()) out.append(i % 2 ? h('mark', part) : part);
  return out;
}

/** “Inside books”: full-text matches for a search, each opening the book at that spot. */
function insideBooks(term) {
  const section = h('section.section.ft-results', { hidden: true });
  api.fulltext(term, 20).then(({ results, status }) => {
    if (!section.isConnected) return;
    const note = status.pending > 0 ? h('p.body-small.muted', `Still indexing ${status.pending} ${status.pending === 1 ? 'book' : 'books'} – more matches may turn up.`) : null;
    if (!results.length) {
      if (note) {
        section.append(note);
        section.hidden = false;
      }
      return;
    }
    // The series search may have come up empty; say so less bluntly when the text matched.
    section.classList.add('has-results');
    const total = results.reduce((a, r) => a + r.total, 0);
    section.append(...[
      h('div.section-head', h('h2.with-icon', h('span.sec-icon', icon('manage_search')), 'Inside books', h('span.sec-count', `${total}${total >= 600 ? '+' : ''}`))),
      note,
      stagger(h('div.ft-list', results.map(({ book, hits, total: n }) => {
        const open = (hit) => `#/read/${book.id}?loc=${encodeURIComponent(hit.section)}&q=${encodeURIComponent(term)}`;
        return h('div.ft-book',
          h('a.ft-cover', { href: open(hits[0]) }, cover(book, { showProgress: false })),
          h('div.ft-body',
            h('a.ft-title.title-small', { href: open(hits[0]) }, book.series && book.series !== book.title ? `${book.series} · ${book.label || book.title}` : book.title),
            h('div.body-small.muted', `${n} ${n === 1 ? 'match' : 'matches'}${book.author ? ` · ${book.author}` : ''}`),
            hits.map((hit) => h('a.ft-hit.state', { href: open(hit) }, h('span.ft-where', hit.label), snippetEl(hit.snippet)))));
      }))),
    ].filter(Boolean));
    section.hidden = false;
  }).catch(() => {});
  return section;
}

export const libraryView = browse('library');
export const wantView = browse('want');
export const genreView = browse('genre');
export const personView = browse('person');
export const tagView = browse('tag');
export const searchView = browse('search');
export const collectionView = browse('collection');
