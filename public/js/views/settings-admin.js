import { t, plural, N_ } from '../i18n.js';
// Admin settings panels: libraries, users, metadata sources, server & email.

import { api } from '../api.js';
import { session, navigate } from '../router.js';
import {
  h, icon, iconButton, button, field, formError, snackbar, confirmDialog, formDialog, timeAgo, formatDuration, formatBytes, loading, menu, AGE_RATINGS, avatar, copyText, cover,
  pageBanner, emptyState,
} from '../ui.js';
import { refreshShell } from '../shell.js';
import { scanIndicator } from './scan.js';

const KIND_ICON = { books: 'menu_book', manga: 'auto_stories', comics: 'photo_library' };
const KIND_OPTIONS = [
  { value: 'books', get label() { return t('Books – EPUB, MOBI/AZW3, FB2, TXT, PDF'); } },
  { value: 'manga', get label() { return t('Manga – right-to-left'); } },
  { value: 'comics', get label() { return t('Comics – left-to-right'); } },
];
const row = (ic, title, sub, control) => h('div.setting-row', ic && icon(ic), h('div.text', h('div', title), sub && h('div.s', sub)), control);
const group = (...rows) => h('div.settings-group', ...rows);
const reload = (tab) => location.hash.startsWith(`#/settings/${tab}`) && navigate(`/settings/${tab}`, { replace: true });

// ---------------------------------------------------------------------------
// Libraries

export async function librariesPanel(panel, stale) {
  panel.append(h('h2', t('Libraries')), loading());
  // The admin panel is where users' personal libraries are managed, so ask for all of them.
  const [libs, providers] = await Promise.all([api.libraries('all'), api.providers()]);
  if (stale()) return;
  panel.lastChild.remove();
  const rowFor = (l) => {
    const more = iconButton('more_vert', t('Library options'), () =>
      menu(more, [
        { label: t('Scan now'), icon: 'sync', onClick: async () => { await api.scanLibrary(l.id); snackbar(t('Scanning {name}…', { name: l.name })); } },
        { label: t('Match metadata online'), icon: 'travel_explore', onClick: async () => { await api.matchLibrary(l.id); snackbar(t('Matching series against online sources…')); } },
        { label: t('Edit'), icon: 'edit', onClick: () => libraryDialog(l, providers) },
        l.calibre && { label: t('Import from Calibre'), icon: 'move_to_inbox', onClick: () => calibreImport(l) },
        { label: t('Remove missing files'), icon: 'cleaning_services', onClick: async () => {
          const r = await api.cleanupLibrary(l.id);
          snackbar(r.removed ? plural(r.removed, 'Removed {removed} missing item', 'Removed {removed} missing items', { removed: r.removed }) : t('Nothing to clean up'));
          reload('libraries');
        } },
        '-',
        { label: t('Remove library'), icon: 'delete', onClick: async () => {
          const ok = await confirmDialog({
            title: t('Remove “{name}”?', { name: l.name }),
            message: t('Its series and everyone’s progress for them will be removed from Flyleaf. Your files on disk are not touched.'),
            confirm: t('Remove'),
            danger: true,
            icon: 'delete',
          });
          if (!ok) return;
          await api.deleteLibrary(l.id);
          snackbar(t('Library removed'));
          refreshShell();
          reload('libraries');
        } },
      ].filter(Boolean)),
    );
    return h('div.setting-row',
      icon(KIND_ICON[l.kind]),
      h('div.text',
        h('div', h('a', { href: `#/library/${l.id}`, style: { color: 'inherit' } }, l.name)),
        h('div.s.mono', l.path),
        h('div.s', t('{seriesCount} series · {bookCount} files · {value}{value2} · {value3}', { seriesCount: l.seriesCount, bookCount: l.bookCount, value: MODE_LABEL[l.mode] || l.mode, value2: l.autoMetadata ? t(' · auto metadata') : '', value3: l.lastScanAt ? t('scanned {value}', { value: timeAgo(l.lastScanAt) }) : t('not scanned yet') })),
        l.watch && l.watch.reason !== 'off' && h('div.s.watch-line', { class: l.watch.watching ? 'on' : 'off', title: l.watch.error || '' },
          icon(l.watch.watching ? 'visibility' : 'visibility_off'),
          l.watch.watching
            ? t('Watching for new files{value}', { value: l.watch.lastScan ? t(' · last change picked up {value}', { value: timeAgo(l.watch.lastScan) }) : '' })
            : l.watch.error ? t('Not watching: {error} – new files show up at the next scheduled scan', { error: l.watch.error }) : t('Starting to watch…')),
      ),
      more,
    );
  };

  // Your private libraries, the shared ones, then each user's libraries in their own section.
  const mine = libs.filter((l) => l.own);
  const shared = libs.filter((l) => !l.personal);
  const owners = new Map();
  for (const l of libs.filter((x) => x.personal && !x.own)) {
    if (!owners.has(l.ownerId)) owners.set(l.ownerId, { name: l.ownerName, list: [] });
    owners.get(l.ownerId).list.push(l);
  }
  const sections = [
    h('div.sub-head', icon('lock'), t('My libraries')),
    mine.length
      ? group(...mine.map(rowFor))
      : group(row('info', t('No private libraries'), t('Libraries only you can see. New libraries are private unless you choose to share them.'))),
    h('div.sub-head', icon('groups'), t('Shared libraries')),
    shared.length
      ? group(...shared.map(rowFor))
      : group(row('info', t('Nothing shared yet'), t('Shared libraries are visible to the users you allow. Edit a library and choose “Shared with users” to share it.'))),
    owners.size > 0 && h('div.sub-head', icon('folder_special'), t('Users’ libraries')),
    owners.size > 0 && h('p.note', { style: { margin: '-4px 4px 12px' } }, t('Personal libraries are private: only their owner sees them, and they don’t appear in your own Home, search or library lists. Open one from here to look inside.')),
    ...[...owners.values()].map((o) => h('div.owner-group',
      h('div.owner-head', h('span.avatar', o.name[0]), h('span.title-small', o.name), h('span.body-small.muted', plural(o.list.length, '{length} library', '{length} libraries', { length: o.list.length }))),
      group(...o.list.map(rowFor)))),
  ];
  panel.append(
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap' } },
      button(t('Add library'), { icon: 'create_new_folder', onclick: () => libraryDialog(null, providers) }),
      button(t('Scan all'), { variant: 'text', icon: 'sync', onclick: async () => { await api.scanAll(); snackbar(t('Scanning all libraries…')); } }),
      button(t('Find duplicates'), { variant: 'text', icon: 'content_copy', onclick: () => navigate('/admin/duplicates') }),
      scanIndicator(() => {
        refreshShell();
        reload('libraries');
      }),
    ),
    ...sections.filter(Boolean),
    fulltextGroup(),
    h('p.note', t('Supported: EPUB · KEPUB · MOBI · AZW · AZW3 · FB2 · TXT · PDF · CBZ · ZIP · CBR · RAR · CB7 · 7Z · CBT · TAR · image folders. Audiobooks in book libraries: M4B · M4A · MP3 · OGG · OPUS · FLAC (a folder of tracks is one audiobook). ComicInfo.xml, EPUB/Calibre metadata and audio tags are read automatically; a Calibre metadata.db in the library folder is imported.')),
  );
}

