// Shared actions for series and books (card ⋮ menus, series page, reader).

import { api, can, downloadUrl, seriesDownloadUrl } from '../api.js';
import { isAdmin, navigate, session } from '../router.js';
import { prefs } from '../prefs.js';
import { h, icon, actions, dialog, formDialog, field, snackbar, confirmDialog, formatBytes, copyText } from '../ui.js';
import { refreshShell } from '../shell.js';

// ---------------------------------------------------------------------------
// Collections

export async function newCollection(seriesIds = []) {
  const name = field('Collection name', { required: true });
  const summary = field('Description', { multiline: true });
  let id = null;
  await formDialog({
    title: 'New collection',
    icon: 'library_add',
    fields: [name, summary],
    submit: 'Create',
    onSubmit: async () => {
      id = (await api.createCollection({ name: name.input.value, summary: summary.input.value, seriesIds })).id;
    },
  });
  if (id) {
    snackbar(seriesIds.length ? 'Added to the new collection' : 'Collection created');
    refreshShell();
  }
  return id;
}

/** Pick collections ("categories") to add series to. */
export async function addToCollection(seriesIds, label = 'this series') {
  const list = (await api.collections()).filter((c) => c.owned);
  const checks = list.map((c) => {
    const input = h('input', { type: 'checkbox', checked: seriesIds.every((id) => c.seriesIds.includes(id)) });
    input.dataset.id = c.id;
    input.dataset.initial = String(input.checked);
    return h('label.check', input, h('span', c.name), h('span.muted', { style: { marginLeft: 'auto', fontSize: '12px' } }, String(c.count)));
  });
  const result = await dialog({
    title: 'Add to collection',
    icon: 'collections_bookmark',
    content: h('div',
      h('p', { style: { marginBottom: '8px' } }, `Choose collections for ${label}.`),
      checks.length ? h('div', checks) : h('p.muted', 'You have no collections yet.'),
    ),
    actions: [
      { label: 'New collection', icon: 'add', value: 'new' },
      { label: 'Cancel' },
      { label: 'Done', variant: 'filled', value: 'save' },
    ],
  });
  if (result === 'new') return newCollection(seriesIds);
  if (result !== 'save') return;
  let changed = 0;
  for (const c of checks) {
    const input = c.querySelector('input');
    if (String(input.checked) === input.dataset.initial) continue;
    changed++;
    if (input.checked) await api.addToCollection(input.dataset.id, seriesIds);
    else for (const sid of seriesIds) await api.removeFromCollection(input.dataset.id, sid);
  }
  if (changed) {
    snackbar('Collections updated');
    refreshShell();
  }
}

// ---------------------------------------------------------------------------
// Downloads & Send to

/** The admin can turn off downloading (and Send to) per user. */
export const canDownload = () => can(session.user, 'download');

