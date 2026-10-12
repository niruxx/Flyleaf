import { api, can } from '../api.js';
import { prefs } from '../prefs.js';
import { isAdmin, session, render } from '../router.js';
import { h, icon, skeleton, emptyState, stagger, pageHeader, cover } from '../ui.js';
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
  page.append(
    h('section.hero.enter',
      h('h1', `${greet}, ${session.user.displayName}`),
      h('p', data.continueReading.length ? 'Pick up where you left off, or find something new.' : 'Your library is ready when you are.'),
      h('div.stats-row',
        h('span.chip', icon('collections_bookmark'), `${totalSeries} series`),
        h('span.chip', icon('book_2'), `${totalItems} books`),
        data.wantToRead.length > 0 && h('a.chip', { href: '#/want-to-read' }, icon('bookmark_heart'), `${data.wantToRead.length} want to read`),
        scan,
      ),
    ),
  );

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
  const shelf = (title, items, href, build = (s) => seriesCard(s, { onChange: reload })) =>
    items.length > 0 &&
    h('section.section.enter',
      h('div.section-head', h('h2', title), href && h('a.btn.text.state', { href }, 'See all', icon('chevron_right'))),
      stagger(h('div.shelf', items.map(build))),
    );

  // append() would print false/null as text, so leave out sections with nothing to show.
  // Recommendations load after the rest of the page, so they never slow it down.
  const recs = h('section.section.recs', { hidden: true });
  api.recommendations(18).then((list) => {
    if (!list.length || !recs.isConnected) return;
    recs.append(
      h('div.section-head', h('h2', 'Recommended for you'), h('a.btn.text.state', { href: '#/recommended' }, 'See all', icon('chevron_right'))),
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
        h('div.section-head', h('h2', 'Discover in Content Finder'), h('a.btn.text.state', { href: '#/recommended' }, 'See all', icon('chevron_right'))),
        stagger(h('div.shelf', r.items.slice(0, 18).map(finderRecCard))),
      );
      discover.hidden = false;
    }).catch(() => {});
  }

  page.append(...[
    data.continueReading.length > 0 &&
      h('section.section.enter', h('div.section-head', h('h2', 'Continue reading')), stagger(h('div.continue', data.continueReading.map(resumeCard)))),
    recs,
    discover,
    shelf('Want to read', data.wantToRead, '#/want-to-read'),
    shelf('Recently added', data.recentlyAdded, '#/library?sort=added'),
    shelf('Recently updated', data.recentlyUpdated, '#/library?sort=updated'),
    ...libraryGroups(data.libraries).map(([heading, list]) =>
      h('section.section.enter',
        h('div.section-head', h('h2', heading)),
        stagger(h('div.list.card', { style: { padding: '8px 0', borderRadius: 'var(--shape-xl)' } },
          list.map((l) =>
            h('a.list-item.state', { href: `#/library/${l.id}` },
              icon(l.own ? 'folder_special' : KIND_ICON[l.kind]),
              h('div.text', h('div.headline', l.name), h('div.supporting', `${l.seriesCount} series · ${l.bookCount} ${l.kind === 'books' ? 'books' : 'volumes & chapters'}${l.own && l.path ? ` · ${l.path}` : ''}`)),
              icon('chevron_right'),
            ),
          ),
        )),
      )),
  ].filter(Boolean));
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
