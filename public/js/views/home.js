import { api, can } from '../api.js';
import { prefs } from '../prefs.js';
import { isAdmin, session, render } from '../router.js';
import { h, icon, skeleton, emptyState, stagger, pageHeader, cover, formatDuration } from '../ui.js';
import { t, plural, currentLanguage } from '../i18n.js';
import { seriesCard, resumeCard } from '../components/cards.js';
import { scanIndicator } from './scan.js';
import { refreshShell } from '../shell.js';

const KIND_ICON = { books: 'menu_book', manga: 'auto_stories', comics: 'photo_library' };

export async function homeView(view, params, stale) {
  const page = h('div.page.home-page');
  view.append(page);
  page.append(skeleton('home'));
  const scan = isAdmin()
    ? scanIndicator(() => {
        refreshShell();
        render();
      })
    : null;

  const data = await api.home();
  if (stale()) return;
  page.replaceChildren();

  const hour = new Date().getHours();
  const greet = hour < 5 ? t('Good night') : hour < 12 ? t('Good morning') : hour < 18 ? t('Good afternoon') : t('Good evening');
  const totalItems = data.libraries.reduce((a, l) => a + l.bookCount, 0);
  const totalSeries = data.libraries.reduce((a, l) => a + l.seriesCount, 0);
  const current = data.continueReading[0];
  const actions = [
    current && h('a.btn.filled.state', { href: `#/read/${current.id}`, title: t('Continue {title}', { title: current.series || current.title }) },
      icon('play_arrow', 'filled'), h('span.btn-label', t('Continue reading'))),
    h(`a.btn.${current ? 'tonal' : 'filled'}.state`, { href: '#/library' }, icon('local_library'), t('Browse library')),
  ];
  const progress = Math.round(Math.max(0, Math.min(1, Number(current?.progress?.percent) || 0)) * 100);
  const spotlight = current ? h('a.reading-spotlight.state', { href: `#/read/${current.id}`, 'aria-label': t('Continue {title}', { title: current.series || current.title }) },
    h('div.spotlight-art', cover(current, { showProgress: false })),
    h('div.spotlight-info',
      h('span.spotlight-kicker', icon('auto_stories'), t('On your bedside table')),
      h('h2', current.series || current.title),
      h('p', current.series && current.label !== current.series ? current.label : current.author || ''),
      h('div.spotlight-progress',
        h('div.progress', { role: 'progressbar', 'aria-label': t('Reading progress'), 'aria-valuenow': progress, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: { width: `${progress}%` } })),
        h('span', t('{percent}% read', { percent: progress }))),
      h('span.spotlight-resume', t('Pick up where you left off'), icon('arrow_forward'))))
    : h('div.reading-invitation', icon('auto_stories'), h('span', t('There is a story for every mood.')));
  page.append(
    h('div.home-welcome',
      h('span', t('{greeting}, {name}', { greeting: greet, name: session.user.displayName })),
      h('span.home-date', new Date().toLocaleDateString(currentLanguage(), { weekday: 'long', month: 'long', day: 'numeric' }))),
    h('section.hero.home-hero.enter',
      h('div.hero-text',
        h('div.hero-eyebrow', icon('local_library'), t('Your personal reading room')),
        h('h1', t('Your next chapter starts here.')),
        h('p', current ? t('A familiar story, or a new favourite. Make a little time for yourself.') : t('Your library is ready when you are.')),
        h('div.hero-actions', actions.filter(Boolean)),
        h('div.home-library-count',
          plural(totalSeries, '{n} series', '{n} series'), h('span', { 'aria-hidden': 'true' }, ' / '),
          plural(totalItems, '{n} book', '{n} books'), scan)),
      spotlight),
    h('nav.home-shortcuts', { 'aria-label': t('Reading shortcuts') },
      [
        ['bookmark_heart', t('Want to read'), t('Your next great read'), '#/want-to-read'],
        ['format_list_numbered', t('Reading lists'), t('A story in the right order'), '#/reading-lists'],
        ['collections_bookmark', t('Collections'), t('Your shelves, your way'), '#/collections'],
        ['insights', t('Reading stats'), t('A little progress, every day'), '#/stats'],
      ].map(([ic, title, sub, href]) => h('a.home-shortcut.state', { href },
        h('span.shortcut-icon', icon(ic)), h('div', h('span.shortcut-title', title), h('span.shortcut-sub', sub)), icon('arrow_outward')))),
  );
  // Streak, this week, yearly goal: filled in when the stats arrive.
  const glance = h('section.glance', { hidden: true });
  api.stats(7).then((s) => glance.isConnected && fillGlance(glance, s, data)).catch(() => {});

  if (!data.libraries.length) {
    page.append(
      isAdmin()
        ? emptyState('library_add', t('Add your first library'), t('Point Flyleaf at a folder of EPUB, MOBI, PDF, CBZ, CBR or CB7 files and it will index them for you.'),
            h('a.btn.filled.state', { href: '#/settings/libraries' }, icon('create_new_folder'), t('Add a library')))
        : emptyState('shelves', t('Nothing here yet'), t('The owner hasn’t added any libraries yet.')),
    );
    return;
  }

  const reload = () => render();
  const shelf = (title, ic, items, href, build = (s) => seriesCard(s, { onChange: reload })) =>
    items.length > 0 &&
    h('section.section.enter',
      sectionHead(title, ic, `${items.length}${items.length >= 12 ? '+' : ''}`, href),
      stagger(h('div.shelf', items.map(build))),
    );

  // append() would print false/null as text, so leave out sections with nothing to show.
  // Recommendations load after the rest of the page, so they never slow it down.
  const recs = h('section.section.recs', { hidden: true });
  api.recommendations(18).then((list) => {
    if (!list.length || !recs.isConnected) return;
    recs.append(
      sectionHead(t('Recommended for you'), 'auto_awesome', null, '#/recommended'),
      stagger(h('div.shelf', list.map((s) => recCard(s, reload)))),
    );
    recs.hidden = false;
  }).catch(() => {});

  // Suggestions from Content Finder sources (slow, cached on the server; loaded last).
  const discover = h('section.section.recs', { hidden: true });
  if (finderRecsOn()) {
    api.finderRecommendations().then((r) => {
      if (!r.items.length || !discover.isConnected) return;
      discover.append(
        sectionHead(t('Discover in Content Finder'), 'travel_explore', null, '#/recommended'),
        stagger(h('div.shelf', r.items.slice(0, 18).map(finderRecCard))),
      );
      discover.hidden = false;
    }).catch(() => {});
  }

  // Genres as a tag cloud (loaded after the page).
  const genres = h('section.section.enter', { hidden: true });
  api.genres().then((list) => {
    if (!list.length || !genres.isConnected) return;
    const top = list.slice(0, 24);
    const max = top[0].count;
    genres.append(
      sectionHead(t('Browse by genre'), 'category', `${list.length}`),
      h('div.genre-cloud', top.map((g, i) => h('a.genre-pill.state', {
        href: `#/genre/${encodeURIComponent(g.name)}`,
        title: t('{name} · {count} series', { name: g.name, count: g.count }),
        style: { '--h': String(hashHue(g.name)), '--w': String(0.9 + (g.count / max) * 0.3), '--i': String(i) },
      }, h('span.g', g.name), h('span.n', String(g.count))))),
    );
    genres.hidden = false;
  }).catch(() => {});

  // New chapters of series you follow (last two weeks).
  const updates = h('section.section.enter', { hidden: true });
  if (can(session.user, 'contentFinder')) {
    api.followUpdates(30).then((list) => {
      const recent = list.filter((u) => Date.now() - u.foundAt < 14 * 86400_000);
      if (!recent.length || !updates.isConnected) return;
      const STATUS = { new: t('Tap to download'), queued: t('Queued'), downloading: t('Downloading'), done: t('Downloaded'), downloaded: t('Downloaded'), failed: t('Download failed') };
      updates.append(
        sectionHead(t('New chapters'), 'new_releases', `${recent.length}`, '#/finder/following'),
        stagger(h('div.shelf', recent.map((u) => h('a.tile', { href: '#/finder/following', title: `${u.title} · ${u.file.label}` },
          cover({ title: u.title, coverUrl: u.cover }, { showProgress: false }),
          h('div.t-title', u.title),
          h('div.t-sub', `${u.file.label} · ${STATUS[u.status] || u.status}`))))),
      );
      updates.hidden = false;
    }).catch(() => {});
  }

  // Smart shelves (saved filters) set to show on Home, each loaded on its own.
  const shelves = h('div');
  api.smartFilters().then((list) => {
    if (!shelves.isConnected) return;
    for (const f of list.filter((x) => x.onHome)) {
      const sec = h('section.section.enter', { hidden: true });
      shelves.append(sec);
      api.seriesList({ ...f.filter, limit: 18 }).then((r) => {
        if (!r.items.length || !sec.isConnected) return;
        sec.append(
          sectionHead(f.name, 'filter_alt', `${r.items.length}${r.hasMore ? '+' : ''}`, `#/shelf/${f.id}`),
          stagger(h('div.shelf', r.items.map((s) => seriesCard(s, { onChange: reload })))),
        );
        sec.hidden = false;
      }).catch(() => {});
    }
  }).catch(() => {});

  page.append(...[
    data.continueReading.length > 0 &&
      h('section.section.enter', sectionHead(t('Continue reading'), 'play_circle', `${data.continueReading.length}`), stagger(h('div.continue', data.continueReading.map(resumeCard)))),
    glance,
    updates,
    recs,
    discover,
    shelf(t('Want to read'), 'bookmark_heart', data.wantToRead, '#/want-to-read'),
    shelves,
    shelf(t('Recently added'), 'new_releases', data.recentlyAdded, '#/library?sort=added'),
    shelf(t('Recently updated'), 'update', data.recentlyUpdated, '#/library?sort=updated'),
    genres,
    ...libraryGroups(data.libraries).map(([heading, list]) =>
      h('section.section.enter',
        sectionHead(heading, 'shelves', `${list.length}`),
        stagger(h('div.lib-cards', list.map(libraryCard))),
      )),
    exploreTiles(),
  ].filter(Boolean));
}