export async function download(url, label, size) {
  if (prefs().promptOnDownload) {
    const ok = await confirmDialog({
      title: 'Download?',
      icon: 'download',
      message: `${label}${size ? ` (${formatBytes(size)})` : ''} will be downloaded to this device.`,
      confirm: 'Download',
    });
    if (!ok) return;
  }
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

/** "Send to": email to an e-reader, download, or share a link. */
export async function sendTo({ book, series }) {
  const [{ devices, emailConfigured }, info] = await Promise.all([api.devices(), api.shareInfo().catch(() => ({ local: [], public: null }))]);
  const name = book ? book.label || book.title : series.name;
  const path = `/#/series/${book ? book.seriesId : series.id}`;
  // Links others can open: the server's address on the home network (not this browser's
  // origin, which may be localhost or a public address) and, when set, the public URL.
  const links = [];
  if (info.local[0]) links.push({ url: info.local[0] + path, title: 'Copy home-network link', sub: info.local[0].replace(/^https?:\/\//, '') + ' · works on your Wi-Fi', icon: 'home' });
  if (info.public) links.push({ url: info.public + path, title: 'Copy internet link', sub: info.public.replace(/^https?:\/\//, '') + ' · works from anywhere', icon: 'public' });
  if (!links.length) links.push({ url: location.origin + path, title: 'Share link', sub: 'For other Flyleaf users on this server', icon: 'share' });
  const pick = (detail) => (e) => e.currentTarget.closest('dialog').dispatchEvent(new CustomEvent('pick', { detail }));
  const choice = await dialog({
    title: `Send “${name}”`,
    icon: 'send_to_mobile',
    content: h('div.list', { style: { margin: '0 -24px' } },
      devices.map((d) =>
        h('button.list-item.state', { type: 'button', onclick: (e) => e.currentTarget.closest('dialog').dispatchEvent(new CustomEvent('pick', { detail: { device: d } })) },
          icon(d.platform === 'kindle' ? 'tablet_android' : 'tablet'), h('div.text', h('div.headline', d.name), h('div.supporting', d.email)), icon('send')),
      ),
      !devices.length && h('div.list-item.static', icon('info'), h('div.text', h('div.supporting', emailConfigured ? 'Add your Kindle/Kobo email address in Settings → Devices to send books by email.' : 'Sending by email needs SMTP set up by the admin (Settings → Server).'))),
      h('hr.divider', { style: { margin: '4px 0' } }),
      h('button.list-item.state', { type: 'button', onclick: (e) => e.currentTarget.closest('dialog').dispatchEvent(new CustomEvent('pick', { detail: { download: true } })) },
        icon('download'), h('div.text', h('div.headline', 'Download to this device'))),
      links.map((l) => h('button.list-item.state', { type: 'button', onclick: pick({ share: l.url }) },
        icon(l.icon), h('div.text', h('div.headline', l.title), h('div.supporting', l.sub)), icon('content_copy'))),
      h('a.list-item.state', { href: '#/settings/devices' }, icon('add'), h('div.text', h('div.headline', 'Manage devices'))),
    ),
    actions: [{ label: 'Close' }],
    onOpen: (dlg, close) => dlg.addEventListener('pick', (e) => close(e.detail)),
  });
  if (!choice) return;
  if (choice.download) return book ? download(downloadUrl(book), name, book.size) : download(seriesDownloadUrl(series.id), `${name} (all volumes, .zip)`);
  if (choice.share) {
    // Copy rather than the system share sheet, so the chosen address is what gets sent.
    return copyText(choice.share);
  }
  if (choice.device) {
    snackbar(`Sending to ${choice.device.name}…`);
    try {
      const r = book ? await api.sendBook(book.id, choice.device.id) : await api.sendSeries(series.id, choice.device.id);
      snackbar(`Sent ${r.sent} ${r.sent === 1 ? 'file' : 'files'} to ${choice.device.name}`);
    } catch (e) {
      snackbar(e.message, { duration: 7000 });
    }
  }
}

// ---------------------------------------------------------------------------
// Deleting

export async function deleteBook(b, { onChange } = {}) {
  const name = b.label || b.title;
  const ok = await confirmDialog({
    title: `Delete “${name}”?`,
    icon: 'delete',
    message: 'The file is removed from disk, along with your progress, bookmarks and notes for it. This can’t be undone.',
    confirm: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api.deleteBook(b.id);
    snackbar(`Deleted “${name}”`);
    // The last volume took its series with it, so don't leave the user on an empty series page.
    const [, view, id] = location.hash.split(/[/?]/);
    if (r.seriesRemoved && view === 'series' && id === String(b.seriesId)) navigate('/library');
    else onChange?.();
    refreshShell();
  } catch (e) {
    snackbar(e.message, { duration: 7000 });
  }
}

// ---------------------------------------------------------------------------
// Action menus

/** ⋮ actions for a series card or the series page. `onChange` refreshes the caller. */
export function seriesActions(anchor, s, { onChange, at } = {}) {
  const changed = () => onChange?.();
  const items = [
    { label: 'Mark as read', icon: 'done_all', onClick: async () => { await api.setSeriesFinished(s.id, true); snackbar('Marked as read'); changed(); } },
    { label: 'Mark as unread', icon: 'remove_done', onClick: async () => { await api.setSeriesFinished(s.id, false); snackbar('Marked as unread'); changed(); } },
    { label: 'Add to category', icon: 'playlist_add', onClick: () => addToCollection([s.id], `“${s.name}”`).then(changed) },
    canDownload() && { label: 'Send to…', icon: 'send_to_mobile', onClick: () => sendTo({ series: s }) },
    '-',
    {
      label: s.wantToRead ? 'Remove from Want to read' : 'Want to read',
      icon: s.wantToRead ? 'bookmark_remove' : 'bookmark_add',
      onClick: async () => {
        await api.setSeriesUser(s.id, { wantToRead: !s.wantToRead });
        snackbar(s.wantToRead ? 'Removed from Want to read' : 'Added to Want to read');
        changed();
      },
    },
    {
      label: s.userBlur ?? s.blur ? 'Unblur artwork' : 'Blur artwork (NSFW)',
      icon: s.userBlur ?? s.blur ? 'visibility' : 'visibility_off',
      onClick: async () => {
        await api.setSeriesUser(s.id, { blur: !(s.userBlur ?? s.blur) });
        changed();
      },
    },
    canDownload() && { label: 'Download series', icon: 'download', onClick: () => download(seriesDownloadUrl(s.id), `${s.name} (all volumes, .zip)`) },
  ];
  if (isAdmin()) {
    items.push('-',
      { label: 'Edit metadata', icon: 'edit', onClick: () => import('./editors.js').then((m) => m.editSeries(s.id).then(changed)) },
      { label: 'Fetch metadata', icon: 'travel_explore', onClick: () => import('./editors.js').then((m) => m.fetchMetadata(s).then(changed)) },
    );
  }
  return actions(anchor, items, { title: s.name, at });
}

/** ⋮ actions for a single volume/book. */
export function bookActions(anchor, b, { onChange, series, at } = {}) {
  const changed = () => onChange?.();
  const done = b.progress?.finished;
  const items = [
    { label: b.progress && !done ? 'Continue reading' : 'Read', icon: 'menu_book', onClick: () => navigate(`/read/${b.id}`) },
    { label: 'Details', icon: 'info', onClick: () => import('./book-info.js').then((m) => m.showBookInfo(b.id)) },
    { label: 'Mark as read', icon: 'done_all', disabled: done, onClick: async () => { await api.setFinished(b.id, true); snackbar('Marked as read'); changed(); } },
    { label: 'Mark as unread', icon: 'remove_done', disabled: !b.progress, onClick: async () => { await api.setFinished(b.id, false); snackbar('Marked as unread'); changed(); } },
    b.seriesId && { label: 'Add to category', icon: 'playlist_add', onClick: () => addToCollection([b.seriesId], `“${series?.name || b.series}”`).then(changed) },
    canDownload() && { label: 'Send to…', icon: 'send_to_mobile', onClick: () => sendTo({ book: b }) },
    canDownload() && { label: 'Download', icon: 'download', onClick: () => download(downloadUrl(b), b.label || b.title, b.size) },
  ];
  if (isAdmin()) {
    items.push('-',
      { label: 'Edit volume', icon: 'edit', onClick: () => import('./editors.js').then((m) => m.editVolume(b).then(changed)) },
      b.seriesId && b.coverUrl && { label: 'Use as series artwork', icon: 'wallpaper', onClick: async () => { await api.setSeriesCoverFromBook(b.seriesId, b.id); snackbar('Series artwork updated'); changed(); } },
    );
  }
  // The server decides: admins may delete anything, others only their own libraries' books and their downloads.
  if (b.canDelete) items.push('-', { label: 'Delete', icon: 'delete', onClick: () => deleteBook(b, { onChange }) });
  return actions(anchor, items, { title: b.label || b.title, at });
}

