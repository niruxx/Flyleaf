import { api } from '../api.js';
import { onLeave, isAdmin, session, render } from '../router.js';
import {
  h, icon, iconButton, button, topBar, dialog, field, formError, snackbar, menu, segmented, confirmDialog,
  getTheme, setTheme, getHue, setHue, HUES, timeAgo, formatDuration,
} from '../ui.js';
import { accountButton, scanIndicator, signOut } from './common.js';

const KIND_OPTIONS = [
  { value: 'books', label: 'Books (EPUB, PDF)' },
  { value: 'manga', label: 'Manga (right-to-left)' },
  { value: 'comics', label: 'Comics (left-to-right)' },
];
const KIND_ICON = { books: 'menu_book', manga: 'auto_stories', comics: 'photo_library' };

export async function settingsView(view, params, stale) {
  const bar = topBar('Settings', accountButton());
  onLeave(bar.cleanup);
  const page = h('div.page', { style: { maxWidth: '880px' } });
  view.append(bar, page);

  if (sessionStorage.getItem('flyleaf.welcome')) {
    sessionStorage.removeItem('flyleaf.welcome');
    page.append(
      h('div.card.filled', { style: { padding: '20px', marginTop: '8px', display: 'flex', gap: '16px', alignItems: 'flex-start' } },
        icon('celebration'),
        h('div',
          h('p.title-medium', 'You’re all set!'),
          h('p.body-medium.muted', 'Next, add a library: pick a folder on this computer that holds your books, manga or comics. Flyleaf will index it and keep it up to date.'),
        ),
      ),
    );
  }

  page.append(appearanceSection());
  if (isAdmin()) {
    const libSection = h('div');
    const userSection = h('div');
    page.append(libSection, userSection);
    await Promise.all([renderLibraries(libSection, stale), renderUsers(userSection, stale)]);
  }
  page.append(accountSection(), installSection());
}

function section(title, action, ...content) {
  return h('section.section',
    h('div.section-head', h('h2', title), action),
    ...content,
  );
}

// ---------------------------------------------------------------------------

function appearanceSection() {
  const swatches = h('div.swatches', HUES.map((c) =>
    h('button.swatch', {
      type: 'button',
      title: c.name,
      'aria-label': `${c.name} accent`,
      'aria-pressed': String(getHue() === c.hue),
      style: { background: `oklch(0.55 0.15 ${c.hue})` },
      onclick: (e) => {
        setHue(c.hue);
        for (const s of swatches.children) {
          s.setAttribute('aria-pressed', String(s === e.currentTarget));
          s.replaceChildren();
        }
        e.currentTarget.append(icon('check'));
      },
    }, getHue() === c.hue && icon('check')),
  ));

  return section('Appearance', null,
    h('div.settings-group',
      h('div.setting-row.wrap',
        icon('contrast'),
        h('div.text', h('div', 'Theme'), h('div.s', 'Follow your device, or choose light or dark.')),
        segmented(
          [
            { value: 'light', label: 'Light', icon: 'light_mode' },
            { value: 'dark', label: 'Dark', icon: 'dark_mode' },
            { value: 'system', label: 'Auto', icon: 'brightness_auto' },
          ],
          getTheme(),
          setTheme,
        ),
      ),
      h('div.setting-row.wrap', icon('palette'), h('div.text', h('div', 'Accent colour'), h('div.s', 'Applies on this device.')), swatches),
    ),
  );
}

// ---------------------------------------------------------------------------
// Libraries

async function renderLibraries(container, stale) {
  const libs = await api.libraries();
  if (stale()) return;
  const add = button('Add library', { variant: 'tonal', icon: 'create_new_folder', onclick: () => libraryDialog() });
  const rows = libs.map((l) => {
    const more = iconButton('more_vert', 'Library options', () =>
      menu(more, [
        { label: 'Scan now', icon: 'sync', onClick: async () => { await api.scanLibrary(l.id); snackbar(`Scanning ${l.name}…`); } },
        { label: 'Edit', icon: 'edit', onClick: () => libraryDialog(l) },
        { label: 'Remove missing files', icon: 'cleaning_services', onClick: async () => {
          const r = await api.cleanupLibrary(l.id);
          snackbar(r.removed ? `Removed ${r.removed} missing ${r.removed === 1 ? 'item' : 'items'}` : 'Nothing to clean up');
          render();
        } },
        '-',
        { label: 'Remove library', icon: 'delete', onClick: async () => {
          const ok = await confirmDialog({
            title: `Remove “${l.name}”?`,
            message: 'Books in this library and everyone’s reading progress for them will be removed from Flyleaf. Your files on disk are not touched.',
            confirm: 'Remove',
            danger: true,
            icon: 'delete',
          });
          if (!ok) return;
          await api.deleteLibrary(l.id);
          snackbar('Library removed');
          render();
        } },
      ]),
    );
    return h('div.setting-row',
      icon(KIND_ICON[l.kind]),
      h('div.text',
        h('div', l.name),
        h('div.s', l.path),
        h('div.s', `${l.bookCount} items · ${l.lastScanAt ? `scanned ${timeAgo(l.lastScanAt)}` : 'not scanned yet'}`),
      ),
      more,
    );
  });

  container.replaceChildren(
    section('Libraries', h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, scanIndicator(() => render()), add),
      libs.length
        ? h('div.settings-group', rows)
        : h('div.settings-group', h('div.setting-row', icon('info'), h('div.text', h('div', 'No libraries yet'),
            h('div.s', 'Add a folder that contains EPUB, PDF, CBZ/ZIP or CBR/RAR files, or folders of images. Sub-folders become series for manga and comics.')))),
    ),
  );
}

