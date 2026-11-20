import { api } from '../api.js';
import { t } from '../i18n.js';
import { session } from '../router.js';
import { button, field, formDialog, formatBytes, h } from '../ui.js';

export function migrationStage(phase) {
  return t(({ waiting: 'Waiting for storage operations to finish', preparing: 'Checking folders and available space',
    copying: 'Copying files', verifying: 'Checking copied files', switching: 'Updating personal library paths',
    cleaning: 'Removing the original folder' })[phase] || 'Moving personal folder');
}

export async function movePersonalFolderDialog(user, initial = '') {
  const [status, locations] = await Promise.all([api.storageMigration(), api.storageFolders(null, user?.id)]);
  const home = user?.homeDir || status.homeDir;
  const destination = field(t('Destination folder on the server'), {
    required: true, autocomplete: 'off', value: initial,
    support: t('Enter the full path of a new folder. Its parent folder must already exist.'),
  });
  const folders = h('div.up-folders');
  const chooser = h('details', h('summary', t('Browse storage folders')), folders);
  const parent = field(t('Browse another folder on the server'));
  const browse = async path => {
    folders.replaceChildren(t('Loading folders…'));
    try {
      const result = path ? await api.storageFolders(path, user?.id) : locations;
      const entries = path ? result.folders : result.roots.map(root => ({ path: root, name: root }));
      folders.replaceChildren(
        ...(path ? [h('p.mono', result.path), button(t('Back'), { variant: 'text', onclick: () => browse(result.parent) }),
          button(t('Use as parent folder'), { variant: 'tonal', onclick: () => {
            const name = home?.split(/[\\/]/).filter(Boolean).at(-1) || 'Flyleaf';
            destination.input.value = result.path.replace(/[\\/]$/, '') + result.separator + name;
            destination.input.dispatchEvent(new Event('input'));
            chooser.open = false;
            destination.input.focus();
          } })] : []),
        ...entries.map(entry => button(entry.name, { variant: 'text', icon: 'folder', onclick: () => browse(entry.path) })),
        ...(user && !path ? [parent, button(t('Open folder'), { variant: 'text', onclick: () => browse(parent.input.value.trim()) })] : []));
    } catch (e) {
      folders.replaceChildren(h('p', e.message), button(t('Back to storage locations'), { variant: 'text', onclick: () => browse(null) }));
    }
  };
  browse(null);
  const info = h('div', { role: 'status' });
  let checked = '';
  destination.input.addEventListener('input', () => { checked = ''; info.replaceChildren(); });
  const preview = button(t('Check destination'), { variant: 'tonal', icon: 'fact_check', onclick: async () => {
    const selected = destination.input.value.trim();
    if (!selected) return destination.input.reportValidity();
    preview.disabled = true;
    checked = '';
    info.textContent = t('Checking the destination…');
    try {
      const result = await api.previewStorageMigration(selected, user?.id);
      if (destination.input.value.trim() !== selected) return;
      if (result.fits !== false) checked = selected;
      info.replaceChildren(h('p.mono', result.destination),
        h('p', t('{files} files · {size} to move', { files: result.files, size: formatBytes(result.bytes) })),
        h('p', result.free == null ? t('The server could not measure available space.') : t('{free} available · {reserve} reserved', { free: formatBytes(result.free), reserve: formatBytes(result.reserve) })),
        result.fits === false ? h('p.form-error', t('The destination does not have enough space.')) : '');
    } catch (e) { if (destination.input.value.trim() === selected) info.textContent = e.message; }
    finally { preview.disabled = false; }
  } });
  await formDialog({
    title: user ? t('Move personal folder for {name}', { name: user.displayName }) : t('Move personal folder'),
    icon: 'drive_file_move',
    fields: [
      h('p', t('Current folder'), ' ', h('span.mono', home)),
      chooser,
      destination,
      preview, info,
      h('p.body-small.muted', t('Flyleaf copies the full folder before updating your library paths and removing the original. Storage writes pause during the move.')),
    ].filter(Boolean),
    submit: t('Start move'),
    onSubmit: async () => {
      if (checked !== destination.input.value.trim()) throw new Error(t('Check the destination before starting the move.'));
      await api.movePersonalFolder(destination.input.value.trim(), user?.id);
      window.dispatchEvent(new Event('flyleaf-storage-migration-started'));
    },
  });
}

export function watchStorageMigration(onChange) {
  const label = h('span');
  const progress = h('progress.task-progress', { max: 100, 'aria-label': t('Personal folder migration progress') });
  const banner = h('aside.storage-migration-banner', { hidden: true },
    h('div', { role: 'status' }, label), progress);
  document.body.append(banner);
  let pending = false;
  let account = null;
  let previous = null;
  async function poll() {
    const user = session.user;
    if (user !== account) { account = user; previous = null; banner.hidden = true; }
    if (!user || pending || document.hidden || !navigator.onLine) return;
    pending = true;
    try {
      const { migration, homeDir } = await api.storageMigration();
      if (session.user !== user) return;
      const running = migration?.status === 'running';
      const recent = migration?.finishedAt && Date.now() - migration.finishedAt < 30_000;
      banner.hidden = !(running || recent);
      if (!banner.hidden) {
        const message = running ? `${migrationStage(migration.phase)} · ${migration.percent}%`
          : migration.status === 'done' ? t('Personal folder migration completed · 100%') : t('Personal folder migration failed · {percent}%', { percent: migration.percent });
        if (label.textContent !== message) label.textContent = message;
        progress.hidden = !running;
        if (running) progress.value = migration.percent;
      }
      const homeChanged = user.homeDir !== homeDir;
      user.homeDir = homeDir;
      const completed = migration?.status === 'done' && recent &&
        (previous?.id !== migration.id || previous?.status !== migration.status);
      previous = migration;
      if (homeChanged || completed) onChange(homeChanged);
    } catch {
      banner.hidden = true;
    } finally {
      pending = false;
    }
  }
  window.addEventListener('flyleaf-storage-migration-started', poll);
  document.addEventListener('visibilitychange', poll);
  setInterval(poll, 3000);
  return poll;
}
