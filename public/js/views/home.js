import { api } from '../api.js';
import { onLeave, isAdmin, session } from '../router.js';
import { h, icon, iconButton, topBar, cover, bookTile, loading, emptyState, timeAgo } from '../ui.js';
import { accountButton, scanIndicator, themeToggle } from './common.js';

const KIND_ICON = { books: 'menu_book', manga: 'auto_stories', comics: 'photo_library' };

export async function homeView(view, params, stale) {
  const bar = topBar(
    'Flyleaf',
    iconButton('search', 'Search', () => (location.hash = '#/library?search')),
    themeToggle(),
    accountButton(),
  );
  onLeave(bar.cleanup);
  const page = h('div.page');
  view.append(bar, page);
  page.append(loading());
  const scan = isAdmin() ? scanIndicator(() => load()) : null;

  async function load() {
    const data = await api.home();
    if (stale()) return;
    page.replaceChildren();

    const hour = new Date().getHours();
    const greet = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    page.append(
      h('div.section', { style: { marginTop: '8px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
        h('h2.headline-small', `${greet}, ${session.user.displayName}`),
        scan,
      ),
    );

    if (!data.libraries.length) {
      page.append(
        isAdmin()
          ? emptyState('library_add', 'Add your first library', 'Point Flyleaf at a folder of EPUB, PDF, CBZ or CBR files and it will index them for you.',
              h('a.btn.filled.state', { href: '#/settings' }, icon('create_new_folder'), 'Add a library'))
          : emptyState('shelves', 'Nothing here yet', 'The owner hasn’t added any libraries yet.'),
      );
      return;
    }

    if (data.continueReading.length) {
      page.append(
        h('section.section', h('div.section-head', h('h2', 'Continue reading')),
          h('div.continue', data.continueReading.map(resumeCard))),
      );
    }

    if (data.recentlyAdded.length) {
      page.append(
        h('section.section',
          h('div.section-head', h('h2', 'Recently added'), h('a.btn.text.state', { href: '#/library' }, 'See all')),
          h('div.shelf', data.recentlyAdded.map((b) => bookTile(b))),
        ),
      );
    }

    page.append(
      h('section.section',
        h('div.section-head', h('h2', 'Libraries')),
        h('div.list.card', { style: { padding: '8px 0' } },
          data.libraries.map((l) =>
            h('a.list-item.state', { href: `#/library/${l.id}` },
              icon(KIND_ICON[l.kind]),
              h('div.text', h('div.headline', l.name),
                h('div.supporting', `${l.bookCount} ${l.kind === 'books' ? 'books' : 'items'}${l.seriesCount ? ` · ${l.seriesCount} series` : ''}`)),
              icon('chevron_right'),
            ),
          ),
        ),
      ),
    );
  }

  await load();
}

function resumeCard(book) {
  const p = book.progress;
  const pct = Math.round((p?.percent || 0) * 100);
  const where = book.pageCount && p?.page != null ? `Page ${p.page + 1} of ${book.pageCount}` : `${pct}%`;
  return h(
    'a.resume-card.state',
    { href: `#/book/${book.id}` },
    cover(book, { showProgress: false }),
    h('div.info',
      h('div.t', book.title),
      h('div.s', book.series ? `${book.series}${book.seriesIndex != null ? ` · ${book.seriesIndex}` : ''}` : book.author || ''),
      h('div.s', `${where} · ${timeAgo(p?.updatedAt)}`),
      h('div.grow'),
      h('div.row',
        h('div.progress', h('span', { style: { width: `${pct}%` } })),
        h('button.icon-btn.filled.state.play', {
          type: 'button',
          title: 'Resume',
          'aria-label': `Resume ${book.title}`,
          onclick: (e) => {
            e.preventDefault();
            location.hash = `#/read/${book.id}`;
          },
        }, icon('play_arrow', 'filled')),
      ),
    ),
  );
}
