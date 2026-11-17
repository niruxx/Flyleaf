// Pure layout helpers: unknown or older preferences always fall back safely.
export const HOME_SECTIONS = [
  ['continue', 'Continue reading'], ['glance', 'Reading stats'], ['updates', 'New chapters'],
  ['recommendations', 'Recommended for you'], ['discover', 'Discover in Content Finder'],
  ['want', 'Want to read'], ['shelves', 'Smart shelves'], ['added', 'Recently added'],
  ['updated', 'Recently updated'], ['genres', 'Browse by genre'], ['libraries', 'Libraries'], ['explore', 'Explore'],
];
export const HOME_SORTS = [
  ['default', 'Shelf default'], ['az', 'Title A–Z'], ['za', 'Title Z–A'],
  ['author', 'Author A–Z'], ['progress', 'Reading progress'],
];
export function homeLayout(value) {
  const p = value && typeof value === 'object' ? value : {};
  const ids = HOME_SECTIONS.map(([id]) => id);
  const order = Array.isArray(p.order) ? [...new Set(p.order.filter(id => ids.includes(id)))] : [];
  return {
    order: [...order, ...ids.filter(id => !order.includes(id))],
    hidden: Array.isArray(p.hidden) ? p.hidden.filter(id => ids.includes(id)) : [],
    sort: HOME_SORTS.some(([id]) => id === p.sort) ? p.sort : 'default',
    compact: p.compact === true, hero: p.hero !== false, shortcuts: p.shortcuts !== false,
  };
}
export function sortHomeItems(items, sort, locale) {
  const compare = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }).compare;
  const title = x => x.sortName || x.name || x.title || x.item?.title || '';
  const progress = x => typeof x.progress === 'number' ? x.progress : x.progress?.percent || 0;
  const author = x => x.authors?.[0] || x.author || x.item?.author || '';
  return [...items].sort((a, b) => {
    if (sort === 'az') return compare(title(a), title(b));
    if (sort === 'za') return compare(title(b), title(a));
    if (sort === 'author') return compare(author(a), author(b)) || compare(title(a), title(b));
    if (sort === 'progress') return progress(b) - progress(a) || compare(title(a), title(b));
    return 0;
  });
}
