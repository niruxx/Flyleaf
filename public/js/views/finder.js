import { t, plural } from '../i18n.js';
// Content Finder: search plugin sources and download books, manga and comics
// into your libraries.

import { api, can } from '../api.js';
import { session, isAdmin, navigate, onLeave } from '../router.js';
import { languageName } from '../languages.js';
import { languageBadge } from '../components/language-badge.js';
import { contentRating, contentRatingBadge } from '../components/content-rating-badge.js';
import { groupDownloads } from '../download-groups.js';
import { h, icon, iconButton, button, setButtonLabel, cover, dialog, snackbar, loading, skeleton, emptyState, stagger, field, formatBytes, timeAgo, libraryOptions, confirmDialog, toggleSwitch, pageBanner, formDialog } from '../ui.js';

const KIND_LABEL = { get books() { return t('Books'); }, get manga() { return t('Manga'); }, get comics() { return t('Comics'); } };
const LAST_SOURCE = 'flyleaf.finder.source';
const ALL = '*';

function sourceIcon(s, size = 20) {
  const fallback = icon('extension');
  if (!s.icon) return fallback;
  const img = h('img.source-icon', { src: s.icon, alt: '', width: size, height: size, referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(fallback));
  return img;
}

function readLast() {
  try {
    return localStorage.getItem(LAST_SOURCE);
  } catch {
    return null;
  }
}
function saveLast(id) {
  try {
    localStorage.setItem(LAST_SOURCE, id);
  } catch {}
}

export async function finderView(view, params, stale) {
  if (!can(session.user, 'contentFinder')) {
    view.append(emptyState('lock', t('Content Finder isn’t enabled'), t('Ask the admin to turn on Content Finder for your account.')));
    return;
  }
  view.append(loading());
  const [sources, libraries] = await Promise.all([api.finderSources(), api.libraries(isAdmin() ? 'all' : undefined)]);
  if (stale()) return;
  view.replaceChildren();

  const downloadsBtn = button(t('Downloads'), { variant: 'tonal', icon: 'download', onclick: () => navigate('/finder/downloads') });
  const head = h('div.page-head.enter', h('h1', t('Content Finder')),
    h('div.finder-actions', downloadsBtn,
      isAdmin() && button(t('Plugins'), { variant: 'text', icon: 'tune', onclick: () => navigate('/settings/plugins') })));

  if (!sources.length) {
    view.append(h('div.page', head, emptyState('extension_off', t('No sources yet'), isAdmin() ? t('Install a plugin to start finding books.') : t('The admin hasn’t installed any sources yet.'),
      isAdmin() && button(t('Install plugins'), { icon: 'extension', onclick: () => navigate('/settings/plugins') }))));
    return;
  }

  const ready = sources.filter((s) => !s.needsSetup && !s.error);
  let current = params.query.get('source') || readLast();
  if (current !== ALL && !sources.some((s) => s.id === current)) current = ready.length > 1 ? ALL : (ready[0] || sources[0]).id;
  const stack = []; // folder navigation: [{ id, title }]
  let query = params.query.get('q') || '';
  let pageNo = 1;
  let token = 0;

  // Find a source by name (handy with dozens of Mihon extensions). "All sources" then searches
  // just the matching ones.
  let sourceFilter = '';
  // Books / Manga / Comics: which kind of source to list and search.
  let kindFilter = '';
  const matchesFilter = (s) => (!kindFilter || (s.kinds || []).includes(kindFilter)) && (!sourceFilter || `${s.name} ${s.description || ''} ${s.language || ''} ${languageName(s.language)}`.toLowerCase().includes(sourceFilter));
  const kindsAvailable = [...new Set(sources.flatMap((s) => s.kinds || []))].filter((k) => KIND_LABEL[k]);
  const kindChips = h('div.chip-row.kind-chips');
  function renderKinds() {
    if (kindsAvailable.length < 2) return kindChips.replaceChildren();
    kindChips.replaceChildren(...['', ...kindsAvailable].map((k) => h('button.chip.state', { type: 'button', 'aria-pressed': String(kindFilter === k), onclick: () => {
      kindFilter = k;
      renderKinds();
      renderChips();
      if (current === ALL) run(true);
    } }, icon(k === 'books' ? 'menu_book' : k === 'manga' ? 'auto_stories' : k === 'comics' ? 'photo_library' : 'select_all'), k ? KIND_LABEL[k] : t('Everything'))));
  }
  const searchable = () => ready.filter(matchesFilter);
  const sourceFind = h('input.source-find', { type: 'search', placeholder: t('Find a source ({length})…', { length: sources.length }), 'aria-label': t('Find a source'), autocomplete: 'off',
    oninput: () => {
      sourceFilter = sourceFind.value.trim().toLowerCase();
      renderChips();
      if (current === ALL) run(true);
    },
    onkeydown: (e) => {
      // Enter with a single match opens that source.
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const hits = sources.filter(matchesFilter);
      if (hits.length === 1) pick(hits[0].id);
    } });
  const chips = h('div.source-chips', { role: 'tablist' });
  function renderChips() {
    const shownSources = sources.filter((s) => matchesFilter(s) || s.id === current);
    chips.replaceChildren(...[
      ready.length > 1 && h('button.chip.state', { type: 'button', role: 'tab', 'aria-pressed': String(current === ALL), onclick: () => pick(ALL) }, icon('travel_explore'),
        sourceFilter ? t('All matching ({length})', { length: searchable().length }) : t('All sources')),
      !shownSources.length && h('span.body-small.muted', t('No source matches.')),
      ...shownSources.map((s) => h('button.chip.state', { type: 'button', role: 'tab', 'aria-pressed': String(current === s.id), title: s.description || s.name, onclick: () => pick(s.id) },
        sourceIcon(s), [s.name, languageName(s.language)].filter(Boolean).join(' · '), (s.needsSetup || s.error) && icon('warning'))),
    ].filter(Boolean));
  }
  // Genres of the current source (sources with genres()); '' = none picked.
  let genre = '';
  const genreRow = h('div.chip-row.genre-chips');
  async function renderGenres() {
    const src = current !== ALL && sourceById(current);
    if (!src?.hasGenres) return genreRow.replaceChildren();
    let list;
    try {
      list = await api.finderGenres(src.id);
    } catch {
      return genreRow.replaceChildren();
    }
    if (current !== src.id) return;
    genreRow.replaceChildren(h('span.label-medium.muted', icon('category'), t('Genre')), ...[{ id: '', name: 'All' }, ...list].map((g) => h('button.chip.state', { type: 'button', 'aria-pressed': String(genre === g.id), dataset: { genre: g.id }, onclick: () => {
      genre = g.id;
      stack.length = 0;
      for (const b of genreRow.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.genre === g.id));
      run(true);
    } }, g.name)));
  }
  function pick(id) {
    current = id;
    genre = '';
    renderGenres();
    saveLast(id);
    stack.length = 0;
    renderChips();
    run(true);
  }

  const input = h('input', { type: 'search', placeholder: t('Search…'), value: query, 'aria-label': t('Search sources'), enterkeyhint: 'search', autocomplete: 'off' });
  const searchBar = h('form.finder-search', { onsubmit: (e) => {
    e.preventDefault();
    query = input.value.trim();
    stack.length = 0;
    const q = new URLSearchParams({ ...(current ? { source: current } : {}), ...(query ? { q: query } : {}) });
    history.replaceState(null, '', `#/finder${q.toString() ? `?${q}` : ''}`);
    run(true);
  } }, icon('search'), input, query && iconButton('close', t('Clear'), () => {
    input.value = '';
    query = '';
    run(true);
  }));
  let tagFilter = '';
  let ratingFilter = '';
  const tagField = field(t('Genres and book tags'), {
    placeholder: t('Space, Yuri'),
    support: t('Separate tags with commas. All tags must match. Filters check each loaded page; load more to check more books.'),
  });
  const ratingField = field(t('Content rating'), { options: [
    { value: '', label: t('Any rating') }, { value: 'safe', label: t('SFW') },
    { value: 'nsfw', label: t('NSFW') }, { value: 'unknown', label: t('Unrated') },
  ] });
  const filters = h('form.finder-filters', { onsubmit: (e) => {
    e.preventDefault();
    tagFilter = tagField.input.value.trim();
    ratingFilter = ratingField.input.value;
    run(true);
  } }, tagField, ratingField, button(t('Apply filters'), { type: 'submit', icon: 'filter_list' }),
  button(t('Clear filters'), { variant: 'text', onclick: () => {
    tagField.input.value = tagFilter = '';
    ratingField.input.value = ratingFilter = '';
    run(true);
  } }));
  const detailCache = new Map();
  async function filterPage(src, r) {
    if (!tagFilter && !ratingFilter) return r;
    const tags = tagFilter.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
    const rating = ratingFilter;
    const items = [];
    let next = 0;
    // Limit detail lookups to four at a time, including on large source pages.
    await Promise.all(Array.from({ length: Math.min(4, r.items.length) }, async () => {
      while (next < r.items.length) {
        const index = next++;
        const item = r.items[index];
        if (item.folder) { items[index] = item; continue; }
        let metadata = item;
        if (tags.length || (rating && contentRating(item) === 'unknown')) {
          const key = JSON.stringify([src.id, item.id]);
          if (!detailCache.has(key)) {
            if (detailCache.size >= 500) detailCache.delete(detailCache.keys().next().value);
            detailCache.set(key, api.finderDetails(src.id, item.id).catch(() => null));
          }
          const details = await detailCache.get(key);
          if (details) metadata = { ...item,
            genres: [...(item.genres || []), ...(details.genres || [])],
            tags: [...(item.tags || []), ...(details.tags || [])],
            ageRating: details.ageRating ?? item.ageRating, nsfw: details.nsfw ?? item.nsfw,
          };
        }
        const labels = [...(metadata.genres || []), ...(metadata.tags || [])].map((v) => v.toLowerCase());
        if (tags.every((tag) => labels.includes(tag)) && (!rating || contentRating(metadata, src) === rating)) items[index] = { ...item, ...metadata };
      }
    }));
    return { ...r, items: items.filter(Boolean) };
  }
  const crumbs = h('div.finder-crumbs');
  const results = h('div.finder-results');
  const more = h('div.finder-more');

  view.append(h('div.page.finder', head,
    h('p.body-medium.muted.enter', { style: { margin: '-8px 0 16px' } }, t('Search the sources your admin has installed and download straight into a library. Only download books you’re allowed to.')),
    sources.length > 6 && h('div.source-find-wrap', icon('filter_list'), sourceFind),
    kindChips, chips, searchBar, genreRow, filters, crumbs, results, more));
  renderKinds();
  renderChips();

  const sourceById = (id) => sources.find((s) => s.id === id);
  renderGenres();

  function tile(src, item) {
    const el = h('button.tile.finder-tile', { type: 'button', title: item.title, onclick: () => (item.folder ? openFolder(item) : openDetails(src, item)) },
      item.folder
        ? h('div.cover.folder-cover', icon('folder', 'filled'), h('div.ph-title', item.title))
        : cover({ title: item.title, coverUrl: item.cover, format: src.kinds?.[0] === 'books' ? 'epub' : 'cbz' }, { showProgress: false }),
      h('div.t-title', item.title),
      !item.folder && h('div.card-badges', languageBadge(item.language || src.language, { source: !item.language }), contentRatingBadge(item, src)),
      h('div.t-sub', item.author || (current === ALL ? src.name : '')),
    );
    return el;
  }

  function openFolder(item) {
    stack.push({ id: item.id, title: item.title });
    run(true);
  }

  function renderCrumbs() {
    crumbs.replaceChildren();
    if (!stack.length || current === ALL) return;
    crumbs.append(
      h('button.chip.state', { type: 'button', onclick: () => { stack.length = 0; run(true); } }, icon('home'), sourceById(current)?.name),
      ...stack.map((f, i) => [icon('chevron_right'), h('button.chip.state', { type: 'button', onclick: () => { stack.length = i + 1; run(true); } }, f.title)]).flat(),
    );
  }

  async function fetchPage(src, page) {
    if (stack.length) return api.finderBrowse(src.id, stack[stack.length - 1].id, page);
    if (genre && src.hasGenres) return api.finderGenre(src.id, genre, query, page);
    if (query) return api.finderSearch(src.id, query, page);
    if (src.canBrowse) return api.finderLatest(src.id, page);
    return { items: [], hasMore: false, needsQuery: true };
  }

  async function run(reset) {
    const my = ++token;
    if (reset) {
      pageNo = 1;
      results.replaceChildren(skeleton('grid', 12));
      more.replaceChildren();
    }
    renderCrumbs();
    input.placeholder = current === ALL ? (sourceFilter ? t('Search {length} matching sources…', { length: searchable().length }) : t('Search every source…')) : t('Search {value}…', { value: sourceById(current)?.name || '' });

    if (current === ALL) {
      const pool = searchable();
      if (!pool.length) {
        results.replaceChildren(emptyState('search_off', t('No source matches'), t('Clear the source filter to search everything.')));
        return;
      }
      if (!query) {
        results.replaceChildren(h('div.source-cards', pool.map((s) => h('button.source-card.state', { type: 'button', onclick: () => pick(s.id) },
          h('div.source-card-head', sourceIcon(s, 32), h('div', h('div.title-medium', s.name), h('div.body-small.muted', (s.kinds || []).map((k) => KIND_LABEL[k]).join(' · ')))),
          s.description && h('p.body-medium.muted', s.description)))));
        return;
      }
      // Search every ready source in parallel; each gets its own row.
      results.replaceChildren();
      for (const s of pool) {
        const section = h('section.finder-section', h('div.finder-section-head', sourceIcon(s), h('h2.title-medium', s.name),
          h('button.btn.text.state', { type: 'button', onclick: () => pick(s.id) }, t('See all'), icon('chevron_right'))), loading());
        results.append(section);
        const shelf = h('div.shelf');
        const status = h('div.finder-more');
        let sourcePage = 0;
        const sourceQuery = query;
        async function loadSourcePage() {
          sourcePage++;
          status.replaceChildren(loading());
          try {
            const r = await filterPage(s, await api.finderSearch(s.id, sourceQuery, sourcePage));
            if (my !== token) return;
            shelf.append(...r.items.map((it) => tile(s, it)));
            status.replaceChildren(...[
              !shelf.children.length && h('p.body-medium.muted.finder-none', t('No matches on the loaded pages.')),
              r.hasMore && button(t('Load more'), { variant: 'tonal', onclick: () => loadSourcePage() }),
            ].filter(Boolean));
          } catch (e) {
            if (my === token) status.replaceChildren(h('p.body-medium.finder-none.error-text', e.message),
              button(t('Try again'), { onclick: () => { sourcePage--; loadSourcePage(); } }));
          }
        }
        section.lastChild.replaceWith(shelf);
        section.append(status);
        loadSourcePage();
      }
      return;
    }

    const src = sourceById(current);
    if (src.error) {
      results.replaceChildren(emptyState('cloud_off', t('{name} isn’t available', { name: src.name }), src.error,
        isAdmin() && button(t('Open plugin settings'), { onclick: () => navigate('/settings/plugins') })));
      return;
    }
    if (src.needsSetup) {
      results.replaceChildren(emptyState('settings', t('{name} needs setting up', { name: src.name }), t('Missing: {value}.', { value: src.needsSetup.join(', ') }),
        isAdmin() && button(t('Open plugin settings'), { onclick: () => navigate('/settings/plugins') })));
      return;
    }
    try {
      const r = await filterPage(src, await fetchPage(src, pageNo));
      if (my !== token) return;
      if (reset) results.replaceChildren();
      if (r.needsQuery) {
        results.replaceChildren(emptyState('search', t('Search {name}', { name: src.name }), t('Type a title or author above.')));
        return;
      }
      if (!r.items.length && pageNo === 1 && !r.hasMore) {
        results.replaceChildren(emptyState('search_off', t('Nothing found'), query ? t('No results for “{query}” on {name}.', { query: query, name: src.name }) : t('This source has nothing to show.')));
        return;
      }
      let grid = results.querySelector('.grid');
      if (!grid) {
        if (!query && !stack.length) results.append(h('h2.title-medium.finder-label', t('Popular')));
        grid = stagger(h('div.grid'));
        results.append(grid);
      }
      grid.querySelector('p')?.remove();
      grid.append(...r.items.map((it) => tile(src, it)));
      if (!grid.children.length) grid.replaceChildren(h('p.body-medium.muted', t('No matches on this page. Load more to check the next page.')));
      // No more pages: leave it empty (replaceChildren would print a null as the text "null").
      more.replaceChildren(...(r.hasMore ? [button(t('Load more'), { variant: 'tonal', icon: 'expand_more', onclick: (e) => {
        e.currentTarget.disabled = true;
        pageNo++;
        run(false);
      } })] : []));
    } catch (e) {
      if (my !== token) return;
      results.replaceChildren(emptyState('cloud_off', t('{name} didn’t respond', { name: src.name }), e.message, button(t('Try again'), { variant: 'tonal', icon: 'refresh', onclick: () => run(true) })));
    }
  }

  async function openDetails(src, item) {
    let d;
    const body = h('div.finder-details', loading());
    const result = dialog({
      title: null,
      className: 'wide finder-dialog fullscreen-compact',
      content: body,
      actions: [],
      onOpen: async (dlg, close) => {
        try {
          d = await api.finderDetails(src.id, item.id);
        } catch (e) {
          body.replaceChildren(emptyState('error', t('Couldn’t load this item'), e.message), h('div.dialog-actions', button(t('Close'), { variant: 'text', onclick: () => close() })));
          return;
        }
        body.replaceChildren(detailsContent(src, d, close));
      },
    });
    await result;
  }

  function detailsContent(src, d, close) {
    // Only libraries you may write into (your own ones, if you have a personal folder).
    const usable = libraries.filter((l) => l.writable);
    const fits = (l) => (src.kinds || []).includes(l.kind);
    const preferred = usable.find((l) => l.own && fits(l)) || usable.find(fits) || usable[0];
    const lib = field(t('Save to library'), { value: preferred?.id ?? '', options: libraryOptions(usable, (l) => `${l.name} (${KIND_LABEL[l.kind]})`) });

    const many = d.files.length > 1;
    // Books: offer one format (the plugin lists the best first). Manga/comics: chapters/volumes, pick any.
    const singleChoice = src.kinds?.[0] === 'books' || d.files.every((f) => f.format && ['epub', 'azw3', 'mobi', 'pdf', 'fb2', 'txt'].includes(f.format));
    const rows = d.files.map((f, i) => {
      const input = h('input', { type: singleChoice ? 'radio' : 'checkbox', name: 'finder-file', checked: singleChoice ? i === 0 : !many });
      input.dataset.index = i;
      return h('label.file-row', input,
        h('div', h('div.body-large', f.title || f.format?.toUpperCase() || t('File {value}', { value: i + 1 })),
          h('div.body-small.muted', [f.format?.toUpperCase(), f.size ? formatBytes(f.size) : null, f.volume != null ? t('Vol. {volume}', { volume: f.volume }) : null, f.chapter != null ? t('Ch. {chapter}', { chapter: f.chapter }) : null, languageName(f.language), f.date].filter(Boolean).join(' · '))));
    });
    const selectAll = !singleChoice && many && h('label.check', h('input', { type: 'checkbox', onchange: (e) => rows.forEach((r) => (r.querySelector('input').checked = e.target.checked)) }), t('Select all {length}', { length: d.files.length }));

    const go = button(t('Download'), { icon: 'download', onclick: async () => {
      const picked = rows.map((r) => r.querySelector('input')).filter((x) => x.checked).map((x) => d.files[Number(x.dataset.index)]);
      if (!picked.length) return snackbar(t('Pick at least one file.'));
      if (!lib.input.value) return snackbar(t('Choose a library first.'));
      go.disabled = true;
      try {
        await api.finderDownload(src.id, { libraryId: Number(lib.input.value), book: { title: d.title, author: d.author, series: d.series, cover: d.cover, ageRating: d.ageRating, layout: d.layout, sourceId: d.id }, files: picked });
        close();
        snackbar(t('Downloading {value}…', { value: picked.length === 1 ? t('“{title}”', { title: d.title }) : t('{length} files', { length: picked.length }) }), { action: t('View'), onAction: () => navigate('/finder/downloads') });
        import('../shell.js').then((m) => m.refreshDownloadsBadge());
      } catch (e) {
        snackbar(e.message, { duration: 6000 });
        go.disabled = false;
      }
    } });

    // Follow: new chapters/volumes are checked for and (by default) downloaded into the chosen library.
    const followable = d.files.length > 0 && !singleChoice && usable.length > 0;
    let following = null;
    const followBtn = followable && button(t('Follow'), { variant: 'outlined', icon: 'notifications', onclick: async () => {
      followBtn.disabled = true;
      try {
        if (following) {
          await api.unfollow(following.id);
          following = null;
          snackbar(t('Stopped following “{value}”', { value: d.series || d.title }));
        } else {
          if (!lib.input.value) return snackbar(t('Choose a library first.'));
          following = await api.follow({
            plugin: src.id, sourceId: d.id, libraryId: Number(lib.input.value), autoDownload: true,
            book: { title: d.title, author: d.author, series: d.series, cover: d.cover, ageRating: d.ageRating, layout: d.layout },
            files: d.files.map((f) => f.id),
          });
          snackbar(t('Following “{value}”. New chapters will download into {value2}.', { value: d.series || d.title, value2: usable.find((l) => l.id === Number(lib.input.value))?.name || t('the library') }), { action: t('Manage'), onAction: () => navigate('/finder/following'), duration: 6000 });
        }
        drawFollow();
      } catch (e) {
        snackbar(e.message, { duration: 6000 });
      } finally {
        followBtn.disabled = false;
      }
    } });
    const drawFollow = () => {
      if (!followBtn) return;
      followBtn.querySelector('.icon').textContent = following ? 'notifications_active' : 'notifications';
      setButtonLabel(followBtn, following ? t('Following') : t('Follow'));
      followBtn.classList.toggle('selected', Boolean(following));
      followBtn.title = following ? t('Stop following') : t('Get new chapters automatically');
    };
    if (followBtn) api.followStatus(src.id, d.id).then((f) => {
      following = f;
      drawFollow();
    }).catch(() => {});

    return h('div.finder-detail',
      h('div.finder-detail-top',
        cover({ title: d.title, coverUrl: d.cover }, { showProgress: false }),
        h('div.finder-detail-info',
          h('div.label-medium.muted', h('span', sourceIcon(src, 16), ' ', src.name)),
          h('h2.headline-small', d.title),
          d.author && h('p.title-small.muted', d.author),
          d.status && h('span.mini-chip', d.status),
          h('p.body-small.muted', t('Available languages: {languages}', { languages: languageName(d.files.flatMap((f) => [].concat(f.language || []))) || t('Unknown language') })),
          src.language && h('p.body-small.muted', t('Source language: {language}', { language: languageName(src.language) })),
          (d.genres.length > 0 || d.tags?.length > 0) && h('div.chip-set', [...new Set([...d.genres, ...(d.tags || [])])].slice(0, 20).map((g) => h('span.chip.static', g))),
          d.url && h('a.btn.text.state', { href: d.url, target: '_blank', rel: 'noopener noreferrer' }, icon('open_in_new'), t('View on site')),
        ),
      ),
      d.summary && h('p.body-medium.finder-summary', d.summary),
      d.files.length
        ? h('div', h('div.label-large', { style: { margin: '16px 0 8px' } }, singleChoice ? t('Format') : t('Files ({length})', { length: d.files.length })), selectAll, h('div.file-list', rows))
        : h('p.body-medium.muted', t('This item has nothing to download.')),
      usable.length ? lib : h('p.form-error', icon('error'), session.user.homeDir
        ? h('span', t('Create a library in your personal folder first: '), h('a', { href: '#/settings/mylibs', onclick: () => close() }, t('My libraries')), '.')
        : t('You don’t have access to any library to save into.')),
      h('div.dialog-actions', button(t('Cancel'), { variant: 'text', onclick: () => close() }), followBtn, d.files.length > 0 && usable.length > 0 && go),
    );
  }

  run(true);

  // Links from recommendations open an item straight away.
  const openId = params.query.get('open');
  const openSrc = openId && sourceById(params.query.get('source'));
  if (openSrc) openDetails(openSrc, { id: openId, title: params.query.get('title') || '' });
}


