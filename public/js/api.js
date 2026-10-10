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

export async function request(method, url, body, { raw = false, keepalive = false } = {}) {
  const headers = { 'X-Flyleaf': '1' };
  let payload;
  if (body instanceof Blob) {
    payload = body;
    headers['Content-Type'] = body.type || 'application/octet-stream';
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
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
};

export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const api = {
  status: () => request('GET', '/api/status'),
  setup: (body) => request('POST', '/api/setup', body),
  login: (body) => request('POST', '/api/login', body),
  logout: () => request('POST', '/api/logout', {}),
  changePassword: (current, next) => request('POST', '/api/me/password', { current, next }),

  home: () => request('GET', '/api/home'),
  libraries: () => request('GET', '/api/libraries'),
  createLibrary: (body) => request('POST', '/api/libraries', body),
  updateLibrary: (id, body) => request('PATCH', `/api/libraries/${id}`, body),
  deleteLibrary: (id) => request('DELETE', `/api/libraries/${id}`),
  scanLibrary: (id) => request('POST', `/api/libraries/${id}/scan`, {}),
  scanAll: () => request('POST', '/api/scan', {}),
  scanStatus: () => request('GET', '/api/scan/status'),
  cleanupLibrary: (id) => request('POST', `/api/libraries/${id}/cleanup`, {}),
  browse: (path) => request('GET', `/api/fs${qs({ path })}`),

  books: (params) => request('GET', `/api/books${qs(params)}`),
  series: (params) => request('GET', `/api/series${qs(params)}`),
  book: (id) => request('GET', `/api/books/${id}`),
  updateBook: (id, body) => request('PATCH', `/api/books/${id}`, body),
  refreshBook: (id) => request('POST', `/api/books/${id}/refresh`, {}),
  setCover: (id, blob) => request('PUT', `/api/books/${id}/cover`, blob),
  generatedCover: (id, blob) => request('POST', `/api/books/${id}/cover/generated`, blob),
  pages: (id) => request('GET', `/api/books/${id}/pages`),
  setFinished: (id, finished) => request('POST', `/api/books/${id}/finished`, { finished }),
  setSeriesFinished: (libraryId, series, finished) => request('POST', '/api/series/finished', { libraryId, series, finished }),
  saveProgress: (id, body, opts) => request('PUT', `/api/books/${id}/progress`, { day: localDay(), ...body }, opts),

  stats: (days) => request('GET', `/api/stats${qs({ days, today: localDay() })}`),

  users: () => request('GET', '/api/users'),
  createUser: (body) => request('POST', '/api/users', body),
  updateUser: (id, body) => request('PATCH', `/api/users/${id}`, body),
  deleteUser: (id) => request('DELETE', `/api/users/${id}`),
  signOutUser: (id) => request('DELETE', `/api/users/${id}/sessions`),
};

export const fileUrl = (book) => `/api/books/${book.id}/file?v=${book.version}`;
export const pageUrl = (book, n) => `/api/books/${book.id}/pages/${n}?v=${book.version}`;