export const MODE_LABEL = { get books() { return t('Regular books'); }, get kavita() { return t('Kavita (file names)'); }, get komga() { return t('Komga (folders)'); } };

/** Full-text search index: how far along it is, and a rebuild button. */
function fulltextGroup() {
  const line = h('div.s', t('Checking…'));
  const wrap = h('div', h('div.sub-head', icon('manage_search'), t('Full-text search')),
    group(h('div.setting-row', icon('manage_search'),
      h('div.text', h('div', t('Search inside books')), line),
      button(t('Rebuild index'), { variant: 'text', icon: 'refresh', onclick: async () => {
        if (!(await confirmDialog({ title: t('Rebuild the search index?'), message: t('Every book’s text is read again in the background. Searching inside books works again as it catches up.'), confirm: t('Rebuild') }))) return;
        draw(await api.rebuildFulltext());
      } }))));
  const draw = (s) => {
    if (!s.enabled) line.textContent = t('Turned off on this server (FULLTEXT=0).');
    else line.textContent = plural(s.indexed, '{value} book indexed{value3}. EPUB, FB2, TXT, DOCX, RTF and PDFs with text are searchable from the search page.', '{value} books indexed{value3}. EPUB, FB2, TXT, DOCX, RTF and PDFs with text are searchable from the search page.', { value: s.indexed.toLocaleString(), value3: s.pending ? t(' · {value} waiting{value2}', { value: s.pending.toLocaleString(), value2: s.running ? t(' (indexing {done} of {total})', { done: s.done, total: s.total }) : '' }) : '' });
  };
  api.fulltextStatus().then(draw).catch(() => (line.textContent = ''));
  return wrap;
}

/** Bring series, tags, ratings and covers over from a Calibre library's metadata.db. */
async function calibreImport(l) {
  const ok = await confirmDialog({
    title: t('Import from Calibre into “{name}”?', { name: l.name }),
    message: t('Titles, authors, series, tags, descriptions, publishers, identifiers and covers from Calibre’s metadata.db are applied to the matching books, and Calibre ratings become your ratings. This also happens automatically after each scan whenever metadata.db changes.'),
    confirm: t('Import'),
    icon: 'move_to_inbox',
  });
  if (!ok) return;
  snackbar(t('Importing from Calibre…'), { duration: 60_000 });
  try {
    const r = await api.calibreImport(l.id);
    snackbar(plural(r.books, 'Imported {books} book from Calibre{value2}{value3}{value4}', 'Imported {books} books from Calibre{value2}{value3}{value4}', { books: r.books, value2: r.unmatched ? t(' · {unmatched} not found in the folder', { unmatched: r.unmatched }) : '', value3: r.covers ? t(' · {covers} covers', { covers: r.covers }) : '', value4: r.ratings ? t(' · {ratings} ratings', { ratings: r.ratings }) : '' }), { duration: 8000 });
  } catch (e) {
    snackbar(e.message, { duration: 8000 });
  }
}

// ---------------------------------------------------------------------------
// Duplicates

const DUP_REASON = {
  'same-file': ['file_copy', N_('Identical files')],
  'same-book': ['menu_book', N_('Same book, different copies')],
  'same-volume': ['collections_bookmark', N_('Same volume or chapter')],
};

/** #/admin/duplicates – review likely duplicate books, keep one copy and merge, or dismiss. */
export async function duplicatesView(view, params, stale) {
  const page = h('div.page', { style: { maxWidth: '1100px' } });
  view.append(page);
  const banner = pageBanner({ icon: 'content_copy', eyebrow: t('Libraries'), title: t('Duplicates'), sub: t('Looking for books that appear more than once…') });
  const body = h('div', loading());
  page.append(banner, body);

  async function load() {
    let groups;
    try {
      groups = await api.duplicates();
    } catch (e) {
      body.replaceChildren(h('p', e.message));
      return;
    }
    if (stale()) return;
    const files = groups.reduce((a, g) => a + g.books.length - 1, 0);
    banner.setSub(groups.length ? plural(groups.length, '{length} group · {files} extra {value2}', '{length} groups · {files} extra {value2}', { length: groups.length, files: files, value2: files === 1 ? 'copy' : 'copies' }) : t('No duplicates found'));
    if (!groups.length) {
      body.replaceChildren(emptyState('task_alt', t('No duplicates'), t('Every book appears once. Groups you marked “Not duplicates” stay hidden.')));
      return;
    }
    body.replaceChildren(...groups.map(groupCard));
  }

  function groupCard(g) {
    const [ic, label] = DUP_REASON[g.reason] || ['content_copy', t('Possible duplicates')];
    // Keep the copy most people read, then the oldest.
    let keep = [...g.books].sort((a, b) => b.readers - a.readers || b.notes - a.notes || a.addedAt - b.addedAt)[0].id;
    const rows = g.books.map((b) => {
      const radio = h('input', { type: 'radio', name: `keep-${g.key}`, checked: b.id === keep, onchange: () => (keep = b.id) });
      return h('label.dup-row',
        radio,
        h('div.dup-text',
          h('div.title-small', b.series && b.series !== b.title ? `${b.series} · ${b.title}` : b.title),
          h('div.body-small.muted', [b.author, b.format.toUpperCase(), formatBytes(b.size), t('{library}{value}', { library: b.library, value: b.personal ? t(' (personal)') : '' }), t('added {value}', { value: timeAgo(b.addedAt) })].filter(Boolean).join(' · ')),
          h('div.body-small.muted.mono', b.path),
          (b.readers || b.notes) > 0 && h('div.body-small', plural(b.readers, '{readers} reader · {notes} {value2}', '{readers} readers · {notes} {value2}', { readers: b.readers, notes: b.notes, value2: b.notes === 1 ? t('bookmark or note') : t('bookmarks and notes') }))),
        iconButton('menu_book', t('Open'), (e) => {
          e.preventDefault();
          navigate(`/read/${b.id}`);
        }));
    });
    const card = h('section.dup-group.enter',
      h('div.dup-head', h('span.sec-icon', icon(ic)), h('div', h('div.title-medium', t(label)), h('div.body-small.muted', t('Choose the copy to keep. Progress, reading time, bookmarks and notes from the others move to it.')))),
      h('div.dup-rows', rows),
      h('div.dup-actions',
        button(t('Not duplicates'), { variant: 'text', icon: 'visibility_off', onclick: async () => {
          await api.ignoreDuplicates(g.key);
          card.remove();
          snackbar(t('Hidden – they won’t be suggested again'));
        } }),
        button(t('Keep selected, delete others'), { variant: 'tonal', icon: 'merge', onclick: async () => {
          const others = g.books.filter((b) => b.id !== keep);
          if (!(await confirmDialog({
            title: plural(others.length, 'Delete {length} copy?', 'Delete {length} copies?', { length: others.length }),
            message: t('{value} will be deleted from disk after everyone’s reading data moves to the copy you keep.', { value: others.map((b) => t('{value} in {library}', { value: b.format.toUpperCase(), library: b.library })).join(', ') }),
            confirm: t('Merge and delete'),
            danger: true,
            icon: 'merge',
          }))) return;
          try {
            const r = await api.mergeDuplicates(keep, others.map((b) => b.id));
            snackbar(plural(r.removed, 'Merged · {removed} copy deleted', 'Merged · {removed} copies deleted', { removed: r.removed }));
            card.remove();
          } catch (e) {
            snackbar(e.message, { duration: 6000 });
          }
        } })));
    return card;
  }

  await load();
}

