// Settings → My libraries: libraries a user creates inside the personal folder the
// admin gave them. Only they (and the admin) can see these, and their downloads and
// uploads go here.

import { api } from '../api.js';
import { session, navigate } from '../router.js';
import { h, icon, iconButton, button, field, snackbar, confirmDialog, formDialog, loading, menu, timeAgo, emptyState } from '../ui.js';
import { refreshShell } from '../shell.js';
import { MODE_LABEL, modeCards } from './settings-admin.js';

const KIND_ICON = { books: 'menu_book', manga: 'auto_stories', comics: 'photo_library' };
const KIND_OPTIONS = [
  { value: 'books', label: 'Books – EPUB, MOBI/AZW3, FB2, TXT, PDF, DOCX, RTF' },
  { value: 'manga', label: 'Manga – right-to-left' },
  { value: 'comics', label: 'Comics – left-to-right' },
];
const reload = () => location.hash.startsWith('#/settings/mylibs') && navigate('/settings/mylibs', { replace: true });

export async function mylibsPanel(panel, stale) {
  panel.append(h('h2', 'My libraries'), loading());
  if (!session.user.homeDir) {
    panel.lastChild.replaceWith(emptyState('folder_off', 'No personal folder', 'Ask the admin to give you a personal folder. You can then create your own libraries in it.'));
    return;
  }
  const { home, libraries } = await api.myLibraries();
  if (stale()) return;
  panel.lastChild.remove();

  const rows = libraries.map((l) => {
    const more = iconButton('more_vert', 'Library options', () => menu(more, [
      { label: 'Scan now', icon: 'sync', onClick: async () => { await api.scanMyLibrary(l.id); snackbar(`Scanning ${l.name}…`); } },
      { label: 'Edit', icon: 'edit', onClick: () => libraryDialog(l) },
      { label: 'Upload into it', icon: 'upload', onClick: () => navigate(`/upload?library=${l.id}`) },
      '-',
      { label: 'Remove library', icon: 'delete', onClick: async () => {
        if (!(await confirmDialog({ title: `Remove “${l.name}”?`, message: 'It disappears from Flyleaf, with your progress for it. The files in the folder are kept.', confirm: 'Remove', danger: true, icon: 'delete' }))) return;
        await api.deleteMyLibrary(l.id);
        snackbar('Library removed');
        refreshShell();
        reload();
      } },
    ]));
    return h('div.setting-row',
      icon(KIND_ICON[l.kind]),
      h('div.text',
        h('div', h('a', { href: `#/library/${l.id}`, style: { color: 'inherit' } }, l.name)),
        h('div.s.mono', l.path || '~'),
        h('div.s', `${l.seriesCount} series · ${l.bookCount} files · ${MODE_LABEL[l.mode] || l.mode} · ${l.lastScanAt ? `scanned ${timeAgo(l.lastScanAt)}` : 'not scanned yet'}`)),
      more);
  });

  panel.append(
    h('div.home-card',
      icon('folder_special', 'filled'),
      h('div', h('div.title-small', 'Your personal folder'), h('div.body-small.mono', home),
        h('div.body-small.muted', 'Libraries you create here are private to you. Books you download with Content Finder or upload go into them.'))),
    libraries.length
      ? h('div.settings-group', ...rows)
      : h('p.note', 'You don’t have a library yet. Create one to start adding books.'),
    h('div', { style: { marginTop: '12px' } }, button('Add library', { icon: 'create_new_folder', onclick: () => libraryDialog(null) })),
  );
}

/** Create or edit one of your libraries. New ones pick a folder inside the personal folder. */
async function libraryDialog(lib) {
  const name = field('Name', { value: lib?.name || '', required: true });
  const kind = field('Type', { value: lib?.kind || 'books', options: KIND_OPTIONS });
  let mode = lib?.mode || 'books';
  let modes = modeCards(mode, (v) => (mode = v));
  kind.input.addEventListener('change', () => {
    if (lib) return;
    mode = kind.input.value === 'books' ? 'books' : 'komga';
    const next = modeCards(mode, (v) => (mode = v));
    modes.replaceWith(next);
    modes = next;
  });
  const auto = h('input', { type: 'checkbox', checked: lib?.autoMetadata ?? false });

  // Folder picker (new libraries only).
  let current = '';
  const crumbs = h('div.up-crumbs');
  const list = h('div.up-folders');
  const chosen = h('strong');
  async function go(rel) {
    list.replaceChildren(h('div.up-folder-loading', h('div.loader.small', h('span'))));
    let r;
    try {
      r = await api.myFolders(rel);
    } catch (e) {
      list.replaceChildren(h('div.form-error', icon('error'), e.message));
      return;
    }
    current = r.path;
    chosen.textContent = `~/${current}`.replace(/\/$/, '') || '~';
    const parts = current ? current.split('/') : [];
    crumbs.replaceChildren(
      h('button.chip.state', { type: 'button', 'aria-pressed': String(!parts.length), onclick: () => go('') }, icon('home'), 'Personal folder'),
      ...parts.flatMap((p, i) => [icon('chevron_right'), h('button.chip.state', { type: 'button', 'aria-pressed': String(i === parts.length - 1), onclick: () => go(parts.slice(0, i + 1).join('/')) }, p)]),
    );
    list.replaceChildren(...(r.folders.length
      ? r.folders.map((f) => h('button.up-folder.state', { type: 'button', disabled: Boolean(f.library), title: f.library ? `Already the library “${f.library.name}”` : '', onclick: () => go(f.path) },
        icon(f.library ? 'folder_special' : 'folder', 'filled'), h('span.up-folder-name', f.name, f.library ? h('span.muted', ` · ${f.library.name}`) : null), icon('chevron_right')))
      : [h('div.up-empty-folder', icon('folder_open'), 'No folders here yet')]));
  }
  const newFolder = button('New folder', { variant: 'text', icon: 'create_new_folder', onclick: async () => {
    const fname = field('Folder name', { required: true, value: name.input.value });
    await formDialog({ title: 'New folder', icon: 'create_new_folder', fields: [fname], submit: 'Create', onSubmit: async () => {
      const r = await api.createMyFolder({ path: current, name: fname.input.value });
      await go(r.path);
    } });
  } });
  if (!lib) go('');

  await formDialog({
    title: lib ? 'Edit library' : 'New library',
    icon: lib ? 'edit' : 'create_new_folder',
    className: 'fullscreen-compact',
    submit: lib ? 'Save' : 'Create library',
    fields: [
      name,
      kind,
      h('p.label-large', { style: { margin: '16px 0 0' } }, 'Folder structure'),
      modes,
      !lib && h('p.label-large', { style: { margin: '16px 0 8px' } }, 'Folder'),
      !lib && crumbs,
      !lib && list,
      !lib && h('div.up-folder-actions', newFolder),
      !lib && h('p.body-small.muted', 'The library will use: ', chosen, '. Pick a folder, or create one for this library.'),
      h('label.check', { style: { marginTop: '12px' } }, auto, 'Automatically fetch metadata & artwork for new series'),
    ],
    onSubmit: async () => {
      const body = { name: name.input.value, kind: kind.input.value, mode, autoMetadata: auto.checked };
      if (lib) await api.updateMyLibrary(lib.id, body);
      else await api.createMyLibrary({ ...body, path: current });
      snackbar(lib ? 'Library updated' : 'Library created – scanning now');
      refreshShell();
      reload();
    },
  });
}
