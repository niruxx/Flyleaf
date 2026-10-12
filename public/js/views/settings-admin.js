// Admin settings panels: libraries, users, metadata sources, server & email.

import { api } from '../api.js';
import { session, navigate } from '../router.js';
import {
  h, icon, iconButton, button, field, formError, snackbar, confirmDialog, formDialog, timeAgo, formatDuration, loading, menu, AGE_RATINGS,
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
  const [libs, providers] = await Promise.all([api.libraries(), api.providers()]);
  if (stale()) return;
  panel.lastChild.remove();
  const rows = libs.map((l) => {
    const more = iconButton('more_vert', 'Library options', () =>
      menu(more, [
        { label: 'Scan now', icon: 'sync', onClick: async () => { await api.scanLibrary(l.id); snackbar(`Scanning ${l.name}…`); } },
        { label: 'Match metadata online', icon: 'travel_explore', onClick: async () => { await api.matchLibrary(l.id); snackbar('Matching series against online sources…'); } },
        { label: 'Edit', icon: 'edit', onClick: () => libraryDialog(l, providers) },
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
      ]),
    );
    return h('div.setting-row',
      icon(KIND_ICON[l.kind]),
      h('div.text',
        h('div', l.name, l.personal ? h('span.mini-chip', { style: { marginLeft: '8px' } }, icon('person'), `${l.ownerName}’s`) : null),
        h('div.s.mono', l.path),
        h('div.s', `${l.seriesCount} series · ${l.bookCount} files · ${MODE_LABEL[l.mode] || l.mode}${l.autoMetadata ? ' · auto metadata' : ''} · ${l.lastScanAt ? `scanned ${timeAgo(l.lastScanAt)}` : 'not scanned yet'}`),
      ),
      more,
    );
  });
  panel.append(
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap' } },
      button('Add library', { icon: 'create_new_folder', onclick: () => libraryDialog(null, providers) }),
      button('Scan all', { variant: 'text', icon: 'sync', onclick: async () => { await api.scanAll(); snackbar('Scanning all libraries…'); } }),
      scanIndicator(() => {
        refreshShell();
        reload('libraries');
      }),
    ),
    libs.length
      ? group(...rows)
      : group(row('info', 'No libraries yet', 'Add a folder containing EPUB, MOBI/AZW3, FB2, TXT, PDF, CBZ/ZIP, CBR/RAR, CB7/7z or CBT/tar files, or folders of images.')),
    h('p.note', 'Supported: EPUB · KEPUB · MOBI · AZW · AZW3 · FB2 · TXT · PDF · CBZ · ZIP · CBR · RAR · CB7 · 7Z · CBT · TAR · image folders. ComicInfo.xml and EPUB/Calibre metadata are read automatically.'),
  );
}

export const MODE_LABEL = { books: 'Regular books', kavita: 'Kavita (file names)', komga: 'Komga (folders)' };

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

  // Shared with everyone (subject to each user's access), or one user's personal library.
  const guests = (await api.users().catch(() => [])).filter((u) => u.role !== 'admin');
  const owner = field('Who it’s for', {
    value: lib?.ownerId ?? '',
    options: [{ value: '', label: 'Shared library' }, ...guests.map((u) => ({ value: u.id, label: `Personal library of ${u.displayName} (@${u.username})` }))],
    support: 'A personal library is only visible to that user (and you), and is where their downloads and uploads go if they have a personal folder.',
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
      guests.length > 0 && owner,
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
      h('span.avatar', { style: { width: '40px', height: '40px', cursor: 'default' } }, (u.displayName || u.username)[0]),
      h('div.text',
        h('div', `${u.displayName}${isSelf ? ' (you)' : ''}`),
        h('div.s', `@${u.username}${u.email ? ` · ${u.email}` : ''} · ${u.role === 'admin' ? 'Admin' : 'Guest · read-only'}`),
        h('div.s', `${u.maxAgeRating == null ? 'No age restriction' : `Up to ${age?.label}`} · ${u.libraryIds ? `${u.libraryIds.length} ${u.libraryIds.length === 1 ? 'library' : 'libraries'}` : 'All libraries'} · active ${timeAgo(u.lastSeenAt)} · ${formatDuration(u.secondsRead, { short: true })} read · ${u.finished} finished`),
        u.homeDir && h('div.s', h('span.mono', `📁 ${u.homeDir}`)),
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

const PERMISSIONS = [
  { key: 'download', icon: 'download', label: 'Download & Send to', sub: 'Download original files and zips, and email books to e-readers.' },
  { key: 'contentFinder', icon: 'travel_explore', label: 'Content Finder', sub: 'Search plugin sources and download new books into the libraries they can see.' },
  { key: 'upload', icon: 'upload', label: 'Upload', sub: 'Upload files and folders into the libraries they can see.' },
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
    support: 'Optional. An absolute folder on the server, e.g. /srv/flyleaf/alex. Created if it doesn’t exist.',
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
  const perms = { download: true, contentFinder: false, apiAccess: true, upload: false, ...(user?.permissions || {}) };
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
      libs.length > 0 && h('div', { style: { marginTop: '8px' } },
        h('label.check', allLibs, h('strong', 'All libraries, including ones added later')),
        h('div.check-grid', { style: { paddingLeft: '28px' } }, libChecks)),
      h('p.label-large', { style: { margin: '16px 0 4px' } }, 'Personal folder'),
      h('p.body-small.muted', { style: { marginBottom: '8px' } },
        'Give this user a folder of their own. They can create their own libraries inside it (nobody else sees them), and their Content Finder downloads and uploads go only into those libraries. The shared libraries above stay read-only for them.'),
      homeField,
      homeBrowse,
      homeBrowser,
      h('p.label-large', { style: { margin: '16px 0 4px' } }, 'Permissions'),
      h('div.perm-list', permRows),
      h('p.body-small.muted', 'Guests always have their own progress, collections, bookmarks and stats, and can never change libraries, metadata or other users.'),
    ],
    submit: user ? 'Save' : 'Create',
    onSubmit: async () => {
      const libraryIds = allLibs.checked ? null : libChecks.map((c) => c.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.dataset.id));
      if (libraryIds && !libraryIds.length) throw new Error('Pick at least one library, or allow all libraries.');
      const body = {
        username: username.input.value.trim(),
        displayName: display.input.value,
        email: email.input.value.trim(),
        maxAgeRating: age.input.value === '' ? null : Number(age.input.value),
        ageIncludeUnknown: unknown.checked,
        libraryIds,
        homeDir: homeField.input.value.trim() || null,
        permissions: Object.fromEntries(permRows.map((r) => r.querySelector('input')).map((i) => [i.dataset.key, i.checked])),
      };
      if (user) await api.updateUser(user.id, body);
      else await api.createUser({ ...body, password: password.input.value });
      snackbar(user ? 'Saved' : 'Guest created');
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
    h('p.note', 'Run as a service with install.sh, and see the README for HTTPS reverse-proxy examples. Logs live in data/logs/flyleaf.log.'),
  );
}

