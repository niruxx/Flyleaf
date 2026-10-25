// Thin fetch wrapper for the Flyleaf API.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function request(method, url, body, { raw = false, keepalive = false, headers: extra = {} } = {}) {
  const headers = { 'X-Flyleaf': '1', ...extra };
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    payload = body;
    headers['Content-Type'] ||= body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', keepalive });
  } catch {
    throw new ApiError("Can't reach the Flyleaf server.", 0);
  }
  if (raw) return res;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/login')) onUnauthorized();
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

const qs = (params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (Array.isArray(v)) v.forEach((x) => s.append(k, x));
    else s.set(k, v);
  }
  const str = s.toString();
  return str ? `?${str}` : '';
};

export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const GET = (u) => request('GET', u);
const POST = (u, b = {}) => request('POST', u, b);
const PUT = (u, b = {}) => request('PUT', u, b);
const PATCH = (u, b = {}) => request('PATCH', u, b);
const DEL = (u) => request('DELETE', u);

export const api = {
  status: () => GET('/api/status'),
  setup: (b) => POST('/api/setup', b),
  login: (b) => POST('/api/login', b),
  register: (b) => POST('/api/register', b),
  logout: () => POST('/api/logout'),

  me: () => GET('/api/me'),
  updateMe: (b) => PATCH('/api/me', b),
  savePrefs: (b) => PUT('/api/me/prefs', b),
  uploadAvatar: (file) => request('PUT', '/api/me/avatar', file, { headers: { 'Content-Type': 'application/octet-stream' } }),
  removeAvatar: () => DEL('/api/me/avatar'),
  uploadBackground: (file) => request('PUT', '/api/me/background', file, { headers: { 'Content-Type': 'application/octet-stream' } }),
  removeBackground: () => DEL('/api/me/background'),
  shareInfo: () => GET('/api/share-info'),
  changePassword: (current, next) => POST('/api/me/password', { current, next }),

  home: () => GET('/api/home'),
  search: (q, limit) => GET(`/api/search${qs({ q, limit })}`),
  genres: () => GET('/api/genres'),
  userTags: () => GET('/api/user-tags'),

  // scope 'all' (admin only): include every user's personal libraries, for the admin panel.
  libraries: (scope) => GET(`/api/libraries${qs({ scope })}`),
  createLibrary: (b) => POST('/api/libraries', b),
  updateLibrary: (id, b) => PATCH(`/api/libraries/${id}`, b),
  deleteLibrary: (id) => DEL(`/api/libraries/${id}`),
  scanLibrary: (id) => POST(`/api/libraries/${id}/scan`),
  matchLibrary: (id) => POST(`/api/libraries/${id}/match`),
  scanAll: () => POST('/api/scan'),
  scanStatus: () => GET('/api/scan/status'),
  cleanupLibrary: (id) => POST(`/api/libraries/${id}/cleanup`),
  browse: (path) => GET(`/api/fs${qs({ path })}`),

  seriesList: (params) => GET(`/api/series${qs(params)}`),
  series: (id) => GET(`/api/series/${id}`),
  similarSeries: (id, limit) => GET(`/api/series/${id}/similar${qs({ limit })}`),
  recommendations: (limit) => GET(`/api/recommendations${qs({ limit })}`),
  setSeriesUser: (id, b) => PUT(`/api/series/${id}/user`, b),
  setSeriesFinished: (id, finished) => POST(`/api/series/${id}/finished`, { finished }),
  updateSeries: (id, b) => PATCH(`/api/series/${id}`, b),
  unlockSeries: (id) => POST(`/api/series/${id}/unlock`),
  refreshSeries: (id) => POST(`/api/series/${id}/refresh`),
  setSeriesCover: (id, blob) => request('PUT', `/api/series/${id}/cover`, blob),
  setSeriesCoverUrl: (id, url) => POST(`/api/series/${id}/cover/url`, { url }),
  setSeriesCoverFromBook: (id, bookId) => POST(`/api/series/${id}/cover/book`, { bookId }),
  resetSeriesCover: (id) => DEL(`/api/series/${id}/cover`),
  addRelation: (id, relatedId, kind) => POST(`/api/series/${id}/relations`, { relatedId, kind }),
  removeRelation: (id, relatedId) => DEL(`/api/series/${id}/relations/${relatedId}`),
  providers: () => GET('/api/metadata/providers'),
  metadataSearch: (provider, q) => GET(`/api/metadata/search${qs({ provider, q })}`),
  applyMetadata: (id, b) => POST(`/api/series/${id}/metadata`, b),
  setSeriesProfile: (id, profileId) => PUT(`/api/series/${id}/profile`, { profileId }),
  saveReaderSettings: (seriesId, settings) => PUT(`/api/series/${seriesId}/reader-settings`, { settings }),

  book: (id) => GET(`/api/books/${id}`),
  bookInfo: (id) => GET(`/api/books/${id}/info`),
  reader: (id) => GET(`/api/books/${id}/reader`),
  updateBook: (id, b) => PATCH(`/api/books/${id}`, b),
  deleteBook: (id) => DEL(`/api/books/${id}`),
  moveTargets: ({ book, series }) => GET(`/api/move-targets?${book ? `book=${book}` : `series=${series}`}`),
  moveBook: (id, libraryId) => POST(`/api/books/${id}/move`, { libraryId }),
  moveSeries: (id, libraryId) => POST(`/api/series/${id}/move`, { libraryId }),
  deleteSeries: (id) => DEL(`/api/series/${id}`),
  refreshBook: (id) => POST(`/api/books/${id}/refresh`),
  setCover: (id, blob) => request('PUT', `/api/books/${id}/cover`, blob),
  generatedCover: (id, blob) => request('POST', `/api/books/${id}/cover/generated`, blob),
  pages: (id) => GET(`/api/books/${id}/pages`),
  setFinished: (id, finished) => POST(`/api/books/${id}/finished`, { finished }),
  saveProgress: (id, b, opts) => request('PUT', `/api/books/${id}/progress`, { day: localDay(), ...b }, opts),

  annotations: (kind) => GET(`/api/annotations${qs({ kind })}`),
  addAnnotation: (bookId, b) => POST(`/api/books/${bookId}/annotations`, b),
  updateAnnotation: (id, b) => PATCH(`/api/annotations/${id}`, b),
  deleteAnnotation: (id) => DEL(`/api/annotations/${id}`),

  collections: () => GET('/api/collections'),
  collection: (id) => GET(`/api/collections/${id}`),
  createCollection: (b) => POST('/api/collections', b),
  updateCollection: (id, b) => PATCH(`/api/collections/${id}`, b),
  deleteCollection: (id) => DEL(`/api/collections/${id}`),
  addToCollection: (id, seriesIds) => POST(`/api/collections/${id}/items`, { seriesIds }),
  removeFromCollection: (id, seriesId) => DEL(`/api/collections/${id}/items/${seriesId}`),

  profiles: () => GET('/api/profiles'),
  createProfile: (b) => POST('/api/profiles', b),
  updateProfile: (id, b) => PATCH(`/api/profiles/${id}`, b),
  deleteProfile: (id) => DEL(`/api/profiles/${id}`),

  apiKeys: () => GET('/api/api-keys'),
  createApiKey: (name, scope = 'read') => POST('/api/api-keys', { name, scope }),
  regenerateApiKey: (id) => POST(`/api/api-keys/${id}/regenerate`),
  deleteApiKey: (id) => DEL(`/api/api-keys/${id}`),

  devices: () => GET('/api/devices'),
  addDevice: (b) => POST('/api/devices', b),
  deleteDevice: (id) => DEL(`/api/devices/${id}`),
  sendBook: (id, deviceId) => POST(`/api/books/${id}/send`, { deviceId }),
  sendSeries: (id, deviceId) => POST(`/api/series/${id}/send`, { deviceId }),

  fonts: () => GET('/api/fonts'),
  uploadFont: (name, file) => request('POST', '/api/fonts', file, { headers: { 'X-Font-Name': name, 'Content-Type': 'application/octet-stream' } }),
  deleteFont: (id) => DEL(`/api/fonts/${id}`),

  importMalStack: (url) => POST('/api/import/mal-stack', { url }),
  importMalList: (file) => request('POST', '/api/import/mal-list', file, { headers: { 'Content-Type': 'application/octet-stream' } }),

  stats: (days) => GET(`/api/stats${qs({ days, today: localDay() })}`),
  statsYear: (year) => GET(`/api/stats/year${qs({ year })}`),
  setReadingGoal: (year, books) => PUT('/api/stats/goal', { year, books }),

  reviews: (seriesId) => GET(`/api/series/${seriesId}/reviews`),
  saveReview: (seriesId, b) => PUT(`/api/series/${seriesId}/review`, b),
  deleteReview: (seriesId) => DEL(`/api/series/${seriesId}/review`),
  removeReview: (seriesId, userId) => DEL(`/api/series/${seriesId}/reviews/${userId}`),

  users: () => GET('/api/users'),
  createUser: (b) => POST('/api/users', b),
  updateUser: (id, b) => PATCH(`/api/users/${id}`, b),
  deleteUser: (id) => DEL(`/api/users/${id}`),
  signOutUser: (id) => DEL(`/api/users/${id}/sessions`),
  userFiles: (id, library) => GET(`/api/users/${id}/files${qs({ library })}`),
  deleteUserFiles: (id, items) => POST(`/api/users/${id}/files/delete`, { items }),

  push: () => GET('/api/push'),
  pushSubscribe: (subscription) => POST('/api/push', { subscription }),
  pushRemove: (b) => POST('/api/push/remove', b),
  pushTest: () => POST('/api/push/test'),

  health: () => GET('/api/health'),
  backupEstimate: () => GET('/api/admin/backup/estimate'),
  backupUrl: (books) => `/api/admin/backup${books ? '?books=1' : ''}`,
  // Upload a backup zip with progress; `setup` uses the first-run endpoint.
  uploadBackup: (file, onProgress, { setup = false } = {}) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', setup ? '/api/setup/restore' : '/api/admin/restore');
    xhr.setRequestHeader('X-Flyleaf', '1');
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data?.error || `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("Can't reach the Flyleaf server.", 0));
    xhr.send(file);
  }),
  restoreBackup: (id, books, { setup = false } = {}) => POST(`${setup ? '/api/setup/restore' : '/api/admin/restore'}/${id}`, { books }),
  cancelRestore: (id) => DEL(`/api/admin/restore/${id}`),

  adminSettings: () => GET('/api/admin/settings'),
  saveAdminSettings: (b) => PUT('/api/admin/settings', b),
  testSmtp: (to) => POST('/api/admin/smtp/test', { to }),

  openapi: () => GET('/api/openapi.json'),
  webhooks: () => GET('/api/admin/webhooks'),
  createWebhook: (b) => POST('/api/admin/webhooks', b),
  updateWebhook: (id, b) => PATCH(`/api/admin/webhooks/${id}`, b),
  deleteWebhook: (id) => DEL(`/api/admin/webhooks/${id}`),
  testWebhook: (id) => POST(`/api/admin/webhooks/${id}/test`),

  finderSources: () => GET('/api/finder/sources'),
  finderRecommendations: (refresh) => GET(`/api/finder/recommendations${qs({ refresh: refresh ? 1 : undefined })}`),
  finderSearch: (plugin, q, page) => GET(`/api/finder/${encodeURIComponent(plugin)}/search${qs({ q, page })}`),
  finderLatest: (plugin, page) => GET(`/api/finder/${encodeURIComponent(plugin)}/latest${qs({ page })}`),
  finderBrowse: (plugin, id, page) => GET(`/api/finder/${encodeURIComponent(plugin)}/browse${qs({ id, page })}`),
  finderDetails: (plugin, id) => GET(`/api/finder/${encodeURIComponent(plugin)}/details${qs({ id })}`),
  finderDownload: (plugin, b) => POST(`/api/finder/${encodeURIComponent(plugin)}/download`, b),
  downloads: () => GET('/api/finder/downloads/list'),
  cancelDownload: (id) => DEL(`/api/finder/downloads/${id}`),
  retryDownload: (id) => POST(`/api/finder/downloads/${id}/retry`),
  // `user` (admin only): just that person's downloads.
  retryFailedDownloads: (user) => POST(`/api/finder/downloads/retry${qs({ user })}`),
  clearDownloads: (what = 'history', user) => DEL(`/api/finder/downloads${qs({ what, user })}`),
  downloadsSummary: () => GET('/api/finder/downloads/summary'),

  plugins: () => GET('/api/admin/plugins'),
  pluginCatalog: () => GET('/api/admin/plugins/catalog'),
  installPlugin: (b) => POST('/api/admin/plugins', b),
  updatePlugin: (id) => POST(`/api/admin/plugins/${encodeURIComponent(id)}/update`),
  configurePlugin: (id, b) => PATCH(`/api/admin/plugins/${encodeURIComponent(id)}`, b),
  removePlugin: (id) => DEL(`/api/admin/plugins/${encodeURIComponent(id)}`),
  addPluginRepo: (url) => POST('/api/admin/plugins/repos', { url }),
  removePluginRepo: (id) => DEL(`/api/admin/plugins/repos/${id}`),
  myLibraries: () => GET('/api/me/libraries'),
  createMyLibrary: (b) => POST('/api/me/libraries', b),
  updateMyLibrary: (id, b) => PATCH(`/api/me/libraries/${id}`, b),
  scanMyLibrary: (id) => POST(`/api/me/libraries/${id}/scan`),
  deleteMyLibrary: (id) => DEL(`/api/me/libraries/${id}`),
  myFolders: (path) => GET(`/api/me/folders${qs({ path })}`),
  createMyFolder: (b) => POST('/api/me/folders', b),
  uploadFolders: (library, path) => GET(`/api/uploads/folders${qs({ library, path })}`),
  createUploadFolder: (b) => POST('/api/uploads/folders', b),
  finishUpload: (b) => POST('/api/uploads/done', b),
  uploadLimits: () => GET('/api/uploads/limits'),
  mihonStatus: () => GET('/api/admin/plugins/mihon/status'),
  mihonExtensions: () => GET('/api/admin/plugins/mihon/extensions'),
  mihonRepos: () => GET('/api/admin/plugins/mihon/repos'),
  mihonSuggestedRepos: () => GET('/api/admin/plugins/mihon/suggested-repos'),
  setMihonRepos: (repos) => PUT('/api/admin/plugins/mihon/repos', { repos }),
  mihonAction: (pkg, action) => POST(`/api/admin/plugins/mihon/extensions/${encodeURIComponent(pkg)}/${action}`),
  mihonBulk: () => GET('/api/admin/plugins/mihon/bulk'),
  startMihonBulk: (action, pkgNames) => POST('/api/admin/plugins/mihon/bulk', { action, pkgNames }),
  cancelMihonBulk: () => DEL('/api/admin/plugins/mihon/bulk'),
  installMihonApk: (file) => request('POST', `/api/admin/plugins/mihon/extensions/apk?name=${encodeURIComponent(file.name)}`, file, { headers: { 'Content-Type': 'application/vnd.android.package-archive' } }),
  extRuntime: () => GET('/api/admin/plugins/mihon/runtime'),
  installExtRuntime: () => POST('/api/admin/plugins/mihon/runtime/install'),
  extRuntimeUpdate: (force) => GET(`/api/admin/plugins/mihon/runtime/update${force ? '?force=1' : ''}`),
  startExtRuntime: () => POST('/api/admin/plugins/mihon/runtime/start'),
  stopExtRuntime: () => POST('/api/admin/plugins/mihon/runtime/stop'),
  restartExtRuntime: () => POST('/api/admin/plugins/mihon/runtime/restart'),
  configureExtRuntime: (b) => PATCH('/api/admin/plugins/mihon/runtime', b),
  extRuntimeLog: () => request('GET', '/api/admin/plugins/mihon/runtime/log', undefined, { raw: true }).then((r) => r.text()),
  removeExtRuntime: (keepData) => DEL(`/api/admin/plugins/mihon/runtime${keepData ? '' : '?keepData=0'}`),
};

/** Whether the signed-in user has a permission (admins have all). */
export const can = (user, perm) => Boolean(user && (user.role === 'admin' || user.permissions?.[perm]));

export const fileUrl = (book) => `/api/books/${book.id}/file?v=${book.version}`;
export const pageUrl = (book, n, width) => `/api/books/${book.id}/pages/${n}?v=${book.version}${width ? `&w=${width}` : ''}`;
export const downloadUrl = (book) => `/api/books/${book.id}/download`;
export const seriesDownloadUrl = (id) => `/api/series/${id}/download`;