/** A section heading with an icon badge, an optional count and an optional “See all”. */
function sectionHead(title, ic, count, href) {
  return h('div.section-head',
    h('h2.with-icon', h('span.sec-icon', icon(ic)), title, count && h('span.sec-count', count)),
    href && h('a.btn.text.state', { href }, t('See all'), icon('chevron_right')));
}

/** A stable hue (0–359) for a word, so each genre keeps its colour. */
const hashHue = (s) => [...String(s).toLowerCase()].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

/** A library as a card: a mosaic of its newest covers behind the name and counts. */
function libraryCard(l) {
  const mosaic = h('div.lib-mosaic');
  const card = h('a.lib-card.state', { href: `#/library/${l.id}` },
    mosaic,
    h('div.lib-info',
      h('span.lib-icon', icon(l.own ? 'folder_special' : KIND_ICON[l.kind])),
      h('div.lib-text',
        h('div.title-medium', l.name),
        h('div.body-small', `${plural(l.seriesCount, '{n} series', '{n} series')} · ${l.kind === 'books' ? plural(l.bookCount, '{n} book', '{n} books') : plural(l.bookCount, '{n} volume or chapter', '{n} volumes & chapters')}`)),
      icon('arrow_forward')));
  api.seriesList({ library: l.id, sort: 'added', limit: 4 }).then((r) => {
    const covers = r.items.filter((s) => s.coverUrl && !s.blur).map((s) => s.coverUrl);
    // --off: distance from the middle cover, so they fan out evenly from the centre.
    mosaic.replaceChildren(...covers.map((url, i) => h('span', { style: { backgroundImage: `url("${url}")`, '--off': String(i - (covers.length - 1) / 2) } })));
    card.classList.toggle('has-art', covers.length > 0);
  }).catch(() => {});
  return card;
}

