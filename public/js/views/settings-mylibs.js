import { t } from '../i18n.js';
// Settings → My libraries: libraries a user creates inside the personal folder the
// admin gave them. Only they (and the admin) can see these, and their downloads and
// uploads go here.

import { api } from '../api.js';
import { session, navigate } from '../router.js';
import { h, icon, iconButton, button, field, snackbar, confirmDialog, formDialog, loading, menu, timeAgo, emptyState } from '../ui.js';
import { refreshShell } from '../shell.js';
import { MODE_LABEL, modeCards, storageLine } from './settings-admin.js';

const KIND_ICON = { books: 'menu_book', manga: 'auto_stories', comics: 'photo_library' };
const KIND_OPTIONS = [
  { value: 'books', get label() { return t('Books – EPUB, MOBI/AZW3, FB2, TXT, PDF, DOCX, RTF'); } },
  { value: 'manga', get label() { return t('Manga – right-to-left'); } },
  { value: 'comics', get label() { return t('Comics – left-to-right'); } },
];
const reload = () => location.hash.startsWith('#/settings/mylibs') && navigate('/settings/mylibs', { replace: true });

export async function mylibsPanel(panel, stale) {
  panel.append(h('h2', t('My libraries')), loading());
  if (!session.user.homeDir) {
    panel.lastChild.replaceWith(emptyState('folder_off', t('No personal folder'), t('Ask the admin to give you a personal folder. You can then create your own libraries in it.')));
    return;
  }
  const [{ home, libraries }, storage] = await Promise.all([api.myLibraries(), api.myStorage().catch(() => null)]);
  if (stale()) return;
  panel.lastChild.remove();

  const rows = libraries.map((l) => {
    const more = iconButton('more_vert', t('Library options'), () => menu(more, [
      { label: t('Scan now'), icon: 'sync', onClick: async () => { await api.scanMyLibrary(l.id); snackbar(t('Scanning {name}…', { name: l.name })); } },
      { label: t('Edit'), icon: 'edit', onClick: () => libraryDialog(l) },
      { label: t('Upload into it'), icon: 'upload', onClick: () => navigate(`/upload?library=${l.id}`) },
      '-',
      { label: t('Remove library'), icon: 'delete', onClick: async () => {
        if (!(await confirmDialog({ title: t('Remove “{name}”?', { name: l.name }), message: t('It disappears from Flyleaf, with your progress for it. The files in the folder are kept.'), confirm: t('Remove'), danger: true, icon: 'delete' }))) return;
        await api.deleteMyLibrary(l.id);
        snackbar(t('Library removed'));
        refreshShell();
        reload();
      } },
    ]));
    return h('div.setting-row',
      icon(KIND_ICON[l.kind]),
      h('div.text',
        h('div', h('a', { href: `#/library/${l.id}`, style: { color: 'inherit' } }, l.name)),
        h('div.s.mono', l.path || '~'),
        h('div.s', t('{seriesCount} series · {bookCount} files · {value} · {value2}', { seriesCount: l.seriesCount, bookCount: l.bookCount, value: MODE_LABEL[l.mode] || l.mode, value2: l.lastScanAt ? t('scanned {value}', { value: timeAgo(l.lastScanAt) }) : t('not scanned yet') }))),
      more);
  });

  panel.append(
    h('div.home-card',
      icon('folder_special', 'filled'),
      h('div', h('div.title-small', t('Your personal folder')), h('div.body-small.mono', home),
        h('div.body-small.muted', t('Libraries you create here are private to you. Books you download with Content Finder or upload go into them.')),
        storage && storageLine(storage))),
    libraries.length
      ? h('div.settings-group', ...rows)
      : h('p.note', t('You don’t have a library yet. Create one to start adding books.')),
    h('div', { style: { marginTop: '12px' } }, button(t('Add library'), { icon: 'create_new_folder', onclick: () => libraryDialog(null) })),
  );
}

/** Create or edit one of your libraries. New ones pick a folder inside the personal folder. */
async function libraryDialog(lib) {
  const name = field(t('Name'), { value: lib?.name || '', required: true });
  const kind = field(t('Type'), { value: lib?.kind || 'books', options: KIND_OPTIONS });
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
      h('button.chip.state', { type: 'button', 'aria-pressed': String(!parts.length), onclick: () => go('') }, icon('home'), t('Personal folder')),
      ...parts.flatMap((p, i) => [icon('chevron_right'), h('button.chip.state', { type: 'button', 'aria-pressed': String(i === parts.length - 1), onclick: () => go(parts.slice(0, i + 1).join('/')) }, p)]),
    );
    list.replaceChildren(...(r.folders.length
      ? r.folders.map((f) => h('button.up-folder.state', { type: 'button', disabled: Boolean(f.library), title: f.library ? t('Already the library “{name}”', { name: f.library.name }) : '', onclick: () => go(f.path) },
        icon(f.library ? 'folder_special' : 'folder', 'filled'), h('span.up-folder-name', f.name, f.library ? h('span.muted', ` · ${f.library.name}`) : null), icon('chevron_right')))
      : [h('div.up-empty-folder', icon('folder_open'), t('No folders here yet'))]));
  }
  const newFolder = button(t('New folder'), { variant: 'text', icon: 'create_new_folder', onclick: async () => {
    const fname = field(t('Folder name'), { required: true, value: name.input.value });
    await formDialog({ title: t('New folder'), icon: 'create_new_folder', fields: [fname], submit: t('Create'), onSubmit: async () => {
      const r = await api.createMyFolder({ path: current, name: fname.input.value });
      await go(r.path);
    } });
  } });
  if (!lib) go('');

  await formDialog({
    title: lib ? t('Edit library') : t('New library'),
    icon: lib ? 'edit' : 'create_new_folder',
    className: 'fullscreen-compact',
    submit: lib ? t('Save') : t('Create library'),
    fields: [
      name,
      kind,
      h('p.label-large', { style: { margin: '16px 0 0' } }, t('Folder structure')),
      modes,
      !lib && h('p.label-large', { style: { margin: '16px 0 8px' } }, t('Folder')),
      !lib && crumbs,
      !lib && list,
      !lib && h('div.up-folder-actions', newFolder),
      !lib && h('p.body-small.muted', t('The library will use: '), chosen, t('. Pick a folder, or create one for this library.')),
      h('label.check', { style: { marginTop: '12px' } }, auto, t('Automatically fetch metadata & artwork for new series')),
    ],
    onSubmit: async () => {
      const body = { name: name.input.value, kind: kind.input.value, mode, autoMetadata: auto.checked };
      if (lib) await api.updateMyLibrary(lib.id, body);
      else await api.createMyLibrary({ ...body, path: current });
      snackbar(lib ? t('Library updated') : t('Library created – scanning now'));
      refreshShell();
      reload();
    },
  });
}