// ---------------------------------------------------------------------------
// Downloads

export async function downloadsView(view, params, stale) {
  const body = h('div.downloads', loading());
  // The admin sees everyone's downloads, one tab per person. Everyone else only gets their own
  // from the server, so they get no tabs.
  const tabs = h('div.download-tabs', { role: 'tablist', hidden: true });
  const statusTabs = h('div.download-tabs', { role: 'tablist', 'aria-label': t('Download status') });
  let statusTab = 'pending';
  const statusLabels = () => [
    ['pending', t('Pending')], ['downloading', t('Downloading')], ['failed', t('Failed')],
    ['completed', t('Completed')], ['cancelled', t('Cancelled')],
  ];
  function selectStatus(key) {
    statusTab = key;
    for (const button of statusTabs.children) {
      const selected = button.dataset.status === key;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of body.querySelectorAll('[data-download-status]')) panel.hidden = panel.dataset.downloadStatus !== key;
  }
  function drawStatusTabs(rows) {
    const counts = {
      pending: rows.filter(d => d.status === 'queued').length,
      downloading: rows.filter(d => d.status === 'downloading').length,
      failed: rows.filter(failed).length,
      completed: rows.filter(d => d.status === 'done').length,
      cancelled: rows.filter(d => d.status === 'failed' && d.error === 'Cancelled').length,
    };
    statusTabs.replaceChildren(...statusLabels().map(([key, label], index, list) => h('button.download-tab.state', {
      type: 'button', role: 'tab', id: `download-tab-${key}`, 'aria-controls': `download-panel-${key}`,
      dataset: { status: key }, onclick: () => selectStatus(key),
      onkeydown: (e) => {
        let next;
        if (e.key === 'ArrowRight') next = (index + 1) % list.length;
        else if (e.key === 'ArrowLeft') next = (index + list.length - 1) % list.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = list.length - 1;
        else return;
        e.preventDefault();
        selectStatus(list[next][0]);
        statusTabs.children[next].focus();
      },
    }, label, h('span.count', String(counts[key])))));
    selectStatus(statusTab);
  }
  let sort = 'asc';
  const collapsedBooks = new Set();
  let downloadGroupId = 0;
  const sorting = h('label.download-sort', t('Sort by title'), h('select', { 'aria-label': t('Sort by title'), onchange: (e) => {
    sort = e.target.value;
    refresh();
  } }, h('option', { value: 'asc' }, t('Title A–Z')), h('option', { value: 'desc' }, t('Title Z–A'))));
  view.append(h('div.page', h('div.page-head.downloads-head.enter', iconButton('arrow_back', t('Back'), () => navigate('/finder')), h('h1', t('Downloads')), sorting), tabs, statusTabs, body));
  let tab = isAdmin() ? params.query.get('user') || 'all' : 'all';

  let timer;
  onLeave(() => clearTimeout(timer));

  // Which chapter/volume a download was, when its title is just the series.
  const titleOf = (d) => {
    const part = d.fileTitle || (d.chapter != null ? t('Chapter {chapter}', { chapter: d.chapter }) : d.volume != null ? t('Volume {volume}', { volume: d.volume }) : null);
    return part && !d.title.includes(part) ? `${d.title} – ${part}` : d.title;
  };
  const failed = (d) => d.status === 'failed' && d.error !== 'Cancelled';
  const active = (d) => d.status === 'queued' || d.status === 'downloading';

  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      snackbar(e.message, { duration: 6000 });
    }
    refresh();
  };

  function row(d) {
    const title = titleOf(d);
    const busy = active(d);
    const cancelled = d.status === 'failed' && !failed(d);
    const pct = d.total ? Math.min(100, (d.received / d.total) * 100) : null;
    return h(`div.download-row.${cancelled ? 'cancelled' : d.status}`,
      icon(cancelled ? 'block' : { queued: 'schedule', downloading: 'downloading', done: 'check_circle', failed: 'error' }[d.status]),
      h('div.text',
        h('div.body-large', title),
        h('div.body-small.muted', [
          d.status === 'downloading' ? t('{value}{value2}', { value: formatBytes(d.received), value2: d.total ? t(' of {value}', { value: formatBytes(d.total) }) : '' }) : null,
          d.status === 'queued' ? t('Waiting…') : null,
          d.status === 'done' ? t('Added to {value} · {value2}', { value: d.library || t('library'), value2: timeAgo(d.finishedAt) }) : null,
          failed(d) ? `${d.error}${d.finishedAt ? ` · ${timeAgo(d.finishedAt)}` : ''}` : null,
          cancelled ? t('Cancelled{value}', { value: d.finishedAt ? ` · ${timeAgo(d.finishedAt)}` : '' }) : null,
          d.plugin,
          // In a person's own tab the name would just repeat the tab.
          isAdmin() && tab === 'all' && d.userName ? t('by {userName}', { userName: d.userName }) : null,
        ].filter(Boolean).join(' · ')),
        busy && h('div.progress', pct == null ? { class: 'indeterminate' } : null, h('span', { style: { width: `${pct ?? 30}%` } })),
      ),
      failed(d) && button(t('Retry'), { variant: 'tonal', icon: 'refresh', onclick: run(async () => {
        await api.retryDownload(d.id);
        snackbar(t('Retrying “{title}”', { title: title }));
      }) }),
      cancelled && iconButton('refresh', t('Download again'), run(async () => {
        await api.retryDownload(d.id);
        snackbar(t('Downloading “{title}” again', { title: title }));
      })),
      iconButton(busy ? 'close' : 'delete', busy ? t('Cancel') : t('Remove'), run(() => api.cancelDownload(d.id))),
    );
  }

  function bookGroup(group) {
    const key = `${group.rows[0].status}:${group.rows[0].error === 'Cancelled'}:${group.key}`;
    const entries = h('div.downloads-list', group.rows.map(row));
    const reveal = h('div.download-book-reveal', { id: `download-entries-${++downloadGroupId}` }, h('div.download-book-reveal-inner', entries));
    const toggle = iconButton('expand_more', '', () => {
      if (collapsedBooks.has(key)) collapsedBooks.delete(key);
      else collapsedBooks.add(key);
      update();
    });
    toggle.setAttribute('aria-controls', reveal.id);
    function update() {
      const collapsed = collapsedBooks.has(key);
      const label = collapsed ? t('Expand downloads for {title}', { title: group.title }) : t('Collapse downloads for {title}', { title: group.title });
      reveal.classList.toggle('expanded', !collapsed);
      reveal.inert = collapsed;
      reveal.setAttribute('aria-hidden', String(collapsed));
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
    }
    update();
    return h('section.download-book-group',
      h('div.download-book-art', cover({ title: group.title, coverUrl: group.cover }, { showProgress: false })),
      h('div.download-book-content',
        h('div.download-book-heading', h('h3.title-medium', group.title, h('span.muted', ` (${group.rows.length})`)), toggle), reveal));
  }

  function section(label, rows, { actions = [], empty } = {}) {
    return h('section.downloads-section',
      h('div.downloads-section-head', h('h2', label, rows.length ? h('span.muted', ` (${rows.length})`) : null), ...actions),
      rows.length ? h('div.download-book-groups', groupDownloads(rows, sort).map(bookGroup)) : empty && h('p.note', empty));
  }

  /** One tab per person who has downloads, named after them, plus “All users”. */
  function drawTabs(all) {
    const people = new Map();
    for (const d of all) {
      const key = String(d.userId ?? 'none');
      const p = people.get(key) || { key, name: d.userId == null ? t('Deleted users') : d.userName || d.username || t('Unknown'), count: 0, attention: 0 };
      p.count++;
      if (active(d) || failed(d)) p.attention++;
      people.set(key, p);
    }
    const me = String(session.user.id);
    const list = [...people.values()].sort((a, b) => (a.key === me ? -1 : b.key === me ? 1 : a.name.localeCompare(b.name)));
    if (tab !== 'all' && !people.has(tab)) tab = 'all';
    const tabButton = (key, label, count, attention) => h('button.download-tab.state', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(tab === key),
      onclick: () => {
        if (tab === key) return;
        tab = key;
        history.replaceState(null, '', `#/finder/downloads${key === 'all' ? '' : `?user=${encodeURIComponent(key)}`}`);
        refresh();
      },
    }, key === 'all' ? icon('groups') : icon('person'), h('span', label), h('span.count', String(count)), attention > 0 && h('span.dot', { title: t('{attention} in progress or failed', { attention: attention }) }));
    tabs.replaceChildren(
      tabButton('all', t('All users'), all.length, all.filter((d) => active(d) || failed(d)).length),
      ...list.map((p) => tabButton(p.key, p.key === me ? t('{name} (you)', { name: p.name }) : p.name, p.count, p.attention)),
    );
    tabs.hidden = false;
  }

  async function refresh() {
    clearTimeout(timer);
    let rows;
    try {
      rows = await api.downloads();
    } catch (e) {
      body.replaceChildren(emptyState('error', t('Couldn’t load downloads'), e.message));
      return;
    }
    if (stale()) return;
    import('../shell.js').then((m) => m.refreshDownloadsBadge());
    if (isAdmin() && rows.length) {
      drawTabs(rows);
      if (tab !== 'all') rows = rows.filter((d) => String(d.userId ?? 'none') === tab);
    }
    // Retry all / Clear act on the open tab only.
    const who = isAdmin() && tab !== 'all' && tab !== 'none' ? tab : undefined;
    drawStatusTabs(rows);
    if (!rows.length) {
      body.replaceChildren(emptyState('download_done', t('No downloads'), t('Books you download from Content Finder appear here.'), button(t('Find books'), { icon: 'travel_explore', onclick: () => navigate('/finder') })));
      return;
    }
    const inProgress = rows.filter(active);
    const failures = rows.filter(failed);
    const history = rows.filter((d) => !active(d) && !failed(d));
    body.replaceChildren(...[
      section(t('Downloading'), rows.filter((d) => d.status === 'downloading'), { empty: t('No downloads are running.') }),
      section(t('Pending'), rows.filter((d) => d.status === 'queued'), { empty: t('No pending downloads.') }),
      section(t('Failed'), failures, {
        empty: t('Nothing has failed.'),
        actions: failures.length ? [
          button(t('Retry all'), { variant: 'tonal', icon: 'refresh', onclick: run(async () => {
            const r = await api.retryFailedDownloads(who);
            snackbar(r.retried ? plural(r.retried, 'Retrying {retried} download', 'Retrying {retried} downloads', { retried: r.retried }) : t('Nothing to retry'));
          }) }),
          button(t('Clear'), { variant: 'text', icon: 'clear_all', onclick: run(async () => {
            if (!(await confirmDialog({ title: t('Clear failed downloads?'), message: t('They’re removed from this list and won’t be retried. You can always download them again from Content Finder.'), confirm: t('Clear'), danger: true }))) return;
            await api.clearDownloads('failed', who);
          }) }),
        ] : [],
      }),
      section(t('Completed'), history.filter((d) => d.status === 'done'), {
        empty: t('Finished downloads appear here.'),
        actions: history.length ? [button(t('Clear history'), { variant: 'text', icon: 'clear_all', onclick: run(() => api.clearDownloads('history', who)) })] : [],
      }),
      section(t('Cancelled'), history.filter((d) => d.error === 'Cancelled'), { empty: t('No cancelled downloads.') }),
    ].map((panel, index) => {
      const key = ['downloading', 'pending', 'failed', 'completed', 'cancelled'][index];
      panel.dataset.downloadStatus = key;
      panel.id = `download-panel-${key}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `download-tab-${key}`);
      panel.tabIndex = 0;
      panel.hidden = statusTab !== key;
      return panel;
    }));
    if (inProgress.length) timer = setTimeout(refresh, 1500);
  }
  refresh();
}

// ---------------------------------------------------------------------------
// Following: series checked for new chapters, and what turned up

const UPDATE_LABEL = { get new() { return t('Not downloaded'); }, get queued() { return t('Queued'); }, get downloading() { return t('Downloading'); }, get done() { return t('Downloaded'); }, get downloaded() { return t('Downloaded'); }, get failed() { return t('Failed'); } };

export async function followingView(view, params, stale) {
  const page = h('div.page');
  view.append(page);
  const banner = pageBanner({
    icon: 'notifications_active',
    eyebrow: t('Content Finder'),
    title: t('Following'),
    sub: t('Series checked for new chapters and volumes'),
    actions: [iconButton('refresh', t('Check all now'), () => checkAll())],
  });
  const watch = h('div');
  const body = h('div', loading());
  page.append(banner, watch, body);

  let libraries = [];
  api.libraries().then((l) => (libraries = l.filter((x) => x.writable))).catch(() => {});

  async function checkAll() {
    snackbar(t('Checking your series for new chapters…'));
    try {
      const r = await api.checkFollows();
      snackbar(r.found ? plural(r.found, 'Found {found} new chapter', 'Found {found} new chapters', { found: r.found }) : t('Everything’s up to date'));
    } catch (e) {
      snackbar(e.message, { duration: 6000 });
    }
    load();
  }

  // "Watch my downloads": match what you downloaded to its source and keep checking it.
  function drawWatch() {
    const on = session.user.prefs.watchDownloads !== false;
    const syncBtn = button(t('Check my downloads now'), { variant: 'tonal', icon: 'manage_search', onclick: async () => {
      syncBtn.disabled = true;
      setButtonLabel(syncBtn, t('Matching your downloads…'));
      try {
        const r = await api.syncFollows(false);
        const parts = [
          r.followed ? plural(r.followed, 'Now following {followed} series', 'Now following {followed} series', { followed: r.followed }) : t('No new series to follow'),
          r.found ? plural(r.found, '{found} newer chapter available', '{found} newer chapters available', { found: r.found }) : null,
          r.unmatched.length ? t('{length} couldn’t be found on their source', { length: r.unmatched.length }) : null,
        ].filter(Boolean);
        snackbar(parts.join(' · '), { duration: 7000 });
        load();
      } catch (e) {
        snackbar(e.message, { duration: 6000 });
      } finally {
        syncBtn.disabled = false;
        setButtonLabel(syncBtn, t('Check my downloads now'));
      }
    } });
    watch.replaceChildren(h('section.watch-card.enter',
      h('span.f-icon', icon('manage_search')),
      h('div.text',
        h('div.title-small', t('Watch my downloads')),
        h('div.body-small.muted', t('Match everything you’ve downloaded with Content Finder to its source, and tell me when newer chapters come out.'))),
      toggleSwitch(on, async (v) => {
        session.user.prefs = await api.savePrefs({ watchDownloads: v });
      }, t('Watch my downloads')),
      syncBtn));
  }

  async function load() {
    let data;
    let updates;
    try {
      [data, updates] = await Promise.all([api.follows(), api.followUpdates(60)]);
    } catch (e) {
      body.replaceChildren(emptyState('error', t('Couldn’t load'), e.message));
      return;
    }
    if (stale()) return;
    banner.setArt(data.follows.map((f) => f.cover).filter(Boolean));
    banner.setSub(data.follows.length
      ? t('{length} series · {value}{value2}', { length: data.follows.length, value: data.checkHours ? plural(data.checkHours, 'checked every {checkHours} hour', 'checked every {checkHours} hours', { checkHours: data.checkHours }) : t('automatic checks are off (FOLLOW_CHECK_HOURS=0)'), value2: data.checking ? t(' · checking now') : '' })
      : t('Series checked for new chapters and volumes'));

    const cards = data.follows.map((f) => {
      const auto = toggleSwitch(f.autoDownload, async (v) => {
        await api.updateFollow(f.id, { autoDownload: v });
        snackbar(v ? t('New chapters will download automatically') : t('You’ll be notified, and can download them yourself'));
      }, t('Download new chapters automatically'));
      const more = iconButton('more_vert', t('More'), () => import('../ui.js').then(({ menu }) => menu(more, [
        { label: t('Source schedule'), icon: 'schedule', onClick: async () => {
          const hours = field(t('Check every (hours)'), { type: 'number', min: 0, max: 8760, step: 'any', value: f.checkHours, required: true,
            support: t('Applies to all your follows on this source. 0 pauses automatic checks; 168 checks weekly.') });
          await formDialog({ title: t('Source schedule'), fields: [hours], submit: t('Save'), onSubmit: () => api.sourceSchedule(f.plugin, Number(hours.input.value)) });
          load();
        } },
        { label: t('Check now'), icon: 'refresh', onClick: async () => {
          try {
            const r = await api.checkFollow(f.id);
            snackbar(r.found ? t('{found} new in {title}', { found: r.found, title: f.title }) : t('{title} is up to date', { title: f.title }));
          } catch (e) {
            snackbar(e.message, { duration: 6000 });
          }
          load();
        } },
        { header: t('New chapters go into') },
        ...libraries.map((l) => ({ label: l.name, icon: 'folder', checked: l.id === f.libraryId, onClick: async () => {
          await api.updateFollow(f.id, { libraryId: l.id });
          load();
        } })),
        '-',
        { label: t('Open in Content Finder'), icon: 'travel_explore', onClick: () => navigate(`/finder?source=${encodeURIComponent(f.plugin)}&open=${encodeURIComponent(f.sourceId)}&title=${encodeURIComponent(f.title)}`) },
        { label: t('Unfollow'), icon: 'notifications_off', onClick: async () => {
          await api.unfollow(f.id);
          snackbar(t('Stopped following “{title}”', { title: f.title }));
          load();
        } },
      ])));
      return h('div.follow-card', { style: f.cover ? { '--art': `url("${f.cover}")` } : null },
        cover({ title: f.title, coverUrl: f.cover }, { showProgress: false }),
        h('div.follow-info',
          h('div.title-medium', f.title),
          h('div.follow-meta', f.checkHours ? t('Checks every {hours} hours', { hours: f.checkHours }) : t('Automatic checks paused')),
          h('div.follow-meta', [f.plugin.split('~').pop(), f.library ? `→ ${f.library}` : t('no library chosen'), t('{known} files known', { known: f.known })].join(' · ')),
          h('div.follow-meta', f.lastError ? t('Last check failed: {lastError}', { lastError: f.lastError }) : f.lastCheckedAt ? t('Checked {value}{value2}', { value: timeAgo(f.lastCheckedAt), value2: f.lastNewAt ? t(' · last new {value}', { value: timeAgo(f.lastNewAt) }) : '' }) : t('Not checked yet')),
          f.recentUpdates > 0 && h('span.follow-new', t('{recentUpdates} new this week', { recentUpdates: f.recentUpdates })),
          h('div.follow-actions', h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: '1' } }, auto, h('span.body-small', t('Auto-download'))), more)));
    });

    const rows = updates.map((u) => h('div.update-row',
      cover({ title: u.title, coverUrl: u.cover }, { showProgress: false }),
      h('div.text', h('div.title-small', `${u.title} · ${u.file.label}`), h('div.body-small.muted', t('{value} · found {value2}{value3}', { value: u.plugin.split('~').pop(), value2: timeAgo(u.foundAt), value3: u.error ? ` · ${u.error}` : '' }))),
      h(`span.update-status.${u.status}`, UPDATE_LABEL[u.status] || u.status),
      (u.status === 'new' || u.status === 'failed') && button(t('Download'), { variant: 'tonal', icon: 'download', onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await api.downloadUpdate(u.id);
          snackbar(t('Downloading {title} · {label}', { title: u.title, label: u.file.label }));
          import('../shell.js').then((m) => m.refreshDownloadsBadge());
          load();
        } catch (err) {
          snackbar(err.message, { duration: 6000 });
          btn.disabled = false;
        }
      } })));
    const waiting = updates.filter((u) => u.status === 'new');

    body.replaceChildren(...[
      h('section.section',
        h('div.section-head', h('h2.with-icon', h('span.sec-icon', icon('bookmark_added')), t('Series you follow'), data.follows.length > 0 && h('span.sec-count', String(data.follows.length)))),
        cards.length
          ? stagger(h('div.follow-list', cards))
          : emptyState('notifications_active', t('You’re not following anything yet'), t('Open a manga or comic in Content Finder and tap Follow, or turn on “Watch my downloads” above.'), button(t('Open Content Finder'), { icon: 'travel_explore', onclick: () => navigate('/finder') }))),
      updates.length > 0 && h('section.section',
        h('div.section-head',
          h('h2.with-icon', h('span.sec-icon', icon('new_releases')), t('Updates'), h('span.sec-count', String(updates.length))),
          waiting.length > 1 && button(t('Download all {length}', { length: waiting.length }), { variant: 'tonal', icon: 'download', onclick: async () => {
            for (const u of waiting) await api.downloadUpdate(u.id).catch(() => {});
            snackbar(t('Downloading {length} chapters', { length: waiting.length }));
            load();
          } })),
        h('div.list.card', rows)),
    ].filter(Boolean));
  }

  drawWatch();
  await load();
}
