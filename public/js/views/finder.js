// Content Finder: search plugin sources and download books, manga and comics
// into your libraries.

import { api, can } from '../api.js';
import { session, isAdmin, navigate, onLeave } from '../router.js';
import { h, icon, iconButton, button, cover, dialog, snackbar, loading, skeleton, emptyState, stagger, field, formatBytes, timeAgo, libraryOptions, confirmDialog } from '../ui.js';

const KIND_LABEL = { books: 'Books', manga: 'Manga', comics: 'Comics' };
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
    view.append(emptyState('lock', 'Content Finder isn’t enabled', 'Ask the admin to turn on Content Finder for your account.'));
    return;
  }
  view.append(loading());
  const [sources, libraries] = await Promise.all([api.finderSources(), api.libraries(isAdmin() ? 'all' : undefined)]);
  if (stale()) return;
  view.replaceChildren();

  const downloadsBtn = button('Downloads', { variant: 'tonal', icon: 'download', onclick: () => navigate('/finder/downloads') });
  const head = h('div.page-head.enter', h('h1', 'Content Finder'),
    h('div.finder-actions', downloadsBtn,
      isAdmin() && button('Plugins', { variant: 'text', icon: 'tune', onclick: () => navigate('/settings/plugins') })));

  if (!sources.length) {
    view.append(h('div.page', head, emptyState('extension_off', 'No sources yet', isAdmin() ? 'Install a plugin to start finding books.' : 'The admin hasn’t installed any sources yet.',
      isAdmin() && button('Install plugins', { icon: 'extension', onclick: () => navigate('/settings/plugins') }))));
    return;
  }

  const ready = sources.filter((s) => !s.needsSetup && !s.error);
  let current = params.query.get('source') || readLast();
  if (current !== ALL && !sources.some((s) => s.id === current)) current = ready.length > 1 ? ALL : (ready[0] || sources[0]).id;
  const stack = []; // folder navigation: [{ id, title }]
  let query = params.query.get('q') || '';
  let pageNo = 1;
  let token = 0;

  const chips = h('div.source-chips', { role: 'tablist' });
  function renderChips() {
    chips.replaceChildren(...[
      ready.length > 1 && h('button.chip.state', { type: 'button', role: 'tab', 'aria-pressed': String(current === ALL), onclick: () => pick(ALL) }, icon('travel_explore'), 'All sources'),
      ...sources.map((s) => h('button.chip.state', { type: 'button', role: 'tab', 'aria-pressed': String(current === s.id), title: s.description || s.name, onclick: () => pick(s.id) },
        sourceIcon(s), s.name, (s.needsSetup || s.error) && icon('warning'))),
    ].filter(Boolean));
  }
  function pick(id) {
    current = id;
    saveLast(id);
    stack.length = 0;
    renderChips();
    run(true);
  }

  const input = h('input', { type: 'search', placeholder: 'Search…', value: query, 'aria-label': 'Search sources', enterkeyhint: 'search', autocomplete: 'off' });
  const searchBar = h('form.finder-search', { onsubmit: (e) => {
    e.preventDefault();
    query = input.value.trim();
    stack.length = 0;
    const q = new URLSearchParams({ ...(current ? { source: current } : {}), ...(query ? { q: query } : {}) });
    history.replaceState(null, '', `#/finder${q.toString() ? `?${q}` : ''}`);
    run(true);
  } }, icon('search'), input, query && iconButton('close', 'Clear', () => {
    input.value = '';
    query = '';
    run(true);
  }));
  const crumbs = h('div.finder-crumbs');
  const results = h('div.finder-results');
  const more = h('div.finder-more');

  view.append(h('div.page.finder', head,
    h('p.body-medium.muted.enter', { style: { margin: '-8px 0 16px' } }, 'Search the sources your admin has installed and download straight into a library. Only download books you’re allowed to.'),
    chips, searchBar, crumbs, results, more));
  renderChips();

  const sourceById = (id) => sources.find((s) => s.id === id);

  function tile(src, item) {
    const el = h('button.tile.finder-tile', { type: 'button', title: item.title, onclick: () => (item.folder ? openFolder(item) : openDetails(src, item)) },
      item.folder
        ? h('div.cover.folder-cover', icon('folder', 'filled'), h('div.ph-title', item.title))
        : cover({ title: item.title, coverUrl: item.cover, format: src.kinds?.[0] === 'books' ? 'epub' : 'cbz' }, { showProgress: false }),
      h('div.t-title', item.title),
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
    input.placeholder = current === ALL ? 'Search every source…' : `Search ${sourceById(current)?.name || ''}…`;

    if (current === ALL) {
      if (!query) {
        results.replaceChildren(h('div.source-cards', ready.map((s) => h('button.source-card.state', { type: 'button', onclick: () => pick(s.id) },
          h('div.source-card-head', sourceIcon(s, 32), h('div', h('div.title-medium', s.name), h('div.body-small.muted', (s.kinds || []).map((k) => KIND_LABEL[k]).join(' · ')))),
          s.description && h('p.body-medium.muted', s.description)))));
        return;
      }
      // Search every ready source in parallel; each gets its own row.
      results.replaceChildren();
      for (const s of ready) {
        const section = h('section.finder-section', h('div.finder-section-head', sourceIcon(s), h('h2.title-medium', s.name),
          h('button.btn.text.state', { type: 'button', onclick: () => pick(s.id) }, 'See all', icon('chevron_right'))), loading());
        results.append(section);
        api.finderSearch(s.id, query, 1).then((r) => {
          if (my !== token) return;
          section.lastChild.replaceWith(r.items.length
            ? h('div.shelf', r.items.slice(0, 20).map((it) => tile(s, it)))
            : h('p.body-medium.muted.finder-none', 'No matches.'));
        }).catch((e) => my === token && section.lastChild.replaceWith(h('p.body-medium.finder-none.error-text', e.message)));
      }
      return;
    }

    const src = sourceById(current);
    if (src.error) {
      results.replaceChildren(emptyState('cloud_off', `${src.name} isn’t available`, src.error,
        isAdmin() && button('Open plugin settings', { onclick: () => navigate('/settings/plugins') })));
      return;
    }
    if (src.needsSetup) {
      results.replaceChildren(emptyState('settings', `${src.name} needs setting up`, `Missing: ${src.needsSetup.join(', ')}.`,
        isAdmin() && button('Open plugin settings', { onclick: () => navigate('/settings/plugins') })));
      return;
    }
    try {
      const r = await fetchPage(src, pageNo);
      if (my !== token) return;
      if (reset) results.replaceChildren();
      if (r.needsQuery) {
        results.replaceChildren(emptyState('search', `Search ${src.name}`, 'Type a title or author above.'));
        return;
      }
      if (!r.items.length && pageNo === 1) {
        results.replaceChildren(emptyState('search_off', 'Nothing found', query ? `No results for “${query}” on ${src.name}.` : 'This source has nothing to show.'));
        return;
      }
      let grid = results.querySelector('.grid');
      if (!grid) {
        if (!query && !stack.length) results.append(h('h2.title-medium.finder-label', 'Popular'));
        grid = stagger(h('div.grid'));
        results.append(grid);
      }
      grid.append(...r.items.map((it) => tile(src, it)));
      // No more pages: leave it empty (replaceChildren would print a null as the text "null").
      more.replaceChildren(...(r.hasMore ? [button('Load more', { variant: 'tonal', icon: 'expand_more', onclick: (e) => {
        e.currentTarget.disabled = true;
        pageNo++;
        run(false);
      } })] : []));
    } catch (e) {
      if (my !== token) return;
      results.replaceChildren(emptyState('cloud_off', `${src.name} didn’t respond`, e.message, button('Try again', { variant: 'tonal', icon: 'refresh', onclick: () => run(true) })));
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
          body.replaceChildren(emptyState('error', 'Couldn’t load this item', e.message), h('div.dialog-actions', button('Close', { variant: 'text', onclick: () => close() })));
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
    const lib = field('Save to library', { value: preferred?.id ?? '', options: libraryOptions(usable, (l) => `${l.name} (${KIND_LABEL[l.kind]})`) });

    const many = d.files.length > 1;
    // Books: offer one format (the plugin lists the best first). Manga/comics: chapters/volumes, pick any.
    const singleChoice = src.kinds?.[0] === 'books' || d.files.every((f) => f.format && ['epub', 'azw3', 'mobi', 'pdf', 'fb2', 'txt'].includes(f.format));
    const rows = d.files.map((f, i) => {
      const input = h('input', { type: singleChoice ? 'radio' : 'checkbox', name: 'finder-file', checked: singleChoice ? i === 0 : !many });
      input.dataset.index = i;
      return h('label.file-row', input,
        h('div', h('div.body-large', f.title || f.format?.toUpperCase() || `File ${i + 1}`),
          h('div.body-small.muted', [f.format?.toUpperCase(), f.size ? formatBytes(f.size) : null, f.volume != null ? `Vol. ${f.volume}` : null, f.chapter != null ? `Ch. ${f.chapter}` : null, f.language, f.date].filter(Boolean).join(' · '))));
    });
    const selectAll = !singleChoice && many && h('label.check', h('input', { type: 'checkbox', onchange: (e) => rows.forEach((r) => (r.querySelector('input').checked = e.target.checked)) }), `Select all ${d.files.length}`);

    const go = button('Download', { icon: 'download', onclick: async () => {
      const picked = rows.map((r) => r.querySelector('input')).filter((x) => x.checked).map((x) => d.files[Number(x.dataset.index)]);
      if (!picked.length) return snackbar('Pick at least one file.');
      if (!lib.input.value) return snackbar('Choose a library first.');
      go.disabled = true;
      try {
        await api.finderDownload(src.id, { libraryId: Number(lib.input.value), book: { title: d.title, author: d.author, series: d.series, ageRating: d.ageRating, layout: d.layout }, files: picked });
        close();
        snackbar(`Downloading ${picked.length === 1 ? `“${d.title}”` : `${picked.length} files`}…`, { action: 'View', onAction: () => navigate('/finder/downloads') });
        import('../shell.js').then((m) => m.refreshDownloadsBadge());
      } catch (e) {
        snackbar(e.message, { duration: 6000 });
        go.disabled = false;
      }
    } });

    return h('div.finder-detail',
      h('div.finder-detail-top',
        cover({ title: d.title, coverUrl: d.cover }, { showProgress: false }),
        h('div.finder-detail-info',
          h('div.label-medium.muted', h('span', sourceIcon(src, 16), ' ', src.name)),
          h('h2.headline-small', d.title),
          d.author && h('p.title-small.muted', d.author),
          d.status && h('span.mini-chip', d.status),
          d.genres.length > 0 && h('div.chip-set', d.genres.slice(0, 10).map((g) => h('span.chip.static', g))),
          d.url && h('a.btn.text.state', { href: d.url, target: '_blank', rel: 'noopener noreferrer' }, icon('open_in_new'), 'View on site'),
        ),
      ),
      d.summary && h('p.body-medium.finder-summary', d.summary),
      d.files.length
        ? h('div', h('div.label-large', { style: { margin: '16px 0 8px' } }, singleChoice ? 'Format' : `Files (${d.files.length})`), selectAll, h('div.file-list', rows))
        : h('p.body-medium.muted', 'This item has nothing to download.'),
      usable.length ? lib : h('p.form-error', icon('error'), session.user.homeDir
        ? h('span', 'Create a library in your personal folder first: ', h('a', { href: '#/settings/mylibs', onclick: () => close() }, 'My libraries'), '.')
        : 'You don’t have access to any library to save into.'),
      h('div.dialog-actions', button('Cancel', { variant: 'text', onclick: () => close() }), d.files.length > 0 && usable.length > 0 && go),
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
  view.append(h('div.page', h('div.page-head.downloads-head.enter', iconButton('arrow_back', 'Back', () => navigate('/finder')), h('h1', 'Downloads')), tabs, body));
  let tab = isAdmin() ? params.query.get('user') || 'all' : 'all';

  let timer;
  onLeave(() => clearTimeout(timer));

  // Which chapter/volume a download was, when its title is just the series.
  const titleOf = (d) => {
    const part = d.fileTitle || (d.chapter != null ? `Chapter ${d.chapter}` : d.volume != null ? `Volume ${d.volume}` : null);
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
          d.status === 'downloading' ? `${formatBytes(d.received)}${d.total ? ` of ${formatBytes(d.total)}` : ''}` : null,
          d.status === 'queued' ? 'Waiting…' : null,
          d.status === 'done' ? `Added to ${d.library || 'library'} · ${timeAgo(d.finishedAt)}` : null,
          failed(d) ? `${d.error}${d.finishedAt ? ` · ${timeAgo(d.finishedAt)}` : ''}` : null,
          cancelled ? `Cancelled${d.finishedAt ? ` · ${timeAgo(d.finishedAt)}` : ''}` : null,
          d.plugin,
          // In a person's own tab the name would just repeat the tab.
          isAdmin() && tab === 'all' && d.userName ? `by ${d.userName}` : null,
        ].filter(Boolean).join(' · ')),
        busy && h('div.progress', pct == null ? { class: 'indeterminate' } : null, h('span', { style: { width: `${pct ?? 30}%` } })),
      ),
      failed(d) && button('Retry', { variant: 'tonal', icon: 'refresh', onclick: run(async () => {
        await api.retryDownload(d.id);
        snackbar(`Retrying “${title}”`);
      }) }),
      cancelled && iconButton('refresh', 'Download again', run(async () => {
        await api.retryDownload(d.id);
        snackbar(`Downloading “${title}” again`);
      })),
      iconButton(busy ? 'close' : 'delete', busy ? 'Cancel' : 'Remove', run(() => api.cancelDownload(d.id))),
    );
  }

  function section(label, rows, { actions = [], empty } = {}) {
    return h('section.downloads-section',
      h('div.downloads-section-head', h('h2', label, rows.length ? h('span.muted', ` (${rows.length})`) : null), ...actions),
      rows.length ? h('div.downloads-list', rows.map(row)) : empty && h('p.note', empty));
  }

  /** One tab per person who has downloads, named after them, plus “All users”. */
  function drawTabs(all) {
    const people = new Map();
    for (const d of all) {
      const key = String(d.userId ?? 'none');
      const p = people.get(key) || { key, name: d.userId == null ? 'Deleted users' : d.userName || d.username || 'Unknown', count: 0, attention: 0 };
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
    }, key === 'all' ? icon('groups') : icon('person'), h('span', label), h('span.count', String(count)), attention > 0 && h('span.dot', { title: `${attention} in progress or failed` }));
    tabs.replaceChildren(
      tabButton('all', 'All users', all.length, all.filter((d) => active(d) || failed(d)).length),
      ...list.map((p) => tabButton(p.key, p.key === me ? `${p.name} (you)` : p.name, p.count, p.attention)),
    );
    tabs.hidden = false;
  }

  async function refresh() {
    clearTimeout(timer);
    let rows;
    try {
      rows = await api.downloads();
    } catch (e) {
      body.replaceChildren(emptyState('error', 'Couldn’t load downloads', e.message));
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
    if (!rows.length) {
      body.replaceChildren(emptyState('download_done', 'No downloads', 'Books you download from Content Finder appear here.', button('Find books', { icon: 'travel_explore', onclick: () => navigate('/finder') })));
      return;
    }
    const inProgress = rows.filter(active);
    const failures = rows.filter(failed);
    const history = rows.filter((d) => !active(d) && !failed(d));
    body.replaceChildren(...[
      inProgress.length > 0 && section('In progress', inProgress),
      section('Failed', failures, {
        empty: 'Nothing has failed.',
        actions: failures.length ? [
          button('Retry all', { variant: 'tonal', icon: 'refresh', onclick: run(async () => {
            const r = await api.retryFailedDownloads(who);
            snackbar(r.retried ? `Retrying ${r.retried} ${r.retried === 1 ? 'download' : 'downloads'}` : 'Nothing to retry');
          }) }),
          button('Clear', { variant: 'text', icon: 'clear_all', onclick: run(async () => {
            if (!(await confirmDialog({ title: 'Clear failed downloads?', message: 'They’re removed from this list and won’t be retried. You can always download them again from Content Finder.', confirm: 'Clear', danger: true }))) return;
            await api.clearDownloads('failed', who);
          }) }),
        ] : [],
      }),
      section('History', history, {
        empty: 'Finished downloads appear here.',
        actions: history.length ? [button('Clear history', { variant: 'text', icon: 'clear_all', onclick: run(() => api.clearDownloads('history', who)) })] : [],
      }),
    ].filter(Boolean));
    if (inProgress.length) timer = setTimeout(refresh, 1500);
  }
  refresh();
}
