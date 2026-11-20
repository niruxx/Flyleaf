import { api } from '../api.js';
import { t } from '../i18n.js';
import { button, dialog, field, h, snackbar } from '../ui.js';

export async function findSeriesSource(series, onLinked, previousPlugin) {
  const available = (await api.finderSources()).filter(source => !source.error && !source.needsSetup);
  const matching = available.filter(source => source.kinds?.includes(series.kind));
  const sources = [...matching, ...available.filter(source => !matching.includes(source))];
  const source = field(t('Content Finder source'), { value: sources.some(src => src.id === previousPlugin) ? previousPlugin : sources[0]?.id,
    options: sources.map(src => ({ value: src.id, label: src.name })) });
  const title = field(t('Title'), { value: series.name, required: true });
  const results = h('div.settings-group', { 'aria-live': 'polite' });
  const form = h('form', source, title, button(t('Search source'), { type: 'submit', icon: 'search' }));
  const search = async (event) => {
    event?.preventDefault();
    const plugin = source.input.value;
    const query = title.input.value.trim();
    if (!plugin || !query) return;
    results.textContent = t('Searching…');
    const request = Symbol();
    results.request = request;
    try {
      const { items } = await api.finderSearch(plugin, query, 1);
      if (results.request !== request || !results.isConnected) return;
      const choices = items.filter(item => !item.folder);
      results.replaceChildren(...choices.map(item => {
        const approve = button(t('Link this entry'), { variant: 'tonal', onclick: async () => {
          approve.disabled = true;
          try {
            const { matchedFiles } = await api.linkFinderSource(series.id, plugin, item.id);
            snackbar(t('Source linked · {count} local files matched', { count: matchedFiles }));
            results.closest('dialog')?.close();
            onLinked();
          } catch (e) { snackbar(e.message); approve.disabled = false; }
        } });
        return h('div.setting-row', h('div.text', h('strong', item.title), item.author && h('div.s', item.author), item.language && h('div.s', item.language)), approve);
      }));
      if (!choices.length) results.textContent = t('No entries found. Try another title or source.');
    } catch (e) { if (results.request === request) results.textContent = e.message; }
  };
  form.addEventListener('submit', search);
  source.input.addEventListener('change', search);
  await dialog({ title: t('Find a Content Finder entry'), icon: 'travel_explore',
    content: h('div', sources.length ? [form, results] : h('p', t('No Content Finder sources are ready to search.'))),
    actions: [{ label: t('Close') }], onOpen: () => { if (sources.length) search(); } });
}

export async function rescanFinderLinks(library) {
  try {
    await api.rescanFinderLinks(library.id);
    snackbar(t('Rescanning the library for Content Finder links. Open a series to match any entries that still need a source.'),
      { action: t('Activity'), onAction: () => { location.hash = '#/activity'; }, duration: 6000 });
  } catch (e) { snackbar(e.message); }
}

export async function reviewFinderLinks(library) {
  const results = h('div.settings-group', { 'aria-live': 'polite' });
  async function load(page) {
    results.textContent = t('Checking source links…');
    try {
      const { items, hasMore } = await api.unlinkedFinderSeries(library.id, page);
      results.replaceChildren(...items.map(item => h('a.setting-row', { href: `#/series/${item.id}` }, item.name)),
        ...(items.length ? [] : [h('p', t('Every indexed series on this page has a Content Finder source.'))]),
        h('div.toolbar', page > 1 && button(t('Previous'), { variant: 'text', onclick: () => load(page - 1) }),
          hasMore && button(t('Next'), { variant: 'text', onclick: () => load(page + 1) })));
    } catch (e) { results.textContent = e.message; }
  }
  await dialog({ title: t('Series without a Content Finder source'), content: results,
    actions: [{ label: t('Close') }], onOpen: () => load(1) });
}