export function modeCards(value, onChange) {
  const wrap = h('div.mode-cards');
  const card = (id, ic, title, text) =>
    h('button.mode-card', { type: 'button', 'aria-pressed': String(value === id), onclick: (e) => {
      for (const c of wrap.children) c.setAttribute('aria-pressed', String(c === e.currentTarget));
      onChange(id);
    } }, icon(ic), h('strong', title), h('span', text));
  wrap.append(
    card('books', 'auto_stories', t('Regular books'), t('Each book stands on its own, using its title, author and cover from the file. Books only group when their metadata names a series. Works with Calibre folders.')),
    card('kavita', 'text_fields', t('Kavita style'), t('Groups files into series by parsing file names (“Series v01 c003”) and embedded metadata – folders don’t matter.')),
    card('komga', 'folder_open', t('Komga style'), t('Every sub-folder is one series, named after the folder. No metadata editing needed for well-organised folders.')),
  );
  return wrap;
}

/** Add/edit a library. `onSaved` replaces the default (reload the Libraries panel). */
export async function libraryDialog(lib, providers, { onSaved } = {}) {
  const state = {
    kind: lib?.kind || 'manga',
    mode: lib?.mode || null,
    sources: lib?.sources || null,
  };
  const name = field(t('Name'), { value: lib?.name || '', required: true });
  const kind = field(t('Type'), { options: KIND_OPTIONS, value: state.kind });
  let mode = state.mode || (state.kind === 'books' ? 'books' : 'komga');
  const modes = modeCards(mode, (v) => (mode = v));
  kind.input.addEventListener('change', () => {
    state.kind = kind.input.value;
    if (!lib) {
      mode = state.kind === 'books' ? 'books' : 'komga';
      modes.replaceWith(modeCards(mode, (v) => (mode = v)));
    }
    renderSources();
  });

  // Private to you (the default for new libraries), shared with users, or one user's own library.
  const guests = (await api.users().catch(() => [])).filter((u) => u.role !== 'admin');
  const me = session.user.id;
  const owner = field(t('Who it’s for'), {
    value: lib ? lib.ownerId ?? '' : me,
    options: [
      { value: me, label: t('Only me – private') },
      { value: '', label: t('Shared with users') },
      ...guests.map((u) => ({ value: u.id, label: t('{displayName} (@{username}) – their personal library', { displayName: u.displayName, username: u.username }), group: t('A user’s library') })),
    ],
    support: t('Private libraries are yours alone. Shared libraries are visible to users you allow (Settings → Users). A user’s library is only theirs, and is where their downloads and uploads go if they have a personal folder.'),
  });

  const auto = h('input', { type: 'checkbox', checked: lib?.autoMetadata ?? false });
  const policy = field(t('Artwork from sources'), {
    value: lib?.coverPolicy || 'missing',
    options: [
      { value: 'missing', label: t('Only when a series has no cover') },
      { value: 'always', label: t('Always use the source’s artwork') },
      { value: 'never', label: t('Never replace artwork') },
    ],
  });
  const defaults = { manga: ['anilist', 'mangadex', 'mal', 'mangaupdates'], comics: ['comicvine', 'anilist', 'mangadex'], books: ['openlibrary', 'googlebooks', 'anilist'] };
  const sourceBox = h('div.check-grid');
  function renderSources() {
    const active = state.sources || defaults[state.kind];
    sourceBox.replaceChildren(...providers.map((p) => {
      const input = h('input', { type: 'checkbox', checked: active.includes(p.id), disabled: !p.configured });
      input.dataset.id = p.id;
      return h('label.check', input, p.name, !p.configured && h('span.muted', { style: { fontSize: '12px' } }, t('(needs key)')));
    }));
  }
  renderSources();

  let pathField = null;
  let browser = null;
  if (!lib) {
    pathField = field(t('Folder path'), { required: true, support: t('Absolute path on the server, e.g. /home/me/Manga') });
    browser = folderBrowser((p, picked) => {
      pathField.input.value = p;
      if (picked && !name.input.dataset.touched) name.input.value = p.split(/[\\/]/).filter(Boolean).pop() || '';
    });
    name.input.addEventListener('input', () => (name.input.dataset.touched = '1'));
  }

  await formDialog({
    title: lib ? t('Edit library') : t('Add library'),
    icon: lib ? 'edit' : 'create_new_folder',
    className: 'fullscreen-compact',
    submit: lib ? t('Save') : t('Add library'),
    fields: [
      name,
      kind,
      owner,
      h('p.label-large', { style: { margin: '16px 0 0' } }, t('Folder structure')),
      modes,
      h('p.label-large', { style: { margin: '16px 0 4px' } }, t('Metadata')),
      h('label.check', auto, t('Automatically fetch metadata & artwork for new series')),
      h('p.body-small.muted', t('Sources are tried in order; a series is only matched when the title is a confident match.')),
      sourceBox,
      policy,
      pathField,
      browser,
    ],
    onSubmit: async () => {
      const sources = [...sourceBox.querySelectorAll('input')].filter((i) => i.checked).map((i) => i.dataset.id);
      const body = { name: name.input.value, kind: kind.input.value, mode, autoMetadata: auto.checked, coverPolicy: policy.input.value, sources, ownerId: owner.input.value ? Number(owner.input.value) : null };
      if (lib) await api.updateLibrary(lib.id, body);
      else await api.createLibrary({ ...body, path: pathField.input.value });
      snackbar(lib ? t('Library updated') : t('Library added – scanning now'));
      refreshShell();
      if (onSaved) onSaved();
      else reload('libraries');
    },
  });
}

function folderBrowser(onPick) {
  const crumb = h('span', '…');
  const info = h('span.body-small.muted');
  const list = h('div.dirs');
  const up = iconButton('arrow_upward', t('Parent folder'), () => current.parent && go(current.parent));
  const use = button(t('Use this folder'), { variant: 'text', onclick: () => onPick(current.path, true) });
  let current = { path: '', parent: null };

  async function go(path, picked = true) {
    list.replaceChildren(h('div.list-item.static', h('div.spinner', { style: { width: '20px', height: '20px', borderWidth: '2px' } })));
    try {
      current = await api.browse(path);
    } catch (e) {
      list.replaceChildren(h('div.list-item.static', icon('error'), h('span', e.message)));
      return;
    }
    crumb.textContent = current.path;
    up.disabled = !current.parent;
    info.textContent = current.bookFiles ? plural(current.bookFiles, '{bookFiles} book file here', '{bookFiles} book files here', { bookFiles: current.bookFiles }) : '';
    onPick(current.path, picked);
    list.replaceChildren(
      ...(current.dirs.length
        ? current.dirs.map((d) => h('button.list-item.state', { type: 'button', onclick: () => go(d.path) }, icon('folder'), h('span.text', d.name), icon('chevron_right')))
        : [h('div.list-item.static.muted', t('No sub-folders'))]),
    );
  }
  go('', false);
  return h('div',
    h('p.label-large', { style: { margin: '16px 0 0' } }, t('Or browse the server')),
    h('div.folder-browser', h('div.crumb', up, crumb, use), list),
    info,
  );
}