/** Shortcuts to the rest of the app, so the bottom of Home isn't a dead end. */
function exploreTiles() {
  const u = session.user;
  const tiles = [
    ['insights', t('Reading stats'), t('Streaks, goals and your year in review'), '#/stats'],
    ['bookmarks', t('Bookmarks & notes'), t('Everything you’ve highlighted and saved'), '#/bookmarks'],
    ['collections_bookmark', t('Collections'), t('Your own lists of series'), '#/collections'],
    can(u, 'contentFinder') && ['travel_explore', t('Content Finder'), t('Search sources and download new books'), '#/finder'],
    can(u, 'upload') && ['upload', t('Upload'), t('Add files from this device'), '#/upload'],
    ['tune', t('Settings'), t('Themes, reading profiles and more'), '#/settings'],
  ].filter(Boolean);
  return h('section.section.enter',
    sectionHead(t('Explore'), 'explore'),
    h('div.explore-grid', tiles.map(([ic, title, s, href], i) =>
      h('a.explore-tile.state', { href, style: { '--i': String(i) } }, h('span.f-icon', icon(ic)), h('div', h('div.title-small', title), h('div.body-small', s))))));
}

/** The “at a glance” row: streak, this week, yearly goal, today. */
function fillGlance(el, s, data) {
  const week = s.daily.reduce((a, d) => a + d.seconds, 0);
  const days = [];
  const start = new Date(`${s.startDay}T00:00:00`);
  const byDay = new Map(s.daily.map((d) => [d.day, d.seconds]));
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ sec: byDay.get(iso) || 0, today: iso === s.today, label: d.toLocaleDateString(undefined, { weekday: 'narrow' }) });
  }
  const max = Math.max(60, ...days.map((d) => d.sec));
  const goal = s.goal;
  const best = s.longestStreak?.days || 0;
  const todayMin = Math.floor(s.todaySeconds / 60);
  const tile = (ic, value, label, extra, href = '#/stats') =>
    h('a.glance-tile.state', { href }, h('div.glance-top', h('span.f-icon', icon(ic)), extra), h('div.glance-value', value), h('div.glance-label', label));
  el.replaceChildren(
    tile('local_fire_department', plural(s.streak, '{n} day', '{n} days'), best > s.streak ? t('Reading streak · best {n}', { n: best }) : t('Reading streak'),
      h('div.flames', Array.from({ length: Math.min(7, s.streak || 0) }, () => icon('local_fire_department', 'filled')))),
    tile('schedule', formatDuration(week, { short: true }), t('This week'),
      h('div.spark', days.map((d) => h(`span${d.today ? '.today' : ''}`, { style: { height: `${d.sec ? Math.max(12, (d.sec / max) * 100) : 6}%` }, title: d.label })))),
    // A pages goal on its own shows pages; otherwise books.
    !goal.books && goal.pages
      ? tile('flag', `${(goal.pagesRead || 0).toLocaleString()} / ${goal.pages.toLocaleString()}`, t('{year} pages goal', { year: goal.year }),
        h('div.mini-ring', { style: { '--p': String(Math.min(1, (goal.pagesRead || 0) / goal.pages)) } }))
      : tile('flag', goal.books ? `${goal.finished} / ${goal.books}` : String(goal.finished), goal.books ? t('{year} goal', { year: goal.year }) : t('Finished in {year}', { year: goal.year }),
        goal.books && h('div.mini-ring', { style: { '--p': String(Math.min(1, goal.finished / goal.books)) } })),
    tile('today', t('{n} min', { n: todayMin }), s.dailyGoalMinutes ? t('Today · goal {n} min', { n: s.dailyGoalMinutes }) : t('Read today'),
      s.dailyGoalMinutes > 0 && h('div.mini-ring', { style: { '--p': String(Math.min(1, todayMin / s.dailyGoalMinutes)) } })),
  );
  el.hidden = false;
}

