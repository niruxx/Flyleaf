import { api, can } from '../api.js';
import { prefs } from '../prefs.js';
import { isAdmin, session, render } from '../router.js';
import { h, icon, skeleton, emptyState, stagger, pageHeader, cover, formatDuration } from '../ui.js';
import { seriesCard, resumeCard } from '../components/cards.js';
import { scanIndicator } from './scan.js';
import { refreshShell } from '../shell.js';

const KIND_ICON = { books: 'menu_book', manga: 'auto_stories', comics: 'photo_library' };

export async function homeView(view, params, stale) {
  const page = h('div.page');
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
  const greet = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const totalItems = data.libraries.reduce((a, l) => a + l.bookCount, 0);
  const totalSeries = data.libraries.reduce((a, l) => a + l.seriesCount, 0);
  const current = data.continueReading[0];
  const actions = [
    // Long titles are cut with “…” so the button keeps its padding.
    current && h('a.btn.filled.state', { href: `#/read/${current.id}`, title: `Continue ${current.series || current.title}` },
      icon('play_arrow', 'filled'), h('span.btn-label', `Continue ${current.series || current.title}`)),
    h('a.btn.tonal.state', { href: '#/library' }, icon('local_library'), 'Browse library'),
    can(session.user, 'contentFinder') && h('a.btn.outlined.state', { href: '#/finder' }, icon('travel_explore'), 'Find books'),
  ];
  // A fan of covers: what you're reading, then what's new.
  const fanItems = [...data.continueReading, ...data.recentlyAdded].filter((x) => x.coverUrl && !x.blur).slice(0, 5);
  page.append(
    h('section.hero.home-hero.enter',
      h('div.hero-glow'),
      h('div.hero-text',
        h('div.hero-eyebrow', new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })),
        h('h1', `${greet}, ${session.user.displayName}`),
        h('p', current
          ? `You’re on ${current.label && current.series ? `${current.label} of ${current.series}` : current.title}. Pick up where you left off, or find something new.`
          : 'Your library is ready when you are.'),
        h('div.stats-row',
          h('a.chip.state', { href: '#/library' }, icon('collections_bookmark'), `${totalSeries} series`),
          h('span.chip', icon('book_2'), `${totalItems} books`),
          data.wantToRead.length > 0 && h('a.chip.state', { href: '#/want-to-read' }, icon('bookmark_heart'), `${data.wantToRead.length} want to read`),
          scan,
        ),
        h('div.hero-actions', actions.filter(Boolean)),
      ),
      fanItems.length > 0 && h('div.hero-fan', { 'aria-hidden': 'true' }, fanItems.map((x, i) =>
        h('a.fan-cover', { href: x.seriesId ? `#/series/${x.seriesId}` : `#/series/${x.id}`, tabindex: '-1', style: { '--i': String(i), '--n': String(fanItems.length), backgroundImage: `url("${x.coverUrl}")` } }))),
    ),
  );
  // Streak, this week, yearly goal: filled in when the stats arrive.
  const glance = h('section.glance', { hidden: true });
  page.append(glance);
  api.stats(7).then((s) => glance.isConnected && fillGlance(glance, s, data)).catch(() => {});

  if (!data.libraries.length) {
    page.append(
      isAdmin()
        ? emptyState('library_add', 'Add your first library', 'Point Flyleaf at a folder of EPUB, MOBI, PDF, CBZ, CBR or CB7 files and it will index them for you.',
            h('a.btn.filled.state', { href: '#/settings/libraries' }, icon('create_new_folder'), 'Add a library'))
        : emptyState('shelves', 'Nothing here yet', 'The owner hasn’t added any libraries yet.'),
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
      sectionHead('Recommended for you', 'auto_awesome', null, '#/recommended'),
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
        sectionHead('Discover in Content Finder', 'travel_explore', null, '#/recommended'),
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
      sectionHead('Browse by genre', 'category', `${list.length}`),
      h('div.genre-cloud', top.map((g, i) => h('a.genre-pill.state', {
        href: `#/genre/${encodeURIComponent(g.name)}`,
        title: `${g.name} · ${g.count} series`,
        style: { '--h': String(hashHue(g.name)), '--w': String(0.9 + (g.count / max) * 0.3), '--i': String(i) },
      }, h('span.g', g.name), h('span.n', String(g.count))))),
    );
    genres.hidden = false;
  }).catch(() => {});

  page.append(...[
    data.continueReading.length > 0 &&
      h('section.section.enter', sectionHead('Continue reading', 'play_circle', `${data.continueReading.length}`), stagger(h('div.continue', data.continueReading.map(resumeCard)))),
    recs,
    discover,
    shelf('Want to read', 'bookmark_heart', data.wantToRead, '#/want-to-read'),
    shelf('Recently added', 'new_releases', data.recentlyAdded, '#/library?sort=added'),
    shelf('Recently updated', 'update', data.recentlyUpdated, '#/library?sort=updated'),
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
    href && h('a.btn.text.state', { href }, 'See all', icon('chevron_right')));
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
        h('div.body-small', `${l.seriesCount} series · ${l.bookCount} ${l.kind === 'books' ? 'books' : 'volumes & chapters'}`)),
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
    ['insights', 'Reading stats', 'Streaks, goals and your year in review', '#/stats'],
    ['bookmarks', 'Bookmarks & notes', 'Everything you’ve highlighted and saved', '#/bookmarks'],
    ['collections_bookmark', 'Collections', 'Your own lists of series', '#/collections'],
    can(u, 'contentFinder') && ['travel_explore', 'Content Finder', 'Search sources and download new books', '#/finder'],
    can(u, 'upload') && ['upload', 'Upload', 'Add files from this device', '#/upload'],
    ['tune', 'Settings', 'Themes, reading profiles and more', '#/settings'],
  ].filter(Boolean);
  return h('section.section.enter',
    sectionHead('Explore', 'explore'),
    h('div.explore-grid', tiles.map(([ic, t, s, href], i) =>
      h('a.explore-tile.state', { href, style: { '--i': String(i) } }, h('span.f-icon', icon(ic)), h('div', h('div.title-small', t), h('div.body-small', s))))));
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
    tile('local_fire_department', `${s.streak} ${s.streak === 1 ? 'day' : 'days'}`, best > s.streak ? `Reading streak · best ${best}` : 'Reading streak',
      h('div.flames', Array.from({ length: Math.min(7, s.streak || 0) }, () => icon('local_fire_department', 'filled')))),
    tile('schedule', formatDuration(week, { short: true }), 'This week',
      h('div.spark', days.map((d) => h(`span${d.today ? '.today' : ''}`, { style: { height: `${d.sec ? Math.max(12, (d.sec / max) * 100) : 6}%` }, title: d.label })))),
    tile('flag', goal.books ? `${goal.finished} / ${goal.books}` : String(goal.finished), goal.books ? `${goal.year} goal` : `Finished in ${goal.year}`,
      goal.books && h('div.mini-ring', { style: { '--p': String(Math.min(1, goal.finished / goal.books)) } })),
    tile('today', `${todayMin} min`, s.dailyGoalMinutes ? `Today · goal ${s.dailyGoalMinutes} min` : 'Read today',
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
  page.append(pageHeader('Recommended for you'), h('p.muted.enter', { style: { marginTop: '-14px', marginBottom: '16px' } },
    'Picked from what you read, finish, rate and save. Series you’ve started or saved aren’t repeated here.'));
  const body = h('div', skeleton('grid'));
  page.append(body);
  const list = await api.recommendations(60);
  if (stale()) return;
  body.replaceChildren(list.length
    ? stagger(h('div.grid', list.map((s) => recCard(s, () => render()))))
    : emptyState('recommend', 'Nothing to recommend yet', 'Read a few books, or mark series as completed or Want to read, and suggestions will show up here.'));

  if (!finderRecsOn()) return;
  // From Content Finder: can take a while the first time, since it searches the sources.
  const status = h('p.muted');
  const grid = h('div', skeleton('grid'));
  const refresh = h('a.btn.text.state', { href: '#/settings/preferences' }, icon('tune'), 'Choose sources');
  page.append(h('section.section', h('div.section-head', h('h2', 'Discover in Content Finder'), refresh), status, grid));
  const show = async (force) => {
    grid.replaceChildren(skeleton('grid'));
    status.textContent = force ? 'Searching your sources again…' : '';
    try {
      const r = await api.finderRecommendations(force);
      if (stale()) return;
      status.textContent = r.items.length
        ? `From ${r.sources.join(', ')} · updated ${new Date(r.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        : '';
      const again = h('button.btn.text.state', { type: 'button', onclick: () => show(true) }, icon('refresh'), 'Search again');
      status.append(' ', again);
      grid.replaceChildren(r.items.length
        ? stagger(h('div.grid', r.items.map(finderRecCard)))
        : emptyState('travel_explore', 'No suggestions from Content Finder', {
            'no-history': 'Read a few books first, so there’s something to go on.',
            'no-sources': 'None of your chosen sources are ready. Pick sources in Settings → Preferences.',
          }[r.reason] || 'Your sources didn’t return anything new. Try other sources in Settings → Preferences.'));
    } catch (e) {
      grid.replaceChildren(emptyState('cloud_off', 'Couldn’t reach your sources', e.message));
    }
  };
  show(false);
}

/** Your own libraries and the shared ones, as separate sections. */
function libraryGroups(libraries) {
  const mine = libraries.filter((l) => l.own);
  const shared = libraries.filter((l) => !l.personal);
  return [
    mine.length > 0 && ['My libraries', mine],
    shared.length > 0 && [mine.length ? 'Shared libraries' : 'Libraries', shared],
  ].filter(Boolean);
}
