'use strict';

// OpenAPI 3.1 description of the REST API, served at /api/openapi.json and
// rendered in Settings → API. Every route the web app uses is listed here.
//
// Each entry: [method, path, tag, summary, options]
//   options.admin / options.perm  – who may call it
//   options.query / options.body  – { name: 'type – description' }
//   options.raw                   – request body is a raw file of this media type
//   options.returns               – short description of the response

const pkg = require('../package.json');

const R = [
  // Session & account
  ['get', '/status', 'Account', 'Server status and the signed-in user (no auth needed)', { public: true, returns: '{ needsSetup, user }' }],
  ['post', '/login', 'Account', 'Sign in with a password (sets a session cookie)', { public: true, body: { username: 'string – username or email', password: 'string' } }],
  ['post', '/logout', 'Account', 'Sign out of this session'],
  ['get', '/me', 'Account', 'The current user'],
  ['patch', '/me', 'Account', 'Update your profile', { body: { username: 'string', displayName: 'string', email: 'string' } }],
  ['put', '/me/prefs', 'Account', 'Save app preferences (merged with existing)', { body: { '*': 'any preference key, see GET /me' } }],
  ['put', '/me/avatar', 'Account', 'Set your profile picture (raw image body: JPEG, PNG, WebP, GIF or AVIF, ≤ 10 MB)', { returns: '{ avatarUrl }' }],
  ['delete', '/me/avatar', 'Account', 'Remove your profile picture'],
  ['get', '/users/{id}/avatar', 'Account', 'A user’s profile picture'],
  ['put', '/me/background', 'Account', 'Upload your app background (raw image or GIF body, ≤ 30 MB); turn it on with prefs.background', { returns: '{ backgroundUrl }' }],
  ['delete', '/me/background', 'Account', 'Remove your uploaded background'],
  ['get', '/me/background', 'Account', 'Your uploaded background'],
  ['get', '/share-info', 'Account', 'Links others can open: the server’s home-network addresses and the public URL', { returns: '{ local: string[], public: string | null }' }],
  ['post', '/me/password', 'Account', 'Change your password (not allowed with an API key)', { body: { current: 'string', next: 'string' } }],

  // Personal libraries (users with a personal folder)
  ['get', '/me/libraries', 'My libraries', 'Your own libraries and your personal folder'],
  ['post', '/me/libraries', 'My libraries', 'Create a library inside your personal folder', { body: { name: 'string', kind: 'books | manga | comics', mode: 'books | kavita | komga', path: 'string – folder relative to your personal folder', autoMetadata: 'boolean' } }],
  ['patch', '/me/libraries/{id}', 'My libraries', 'Rename or re-type one of your libraries', { body: { name: 'string', kind: 'string', mode: 'string', autoMetadata: 'boolean' } }],
  ['post', '/me/libraries/{id}/scan', 'My libraries', 'Scan one of your libraries'],
  ['delete', '/me/libraries/{id}', 'My libraries', 'Remove one of your libraries (files are kept)'],
  ['get', '/me/folders', 'My libraries', 'Folders inside your personal folder', { query: { path: 'string – relative folder' } }],
  ['post', '/me/folders', 'My libraries', 'Create a folder inside your personal folder', { body: { path: 'string – parent folder', name: 'string' } }],

  // Browsing
  ['get', '/home', 'Browse', 'Home page: continue reading, want to read, recently added/updated, libraries'],
  ['get', '/libraries', 'Browse', 'Libraries you can see'],
  ['get', '/series', 'Browse', 'List and filter series', {
    query: {
      library: 'integer – library id', kind: 'books | manga | comics', q: 'string – ranked text search (best matches first unless sort is set)', letter: 'A–Z or # – first letter of the title', genre: 'string (repeatable)', tag: 'string', userTag: 'string – your own tag',
      person: 'string – writer/artist name', status: 'string', want: '1 – only Want to read', read: 'unread | reading | finished', sort: 'name | name_desc | author | added | read | year | updated | want | relevance', limit: 'integer ≤ 2000', offset: 'integer',
    },
    returns: '{ items: Series[], hasMore }',
  }],
  ['get', '/series/{id}', 'Browse', 'One series with its volumes, your progress, links and relations'],
  ['get', '/series/{id}/similar', 'Browse', 'More like this: series sharing genres, tags and creators, best first', { query: { limit: 'integer ≤ 40, default 12' }, returns: 'Series[]' }],
  ['get', '/series/{id}/cover', 'Browse', 'Series artwork (image)', { returns: 'image/*' }],
  ['get', '/genres', 'Browse', 'Genres with series counts'],
  ['get', '/user-tags', 'Browse', 'Your own tags with counts'],
  ['get', '/search', 'Browse', 'Search series, books, people, genres and collections', { query: { q: 'string', limit: 'integer ≤ 100' } }],

  // Books & reading
  ['get', '/books/{id}', 'Books', 'One book or volume'],
  ['get', '/books/{id}/reader', 'Books', 'Everything the reader needs: book, settings, annotations'],
  ['get', '/books/{id}/cover', 'Books', 'Book cover (image)', { returns: 'image/*' }],
  ['get', '/books/{id}/file', 'Books', 'File for in-browser reading (TXT, DOCX and RTF are converted to EPUB)', { returns: 'file' }],
  ['get', '/books/{id}/download', 'Books', 'Original file as an attachment (image folders are zipped)', { perm: 'download', returns: 'file' }],
  ['get', '/books/{id}/pages', 'Books', 'Page count of an image book (CBZ/CBR/CB7/CBT/folder)', { returns: '{ count }' }],
  ['get', '/books/{id}/pages/{n}', 'Books', 'Page image n (0-based), read straight from the archive', { query: { w: 'integer – resize to this width (100–4000)' }, returns: 'image/*' }],
  ['put', '/books/{id}/progress', 'Reading', 'Save reading position', {
    body: { page: 'integer – 0-based page', percent: 'number 0–1', position: 'string – EPUB CFI', seconds: 'integer – time read since the last save (≤ 600)', finished: 'boolean', day: 'YYYY-MM-DD – your local date' },
  }],
  ['post', '/books/{id}/finished', 'Reading', 'Mark a book read or unread', { body: { finished: 'boolean' } }],
  ['post', '/series/{id}/finished', 'Reading', 'Mark a whole series read or unread', { body: { finished: 'boolean' } }],
  ['put', '/series/{id}/user', 'Reading', 'Your status, tags, Want to read and blur for a series', { body: { wantToRead: 'boolean', status: 'reading | completed | on_hold | dropped | plan | null', blur: 'boolean', tags: 'string[]' } }],
  ['get', '/stats', 'Reading', 'Your reading statistics', { query: { days: 'integer 7–365', today: 'YYYY-MM-DD' } }],
  ['get', '/series/{id}/download', 'Books', 'Download every volume of a series as a zip', { perm: 'download', returns: 'application/zip' }],

  // Personal data
  ['get', '/collections', 'Collections', 'Your collections and ones shared with you'],
  ['post', '/collections', 'Collections', 'Create a collection', { body: { name: 'string', summary: 'string', seriesIds: 'integer[]', promoted: 'boolean – admin: show to everyone' } }],
  ['get', '/collections/{id}', 'Collections', 'A collection and its series'],
  ['patch', '/collections/{id}', 'Collections', 'Rename or describe a collection', { body: { name: 'string', summary: 'string' } }],
  ['delete', '/collections/{id}', 'Collections', 'Delete a collection'],
  ['post', '/collections/{id}/items', 'Collections', 'Add series to a collection', { body: { seriesIds: 'integer[]' } }],
  ['delete', '/collections/{id}/items/{seriesId}', 'Collections', 'Remove a series from a collection'],
  ['get', '/annotations', 'Annotations', 'Your highlights, notes and bookmarks', { query: { kind: 'highlight | bookmark' } }],
  ['post', '/books/{id}/annotations', 'Annotations', 'Add a highlight, note or bookmark', { body: { kind: 'highlight | bookmark', locator: 'string – EPUB CFI or page locator', page: 'integer', percent: 'number 0–1', text: 'string', note: 'string', color: 'yellow | green | blue | pink | purple | underline', chapter: 'string' } }],
  ['patch', '/annotations/{id}', 'Annotations', 'Edit a note or colour', { body: { note: 'string', color: 'string' } }],
  ['delete', '/annotations/{id}', 'Annotations', 'Delete an annotation'],
  ['get', '/profiles', 'Reading profiles', 'Your reading profiles and the default settings'],
  ['post', '/profiles', 'Reading profiles', 'Create a profile', { body: { name: 'string', settings: 'object' } }],
  ['patch', '/profiles/{id}', 'Reading profiles', 'Update a profile and the libraries it applies to', { body: { name: 'string', settings: 'object', libraries: 'integer[]' } }],
  ['delete', '/profiles/{id}', 'Reading profiles', 'Delete a profile'],
  ['put', '/series/{id}/profile', 'Reading profiles', 'Use a profile for one series', { body: { profileId: 'integer | null' } }],
  ['put', '/series/{id}/reader-settings', 'Reading profiles', 'Per-series reader tweaks', { body: { settings: 'object' } }],
  ['get', '/devices', 'Send to device', 'Your e-reader email addresses'],
  ['post', '/devices', 'Send to device', 'Add an e-reader', { body: { name: 'string', email: 'string', platform: 'kindle | kobo | pocketbook | other' } }],
  ['delete', '/devices/{id}', 'Send to device', 'Remove an e-reader'],
  ['post', '/books/{id}/send', 'Send to device', 'Email a book to an e-reader', { perm: 'download', body: { deviceId: 'integer' } }],
  ['post', '/series/{id}/send', 'Send to device', 'Email a whole series', { perm: 'download', body: { deviceId: 'integer' } }],
  ['get', '/fonts', 'Fonts', 'EPUB fonts'],
  ['get', '/fonts/{id}/file', 'Fonts', 'A custom font file'],
  ['post', '/import/mal-stack', 'Import', 'Import a public MyAnimeList stack into a collection', { body: { url: 'string' } }],
  ['post', '/import/mal-list', 'Import', 'Import a MyAnimeList XML export', { raw: 'application/xml' }],
  ['get', '/api-keys', 'API keys', 'Your API keys (browser session only)', { perm: 'apiAccess' }],
  ['post', '/api-keys', 'API keys', 'Create an API key (browser session only)', { perm: 'apiAccess', body: { name: 'string', scope: 'read | full' } }],
  ['post', '/api-keys/{id}/regenerate', 'API keys', 'Replace a key with a new one', { perm: 'apiAccess' }],
  ['delete', '/api-keys/{id}', 'API keys', 'Revoke a key', { perm: 'apiAccess' }],

  // Content Finder
  ['get', '/finder/sources', 'Content Finder', 'Enabled plugin sources', { perm: 'contentFinder' }],
  ['get', '/finder/{plugin}/search', 'Content Finder', 'Search a source', { perm: 'contentFinder', query: { q: 'string', page: 'integer' }, returns: '{ items: [{ id, title, author, cover, folder }], hasMore }' }],
  ['get', '/finder/{plugin}/latest', 'Content Finder', 'Browse a source (popular or latest)', { perm: 'contentFinder', query: { page: 'integer' } }],
  ['get', '/finder/{plugin}/browse', 'Content Finder', 'Open a folder item', { perm: 'contentFinder', query: { id: 'string', page: 'integer' } }],
  ['get', '/finder/{plugin}/details', 'Content Finder', 'Details and downloadable files for an item', { perm: 'contentFinder', query: { id: 'string' } }],
  ['post', '/finder/{plugin}/download', 'Content Finder', 'Queue downloads into a library', { perm: 'contentFinder', body: { libraryId: 'integer', book: '{ title, author, series }', files: '[{ id, title, format }]' }, returns: '202 { ids }' }],
  ['get', '/finder/downloads/list', 'Content Finder', 'Recent downloads (yours; the admin sees everyone’s)', { perm: 'contentFinder' }],
  ['delete', '/finder/downloads/{id}', 'Content Finder', 'Cancel or remove a download', { perm: 'contentFinder' }],
  ['delete', '/finder/downloads', 'Content Finder', 'Clear finished and failed downloads', { perm: 'contentFinder' }],

  // Uploads
  ['get', '/uploads/folders', 'Uploads', 'Folders inside a library', { perm: 'upload', query: { library: 'integer', path: 'string – relative folder' } }],
  ['post', '/uploads/folders', 'Uploads', 'Create a folder in a library', { perm: 'upload', body: { libraryId: 'integer', path: 'string – parent folder', name: 'string' } }],
  ['put', '/uploads/file', 'Uploads', 'Upload one file (raw request body). `name` may include sub-folders, e.g. "Series/Ch 1/001.jpg"', { perm: 'upload', query: { library: 'integer', folder: 'string – destination folder', name: 'string – file name' }, raw: 'application/octet-stream', returns: '201 { path, name, size, renamed }' }],
  ['post', '/uploads/done', 'Uploads', 'Finish a batch: scan the library and optionally add the new series to a collection', { perm: 'upload', body: { libraryId: 'integer', files: 'string[] – paths returned by the uploads', collectionId: 'integer – optional' } }],
  ['get', '/uploads/limits', 'Uploads', 'Largest file the server accepts', { perm: 'upload' }],

  // Admin
  ['post', '/libraries', 'Admin: libraries', 'Add a library', { admin: true, body: { ownerId: 'integer | null – make it a personal library of this user', name: 'string', path: 'string – absolute folder', kind: 'books | manga | comics', mode: 'books | kavita | komga', autoMetadata: 'boolean', coverPolicy: 'missing | always | never', sources: 'string[]' } }],
  ['patch', '/libraries/{id}', 'Admin: libraries', 'Edit a library', { admin: true, body: { name: 'string', kind: 'string', mode: 'string', autoMetadata: 'boolean', coverPolicy: 'string', sources: 'string[]' } }],
  ['delete', '/libraries/{id}', 'Admin: libraries', 'Remove a library (files are not touched)', { admin: true }],
  ['post', '/libraries/{id}/scan', 'Admin: libraries', 'Scan one library now', { admin: true }],
  ['post', '/libraries/{id}/match', 'Admin: libraries', 'Match every series against online metadata', { admin: true }],
  ['post', '/libraries/{id}/cleanup', 'Admin: libraries', 'Forget files that no longer exist', { admin: true }],
  ['post', '/scan', 'Admin: libraries', 'Scan every library', { admin: true }],
  ['get', '/scan/status', 'Admin: libraries', 'Scanner progress'],
  ['get', '/fs', 'Admin: libraries', 'Browse server folders', { admin: true, query: { path: 'string' } }],
  ['patch', '/books/{id}', 'Admin: metadata', 'Edit a book', { admin: true, body: { title: 'string', author: 'string', volume: 'number', chapter: 'number', description: 'string' } }],
  ['post', '/books/{id}/refresh', 'Admin: metadata', 'Re-read a book’s embedded metadata', { admin: true }],
  ['put', '/books/{id}/cover', 'Admin: metadata', 'Upload a book cover', { admin: true, raw: 'image/*' }],
  ['patch', '/series/{id}', 'Admin: metadata', 'Edit series metadata (edited fields are locked)', { admin: true, body: { name: 'string', summary: 'string', genres: 'string[]', tags: 'string[]', people: '[{ name, role }]', year: 'integer', ageRating: '0–3', links: '[{ url }]', '…': 'see the series editor' } }],
  ['post', '/series/{id}/unlock', 'Admin: metadata', 'Unlock fields so scans and providers may update them', { admin: true }],
  ['post', '/series/{id}/refresh', 'Admin: metadata', 'Reset series metadata to what the files contain', { admin: true }],
  ['put', '/series/{id}/cover', 'Admin: metadata', 'Upload series artwork', { admin: true, raw: 'image/*' }],
  ['post', '/series/{id}/cover/url', 'Admin: metadata', 'Set series artwork from a URL', { admin: true, body: { url: 'string' } }],
  ['post', '/series/{id}/cover/book', 'Admin: metadata', 'Use a volume’s cover as series artwork', { admin: true, body: { bookId: 'integer' } }],
  ['delete', '/series/{id}/cover', 'Admin: metadata', 'Remove custom series artwork', { admin: true }],
  ['post', '/series/{id}/relations', 'Admin: metadata', 'Relate two series', { admin: true, body: { relatedId: 'integer', kind: 'sequel | prequel | spin_off | side_story | adaptation | alternative | other' } }],
  ['delete', '/series/{id}/relations/{relatedId}', 'Admin: metadata', 'Remove a relation', { admin: true }],
  ['get', '/metadata/providers', 'Admin: metadata', 'Metadata providers and whether they are configured'],
  ['get', '/metadata/search', 'Admin: metadata', 'Search metadata providers', { admin: true, query: { q: 'string', provider: 'anilist | mangadex | mal | mangaupdates | comicvine | openlibrary | googlebooks' } }],
  ['post', '/series/{id}/metadata', 'Admin: metadata', 'Apply a provider match to a series', { admin: true, body: { provider: 'string', providerId: 'string', fields: 'string[] – optional subset', cover: 'boolean – also use its artwork' } }],
  ['get', '/users', 'Admin: users', 'All users with reading totals', { admin: true }],
  ['post', '/users', 'Admin: users', 'Create a guest', {
    admin: true,
    body: {
      username: 'string', password: 'string', displayName: 'string', email: 'string', maxAgeRating: '0–3 | null', ageIncludeUnknown: 'boolean',
      libraryIds: 'integer[] | null – shared libraries; null means all of them', homeDir: 'string | null – personal folder (absolute path) for their own libraries, downloads and uploads',
      permissions: '{ download, contentFinder, apiAccess, upload }',
    },
  }],
  ['patch', '/users/{id}', 'Admin: users', 'Edit a user (same fields as create)', { admin: true }],
  ['delete', '/users/{id}', 'Admin: users', 'Delete a guest', { admin: true }],
  ['delete', '/users/{id}/sessions', 'Admin: users', 'Sign a user out everywhere', { admin: true }],
  ['post', '/fonts', 'Admin: settings', 'Upload an EPUB font', { admin: true, raw: 'font/*' }],
  ['delete', '/fonts/{id}', 'Admin: settings', 'Delete a font', { admin: true }],
  ['get', '/admin/settings', 'Admin: settings', 'Server settings', { admin: true }],
  ['put', '/admin/settings', 'Admin: settings', 'Update server settings', { admin: true, body: { publicUrl: 'string', opdsEnabled: 'boolean', comicvineKey: 'string', googleBooksKey: 'string', malClientId: 'string', smtp: '{ host, port, secure, user, pass, from }' } }],
  ['post', '/admin/smtp/test', 'Admin: settings', 'Send a test email', { admin: true, body: { to: 'string' } }],
  ['get', '/admin/webhooks', 'Admin: webhooks', 'Webhooks and the events you can subscribe to', { admin: true }],
  ['post', '/admin/webhooks', 'Admin: webhooks', 'Add a webhook (a signing secret is generated)', { admin: true, body: { url: 'string', events: 'string[] – event names or "*"', enabled: 'boolean' } }],
  ['patch', '/admin/webhooks/{id}', 'Admin: webhooks', 'Edit a webhook', { admin: true, body: { url: 'string', events: 'string[]', enabled: 'boolean' } }],
  ['delete', '/admin/webhooks/{id}', 'Admin: webhooks', 'Delete a webhook', { admin: true }],
  ['post', '/admin/webhooks/{id}/test', 'Admin: webhooks', 'Send a ping delivery now', { admin: true }],
  ['get', '/admin/plugins', 'Admin: plugins', 'Installed plugins and repositories', { admin: true }],
  ['get', '/admin/plugins/catalog', 'Admin: plugins', 'Plugins available from every repository', { admin: true }],
  ['post', '/admin/plugins', 'Admin: plugins', 'Install a plugin', { admin: true, body: { id: 'string – from a repository', repo: '"builtin" | repository id', url: 'string – a .lua file', source: 'string – Lua code' } }],
  ['post', '/admin/plugins/{id}/update', 'Admin: plugins', 'Update a plugin from where it was installed', { admin: true }],
  ['patch', '/admin/plugins/{id}', 'Admin: plugins', 'Enable/disable or configure a plugin', { admin: true, body: { enabled: 'boolean', settings: 'object' } }],
  ['get', '/admin/plugins/{id}/source', 'Admin: plugins', 'A plugin’s Lua source', { admin: true, returns: 'text/plain' }],
  ['delete', '/admin/plugins/{id}', 'Admin: plugins', 'Uninstall a plugin', { admin: true }],
  ['post', '/admin/plugins/repos', 'Admin: plugins', 'Add a plugin repository', { admin: true, body: { url: 'string – index.json URL' } }],
  ['delete', '/admin/plugins/repos/{id}', 'Admin: plugins', 'Remove a plugin repository', { admin: true }],
  ['get', '/admin/plugins/mihon/status', 'Admin: plugins', 'Suwayomi-Server version and URL (Mihon extensions plugin)', { admin: true }],
  ['get', '/admin/plugins/mihon/repos', 'Admin: plugins', 'Mihon extension repositories configured in Suwayomi', { admin: true }],
  ['put', '/admin/plugins/mihon/repos', 'Admin: plugins', 'Replace the Mihon extension repositories', { admin: true, body: { repos: 'string[] – index.min.json URLs' } }],
  ['get', '/admin/plugins/mihon/extensions', 'Admin: plugins', 'Mihon extensions from those repositories', { admin: true }],
  ['post', '/admin/plugins/mihon/extensions/{pkg}/{action}', 'Admin: plugins', 'Install, update or uninstall a Mihon extension (action = install | update | uninstall)', { admin: true }],
];