/** A series card whose subtitle says why it was recommended. */
export function recCard(s, onChange) {
  const card = seriesCard(s, { onChange });
  const sub = card.querySelector('.t-sub');
  if (sub && s.reason) {
    card.classList.add('rec-card');
    sub.textContent = s.reason;
    sub.title = s.reason;
  }
  return card;
}

const finderRecsOn = () => can(session.user, 'contentFinder') && prefs().finderRecs?.enabled !== false;

/** A suggestion from a Content Finder source: opens it there, ready to download. */
export function finderRecCard(r) {
  const href = `#/finder?source=${encodeURIComponent(r.source.id)}&open=${encodeURIComponent(r.item.id)}&title=${encodeURIComponent(r.item.title)}`;
  return h('a.tile.rec-card.finder-rec', { href, title: `${r.item.title}${r.item.author ? ` – ${r.item.author}` : ''}` },
    cover({ title: r.item.title, coverUrl: r.item.cover, format: r.source.kinds?.[0] === 'books' ? 'epub' : 'cbz' }, { showProgress: false }),
    h('span.finder-rec-src', r.source.icon ? h('img', { src: r.source.icon, alt: '', loading: 'lazy' }) : icon('travel_explore'), r.source.name),
    h('div.t-title', r.item.title),
    h('div.t-sub', r.reason));
}

