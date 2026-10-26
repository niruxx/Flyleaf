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
  { value: 'books', label: 'Books – EPUB, MOBI/AZW3, FB2, TXT, PDF' },
  { value: 'manga', label: 'Manga – right-to-left' },
  { value: 'comics', label: 'Comics – left-to-right' },
];
const row = (ic, title, sub, control) => h('div.setting-row', ic && icon(ic), h('div.text', h('div', title), sub && h('div.s', sub)), control);
const group = (...rows) => h('div.settings-group', ...rows);
const reload = (tab) => location.hash.startsWith(`#/settings/${tab}`) && navigate(`/settings/${tab}`, { replace: true });

// ---------------------------------------------------------------------------
// Libraries

export async function librariesPanel(panel, stale) {
  panel.append(h('h2', 'Libraries'), loading());
  // The admin panel is where users' personal libraries are managed, so ask for all of them.
  const [libs, providers] = await Promise.all([api.libraries('all'), api.providers()]);
  if (stale()) return;
  panel.lastChild.remove();
  const rowFor = (l) => {
    const more = iconButton('more_vert', 'Library options', () =>
      menu(more, [
        { label: 'Scan now', icon: 'sync', onClick: async () => { await api.scanLibrary(l.id); snackbar(`Scanning ${l.name}…`); } },
        { label: 'Match metadata online', icon: 'travel_explore', onClick: async () => { await api.matchLibrary(l.id); snackbar('Matching series against online sources…'); } },
        { label: 'Edit', icon: 'edit', onClick: () => libraryDialog(l, providers) },
        l.calibre && { label: 'Import from Calibre', icon: 'move_to_inbox', onClick: () => calibreImport(l) },
        { label: 'Remove missing files', icon: 'cleaning_services', onClick: async () => {
          const r = await api.cleanupLibrary(l.id);
          snackbar(r.removed ? `Removed ${r.removed} missing ${r.removed === 1 ? 'item' : 'items'}` : 'Nothing to clean up');
          reload('libraries');
        } },
        '-',
        { label: 'Remove library', icon: 'delete', onClick: async () => {
          const ok = await confirmDialog({
            title: `Remove “${l.name}”?`,
            message: 'Its series and everyone’s progress for them will be removed from Flyleaf. Your files on disk are not touched.',
            confirm: 'Remove',
            danger: true,
            icon: 'delete',
          });
          if (!ok) return;
          await api.deleteLibrary(l.id);
          snackbar('Library removed');
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
        h('div.s', `${l.seriesCount} series · ${l.bookCount} files · ${MODE_LABEL[l.mode] || l.mode}${l.autoMetadata ? ' · auto metadata' : ''} · ${l.lastScanAt ? `scanned ${timeAgo(l.lastScanAt)}` : 'not scanned yet'}`),
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
    h('div.sub-head', icon('lock'), 'My libraries'),
    mine.length
      ? group(...mine.map(rowFor))
      : group(row('info', 'No private libraries', 'Libraries only you can see. New libraries are private unless you choose to share them.')),
    h('div.sub-head', icon('groups'), 'Shared libraries'),
    shared.length
      ? group(...shared.map(rowFor))
      : group(row('info', 'Nothing shared yet', 'Shared libraries are visible to the users you allow. Edit a library and choose “Shared with users” to share it.')),
    owners.size > 0 && h('div.sub-head', icon('folder_special'), 'Users’ libraries'),
    owners.size > 0 && h('p.note', { style: { margin: '-4px 4px 12px' } }, 'Personal libraries are private: only their owner sees them, and they don’t appear in your own Home, search or library lists. Open one from here to look inside.'),
    ...[...owners.values()].map((o) => h('div.owner-group',
      h('div.owner-head', h('span.avatar', o.name[0]), h('span.title-small', o.name), h('span.body-small.muted', `${o.list.length} ${o.list.length === 1 ? 'library' : 'libraries'}`)),
      group(...o.list.map(rowFor)))),
  ];
  panel.append(
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap' } },
      button('Add library', { icon: 'create_new_folder', onclick: () => libraryDialog(null, providers) }),
      button('Scan all', { variant: 'text', icon: 'sync', onclick: async () => { await api.scanAll(); snackbar('Scanning all libraries…'); } }),
      button('Find duplicates', { variant: 'text', icon: 'content_copy', onclick: () => navigate('/admin/duplicates') }),
      scanIndicator(() => {
        refreshShell();
        reload('libraries');
      }),
    ),
    ...sections.filter(Boolean),
    fulltextGroup(),
    h('p.note', 'Supported: EPUB · KEPUB · MOBI · AZW · AZW3 · FB2 · TXT · PDF · CBZ · ZIP · CBR · RAR · CB7 · 7Z · CBT · TAR · image folders. Audiobooks in book libraries: M4B · M4A · MP3 · OGG · OPUS · FLAC (a folder of tracks is one audiobook). ComicInfo.xml, EPUB/Calibre metadata and audio tags are read automatically; a Calibre metadata.db in the library folder is imported.'),
  );
}

export const MODE_LABEL = { books: 'Regular books', kavita: 'Kavita (file names)', komga: 'Komga (folders)' };

/** Full-text search index: how far along it is, and a rebuild button. */
function fulltextGroup() {
  const line = h('div.s', 'Checking…');
  const wrap = h('div', h('div.sub-head', icon('manage_search'), 'Full-text search'),
    group(h('div.setting-row', icon('manage_search'),
      h('div.text', h('div', 'Search inside books'), line),
      button('Rebuild index', { variant: 'text', icon: 'refresh', onclick: async () => {
        if (!(await confirmDialog({ title: 'Rebuild the search index?', message: 'Every book’s text is read again in the background. Searching inside books works again as it catches up.', confirm: 'Rebuild' }))) return;
        draw(await api.rebuildFulltext());
      } }))));
  const draw = (s) => {
    if (!s.enabled) line.textContent = 'Turned off on this server (FULLTEXT=0).';
    else line.textContent = `${s.indexed.toLocaleString()} ${s.indexed === 1 ? 'book' : 'books'} indexed${s.pending ? ` · ${s.pending.toLocaleString()} waiting${s.running ? ` (indexing ${s.done} of ${s.total})` : ''}` : ''}. EPUB, FB2, TXT, DOCX, RTF and PDFs with text are searchable from the search page.`;
  };
  api.fulltextStatus().then(draw).catch(() => (line.textContent = ''));
  return wrap;
}

/** Bring series, tags, ratings and covers over from a Calibre library's metadata.db. */
async function calibreImport(l) {
  const ok = await confirmDialog({
    title: `Import from Calibre into “${l.name}”?`,
    message: 'Titles, authors, series, tags, descriptions, publishers, identifiers and covers from Calibre’s metadata.db are applied to the matching books, and Calibre ratings become your ratings. This also happens automatically after each scan whenever metadata.db changes.',
    confirm: 'Import',
    icon: 'move_to_inbox',
  });
  if (!ok) return;
  snackbar('Importing from Calibre…', { duration: 60_000 });
  try {
    const r = await api.calibreImport(l.id);
    snackbar(`Imported ${r.books} ${r.books === 1 ? 'book' : 'books'} from Calibre${r.unmatched ? ` · ${r.unmatched} not found in the folder` : ''}${r.covers ? ` · ${r.covers} covers` : ''}${r.ratings ? ` · ${r.ratings} ratings` : ''}`, { duration: 8000 });
  } catch (e) {
    snackbar(e.message, { duration: 8000 });
  }
}

// ---------------------------------------------------------------------------
// Duplicates

const DUP_REASON = {
  'same-file': ['file_copy', 'Identical files'],
  'same-book': ['menu_book', 'Same book, different copies'],
  'same-volume': ['collections_bookmark', 'Same volume or chapter'],
};

/** #/admin/duplicates – review likely duplicate books, keep one copy and merge, or dismiss. */
export async function duplicatesView(view, params, stale) {
  const page = h('div.page', { style: { maxWidth: '1100px' } });
  view.append(page);
  const banner = pageBanner({ icon: 'content_copy', eyebrow: 'Libraries', title: 'Duplicates', sub: 'Looking for books that appear more than once…' });
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
    banner.setSub(groups.length ? `${groups.length} ${groups.length === 1 ? 'group' : 'groups'} · ${files} extra ${files === 1 ? 'copy' : 'copies'}` : 'No duplicates found');
    if (!groups.length) {
      body.replaceChildren(emptyState('task_alt', 'No duplicates', 'Every book appears once. Groups you marked “Not duplicates” stay hidden.'));
      return;
    }
    body.replaceChildren(...groups.map(groupCard));
  }

  function groupCard(g) {
    const [ic, label] = DUP_REASON[g.reason] || ['content_copy', 'Possible duplicates'];
    // Keep the copy most people read, then the oldest.
    let keep = [...g.books].sort((a, b) => b.readers - a.readers || b.notes - a.notes || a.addedAt - b.addedAt)[0].id;
    const rows = g.books.map((b) => {
      const radio = h('input', { type: 'radio', name: `keep-${g.key}`, checked: b.id === keep, onchange: () => (keep = b.id) });
      return h('label.dup-row',
        radio,
        h('div.dup-text',
          h('div.title-small', b.series && b.series !== b.title ? `${b.series} · ${b.title}` : b.title),
          h('div.body-small.muted', [b.author, b.format.toUpperCase(), formatBytes(b.size), `${b.library}${b.personal ? ' (personal)' : ''}`, `added ${timeAgo(b.addedAt)}`].filter(Boolean).join(' · ')),
          h('div.body-small.muted.mono', b.path),
          (b.readers || b.notes) > 0 && h('div.body-small', `${b.readers} ${b.readers === 1 ? 'reader' : 'readers'} · ${b.notes} ${b.notes === 1 ? 'bookmark or note' : 'bookmarks and notes'}`)),
        iconButton('menu_book', 'Open', (e) => {
          e.preventDefault();
          navigate(`/read/${b.id}`);
        }));
    });
    const card = h('section.dup-group.enter',
      h('div.dup-head', h('span.sec-icon', icon(ic)), h('div', h('div.title-medium', label), h('div.body-small.muted', 'Choose the copy to keep. Progress, reading time, bookmarks and notes from the others move to it.'))),
      h('div.dup-rows', rows),
      h('div.dup-actions',
        button('Not duplicates', { variant: 'text', icon: 'visibility_off', onclick: async () => {
          await api.ignoreDuplicates(g.key);
          card.remove();
          snackbar('Hidden – they won’t be suggested again');
        } }),
        button('Keep selected, delete others', { variant: 'tonal', icon: 'merge', onclick: async () => {
          const others = g.books.filter((b) => b.id !== keep);
          if (!(await confirmDialog({
            title: `Delete ${others.length} ${others.length === 1 ? 'copy' : 'copies'}?`,
            message: `${others.map((b) => `${b.format.toUpperCase()} in ${b.library}`).join(', ')} will be deleted from disk after everyone’s reading data moves to the copy you keep.`,
            confirm: 'Merge and delete',
            danger: true,
            icon: 'merge',
          }))) return;
          try {
            const r = await api.mergeDuplicates(keep, others.map((b) => b.id));
            snackbar(`Merged · ${r.removed} ${r.removed === 1 ? 'copy' : 'copies'} deleted`);
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
    card('books', 'auto_stories', 'Regular books', 'Each book stands on its own, using its title, author and cover from the file. Books only group when their metadata names a series. Works with Calibre folders.'),
    card('kavita', 'text_fields', 'Kavita style', 'Groups files into series by parsing file names (“Series v01 c003”) and embedded metadata – folders don’t matter.'),
    card('komga', 'folder_open', 'Komga style', 'Every sub-folder is one series, named after the folder. No metadata editing needed for well-organised folders.'),
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
  const name = field('Name', { value: lib?.name || '', required: true });
  const kind = field('Type', { options: KIND_OPTIONS, value: state.kind });
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
  const owner = field('Who it’s for', {
    value: lib ? lib.ownerId ?? '' : me,
    options: [
      { value: me, label: 'Only me – private' },
      { value: '', label: 'Shared with users' },
      ...guests.map((u) => ({ value: u.id, label: `${u.displayName} (@${u.username}) – their personal library`, group: 'A user’s library' })),
    ],
    support: 'Private libraries are yours alone. Shared libraries are visible to users you allow (Settings → Users). A user’s library is only theirs, and is where their downloads and uploads go if they have a personal folder.',
  });

  const auto = h('input', { type: 'checkbox', checked: lib?.autoMetadata ?? false });
  const policy = field('Artwork from sources', {
    value: lib?.coverPolicy || 'missing',
    options: [
      { value: 'missing', label: 'Only when a series has no cover' },
      { value: 'always', label: 'Always use the source’s artwork' },
      { value: 'never', label: 'Never replace artwork' },
    ],
  });
  const defaults = { manga: ['anilist', 'mangadex', 'mal', 'mangaupdates'], comics: ['comicvine', 'anilist', 'mangadex'], books: ['openlibrary', 'googlebooks', 'anilist'] };
  const sourceBox = h('div.check-grid');
  function renderSources() {
    const active = state.sources || defaults[state.kind];
    sourceBox.replaceChildren(...providers.map((p) => {
      const input = h('input', { type: 'checkbox', checked: active.includes(p.id), disabled: !p.configured });
      input.dataset.id = p.id;
      return h('label.check', input, p.name, !p.configured && h('span.muted', { style: { fontSize: '12px' } }, '(needs key)'));
    }));
  }
  renderSources();

  let pathField = null;
  let browser = null;
  if (!lib) {
    pathField = field('Folder path', { required: true, support: 'Absolute path on the server, e.g. /home/me/Manga' });
    browser = folderBrowser((p, picked) => {
      pathField.input.value = p;
      if (picked && !name.input.dataset.touched) name.input.value = p.split(/[\\/]/).filter(Boolean).pop() || '';
    });
    name.input.addEventListener('input', () => (name.input.dataset.touched = '1'));
  }

  await formDialog({
    title: lib ? 'Edit library' : 'Add library',
    icon: lib ? 'edit' : 'create_new_folder',
    className: 'fullscreen-compact',
    submit: lib ? 'Save' : 'Add library',
    fields: [
      name,
      kind,
      owner,
      h('p.label-large', { style: { margin: '16px 0 0' } }, 'Folder structure'),
      modes,
      h('p.label-large', { style: { margin: '16px 0 4px' } }, 'Metadata'),
      h('label.check', auto, 'Automatically fetch metadata & artwork for new series'),
      h('p.body-small.muted', 'Sources are tried in order; a series is only matched when the title is a confident match.'),
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
      snackbar(lib ? 'Library updated' : 'Library added – scanning now');
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
  const up = iconButton('arrow_upward', 'Parent folder', () => current.parent && go(current.parent));
  const use = button('Use this folder', { variant: 'text', onclick: () => onPick(current.path, true) });
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
    info.textContent = current.bookFiles ? `${current.bookFiles} book ${current.bookFiles === 1 ? 'file' : 'files'} here` : '';
    onPick(current.path, picked);
    list.replaceChildren(
      ...(current.dirs.length
        ? current.dirs.map((d) => h('button.list-item.state', { type: 'button', onclick: () => go(d.path) }, icon('folder'), h('span.text', d.name), icon('chevron_right')))
        : [h('div.list-item.static.muted', 'No sub-folders')]),
    );
  }
  go('', false);
  return h('div',
    h('p.label-large', { style: { margin: '16px 0 0' } }, 'Or browse the server'),
    h('div.folder-browser', h('div.crumb', up, crumb, use), list),
    info,
  );
}

// ---------------------------------------------------------------------------
// Users

export async function usersPanel(panel, stale) {
  panel.append(h('h2', 'Users'), loading());
  const users = await api.users();
  if (stale()) return;
  panel.lastChild.remove();
  const rows = users.map((u) => {
    const isSelf = u.id === session.user.id;
    const age = AGE_RATINGS.find((a) => a.value === u.maxAgeRating);
    const more = !isSelf && u.role !== 'admin' && iconButton('more_vert', 'User options', () =>
      menu(more, [
        { label: 'Edit', icon: 'edit', onClick: () => userDialog(u) },
        { label: 'Downloads & uploads', icon: 'folder_open', onClick: () => navigate(`/admin/users/${u.id}/files`) },
        { label: 'Reset password', icon: 'key', onClick: () => passwordDialog(u) },
        { label: 'Sign out everywhere', icon: 'logout', onClick: async () => { await api.signOutUser(u.id); snackbar(`${u.displayName} signed out`); } },
        '-',
        { label: 'Delete user', icon: 'person_remove', onClick: async () => {
          if (!(await confirmDialog({ title: `Delete ${u.displayName}?`, message: 'Their reading progress, collections and stats will be deleted.', confirm: 'Delete', danger: true, icon: 'person_remove' }))) return;
          await api.deleteUser(u.id);
          snackbar('User deleted');
          reload('users');
        } },
      ]),
    );
    return h('div.setting-row',
      avatar(u, 40),
      h('div.text',
        h('div', `${u.displayName}${isSelf ? ' (you)' : ''}`),
        h('div.s', `@${u.username}${u.email ? ` · ${u.email}` : ''} · ${u.role === 'admin' ? 'Admin' : 'Guest · read-only'}`),
        h('div.s', `${u.maxAgeRating == null ? 'No age restriction' : `Up to ${age?.label}`} · ${!u.libraryIds ? 'All libraries' : u.libraryIds.length ? `${u.libraryIds.length} shared ${u.libraryIds.length === 1 ? 'library' : 'libraries'}` : 'No shared libraries'} · active ${timeAgo(u.lastSeenAt)} · ${formatDuration(u.secondsRead, { short: true })} read · ${u.finished} finished`),
        u.homeDir && h('div.s', h('span.mono', `📁 ${u.homeDir}`)),
        u.storage && storageLine(u.storage),
        !isSelf && (u.downloaded > 0 || u.uploaded > 0) && h('a.contrib-line.s', { href: `#/admin/users/${u.id}/files`, title: 'Review downloads & uploads' },
          icon('folder_open'),
          `${u.downloaded} downloaded · ${u.uploaded} uploaded`,
          u.contributions.length > 0 && ` – ${u.contributions.map((c) => `${c.name}: ${[c.downloads && `${c.downloads} ↓`, c.uploads && `${c.uploads} ↑`].filter(Boolean).join(' ')}`).join(', ')}`),
        u.role !== 'admin' && h('div.perm-chips', PERMISSIONS.filter((p) => u.permissions?.[p.key]).map((p) => h('span.mini-chip', icon(p.icon), p.label))),
      ),
      more,
    );
  });
  panel.append(
    h('div', { style: { marginBottom: '16px' } }, button('Add guest', { icon: 'person_add', onclick: () => userDialog(null) })),
    group(...rows),
    h('p.note', 'Guests can browse, read, bookmark and keep their own progress, collections and stats – but can’t change libraries, metadata or other users. Share access outside your network by port-forwarding Flyleaf (ideally behind HTTPS).'),
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
  const bulk = button('Delete selected', { variant: 'tonal', icon: 'delete', disabled: true, onclick: () => remove([...selected].map((k) => items.find((i) => i.key === k))) });
  const count = h('span.label-large.muted');
  const refresh = () => {
    bulk.disabled = !selected.size;
    count.textContent = selected.size ? `${selected.size} selected` : `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
  };
  let items = data.items;

  async function remove(targets) {
    const n = targets.length;
    if (!(await confirmDialog({
      title: `Delete ${n === 1 ? `“${targets[0].title}”` : `${n} items`}?`,
      message: `The ${n === 1 ? 'file is' : 'files are'} deleted from the server, along with everyone’s progress, bookmarks and notes for ${n === 1 ? 'it' : 'them'}.`,
      confirm: 'Delete',
      danger: true,
      icon: 'delete',
    }))) return;
    const r = await api.deleteUserFiles(params.id, targets.flatMap((t) => t.refs));
    snackbar(r.failed.length ? `Deleted ${r.deleted}; ${r.failed.length} failed: ${r.failed[0]}` : `Deleted ${r.deleted} ${r.deleted === 1 ? 'item' : 'items'}`, { duration: r.failed.length ? 8000 : 4000 });
    const fresh = await api.userFiles(params.id, library);
    items = fresh.items;
    data = fresh;
    selected.clear();
    draw();
  }

  function draw() {
    list.replaceChildren(...(items.length ? items.map((it) => {
      const check = h('input', { type: 'checkbox', checked: selected.has(it.key), 'aria-label': `Select ${it.title}`, onchange: () => {
        if (check.checked) selected.add(it.key);
        else selected.delete(it.key);
        refresh();
      } });
      const sources = [...new Set(it.refs.map((r) => r.source))];
      const meta = [
        sources.map((s) => (s === 'download' ? `Downloaded${it.plugin ? ` via ${it.plugin}` : ''}` : 'Uploaded')).join(' + '),
        it.libraryName + (it.personal ? ' (personal)' : ''),
        it.size ? formatBytes(it.size) : null,
        timeAgo(it.at),
        !it.book && 'not in the library yet',
      ].filter(Boolean).join(' · ');
      return h('div.list-item.moderation-row',
        check,
        h('div', { style: { width: '40px', flex: 'none' } }, it.book ? cover(it.book, { showProgress: false }) : h('div.file-badge', icon('draft'))),
        h('div.text',
          h('div.headline', it.book ? (it.book.series && it.book.series !== it.book.label ? `${it.book.series} · ${it.book.label}` : it.book.title) : it.title),
          h('div.supporting', meta),
          h('div.supporting.mono', it.file)),
        it.book && iconButton('menu_book', 'Open', () => navigate(`/read/${it.book.id}`)),
        it.book?.seriesId && iconButton('open_in_new', 'Series page', () => navigate(`/series/${it.book.seriesId}`)),
        iconButton('delete', 'Delete', () => remove([it])),
      );
    }) : [h('div.list-item.static.muted', 'Nothing here.')]));
    refresh();
  }

  const filter = h('div.chip-set',
    [{ id: '', name: 'All libraries', n: data.libraries.reduce((a, l) => a + l.downloads + l.uploads, 0) },
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
      iconButton('arrow_back', 'Back to users', () => navigate('/settings/users')),
      h('h1', `${data.user.displayName}’s downloads & uploads`)),
    h('p.body-medium.muted', { style: { margin: '0 0 12px' } },
      'Everything this user added with Content Finder or the Upload tab. Delete anything that breaks your server’s rules – the files are removed from disk.'),
    data.ownLibraries.length > 0 && h('div.chip-set', { style: { marginBottom: '12px' } },
      h('span.label-large', { style: { alignSelf: 'center', marginRight: '4px' } }, 'Their libraries:'),
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
    h('div.s', st.quota ? `${formatBytes(st.used)} of ${formatBytes(st.quota)} used` : `${formatBytes(st.used)} used · no storage limit`,
      st.files ? ` · ${st.files.toLocaleString()} ${st.files === 1 ? 'file' : 'files'}` : ''),
    st.quota > 0 && h('div.storage-bar', { class: pct >= 90 ? 'full' : '' }, h('span', { style: { width: `${pct}%` } })));
}

const PERMISSIONS = [
  { key: 'download', icon: 'download', label: 'Download & Send to', sub: 'Download original files and zips, and email books to e-readers.' },
  { key: 'contentFinder', icon: 'travel_explore', label: 'Content Finder', sub: 'Search plugin sources and download new books into the libraries they can see.' },
  { key: 'upload', icon: 'upload', label: 'Upload', sub: 'Upload files and folders into the libraries they can see.' },
  { key: 'deleteBooks', icon: 'delete', label: 'Delete books', sub: 'Delete books in their own libraries and files they downloaded. Other books in shared libraries can’t be deleted.' },
  { key: 'apiAccess', icon: 'key', label: 'API keys', sub: 'Create keys for OPDS reading apps and the REST API.' },
];

export async function userDialog(user, { onSaved } = {}) {
  const username = field('Username', { value: user?.username || '', required: true, autocapitalize: 'none', support: '3–32 letters, numbers, . - _' });
  const display = field('Display name', { value: user?.displayName || '' });
  const email = field('Email', { value: user?.email || '', type: 'email' });
  const password = !user && field('Password', { type: 'password', required: true, autocomplete: 'new-password', support: 'At least 8 characters. Share it with your guest.' });
  const age = field('Age restriction', { value: user?.maxAgeRating ?? '', options: [{ value: '', label: 'No restriction' }, ...AGE_RATINGS.filter((a) => a.value !== '').map((a) => ({ value: a.value, label: `Up to ${a.label}` }))] });
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
  const homeField = field('Personal folder', {
    value: user?.homeDir || '',
    support: user
      ? 'Optional. An absolute folder on the server, e.g. /srv/flyleaf/alex. Created if it doesn’t exist.'
      : 'Leave empty to use Flyleaf’s data folder (content/<username>), or enter an absolute folder on the server. Books, Comics and Manga libraries are created in it.',
    autocomplete: 'off',
  });
  const homeBrowser = h('div.home-browser', { hidden: true });
  const homeBrowse = button('Browse the server', { variant: 'text', icon: 'folder_open', onclick: () => {
    homeBrowser.hidden = !homeBrowser.hidden;
    if (!homeBrowser.hidden && !homeBrowser.childElementCount) {
      homeBrowser.append(folderBrowser((p, picked) => {
        if (picked) homeField.input.value = p;
      }));
    }
  } });
  const quotaField = field('Storage limit (GB)', {
    value: user?.quotaMb == null ? '' : user.quotaMb === 0 ? '0' : String(+(user.quotaMb / 1024).toFixed(2)),
    type: 'number',
    min: 0,
    step: 'any',
    support: 'How much their personal folder may hold. Empty uses the server default (Server & email → Storage); 0 means no limit.',
  });
  const perms = { download: true, contentFinder: false, apiAccess: true, upload: false, deleteBooks: true, ...(user?.permissions || {}) };
  const permRows = PERMISSIONS.map((p) => {
    const input = h('input', { type: 'checkbox', checked: perms[p.key] });
    input.dataset.key = p.key;
    return h('label.perm-row', icon(p.icon), h('div', h('div.body-large', p.label), h('div.body-small.muted', p.sub)), input);
  });

  await formDialog({
    title: user ? `Edit ${user.displayName}` : 'Add guest',
    icon: user ? 'edit' : 'person_add',
    className: 'fullscreen-compact',
    fields: [
      username, display, email, password,
      h('p.label-large', { style: { margin: '16px 0 4px' } }, 'Content'),
      age, h('label.check', unknown, 'Include series with no age rating'),
      h('div', { style: { marginTop: '8px' } },
        h('label.check', allLibs, h('strong', 'All shared libraries, including ones added later')),
        libs.length > 0
          ? h('div.check-grid', { style: { paddingLeft: '28px' } }, libChecks)
          : h('p.body-small.muted', { style: { paddingLeft: '28px' } }, 'There are no shared libraries yet. Their personal libraries are always available to them.')),
      h('p.label-large', { style: { margin: '16px 0 4px' } }, 'Personal folder'),
      h('p.body-small.muted', { style: { marginBottom: '8px' } },
        'Give this user a folder of their own. They can create their own libraries inside it (nobody else sees them), and their Content Finder downloads and uploads go only into those libraries. The shared libraries above stay read-only for them.'),
      homeField,
      homeBrowse,
      homeBrowser,
      user?.storage && storageLine(user.storage),
      quotaField,
      h('p.label-large', { style: { margin: '16px 0 4px' } }, 'Permissions'),
      h('div.perm-list', permRows),
      h('p.body-small.muted', 'Guests always have their own progress, collections, bookmarks and stats, and can never change libraries, metadata or other users.'),
    ],
    submit: user ? 'Save' : 'Create',
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
        snackbar('Saved');
      } else {
        const r = await api.createUser({ ...body, password: password.input.value });
        snackbar(r.libraries ? `Guest created, with ${r.libraries === 3 ? 'Books, Comics and Manga libraries' : `${r.libraries} libraries`} in ${r.homeDir}` : 'Guest created', { duration: 6000 });
      }
      if (onSaved) onSaved();
      else reload('users');
    },
  });
}

async function passwordDialog(user) {
  const password = field('New password', { type: 'password', required: true, autocomplete: 'new-password' });
  await formDialog({
    title: `Reset password for ${user.displayName}`,
    icon: 'key',
    fields: [password],
    onSubmit: async () => {
      await api.updateUser(user.id, { password: password.input.value });
      snackbar('Password changed. They’ve been signed out of other devices.');
    },
  });
}

// ---------------------------------------------------------------------------
// Metadata sources

export async function metadataPanel(panel, stale) {
  panel.append(h('h2', 'Metadata sources'), loading());
  const [s, providers] = await Promise.all([api.adminSettings(), api.providers()]);
  if (stale()) return;
  panel.lastChild.remove();
  const cv = field('ComicVine API key', { value: s.comicvineKey || '', support: 'Free at comicvine.gamespot.com/api' });
  const gb = field('Google Books API key (optional)', { value: s.googleBooksKey || '', support: 'Avoids shared rate limits. console.cloud.google.com → Books API' });
  const mal = field('MyAnimeList Client ID (optional)', { value: s.malClientId || '', support: 'myanimelist.net/apiconfig – otherwise the public Jikan API is used.' });
  const err = h('div');
  panel.append(
    group(...providers.map((p) => row(p.configured ? 'check_circle' : 'key', p.name, `${p.kinds.join(', ')}${p.needsKey ? ' · needs an API key' : ' · no key needed'}`, h('span.label-medium', { style: { color: p.configured ? 'var(--md-primary)' : 'var(--md-error)' } }, p.configured ? 'Ready' : 'Not configured')))),
    h('div.sub-head', 'API keys'),
    group(h('div.setting-row.stack', err, cv, gb, mal, h('div', button('Save keys', { icon: 'save', onclick: async () => {
      err.replaceChildren();
      try {
        await api.saveAdminSettings({ comicvineKey: cv.input.value, googleBooksKey: gb.input.value, malClientId: mal.input.value });
        snackbar('Saved');
        reload('metadata');
      } catch (e) {
        err.append(formError(e.message));
      }
    } })))),
    h('p.note', 'Turn on automatic matching per library (Libraries → Edit). You can always fetch or edit metadata by hand from a series page – edited fields are locked so scans never overwrite them.'),
  );
}

// ---------------------------------------------------------------------------
// Server & email

export async function serverPanel(panel, stale) {
  panel.append(h('h2', 'Server & email'), loading());
  const s = await api.adminSettings();
  if (stale()) return;
  panel.lastChild.remove();
  const publicUrl = field('Public URL', { value: s.publicUrl || '', type: 'url', support: 'How people reach Flyleaf from outside, e.g. https://books.example.com – used for OPDS links.' });
  const opds = h('input', { type: 'checkbox', checked: s.opdsEnabled !== false });
  const host = field('SMTP host', { value: s.smtp.host });
  const port = field('Port', { value: s.smtp.port, type: 'number' });
  const secure = h('input', { type: 'checkbox', checked: s.smtp.secure });
  const user = field('Username', { value: s.smtp.user, autocomplete: 'off' });
  const pass = field('Password', { value: s.smtp.pass, type: 'password', autocomplete: 'new-password' });
  const from = field('From address', { value: s.smtp.from, type: 'email', support: 'For Kindle, approve this address in your Amazon account.' });
  const err = h('div');
  panel.append(
    group(h('div.setting-row.stack', publicUrl, h('label.check', opds, 'Enable the OPDS catalog for third-party apps'))),
    h('div.sub-head', 'Email (for Send to Kindle / Kobo)'),
    group(h('div.setting-row.stack', err, host,
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px', alignItems: 'center' } }, port, h('label.check', secure, 'Use TLS (port 465)')),
      user, pass, from,
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        button('Save', { icon: 'save', onclick: async () => {
          err.replaceChildren();
          try {
            await api.saveAdminSettings({ publicUrl: publicUrl.input.value, opdsEnabled: opds.checked, smtp: { host: host.input.value, port: port.input.value, secure: secure.checked, user: user.input.value, pass: pass.input.value, from: from.input.value } });
            snackbar('Saved');
          } catch (e) {
            err.append(formError(e.message));
          }
        } }),
        button('Send test email', { variant: 'text', icon: 'outgoing_mail', onclick: async () => {
          const to = field('Send to', { type: 'email', value: session.user.email || '', required: true });
          await formDialog({ title: 'Test email', fields: [to], submit: 'Send', onSubmit: async () => {
            await api.testSmtp(to.input.value);
            snackbar('Test email sent');
          } });
        } }),
      ),
    )),
    h('div.sub-head', 'Storage'),
    storageGroup(),
    h('div.sub-head', 'Sign-up'),
    registrationGroup(s),
    h('p.note', 'Run as a service with install.sh, and see the README for HTTPS reverse-proxy examples. Logs live in data/logs/flyleaf.log.'),
  );
}

/** Storage limits: personal folder quota, largest upload, free space to keep on the disk. */
function storageGroup() {
  const wrap = h('div.settings-group', h('div.setting-row', loading()));
  api.storageLimits().then((s) => {
    const gb = (mb) => (mb == null ? '' : String(+(mb / 1024).toFixed(2)));
    const quota = field('Default storage per personal folder (GB)', { value: gb(s.defaultQuotaMb), type: 'number', min: 0, step: 'any', support: 'For users with a personal folder. Empty or 0 means no limit; you can override it per user in Users → Edit. Admins are never limited.' });
    const upload = field('Largest upload (MB)', { value: s.maxUploadMb ?? '', type: 'number', min: 1, support: `Per file. Empty uses MAX_UPLOAD_MB (${s.envMaxUploadMb.toLocaleString()} MB).` });
    const reserve = field('Keep free on the disk (GB)', { value: gb(s.reserveFreeMb), type: 'number', min: 0, step: 'any', support: 'Uploads and downloads stop before the disk gets fuller than this, so the database never runs out of room.' });
    const err = h('div');
    const disk = s.disk.total ? `${formatBytes(s.disk.free)} free of ${formatBytes(s.disk.total)} on the data disk` : 'Free space unknown';
    wrap.replaceChildren(
      row('hard_drive', disk, s.disk.total ? h('div.storage-bar', { class: s.disk.free / s.disk.total < 0.1 ? 'full' : '' }, h('span', { style: { width: `${100 - (s.disk.free / s.disk.total) * 100}%` } })) : null),
      h('div.setting-row.stack', err, quota, upload, reserve,
        h('div', button('Save storage limits', { icon: 'save', onclick: async () => {
          err.replaceChildren();
          const mb = (v) => (v === '' ? null : Math.round(Number(v) * 1024));
          try {
            await api.saveStorageLimits({ defaultQuotaMb: mb(quota.input.value), maxUploadMb: upload.input.value === '' ? null : Number(upload.input.value), reserveFreeMb: mb(reserve.input.value) ?? 0 });
            snackbar('Saved');
          } catch (e) {
            err.append(formError(e.message));
          }
        } }))),
    );
  }).catch((e) => wrap.replaceChildren(row('error', 'Couldn’t load storage limits', e.message)));
  return wrap;
}

/** Let people create their own accounts (for a publicly hosted Flyleaf). */
function registrationGroup(s) {
  const reg = { enabled: false, inviteCode: '', sharedLibraries: 'all', permissions: null, ...(s.registration || {}) };
  const enabled = h('input', { type: 'checkbox', checked: reg.enabled });
  const invite = field('Invite code', { value: reg.inviteCode || '', autocomplete: 'off', support: 'Optional, but recommended on a public server: only people you give the code to can sign up. Leave empty to let anyone sign up.' });
  const generate = button('Generate', { variant: 'text', icon: 'casino', onclick: () => {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    invite.input.value = [...bytes].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
    invite.input.dispatchEvent(new Event('input'));
  } });
  const shared = field('Shared libraries for new accounts', {
    value: reg.sharedLibraries,
    options: [{ value: 'all', label: 'All shared libraries' }, { value: 'none', label: 'None – only their own Books, Comics and Manga' }],
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
    h('p.label-large', { style: { margin: '12px 0 4px' } }, 'What new accounts can do'),
    h('div.perm-list', permRows),
    h('p.body-small.muted', { style: { marginTop: '8px' } }, 'You can change any account later in Settings → Users.'),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '12px' } },
      h('span.body-medium', 'Sign-up link: ', h('span.mono', link)),
      button('Copy', { variant: 'text', icon: 'content_copy', onclick: () => copyText(link) })),
  );
  enabled.addEventListener('change', () => (details.hidden = !enabled.checked));
  const err = h('div');
  return group(h('div.setting-row.stack', err,
    h('label.check', enabled, h('span', h('strong', 'Let people create their own accounts'), h('br'),
      h('span.body-small.muted', 'Adds “Create an account” to the sign-in page. Each new account gets its own folder (content/<username>) with Books, Comics and Manga libraries.'))),
    details,
    h('div', button('Save sign-up settings', { icon: 'save', onclick: async () => {
      err.replaceChildren();
      try {
        await api.saveAdminSettings({ registration: {
          enabled: enabled.checked,
          inviteCode: invite.input.value,
          sharedLibraries: shared.input.value,
          permissions: Object.fromEntries(permRows.map((r) => r.querySelector('input')).map((i) => [i.dataset.key, i.checked])),
        } });
        snackbar(enabled.checked ? 'Sign-up is on' : 'Sign-up is off');
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
const GROUP_LABEL = { '': 'Everything', security: 'Sign-ins & security', downloads: 'Downloads', changes: 'Uploads & deletions', admin: 'Admin changes' };

export async function activityPanel(panel, stale) {
  panel.append(h('h2', 'Activity'), loading());
  const [data, sec, users] = await Promise.all([api.activity(), api.activitySecurity(), api.users()]);
  if (stale()) return;
  panel.lastChild.remove();

  const filters = { group: '', user: '', q: '' };
  const list = h('div.list.card.activity-list');
  const more = button('Show older', { variant: 'text', icon: 'expand_more', onclick: () => load(true) });
  let entries = data.entries;

  const entryRow = (e) => {
    const bad = e.action === 'login.failed' || e.action === 'login.blocked';
    const extra = e.details && Object.entries(e.details).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
    return h(`div.list-item.static.activity-row${bad ? '.bad' : ''}`,
      icon(ACTIVITY_ICON[e.action] || 'history'),
      h('div.text',
        h('div.headline', h('strong', e.username || 'Someone'), ` ${e.label.toLowerCase()}`, e.target && e.target !== e.username ? h('span', ' · ', e.target) : ''),
        h('div.supporting', [new Date(e.at).toLocaleString(), e.ip, extra].filter(Boolean).join(' · '))),
      h('span.label-small.muted', { title: new Date(e.at).toLocaleString() }, timeAgo(e.at)));
  };
  function draw() {
    list.replaceChildren(...(entries.length ? entries.map(entryRow) : [h('div.list-item.static.muted', 'Nothing logged yet.')]));
    more.hidden = entries.length === 0 || entries.length % 100 !== 0;
  }
  async function load(older = false) {
    const r = await api.activity({ ...filters, before: older ? entries.at(-1)?.id : undefined });
    entries = older ? [...entries, ...r.entries] : r.entries;
    draw();
    if (older && r.entries.length < 100) more.hidden = true;
  }

  const group = field('Show', { value: '', options: Object.entries(GROUP_LABEL).map(([value, label]) => ({ value, label })) });
  const who = field('User', { value: '', options: [{ value: '', label: 'Everyone' }, ...users.map((u) => ({ value: u.id, label: `${u.displayName} (@${u.username})` }))] });
  const text = field('Search', { value: '', support: 'Title, name or IP address' });
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
      row(s.failed24h ? 'gpp_maybe' : 'verified_user', s.failed24h ? `${s.failed24h} failed ${s.failed24h === 1 ? 'sign-in' : 'sign-ins'} in the last day` : 'No failed sign-ins in the last day',
        `${s.signins24h} successful ${s.signins24h === 1 ? 'sign-in' : 'sign-ins'} · an address is blocked for 15 minutes after 10 wrong passwords, and admins get a notification after 5`),
      ...s.blocked.map((b) => row('block', `${b.ip} is blocked`, `${b.failures} wrong passwords · unblocks itself at ${new Date(b.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        button('Unblock', { variant: 'tonal', icon: 'lock_open', onclick: async () => {
          drawSecurity(await api.unblockIp(b.ip));
          snackbar(`${b.ip} can sign in again`);
        } }))),
    ),
    (s.byIp.length > 0 || s.byUsername.length > 0) && h('div.security-grid',
      s.byIp.length > 0 && h('div.settings-group',
        h('div.setting-row', h('div.text', h('div.label-large', 'By address'))),
        ...s.byIp.map((r) => row('lan', r.ip || 'unknown', `${r.count} failed · last ${timeAgo(r.last)}${r.usernames.length ? ` · tried ${r.usernames.join(', ')}` : ''}`))),
      s.byUsername.length > 0 && h('div.settings-group',
        h('div.setting-row', h('div.text', h('div.label-large', 'By account name'))),
        ...s.byUsername.map((r) => row(r.exists ? 'person' : 'person_off', r.username, `${r.count} failed · last ${timeAgo(r.last)}${r.exists ? ' · a real account' : ' · no such account'}`))),
    ),
  ].filter(Boolean));
  drawSecurity(sec);

  panel.append(
    h('div.sub-head', 'Failed sign-ins'),
    secWrap,
    h('div.sub-head', 'Activity log'),
    h('div.activity-filters', group, who, text,
      button('Export CSV', { variant: 'text', icon: 'download', onclick: () => {
        const a = h('a', { href: api.activityCsvUrl(filters), download: '' });
        document.body.append(a);
        a.click();
        a.remove();
      } })),
    list,
    h('div', { style: { textAlign: 'center', marginTop: '8px' } }, more),
    h('p.note', `Sign-ins, downloads, uploads, deletions and admin changes are kept for ${data.keepDays} days (ACTIVITY_DAYS).`),
  );
  draw();
}