const WEBHOOK_DOC = `Webhooks POST JSON \`{ event, at, data }\` to your URL with headers \`X-Flyleaf-Event\`,
\`X-Flyleaf-Delivery\` and \`X-Flyleaf-Signature: sha256=<HMAC-SHA256 of the raw body using the hook's secret>\`.
Failed deliveries are retried after 10 s and 60 s.`;

function schemaFor(desc) {
  const type = String(desc).split(' ')[0];
  if (/^integer/.test(type)) return { type: 'integer', description: desc };
  if (/^number/.test(type)) return { type: 'number', description: desc };
  if (/^boolean/.test(type)) return { type: 'boolean', description: desc };
  if (/\[\]$/.test(type)) return { type: 'array', items: { type: type.startsWith('integer') ? 'integer' : 'string' }, description: desc };
  return { type: 'string', description: desc };
}

function build(serverUrl = '/api') {
  const paths = {};
  for (const [method, p, tag, summary, o = {}] of R) {
    const params = [...p.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: ['plugin', 'pkg', 'action'].includes(m[1]) ? 'string' : 'integer' } }));
    for (const [name, desc] of Object.entries(o.query || {})) params.push({ name, in: 'query', schema: schemaFor(desc) });
    const who = o.public ? 'No authentication needed.' : o.admin ? 'Admin only.' : o.perm ? `Requires the \`${o.perm}\` permission.` : 'Any signed-in user.';
    const op = {
      tags: [tag],
      summary,
      description: [who, method !== 'get' && !o.public ? 'With an API key, needs a **full** scope key.' : null].filter(Boolean).join(' '),
      operationId: `${method}${p.replace(/\{(\w+)\}/g, 'By$1').replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))}`,
      parameters: params.length ? params : undefined,
      responses: { 200: { description: o.returns || 'JSON' }, 401: { description: 'Not signed in / invalid key' }, 403: { description: 'Not allowed' } },
    };
    if (o.public) op.security = [];
    if (o.body) {
      op.requestBody = {
        content: {
          'application/json': {
            schema: { type: 'object', properties: Object.fromEntries(Object.entries(o.body).map(([k, d]) => [k, schemaFor(d)])) },
          },
        },
      };
    } else if (o.raw) {
      op.requestBody = { content: { [o.raw]: { schema: { type: 'string', format: 'binary' } } } };
    }
    (paths[p] ||= {})[method] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Flyleaf API',
      version: pkg.version,
      description: `Everything the Flyleaf web app does goes through this API, so scripts can do it too.

**Authentication.** Create a key in Settings → API & webhooks and send it as \`Authorization: Bearer <key>\` (or \`X-Api-Key: <key>\`).
A **read** key can only make GET requests; a **full** key can do anything its owner can. Requests act as the key's owner and see only
what that user may see (age rating and library restrictions apply).

**Webhooks.** ${WEBHOOK_DOC}

**OPDS.** Reading apps use the OPDS catalog at \`/api/opds/<key>\` instead.`,
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }, { apiKey: [] }, { cookie: [] }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'API key from Settings → API & webhooks' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        cookie: { type: 'apiKey', in: 'cookie', name: 'flyleaf_session', description: 'Browser session (state-changing requests also need the header X-Flyleaf: 1)' },
      },
    },
    paths,
  };
}

module.exports = { build, ROUTES: R };