/** All recommendations, as a grid. */
export async function recommendedView(view, params, stale) {
  const page = h('div.page');
  view.append(page);
  page.append(pageHeader(t('Recommended for you')), h('p.muted.enter', { style: { marginTop: '-14px', marginBottom: '16px' } },
    t('Picked from what you read, finish, rate and save. Series you’ve started or saved aren’t repeated here.')));
  const body = h('div', skeleton('grid'));
  page.append(body);
  const list = await api.recommendations(60);
  if (stale()) return;
  body.replaceChildren(list.length
    ? stagger(h('div.grid', list.map((s) => recCard(s, () => render()))))
    : emptyState('recommend', t('Nothing to recommend yet'), t('Read a few books, or mark series as completed or Want to read, and suggestions will show up here.')));

  if (!finderRecsOn()) return;
  // From Content Finder: can take a while the first time, since it searches the sources.
  const status = h('p.muted');
  const grid = h('div', skeleton('grid'));
  const refresh = h('a.btn.text.state', { href: '#/settings/preferences' }, icon('tune'), t('Choose sources'));
  page.append(h('section.section', h('div.section-head', h('h2', t('Discover in Content Finder')), refresh), status, grid));
  const show = async (force) => {
    grid.replaceChildren(skeleton('grid'));
    status.textContent = force ? t('Searching your sources again…') : '';
    try {
      const r = await api.finderRecommendations(force);
      if (stale()) return;
      status.textContent = r.items.length
        ? t('From {value} · updated {value2}', { value: r.sources.join(', '), value2: new Date(r.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) })
        : '';
      const again = h('button.btn.text.state', { type: 'button', onclick: () => show(true) }, icon('refresh'), t('Search again'));
      status.append(' ', again);
      grid.replaceChildren(r.items.length
        ? stagger(h('div.grid', r.items.map(finderRecCard)))
        : emptyState('travel_explore', t('No suggestions from Content Finder'), {
            'no-history': t('Read a few books first, so there’s something to go on.'),
            'no-sources': t('None of your chosen sources are ready. Pick sources in Settings → Preferences.'),
          }[r.reason] || t('Your sources didn’t return anything new. Try other sources in Settings → Preferences.')));
    } catch (e) {
      grid.replaceChildren(emptyState('cloud_off', t('Couldn’t reach your sources'), e.message));
    }
  };
  show(false);
}

/** Your own libraries and the shared ones, as separate sections. */
function libraryGroups(libraries) {
  const mine = libraries.filter((l) => l.own);
  const shared = libraries.filter((l) => !l.personal);
  return [
    mine.length > 0 && [t('My libraries'), mine],
    shared.length > 0 && [mine.length ? t('Shared libraries') : t('Libraries'), shared],
  ].filter(Boolean);
}