// ---------------------------------------------------------------------------
// Users

export async function usersPanel(panel, stale) {
  panel.append(h('h2', t('Users')), loading());
  const users = await api.users();
  if (stale()) return;
  panel.lastChild.remove();
  const rows = users.map((u) => {
    const isSelf = u.id === session.user.id;
    const age = AGE_RATINGS.find((a) => a.value === u.maxAgeRating);
    const more = !isSelf && u.role !== 'admin' && iconButton('more_vert', t('User options'), () =>
      menu(more, [
        { label: t('Edit'), icon: 'edit', onClick: () => userDialog(u) },
        { label: t('Downloads & uploads'), icon: 'folder_open', onClick: () => navigate(`/admin/users/${u.id}/files`) },
        { label: t('Reset password'), icon: 'key', onClick: () => passwordDialog(u) },
        { label: t('Sign out everywhere'), icon: 'logout', onClick: async () => { await api.signOutUser(u.id); snackbar(t('{displayName} signed out', { displayName: u.displayName })); } },
        '-',
        { label: t('Delete user'), icon: 'person_remove', onClick: async () => {
          if (!(await confirmDialog({ title: t('Delete {displayName}?', { displayName: u.displayName }), message: t('Their reading progress, collections and stats will be deleted.'), confirm: t('Delete'), danger: true, icon: 'person_remove' }))) return;
          await api.deleteUser(u.id);
          snackbar(t('User deleted'));
          reload('users');
        } },
      ]),
    );
    return h('div.setting-row',
      avatar(u, 40),
      h('div.text',
        h('div', `${u.displayName}${isSelf ? ' (you)' : ''}`),
        h('div.s', `@${u.username}${u.email ? ` · ${u.email}` : ''} · ${u.role === 'admin' ? t('Admin') : 'Guest · read-only'}`),
        h('div.s', t('{value} · {value2} · active {value3} · {value4} read · {finished} finished', { value: u.maxAgeRating == null ? t('No age restriction') : t('Up to {value}', { value: age?.label }), value2: !u.libraryIds ? t('All libraries') : u.libraryIds.length ? plural(u.libraryIds.length, '{length} shared library', '{length} shared libraries', { length: u.libraryIds.length }) : t('No shared libraries'), value3: timeAgo(u.lastSeenAt), value4: formatDuration(u.secondsRead, { short: true }), finished: u.finished })),
        u.homeDir && h('div.s', h('span.mono', `📁 ${u.homeDir}`)),
        u.storage && storageLine(u.storage),
        !isSelf && (u.downloaded > 0 || u.uploaded > 0) && h('a.contrib-line.s', { href: `#/admin/users/${u.id}/files`, title: t('Review downloads & uploads') },
          icon('folder_open'),
          t('{downloaded} downloaded · {uploaded} uploaded', { downloaded: u.downloaded, uploaded: u.uploaded }),
          u.contributions.length > 0 && ` – ${u.contributions.map((c) => `${c.name}: ${[c.downloads && `${c.downloads} ↓`, c.uploads && `${c.uploads} ↑`].filter(Boolean).join(' ')}`).join(', ')}`),
        u.role !== 'admin' && h('div.perm-chips', PERMISSIONS.filter((p) => u.permissions?.[p.key]).map((p) => h('span.mini-chip', icon(p.icon), p.label))),
      ),
      more,
    );
  });
  panel.append(
    h('div', { style: { marginBottom: '16px' } }, button(t('Add guest'), { icon: 'person_add', onclick: () => userDialog(null) })),
    group(...rows),
    h('p.note', t('Guests can browse, read, bookmark and keep their own progress, collections and stats – but can’t change libraries, metadata or other users. Share access outside your network by port-forwarding Flyleaf (ideally behind HTTPS).')),
  );
}

