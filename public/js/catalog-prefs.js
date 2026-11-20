export const CATALOG_DEFAULTS = Object.freeze({ startPage: 'home', cardSize: 'standard', sort: 'default', showCovers: true });

export function catalogPrefs(user) {
  return { ...CATALOG_DEFAULTS, ...user?.prefs?.catalog };
}

export function startPage(user) {
  const page = catalogPrefs(user).startPage;
  if (page === 'library') return '/library';
  if (page === 'want') return '/want-to-read';
  return '/';
}

export function applyCatalogPrefs(user) {
  document.documentElement.dataset.catalogSize = catalogPrefs(user).cardSize;
}