async function libraryDialog(lib = null) {
  const name = field('Name', { value: lib?.name || '', required: true });
  const kind = field('Type', { options: KIND_OPTIONS, value: lib?.kind || 'books' });
  name.input.addEventListener('input', () => (name.dataset.touched = '1'));
  const err = h('div');
  const formId = 'library-form';
  let pathField = null;
  let browser = null;

  if (!lib) {
    pathField = field('Folder path', { required: true, support: 'Absolute path on the server, e.g. /home/me/Manga' });
    browser = folderBrowser((p, userPicked) => {
      pathField.input.value = p;
      if (userPicked && !name.dataset.touched) name.input.value = p.split(/[\\/]/).filter(Boolean).pop() || '';
    });
  }

  const form = h('form', {
    id: formId,
    onsubmit: async (e) => {
      e.preventDefault();
      err.replaceChildren();
      try {
        if (lib) {
          await api.updateLibrary(lib.id, { name: name.input.value, kind: kind.input.value });
          snackbar('Library updated');
        } else {
          await api.createLibrary({ name: name.input.value, kind: kind.input.value, path: pathField.input.value });
          snackbar('Library added – scanning now');
        }
        form.closest('dialog').close();
        render();
      } catch (e2) {
        err.append(formError(e2.message));
      }
    },
  }, err, name, kind, pathField, browser);

  await dialog({
    title: lib ? 'Edit library' : 'Add library',
    className: 'fullscreen-compact',
    content: form,
    actions: [{ label: 'Cancel' }, { label: lib ? 'Save' : 'Add', submit: formId, variant: 'filled' }],
  });
}

