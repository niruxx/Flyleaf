import { api } from '../api.js';
import { navigate } from '../router.js';
import { h, icon, button, cover, loading, emptyState, stagger, pageHeader } from '../ui.js';
import { newCollection } from '../components/actions.js';

export async function collectionsView(view, params, stale) {
  const page = h('div.page');
  view.append(page);
  page.append(loading());
  const list = await api.collections();
  if (stale()) return;
  page.replaceChildren(
    pageHeader('Collections', button('New collection', { variant: 'tonal', icon: 'add', onclick: async () => {
      const id = await newCollection();
      if (id) navigate(`/collection/${id}`);
    } })),
  );
  if (!list.length) {
    page.append(emptyState('collections_bookmark', 'No collections yet', 'Group series however you like – “Summer reads”, “Isekai”, “Finished favourites”. Use “Add to category” from any series menu.'));
    return;
  }
  const seriesById = new Map();
  const ids = [...new Set(list.flatMap((c) => c.seriesIds.slice(0, 3)))];
  await Promise.all(ids.map((id) => api.series(id).then((s) => seriesById.set(id, s)).catch(() => {})));
  if (stale()) return;
  page.append(
    stagger(h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' } },
      list.map((c) =>
        h('a.collection-card', { href: `#/collection/${c.id}` },
          h('div.art', [0, 1, 2].map((i) => {
            const s = seriesById.get(c.seriesIds[i]);
            return s ? cover({ ...s, title: s.name }, { showProgress: false }) : h('div.cover');
          })),
          h('div.n', c.promoted ? [icon('public'), ' ', c.name] : c.name),
          h('div.c', `${c.count} series${c.owned ? '' : ' · shared'}`),
        ),
      ),
    )),
  );
}