/** #/admin/users/:id/files – review and delete what a user downloaded or uploaded. */
export async function userFilesView(view, params, stale) {
  const page = h('div.page', { style: { maxWidth: '1100px' } });
  view.append(page, loading());
  let library = params.query.get('library') || '';
  let data;
  try {
    data = await api.userFiles(params.id, library);
  } catch (e) {
    view.lastChild.remove();
    page.append(h('p', e.message));
    return;
  }
  if (stale()) return;
  view.lastChild.remove();

  const selected = new Set();
  const list = h('div.list.card');
  const bulk = button(t('Delete selected'), { variant: 'tonal', icon: 'delete', disabled: true, onclick: () => remove([...selected].map((k) => items.find((i) => i.key === k))) });
  const count = h('span.label-large.muted');
  const refresh = () => {
    bulk.disabled = !selected.size;
    count.textContent = selected.size ? t('{size} selected', { size: selected.size }) : plural(items.length, '{length} item', '{length} items', { length: items.length });
  };
  let items = data.items;

  async function remove(targets) {
    const n = targets.length;
    if (!(await confirmDialog({
      title: t('Delete {value}?', { value: n === 1 ? t('“{title}”', { title: targets[0].title }) : t('{n} items', { n: n }) }),
      message: plural(n, 'The {value} deleted from the server, along with everyone’s progress, bookmarks and notes for it.', 'The {value} deleted from the server, along with everyone’s progress, bookmarks and notes for them.', { value: n === 1 ? t('file is') : t('files are') }),
      confirm: t('Delete'),
      danger: true,
      icon: 'delete',
    }))) return;
    const r = await api.deleteUserFiles(params.id, targets.flatMap((localT) => localT.refs));
    snackbar(r.failed.length ? t('Deleted {deleted}; {length} failed: {value}', { deleted: r.deleted, length: r.failed.length, value: r.failed[0] }) : plural(r.deleted, 'Deleted {deleted} item', 'Deleted {deleted} items', { deleted: r.deleted }), { duration: r.failed.length ? 8000 : 4000 });
    const fresh = await api.userFiles(params.id, library);
    items = fresh.items;
    data = fresh;
    selected.clear();
    draw();
  }

  function draw() {
    list.replaceChildren(...(items.length ? items.map((it) => {
      const check = h('input', { type: 'checkbox', checked: selected.has(it.key), 'aria-label': t('Select {title}', { title: it.title }), onchange: () => {
        if (check.checked) selected.add(it.key);
        else selected.delete(it.key);
        refresh();
      } });
      const sources = [...new Set(it.refs.map((r) => r.source))];
      const meta = [
        sources.map((s) => (s === 'download' ? t('Downloaded{value}', { value: it.plugin ? t(' via {plugin}', { plugin: it.plugin }) : '' }) : t('Uploaded'))).join(' + '),
        it.libraryName + (it.personal ? ' (personal)' : ''),
        it.size ? formatBytes(it.size) : null,
        timeAgo(it.at),
        !it.book && t('not in the library yet'),
      ].filter(Boolean).join(' · ');
      return h('div.list-item.moderation-row',
        check,
        h('div', { style: { width: '40px', flex: 'none' } }, it.book ? cover(it.book, { showProgress: false }) : h('div.file-badge', icon('draft'))),
        h('div.text',
          h('div.headline', it.book ? (it.book.series && it.book.series !== it.book.label ? `${it.book.series} · ${it.book.label}` : it.book.title) : it.title),
          h('div.supporting', meta),
          h('div.supporting.mono', it.file)),
        it.book && iconButton('menu_book', t('Open'), () => navigate(`/read/${it.book.id}`)),
        it.book?.seriesId && iconButton('open_in_new', t('Series page'), () => navigate(`/series/${it.book.seriesId}`)),
        iconButton('delete', t('Delete'), () => remove([it])),
      );
    }) : [h('div.list-item.static.muted', t('Nothing here.'))]));
    refresh();
  }

  const filter = h('div.chip-set',
    [{ id: '', name: t('All libraries'), n: data.libraries.reduce((a, l) => a + l.downloads + l.uploads, 0) },
      ...data.libraries.map((l) => ({ id: String(l.id), name: l.name + (l.personal ? ' (personal)' : ''), n: l.downloads + l.uploads, l }))].map((c) =>
      h('button.chip.state', { type: 'button', 'aria-pressed': String(c.id === library), onclick: async () => {
        library = c.id;
        history.replaceState(null, '', `#/admin/users/${params.id}/files${library ? `?library=${library}` : ''}`);
        const fresh = await api.userFiles(params.id, library);
        items = fresh.items;
        selected.clear();
        for (const b of filter.children) b.setAttribute('aria-pressed', String(b.dataset.id === library));
        draw();
      }, dataset: { id: c.id } }, c.name, h('span.chip-count', ` ${c.n}`, c.l ? ` (${[c.l.downloads && `${c.l.downloads} ↓`, c.l.uploads && `${c.l.uploads} ↑`].filter(Boolean).join(' ')})` : ''))));

  page.append(
    h('div.page-head',
      iconButton('arrow_back', t('Back to users'), () => navigate('/settings/users')),
      h('h1', t('{displayName}’s downloads & uploads', { displayName: data.user.displayName }))),
    h('p.body-medium.muted', { style: { margin: '0 0 12px' } },
      t('Everything this user added with Content Finder or the Upload tab. Delete anything that breaks your server’s rules – the files are removed from disk.')),
    data.ownLibraries.length > 0 && h('div.chip-set', { style: { marginBottom: '12px' } },
      h('span.label-large', { style: { alignSelf: 'center', marginRight: '4px' } }, t('Their libraries:')),
      data.ownLibraries.map((l) => h('a.chip.state', { href: `#/library/${l.id}` }, icon('folder_special'), l.name))),
    filter,
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', margin: '16px 0 8px' } }, count, bulk),
    list,
  );
  draw();
}

/** "1.2 GB of 5 GB" with a bar, for a personal folder. */
export function storageLine(st) {
  const pct = st.quota ? Math.min(100, (st.used / st.quota) * 100) : 0;
  return h('div.storage-line',
    h('div.s', st.quota ? t('{value} of {value2} used', { value: formatBytes(st.used), value2: formatBytes(st.quota) }) : t('{value} used · no storage limit', { value: formatBytes(st.used) }),
      st.files ? plural(st.files, ' · {value} file', ' · {value} files', { value: st.files.toLocaleString() }) : ''),
    st.quota > 0 && h('div.storage-bar', { class: pct >= 90 ? 'full' : '' }, h('span', { style: { width: `${pct}%` } })));
}

const PERMISSIONS = [
  { key: 'download', icon: 'download', get label() { return t('Download & Send to'); }, get sub() { return t('Download original files and zips, and email books to e-readers.'); } },
  { key: 'contentFinder', icon: 'travel_explore', get label() { return t('Content Finder'); }, get sub() { return t('Search plugin sources and download new books into the libraries they can see.'); } },
  { key: 'upload', icon: 'upload', get label() { return t('Upload'); }, get sub() { return t('Upload files and folders into the libraries they can see.'); } },
  { key: 'deleteBooks', icon: 'delete', get label() { return t('Delete books'); }, get sub() { return t('Delete books in their own libraries and files they downloaded. Other books in shared libraries can’t be deleted.'); } },
  { key: 'apiAccess', icon: 'key', get label() { return t('API keys'); }, get sub() { return t('Create keys for OPDS reading apps and the REST API.'); } },
];

