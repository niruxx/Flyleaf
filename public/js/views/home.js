import { api } from '../api.js';
import { isAdmin, session, render } from '../router.js';
import { h, icon, skeleton, emptyState, stagger, pageHeader } from '../ui.js';
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

  page.append(...[
    data.continueReading.length > 0 &&
      h('section.section.enter', h('div.section-head', h('h2', 'Continue reading')), stagger(h('div.continue', data.continueReading.map(resumeCard)))),
    recs,
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