function folderBrowser(onPick) {
  const crumb = h('span', '…');
  const info = h('span.body-small.muted');
  const list = h('div.dirs');
  const up = iconButton('arrow_upward', 'Parent folder', () => current.parent && go(current.parent));
  const use = button('Use this folder', { variant: 'text', onclick: () => onPick(current.path) });
  let current = { path: '', parent: null };

  async function go(path, userPicked = true) {
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
    onPick(current.path, userPicked);
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

async function renderUsers(container, stale) {
  const users = await api.users();
  if (stale()) return;
  const add = button('Add guest', { variant: 'tonal', icon: 'person_add', onclick: () => userDialog() });

  const rows = users.map((u) => {
    const isSelf = u.id === session.user.id;
    const more = !isSelf && u.role !== 'admin' && iconButton('more_vert', 'User options', () =>
      menu(more, [
        { label: 'Reset password', icon: 'key', onClick: () => passwordDialog(u) },
        { label: 'Rename', icon: 'badge', onClick: () => userDialog(u) },
        { label: 'Sign out everywhere', icon: 'logout', onClick: async () => { await api.signOutUser(u.id); snackbar(`${u.displayName} signed out`); } },
        '-',
        { label: 'Delete user', icon: 'person_remove', onClick: async () => {
          const ok = await confirmDialog({ title: `Delete ${u.displayName}?`, message: 'Their reading progress and stats will be deleted.', confirm: 'Delete', danger: true, icon: 'person_remove' });
          if (!ok) return;
          await api.deleteUser(u.id);
          snackbar('User deleted');
          render();
        } },
      ]),
    );
    return h('div.setting-row',
      h('span.avatar', { style: { width: '40px', height: '40px', cursor: 'default' } }, (u.displayName || u.username)[0]),
      h('div.text',
        h('div', `${u.displayName}${isSelf ? ' (you)' : ''}`),
        h('div.s', `@${u.username} · ${u.role === 'admin' ? 'Admin' : 'Guest · read-only'}`),
        h('div.s', `Last active ${timeAgo(u.lastSeenAt)} · ${formatDuration(u.secondsRead, { short: true })} read · ${u.finished} finished`),
      ),
      more,
    );
  });

  container.replaceChildren(
    section('Users', add,
      h('div.settings-group', rows),
      h('p.body-small.muted', { style: { marginTop: '8px' } },
        'Guests can browse and read, and have their own progress and stats, but can’t change libraries, metadata or users.'),
    ),
  );
}

async function userDialog(user = null) {
  const display = field('Display name', { value: user?.displayName || '' });
  const username = !user && field('Username', { required: true, autocomplete: 'off', autocapitalize: 'none', support: '3–32 letters, numbers, . - _' });
  const password = !user && field('Password', { type: 'password', required: true, autocomplete: 'new-password', support: 'At least 8 characters. Share it with your guest.' });
  const err = h('div');
  const formId = 'user-form';
  const form = h('form', {
    id: formId,
    onsubmit: async (e) => {
      e.preventDefault();
      err.replaceChildren();
      try {
        if (user) await api.updateUser(user.id, { displayName: display.input.value });
        else await api.createUser({ username: username.input.value.trim(), password: password.input.value, displayName: display.input.value });
        form.closest('dialog').close();
        snackbar(user ? 'Saved' : 'Guest created');
        render();
      } catch (e2) {
        err.append(formError(e2.message));
      }
    },
  }, err, username, display, password);
  await dialog({
    title: user ? 'Rename user' : 'Add guest',
    content: form,
    actions: [{ label: 'Cancel' }, { label: user ? 'Save' : 'Create', submit: formId, variant: 'filled' }],
  });
}

async function passwordDialog(user) {
  const password = field('New password', { type: 'password', required: true, autocomplete: 'new-password' });
  const err = h('div');
  const form = h('form', {
    id: 'pw-form',
    onsubmit: async (e) => {
      e.preventDefault();
      err.replaceChildren();
      try {
        await api.updateUser(user.id, { password: password.input.value });
        form.closest('dialog').close();
        snackbar('Password changed. They’ve been signed out of other devices.');
      } catch (e2) {
        err.append(formError(e2.message));
      }
    },
  }, err, password);
  await dialog({ title: `Reset password for ${user.displayName}`, content: form, actions: [{ label: 'Cancel' }, { label: 'Save', submit: 'pw-form', variant: 'filled' }] });
}

// ---------------------------------------------------------------------------

function accountSection() {
  const u = session.user;
  return section('Account', null,
    h('div.settings-group',
      h('div.setting-row',
        h('span.avatar', { style: { width: '40px', height: '40px', cursor: 'default' } }, (u.displayName || u.username)[0]),
        h('div.text', h('div', u.displayName), h('div.s', `@${u.username} · ${u.role === 'admin' ? 'Admin' : 'Guest (read-only)'}`)),
      ),
      isAdmin() && h('button.setting-row.list-item.state', { type: 'button', onclick: changePassword }, icon('key'), h('div.text', h('div', 'Change password')), icon('chevron_right')),
      h('button.setting-row.list-item.state', { type: 'button', onclick: signOut }, icon('logout'), h('div.text', h('div', 'Sign out')), icon('chevron_right')),
    ),
  );
}

async function changePassword() {
  const current = field('Current password', { type: 'password', required: true, autocomplete: 'current-password' });
  const next = field('New password', { type: 'password', required: true, autocomplete: 'new-password', support: 'At least 8 characters.' });
  const err = h('div');
  const form = h('form', {
    id: 'me-pw',
    onsubmit: async (e) => {
      e.preventDefault();
      err.replaceChildren();
      try {
        await api.changePassword(current.input.value, next.input.value);
        form.closest('dialog').close();
        snackbar('Password changed');
      } catch (e2) {
        err.append(formError(e2.message));
      }
    },
  }, err, current, next);
  await dialog({ title: 'Change password', content: form, actions: [{ label: 'Cancel' }, { label: 'Save', submit: 'me-pw', variant: 'filled' }] });
}

function installSection() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return null;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return section('Install app', null,
    h('div.settings-group',
      h('div.setting-row', icon(ios ? 'ios_share' : 'install_mobile'),
        h('div.text',
          h('div', 'Add Flyleaf to your home screen'),
          h('div.s', ios
            ? 'In Safari, tap the Share button, then “Add to Home Screen”. Flyleaf opens full-screen like a native app.'
            : 'Use your browser’s “Install app” or “Add to Home screen” option for a full-screen reader.'),
        ),
      ),
    ),
  );
}