export async function userDialog(user, { onSaved } = {}) {
  const username = field(t('Username'), { value: user?.username || '', required: true, autocapitalize: 'none', support: t('3–32 letters, numbers, . - _') });
  const display = field(t('Display name'), { value: user?.displayName || '' });
  const email = field(t('Email'), { value: user?.email || '', type: 'email' });
  const password = !user && field(t('Password'), { type: 'password', required: true, autocomplete: 'new-password', support: t('At least 8 characters. Share it with your guest.') });
  const age = field(t('Age restriction'), { value: user?.maxAgeRating ?? '', options: [{ value: '', label: t('No restriction') }, ...AGE_RATINGS.filter((a) => a.value !== '').map((a) => ({ value: a.value, label: t('Up to {label}', { label: a.label }) }))] });
  const unknown = h('input', { type: 'checkbox', checked: user ? user.ageIncludeUnknown : true });

  // Library access: everything, or a chosen set.
  // Shared libraries only: personal libraries belong to one user and are never shared.
  const libs = (await api.libraries()).filter((l) => !l.personal);
  const restricted = Array.isArray(user?.libraryIds);
  const allLibs = h('input', { type: 'checkbox', checked: !restricted });
  const libChecks = libs.map((l) => {
    const input = h('input', { type: 'checkbox', checked: !restricted || user.libraryIds.includes(l.id), disabled: !restricted });
    input.dataset.id = l.id;
    return h('label.check', input, l.name);
  });
  allLibs.addEventListener('change', () => {
    for (const c of libChecks) {
      const input = c.querySelector('input');
      input.disabled = allLibs.checked;
      if (allLibs.checked) input.checked = true;
    }
  });
  // Personal folder: their own libraries live here, and their downloads/uploads go only here.
  const homeField = field(t('Personal folder'), {
    value: user?.homeDir || '',
    support: user
      ? t('Optional. An absolute folder on the server, e.g. /srv/flyleaf/alex. Created if it doesn’t exist.')
      : t('Leave empty to use Flyleaf’s data folder (content/<username>), or enter an absolute folder on the server. Books, Comics and Manga libraries are created in it.'),
    autocomplete: 'off',
  });
  const homeBrowser = h('div.home-browser', { hidden: true });
  const homeBrowse = button(t('Browse the server'), { variant: 'text', icon: 'folder_open', onclick: () => {
    homeBrowser.hidden = !homeBrowser.hidden;
    if (!homeBrowser.hidden && !homeBrowser.childElementCount) {
      homeBrowser.append(folderBrowser((p, picked) => {
        if (picked) homeField.input.value = p;
      }));
    }
  } });
  const quotaField = field(t('Storage limit (GB)'), {
    value: user?.quotaMb == null ? '' : user.quotaMb === 0 ? '0' : String(+(user.quotaMb / 1024).toFixed(2)),
    type: 'number',
    min: 0,
    step: 'any',
    support: t('How much their personal folder may hold. Empty uses the server default (Server & email → Storage); 0 means no limit.'),
  });
  const perms = { download: true, contentFinder: false, apiAccess: true, upload: false, deleteBooks: true, ...(user?.permissions || {}) };
  const permRows = PERMISSIONS.map((p) => {
    const input = h('input', { type: 'checkbox', checked: perms[p.key] });
    input.dataset.key = p.key;
    return h('label.perm-row', icon(p.icon), h('div', h('div.body-large', p.label), h('div.body-small.muted', p.sub)), input);
  });

  await formDialog({
    title: user ? t('Edit {displayName}', { displayName: user.displayName }) : t('Add guest'),
    icon: user ? 'edit' : 'person_add',
    className: 'fullscreen-compact',
    fields: [
      username, display, email, password,
      h('p.label-large', { style: { margin: '16px 0 4px' } }, t('Content')),
      age, h('label.check', unknown, t('Include series with no age rating')),
      h('div', { style: { marginTop: '8px' } },
        h('label.check', allLibs, h('strong', t('All shared libraries, including ones added later'))),
        libs.length > 0
          ? h('div.check-grid', { style: { paddingLeft: '28px' } }, libChecks)
          : h('p.body-small.muted', { style: { paddingLeft: '28px' } }, t('There are no shared libraries yet. Their personal libraries are always available to them.'))),
      h('p.label-large', { style: { margin: '16px 0 4px' } }, t('Personal folder')),
      h('p.body-small.muted', { style: { marginBottom: '8px' } },
        t('Give this user a folder of their own. They can create their own libraries inside it (nobody else sees them), and their Content Finder downloads and uploads go only into those libraries. The shared libraries above stay read-only for them.')),
      homeField,
      homeBrowse,
      homeBrowser,
      user?.storage && storageLine(user.storage),
      quotaField,
      h('p.label-large', { style: { margin: '16px 0 4px' } }, t('Permissions')),
      h('div.perm-list', permRows),
      h('p.body-small.muted', t('Guests always have their own progress, collections, bookmarks and stats, and can never change libraries, metadata or other users.')),
    ],
    submit: user ? t('Save') : t('Create'),
    onSubmit: async () => {
      // An empty list is fine: no shared libraries, just their own personal ones.
      const libraryIds = allLibs.checked ? null : libChecks.map((c) => c.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.dataset.id));
      const body = {
        username: username.input.value.trim(),
        displayName: display.input.value,
        email: email.input.value.trim(),
        maxAgeRating: age.input.value === '' ? null : Number(age.input.value),
        ageIncludeUnknown: unknown.checked,
        libraryIds,
        homeDir: homeField.input.value.trim() || null,
        quotaMb: quotaField.input.value === '' ? null : Math.round(Number(quotaField.input.value) * 1024),
        permissions: Object.fromEntries(permRows.map((r) => r.querySelector('input')).map((i) => [i.dataset.key, i.checked])),
      };
      if (user) {
        await api.updateUser(user.id, body);
        snackbar(t('Saved'));
      } else {
        const r = await api.createUser({ ...body, password: password.input.value });
        snackbar(r.libraries ? t('Guest created, with {value} in {homeDir}', { value: r.libraries === 3 ? t('Books, Comics and Manga libraries') : t('{libraries} libraries', { libraries: r.libraries }), homeDir: r.homeDir }) : t('Guest created'), { duration: 6000 });
      }
      if (onSaved) onSaved();
      else reload('users');
    },
  });
}

async function passwordDialog(user) {
  const password = field(t('New password'), { type: 'password', required: true, autocomplete: 'new-password' });
  await formDialog({
    title: t('Reset password for {displayName}', { displayName: user.displayName }),
    icon: 'key',
    fields: [password],
    onSubmit: async () => {
      await api.updateUser(user.id, { password: password.input.value });
      snackbar(t('Password changed. They’ve been signed out of other devices.'));
    },
  });
}

// ---------------------------------------------------------------------------
// Metadata sources

export async function metadataPanel(panel, stale) {
  panel.append(h('h2', t('Metadata sources')), loading());
  const [s, providers] = await Promise.all([api.adminSettings(), api.providers()]);
  if (stale()) return;
  panel.lastChild.remove();
  const cv = field(t('ComicVine API key'), { value: s.comicvineKey || '', support: t('Free at comicvine.gamespot.com/api') });
  const gb = field(t('Google Books API key (optional)'), { value: s.googleBooksKey || '', support: t('Avoids shared rate limits. console.cloud.google.com → Books API') });
  const mal = field(t('MyAnimeList Client ID (optional)'), { value: s.malClientId || '', support: t('myanimelist.net/apiconfig – otherwise the public Jikan API is used.') });
  const err = h('div');
  panel.append(
    group(...providers.map((p) => row(p.configured ? 'check_circle' : 'key', p.name, `${p.kinds.join(', ')}${p.needsKey ? t(' · needs an API key') : t(' · no key needed')}`, h('span.label-medium', { style: { color: p.configured ? 'var(--md-primary)' : 'var(--md-error)' } }, p.configured ? t('Ready') : t('Not configured'))))),
    h('div.sub-head', t('API keys')),
    group(h('div.setting-row.stack', err, cv, gb, mal, h('div', button(t('Save keys'), { icon: 'save', onclick: async () => {
      err.replaceChildren();
      try {
        await api.saveAdminSettings({ comicvineKey: cv.input.value, googleBooksKey: gb.input.value, malClientId: mal.input.value });
        snackbar(t('Saved'));
        reload('metadata');
      } catch (e) {
        err.append(formError(e.message));
      }
    } })))),
    h('p.note', t('Turn on automatic matching per library (Libraries → Edit). You can always fetch or edit metadata by hand from a series page – edited fields are locked so scans never overwrite them.')),
  );
}

// ---------------------------------------------------------------------------
// Server & email

export async function serverPanel(panel, stale) {
  panel.append(h('h2', t('Server & email')), loading());
  const s = await api.adminSettings();
  if (stale()) return;
  panel.lastChild.remove();
  const publicUrl = field(t('Public URL'), { value: s.publicUrl || '', type: 'url', support: t('How people reach Flyleaf from outside, e.g. https://books.example.com – used for OPDS links.') });
  const opds = h('input', { type: 'checkbox', checked: s.opdsEnabled !== false });
  const host = field(t('SMTP host'), { value: s.smtp.host });
  const port = field(t('Port'), { value: s.smtp.port, type: 'number' });
  const secure = h('input', { type: 'checkbox', checked: s.smtp.secure });
  const user = field(t('Username'), { value: s.smtp.user, autocomplete: 'off' });
  const pass = field(t('Password'), { value: s.smtp.pass, type: 'password', autocomplete: 'new-password' });
  const from = field(t('From address'), { value: s.smtp.from, type: 'email', support: t('For Kindle, approve this address in your Amazon account.') });
  const err = h('div');
  panel.append(
    group(h('div.setting-row.stack', publicUrl, h('label.check', opds, t('Enable the OPDS catalog for third-party apps')))),
    h('div.sub-head', t('Email (for Send to Kindle / Kobo)')),
    group(h('div.setting-row.stack', err, host,
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px', alignItems: 'center' } }, port, h('label.check', secure, t('Use TLS (port 465)'))),
      user, pass, from,
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        button(t('Save'), { icon: 'save', onclick: async () => {
          err.replaceChildren();
          try {
            await api.saveAdminSettings({ publicUrl: publicUrl.input.value, opdsEnabled: opds.checked, smtp: { host: host.input.value, port: port.input.value, secure: secure.checked, user: user.input.value, pass: pass.input.value, from: from.input.value } });
            snackbar(t('Saved'));
          } catch (e) {
            err.append(formError(e.message));
          }
        } }),
        button(t('Send test email'), { variant: 'text', icon: 'outgoing_mail', onclick: async () => {
          const to = field(t('Send to'), { type: 'email', value: session.user.email || '', required: true });
          await formDialog({ title: t('Test email'), fields: [to], submit: t('Send'), onSubmit: async () => {
            await api.testSmtp(to.input.value);
            snackbar(t('Test email sent'));
          } });
        } }),
      ),
    )),
    h('div.sub-head', t('Storage')),
    storageGroup(),
    h('div.sub-head', t('Sign-up')),
    registrationGroup(s),
    h('p.note', t('Run as a service with install.sh, and see the README for HTTPS reverse-proxy examples. Logs live in data/logs/flyleaf.log.')),
  );
}

/** Storage limits: personal folder quota, largest upload, free space to keep on the disk. */
function storageGroup() {
  const wrap = h('div.settings-group', h('div.setting-row', loading()));
  api.storageLimits().then((s) => {
    const gb = (mb) => (mb == null ? '' : String(+(mb / 1024).toFixed(2)));
    const quota = field(t('Default storage per personal folder (GB)'), { value: gb(s.defaultQuotaMb), type: 'number', min: 0, step: 'any', support: t('For users with a personal folder. Empty or 0 means no limit; you can override it per user in Users → Edit. Admins are never limited.') });
    const upload = field(t('Largest upload (MB)'), { value: s.maxUploadMb ?? '', type: 'number', min: 1, support: t('Per file. Empty uses MAX_UPLOAD_MB ({value} MB).', { value: s.envMaxUploadMb.toLocaleString() }) });
    const reserve = field(t('Keep free on the disk (GB)'), { value: gb(s.reserveFreeMb), type: 'number', min: 0, step: 'any', support: t('Uploads and downloads stop before the disk gets fuller than this, so the database never runs out of room.') });
    const err = h('div');
    const disk = s.disk.total ? t('{value} free of {value2} on the data disk', { value: formatBytes(s.disk.free), value2: formatBytes(s.disk.total) }) : t('Free space unknown');
    wrap.replaceChildren(
      row('hard_drive', disk, s.disk.total ? h('div.storage-bar', { class: s.disk.free / s.disk.total < 0.1 ? 'full' : '' }, h('span', { style: { width: `${100 - (s.disk.free / s.disk.total) * 100}%` } })) : null),
      h('div.setting-row.stack', err, quota, upload, reserve,
        h('div', button(t('Save storage limits'), { icon: 'save', onclick: async () => {
          err.replaceChildren();
          const mb = (v) => (v === '' ? null : Math.round(Number(v) * 1024));
          try {
            await api.saveStorageLimits({ defaultQuotaMb: mb(quota.input.value), maxUploadMb: upload.input.value === '' ? null : Number(upload.input.value), reserveFreeMb: mb(reserve.input.value) ?? 0 });
            snackbar(t('Saved'));
          } catch (e) {
            err.append(formError(e.message));
          }
        } }))),
    );
  }).catch((e) => wrap.replaceChildren(row('error', t('Couldn’t load storage limits'), e.message)));
  return wrap;
}

/** Let people create their own accounts (for a publicly hosted Flyleaf). */
function registrationGroup(s) {
  const reg = { enabled: false, inviteCode: '', sharedLibraries: 'all', permissions: null, ...(s.registration || {}) };
  const enabled = h('input', { type: 'checkbox', checked: reg.enabled });
  const invite = field(t('Invite code'), { value: reg.inviteCode || '', autocomplete: 'off', support: t('Optional, but recommended on a public server: only people you give the code to can sign up. Leave empty to let anyone sign up.') });
  const generate = button(t('Generate'), { variant: 'text', icon: 'casino', onclick: () => {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    invite.input.value = [...bytes].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
    invite.input.dispatchEvent(new Event('input'));
  } });
  const shared = field(t('Shared libraries for new accounts'), {
    value: reg.sharedLibraries,
    options: [{ value: 'all', label: t('All shared libraries') }, { value: 'none', label: t('None – only their own Books, Comics and Manga') }],
  });
  const perms = { download: true, contentFinder: false, apiAccess: true, upload: false, deleteBooks: true, ...(reg.permissions || {}) };
  const permRows = PERMISSIONS.map((p) => {
    const input = h('input', { type: 'checkbox', checked: perms[p.key] });
    input.dataset.key = p.key;
    return h('label.perm-row', icon(p.icon), h('div', h('div.body-large', p.label), h('div.body-small.muted', p.sub)), input);
  });
  const base = (s.publicUrl || location.origin).replace(/\/+$/, '');
  const link = `${base}/#/register`;
  const details = h('div', { hidden: !reg.enabled },
    invite, h('div', { style: { margin: '-4px 0 8px' } }, generate),
    shared,
    h('p.label-large', { style: { margin: '12px 0 4px' } }, t('What new accounts can do')),
    h('div.perm-list', permRows),
    h('p.body-small.muted', { style: { marginTop: '8px' } }, t('You can change any account later in Settings → Users.')),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '12px' } },
      h('span.body-medium', t('Sign-up link: '), h('span.mono', link)),
      button(t('Copy'), { variant: 'text', icon: 'content_copy', onclick: () => copyText(link) })),
  );
  enabled.addEventListener('change', () => (details.hidden = !enabled.checked));
  const err = h('div');
  return group(h('div.setting-row.stack', err,
    h('label.check', enabled, h('span', h('strong', t('Let people create their own accounts')), h('br'),
      h('span.body-small.muted', t('Adds “Create an account” to the sign-in page. Each new account gets its own folder (content/<username>) with Books, Comics and Manga libraries.')))),
    details,
    h('div', button(t('Save sign-up settings'), { icon: 'save', onclick: async () => {
      err.replaceChildren();
      try {
        await api.saveAdminSettings({ registration: {
          enabled: enabled.checked,
          inviteCode: invite.input.value,
          sharedLibraries: shared.input.value,
          permissions: Object.fromEntries(permRows.map((r) => r.querySelector('input')).map((i) => [i.dataset.key, i.checked])),
        } });
        snackbar(enabled.checked ? t('Sign-up is on') : t('Sign-up is off'));
      } catch (e) {
        err.append(formError(e.message));
      }
    } })),
  ));
}


// ---------------------------------------------------------------------------
// Activity: who signed in, downloaded or deleted what, and failed sign-ins

const ACTIVITY_ICON = {
  login: 'login', 'login.failed': 'gpp_bad', 'login.blocked': 'block', logout: 'logout', signup: 'person_add', setup: 'rocket_launch', 'password.changed': 'key',
  'book.downloaded': 'download', 'series.downloaded': 'download', 'opds.download': 'download', 'finder.download': 'travel_explore', 'follow.added': 'bookmark_add',
  'book.sent': 'send_to_mobile', 'series.sent': 'send_to_mobile', upload: 'upload', 'book.deleted': 'delete', 'series.deleted': 'delete', 'moderation.deleted': 'delete_sweep',
  'book.moved': 'drive_file_move', 'series.moved': 'drive_file_move', 'duplicates.merged': 'merge',
};
const GROUP_LABEL = { get ''() { return t('Everything'); }, get security() { return t('Sign-ins & security'); }, get downloads() { return t('Downloads'); }, get changes() { return t('Uploads & deletions'); }, get admin() { return t('Admin changes'); } };

export async function activityPanel(panel, stale) {
  panel.append(h('h2', t('Activity')), loading());
  const [data, sec, users] = await Promise.all([api.activity(), api.activitySecurity(), api.users()]);
  if (stale()) return;
  panel.lastChild.remove();

  const filters = { group: '', user: '', q: '' };
  const list = h('div.list.card.activity-list');
  const more = button(t('Show older'), { variant: 'text', icon: 'expand_more', onclick: () => load(true) });
  let entries = data.entries;

  const entryRow = (e) => {
    const bad = e.action === 'login.failed' || e.action === 'login.blocked';
    const extra = e.details && Object.entries(e.details).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
    return h(`div.list-item.static.activity-row${bad ? '.bad' : ''}`,
      icon(ACTIVITY_ICON[e.action] || 'history'),
      h('div.text',
        h('div.headline', h('strong', e.username || t('Someone')), ` ${e.label.toLowerCase()}`, e.target && e.target !== e.username ? h('span', ' · ', e.target) : ''),
        h('div.supporting', [new Date(e.at).toLocaleString(), e.ip, extra].filter(Boolean).join(' · '))),
      h('span.label-small.muted', { title: new Date(e.at).toLocaleString() }, timeAgo(e.at)));
  };
  function draw() {
    list.replaceChildren(...(entries.length ? entries.map(entryRow) : [h('div.list-item.static.muted', t('Nothing logged yet.'))]));
    more.hidden = entries.length === 0 || entries.length % 100 !== 0;
  }
  async function load(older = false) {
    const r = await api.activity({ ...filters, before: older ? entries.at(-1)?.id : undefined });
    entries = older ? [...entries, ...r.entries] : r.entries;
    draw();
    if (older && r.entries.length < 100) more.hidden = true;
  }

  const group = field(t('Show'), { value: '', options: Object.entries(GROUP_LABEL).map(([value, label]) => ({ value, label })) });
  const who = field(t('User'), { value: '', options: [{ value: '', label: t('Everyone') }, ...users.map((u) => ({ value: u.id, label: `${u.displayName} (@${u.username})` }))] });
  const text = field(t('Search'), { value: '', support: t('Title, name or IP address') });
  group.input.addEventListener('change', () => { filters.group = group.input.value; load(); });
  who.input.addEventListener('change', () => { filters.user = who.input.value; load(); });
  let timer;
  text.input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { filters.q = text.input.value.trim(); load(); }, 300);
  });

  const secWrap = h('div');
  const drawSecurity = (s) => secWrap.replaceChildren(...[
    h('div.settings-group',
      row(s.failed24h ? 'gpp_maybe' : 'verified_user', s.failed24h ? plural(s.failed24h, '{failed24h} failed sign-in in the last day', '{failed24h} failed sign-ins in the last day', { failed24h: s.failed24h }) : t('No failed sign-ins in the last day'),
        plural(s.signins24h, '{signins24h} successful sign-in · an address is blocked for 15 minutes after 10 wrong passwords, and admins get a notification after 5', '{signins24h} successful sign-ins · an address is blocked for 15 minutes after 10 wrong passwords, and admins get a notification after 5', { signins24h: s.signins24h })),
      ...s.blocked.map((b) => row('block', t('{ip} is blocked', { ip: b.ip }), t('{failures} wrong passwords · unblocks itself at {value}', { failures: b.failures, value: new Date(b.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
        button(t('Unblock'), { variant: 'tonal', icon: 'lock_open', onclick: async () => {
          drawSecurity(await api.unblockIp(b.ip));
          snackbar(t('{ip} can sign in again', { ip: b.ip }));
        } }))),
    ),
    (s.byIp.length > 0 || s.byUsername.length > 0) && h('div.security-grid',
      s.byIp.length > 0 && h('div.settings-group',
        h('div.setting-row', h('div.text', h('div.label-large', t('By address')))),
        ...s.byIp.map((r) => row('lan', r.ip || 'unknown', t('{count} failed · last {value}{value2}', { count: r.count, value: timeAgo(r.last), value2: r.usernames.length ? t(' · tried {value}', { value: r.usernames.join(', ') }) : '' })))),
      s.byUsername.length > 0 && h('div.settings-group',
        h('div.setting-row', h('div.text', h('div.label-large', t('By account name')))),
        ...s.byUsername.map((r) => row(r.exists ? 'person' : 'person_off', r.username, t('{count} failed · last {value}{value2}', { count: r.count, value: timeAgo(r.last), value2: r.exists ? t(' · a real account') : t(' · no such account') })))),
    ),
  ].filter(Boolean));
  drawSecurity(sec);

  panel.append(
    h('div.sub-head', t('Failed sign-ins')),
    secWrap,
    h('div.sub-head', t('Activity log')),
    h('div.activity-filters', group, who, text,
      button(t('Export CSV'), { variant: 'text', icon: 'download', onclick: () => {
        const a = h('a', { href: api.activityCsvUrl(filters), download: '' });
        document.body.append(a);
        a.click();
        a.remove();
      } })),
    list,
    h('div', { style: { textAlign: 'center', marginTop: '8px' } }, more),
    h('p.note', t('Sign-ins, downloads, uploads, deletions and admin changes are kept for {keepDays} days (ACTIVITY_DAYS).', { keepDays: data.keepDays })),
  );
  draw();
}
