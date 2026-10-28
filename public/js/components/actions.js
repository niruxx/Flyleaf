import { t, plural } from '../i18n.js';
// Shared actions for series and books (card ⋮ menus, series page, reader).

import { api, can, downloadUrl, seriesDownloadUrl } from '../api.js';
import { isAdmin, navigate, session } from '../router.js';
import { prefs } from '../prefs.js';
import { h, icon, actions, dialog, formDialog, field, snackbar, confirmDialog, formatBytes, copyText } from '../ui.js';
import { refreshShell } from '../shell.js';
import { offlineSupported, isSaved, saveBook, removeBook } from '../offline.js';

// ---------------------------------------------------------------------------
// Collections

export async function newCollection(seriesIds = []) {
  const name = field(t('Collection name'), { required: true });
  const summary = field(t('Description'), { multiline: true });
  let id = null;
  await formDialog({
    title: t('New collection'),
    icon: 'library_add',
    fields: [name, summary],
    submit: t('Create'),
    onSubmit: async () => {
      id = (await api.createCollection({ name: name.input.value, summary: summary.input.value, seriesIds })).id;
    },
  });
  if (id) {
    snackbar(seriesIds.length ? t('Added to the new collection') : t('Collection created'));
    refreshShell();
  }
  return id;
}

/** Pick collections ("categories") to add series to. */
export async function addToCollection(seriesIds, label = t('this series')) {
  const list = (await api.collections()).filter((c) => c.owned);
  const checks = list.map((c) => {
    const input = h('input', { type: 'checkbox', checked: seriesIds.every((id) => c.seriesIds.includes(id)) });
    input.dataset.id = c.id;
    input.dataset.initial = String(input.checked);
    return h('label.check', input, h('span', c.name), h('span.muted', { style: { marginLeft: 'auto', fontSize: '12px' } }, String(c.count)));
  });
  const result = await dialog({
    title: t('Add to collection'),
    icon: 'collections_bookmark',
    content: h('div',
      h('p', { style: { marginBottom: '8px' } }, t('Choose collections for {label}.', { label: label })),
      checks.length ? h('div', checks) : h('p.muted', t('You have no collections yet.')),
    ),
    actions: [
      { label: t('New collection'), icon: 'add', value: 'new' },
      { label: t('Cancel') },
      { label: t('Done'), variant: 'filled', value: 'save' },
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
    snackbar(t('Collections updated'));
    refreshShell();
  }
}

// ---------------------------------------------------------------------------
// Reading lists

export async function newReadingList({ bookIds = [], seriesId = null } = {}) {
  const name = field(t('Reading list name'), { required: true, support: t('For example an event: “Civil War reading order”') });
  const summary = field(t('Description'), { multiline: true });
  const shared = h('input', { type: 'checkbox' });
  let id = null;
  await formDialog({
    title: t('New reading list'),
    icon: 'format_list_numbered',
    fields: [name, summary, isAdmin() && h('label.check', shared, t('Share with all users'))],
    submit: t('Create'),
    onSubmit: async () => {
      id = (await api.createReadingList({ name: name.input.value, summary: summary.input.value, promoted: shared.checked, bookIds, seriesId })).id;
    },
  });
  if (id) {
    snackbar(bookIds.length || seriesId ? t('Added to the new reading list') : t('Reading list created'));
    refreshShell();
  }
  return id;
}

/** Add a book, or a whole series in order, to the end of one of your reading lists. */
export async function addToReadingList({ bookIds = [], seriesId = null }, label = t('this book')) {
  const lists = (await api.readingLists()).filter((l) => l.owned);
  let picked = lists[0]?.id ?? null;
  const rows = lists.map((l) => {
    const input = h('input', { type: 'radio', name: 'rl', checked: l.id === picked, onchange: () => (picked = l.id) });
    return h('label.check', input, h('span', l.name), h('span.muted', { style: { marginLeft: 'auto', fontSize: '12px' } }, String(l.count)));
  });
  const result = await dialog({
    title: t('Add to reading list'),
    icon: 'format_list_numbered',
    content: h('div',
      h('p', { style: { marginBottom: '8px' } }, t('Add {label} to the end of a reading list.', { label: label })),
      rows.length ? h('div', rows) : h('p.muted', t('You have no reading lists yet.'))),
    actions: [
      { label: t('New list'), icon: 'add', value: 'new' },
      { label: t('Cancel') },
      rows.length > 0 && { label: t('Add'), variant: 'filled', value: 'add' },
    ].filter(Boolean),
  });
  if (result === 'new') return newReadingList({ bookIds, seriesId });
  if (result !== 'add' || !picked) return;
  const r = await api.addToReadingList(picked, { bookIds, seriesId });
  snackbar(r.added ? t('Added {value} to “{name}”', { value: r.added === 1 ? '1 book' : t('{added} books', { added: r.added }), name: lists.find((l) => l.id === picked).name }) : t('Already in that list'));
  refreshShell();
}

// ---------------------------------------------------------------------------
// Downloads & Send to

/** The admin can turn off downloading (and Send to) per user. */
export const canDownload = () => can(session.user, 'download');

export async function download(url, label, size) {
  if (prefs().promptOnDownload) {
    const ok = await confirmDialog({
      title: t('Download?'),
      icon: 'download',
      message: t('{label}{value} will be downloaded to this device.', { label: label, value: size ? ` (${formatBytes(size)})` : '' }),
      confirm: t('Download'),
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
  if (info.local[0]) links.push({ url: info.local[0] + path, title: t('Copy home-network link'), sub: info.local[0].replace(/^https?:\/\//, '') + ' · works on your Wi-Fi', icon: 'home' });
  if (info.public) links.push({ url: info.public + path, title: t('Copy internet link'), sub: info.public.replace(/^https?:\/\//, '') + ' · works from anywhere', icon: 'public' });
  if (!links.length) links.push({ url: location.origin + path, title: t('Share link'), sub: t('For other Flyleaf users on this server'), icon: 'share' });
  const pick = (detail) => (e) => e.currentTarget.closest('dialog').dispatchEvent(new CustomEvent('pick', { detail }));
  const choice = await dialog({
    title: t('Send “{name}”', { name: name }),
    icon: 'send_to_mobile',
    content: h('div.list', { style: { margin: '0 -24px' } },
      devices.map((d) =>
        h('button.list-item.state', { type: 'button', onclick: (e) => e.currentTarget.closest('dialog').dispatchEvent(new CustomEvent('pick', { detail: { device: d } })) },
          icon(d.platform === 'kindle' ? 'tablet_android' : 'tablet'), h('div.text', h('div.headline', d.name), h('div.supporting', d.email)), icon('send')),
      ),
      !devices.length && h('div.list-item.static', icon('info'), h('div.text', h('div.supporting', emailConfigured ? t('Add your Kindle/Kobo email address in Settings → Devices to send books by email.') : t('Sending by email needs SMTP set up by the admin (Settings → Server).')))),
      h('hr.divider', { style: { margin: '4px 0' } }),
      h('button.list-item.state', { type: 'button', onclick: (e) => e.currentTarget.closest('dialog').dispatchEvent(new CustomEvent('pick', { detail: { download: true } })) },
        icon('download'), h('div.text', h('div.headline', t('Download to this device')))),
      links.map((l) => h('button.list-item.state', { type: 'button', onclick: pick({ share: l.url }) },
        icon(l.icon), h('div.text', h('div.headline', l.title), h('div.supporting', l.sub)), icon('content_copy'))),
      h('a.list-item.state', { href: '#/settings/devices' }, icon('add'), h('div.text', h('div.headline', t('Manage devices')))),
    ),
    actions: [{ label: t('Close') }],
    onOpen: (dlg, close) => dlg.addEventListener('pick', (e) => close(e.detail)),
  });
  if (!choice) return;
  if (choice.download) return book ? download(downloadUrl(book), name, book.size) : download(seriesDownloadUrl(series.id), t('{name} (all volumes, .zip)', { name: name }));
  if (choice.share) {
    // Copy rather than the system share sheet, so the chosen address is what gets sent.
    return copyText(choice.share);
  }
  if (choice.device) {
    snackbar(t('Sending to {name}…', { name: choice.device.name }));
    try {
      const r = book ? await api.sendBook(book.id, choice.device.id) : await api.sendSeries(series.id, choice.device.id);
      snackbar(plural(r.sent, 'Sent {sent} file to {name}', 'Sent {sent} files to {name}', { sent: r.sent, name: choice.device.name }));
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
    title: t('Delete “{name}”?', { name: name }),
    icon: 'delete',
    message: t('The file is removed from disk, along with your progress, bookmarks and notes for it. This can’t be undone.'),
    confirm: t('Delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api.deleteBook(b.id);
    snackbar(t('Deleted “{name}”', { name: name }));
    // The last volume took its series with it, so don't leave the user on an empty series page.
    const [, view, id] = location.hash.split(/[/?]/);
    if (r.seriesRemoved && view === 'series' && id === String(b.seriesId)) navigate('/library');
    else onChange?.();
    refreshShell();
  } catch (e) {
    snackbar(e.message, { duration: 7000 });
  }
}

export async function deleteSeries(s, { onChange } = {}) {
  const many = s.count > 1;
  const ok = await confirmDialog({
    title: t('Delete “{name}”?', { name: s.name }),
    icon: 'delete',
    message: t('{value} removed from disk, along with your progress, bookmarks and notes. This can’t be undone.', { value: many ? t('All {count} books in this series are', { count: s.count }) : t('The file is') }),
    confirm: t('Delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteSeries(s.id);
    snackbar(t('Deleted “{name}”', { name: s.name }));
    const [, view, id] = location.hash.split(/[/?]/);
    if (view === 'series' && id === String(s.id)) navigate('/library');
    else onChange?.();
    refreshShell();
  } catch (e) {
    snackbar(e.message, { duration: 7000 });
  }
}

// ---------------------------------------------------------------------------
// Moving to another library

const KIND_ICON = { books: 'menu_book', manga: 'auto_stories', comics: 'photo_library' };

/** "Manga · shared": the type when the name doesn't already say it, and (for the admin) whose it is. */
function libraryNote(l) {
  const kind = `${l.kind[0].toUpperCase()}${l.kind.slice(1)}`;
  return [l.name.toLowerCase() !== l.kind ? kind : null, isAdmin() ? (l.own ? t('your library') : 'shared') : null].filter(Boolean).join(' · ');
}

/** Pick a library to move a book or a whole series into; the files move on disk. */
export async function moveTo({ book, series }, { onChange } = {}) {
  let targets;
  try {
    targets = await api.moveTargets(book ? { book: book.id } : { series: series.id });
  } catch (e) {
    return snackbar(e.message, { duration: 6000 });
  }
  const name = book ? book.label || book.title : series.name;
  if (!targets.length) return snackbar(t('You don’t have another library to move it to.'), { duration: 6000 });
  const pick = await dialog({
    title: t('Move “{name}”', { name: name }),
    icon: 'drive_file_move',
    content: h('div',
      h('p', { style: { marginBottom: '8px' } }, book
        ? t('Move this file to another library. Your progress, bookmarks and notes come along.')
        : t('Move all {value} to another library. Your progress, bookmarks and notes come along.', { value: series.count > 1 ? t('{count} books', { count: series.count }) : t('of this series') })),
      h('div.list', { style: { margin: '0 -24px' } }, targets.map((l) =>
        h('button.list-item.state', { type: 'button', onclick: (e) => e.currentTarget.closest('dialog').dispatchEvent(new CustomEvent('pick', { detail: l })) },
          icon(KIND_ICON[l.kind] || 'folder'),
          h('div.text', h('div.headline', l.name), libraryNote(l) && h('div.supporting', libraryNote(l))),
          icon('chevron_right')))),
    ),
    actions: [{ label: t('Cancel') }],
    onOpen: (dlg, close) => dlg.addEventListener('pick', (e) => close(e.detail)),
  });
  if (!pick) return;
  snackbar(t('Moving to {name}…', { name: pick.name }));
  try {
    const r = book ? await api.moveBook(book.id, pick.id) : await api.moveSeries(series.id, pick.id);
    snackbar(t('Moved to {name}', { name: pick.name }), { action: t('Open'), onAction: () => navigate(`/library/${pick.id}`) });
    // Don't leave the user on a series page that no longer exists here.
    const [, view, id] = location.hash.split(/[/?]/);
    const seriesId = book ? book.seriesId : series.id;
    // A moved series may regroup under a new identity once its new library is scanned.
    const gone = book ? r.seriesRemoved : true;
    if (gone && view === 'series' && id === String(seriesId)) navigate(`/library/${pick.id}`);
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
    { label: t('Mark as read'), icon: 'done_all', onClick: async () => { await api.setSeriesFinished(s.id, true); snackbar(t('Marked as read')); changed(); } },
    { label: t('Mark as unread'), icon: 'remove_done', onClick: async () => { await api.setSeriesFinished(s.id, false); snackbar(t('Marked as unread')); changed(); } },
    { label: t('Add to category'), icon: 'playlist_add', onClick: () => addToCollection([s.id], `“${s.name}”`).then(changed) },
    { label: t('Add to reading list'), icon: 'format_list_numbered', onClick: () => addToReadingList({ seriesId: s.id }, t('every book of “{name}”', { name: s.name })) },
    canDownload() && { label: t('Send to…'), icon: 'send_to_mobile', onClick: () => sendTo({ series: s }) },
    '-',
    {
      label: s.wantToRead ? t('Remove from Want to read') : t('Want to read'),
      icon: s.wantToRead ? 'bookmark_remove' : 'bookmark_add',
      onClick: async () => {
        await api.setSeriesUser(s.id, { wantToRead: !s.wantToRead });
        snackbar(s.wantToRead ? t('Removed from Want to read') : t('Added to Want to read'));
        changed();
      },
    },
    {
      label: s.userBlur ?? s.blur ? t('Unblur artwork') : t('Blur artwork (NSFW)'),
      icon: s.userBlur ?? s.blur ? 'visibility' : 'visibility_off',
      onClick: async () => {
        await api.setSeriesUser(s.id, { blur: !(s.userBlur ?? s.blur) });
        changed();
      },
    },
    canDownload() && { label: t('Download series'), icon: 'download', onClick: () => download(seriesDownloadUrl(s.id), t('{name} (all volumes, .zip)', { name: s.name })) },
    offlineSupported() && { label: t('Save next 3 for offline'), icon: 'offline_pin', onClick: () => saveNextOffline(s, 3) },
  ];
  if (isAdmin()) {
    items.push('-',
      { label: t('Edit metadata'), icon: 'edit', onClick: () => import('./editors.js').then((m) => m.editSeries(s.id).then(changed)) },
      { label: t('Fetch metadata'), icon: 'travel_explore', onClick: () => import('./editors.js').then((m) => m.fetchMetadata(s).then(changed)) },
    );
  }
  if (s.canMove || s.canDelete) items.push('-');
  if (s.canMove) items.push({ label: t('Move to library…'), icon: 'drive_file_move', onClick: () => moveTo({ series: s }, { onChange }) });
  if (s.canDelete) items.push({ label: t('Delete'), icon: 'delete', onClick: () => deleteSeries(s, { onChange }) });
  return actions(anchor, items, { title: s.name, at });
}

/** “Save for offline” / “Remove offline copy” for a book (when this browser can keep books). */
function offlineItem(b) {
  if (!offlineSupported()) return null;
  if (isSaved(b.id)) {
    return { label: t('Remove offline copy'), icon: 'offline_pin', onClick: async () => {
      await removeBook(b.id);
      snackbar(t('Removed from this device'));
    } };
  }
  return { label: t('Save for offline'), icon: 'download_for_offline', onClick: () => saveOffline(b.id, b.label || b.title) };
}

/** Save one book on this device, with progress in a snackbar. */
export async function saveOffline(bookId, title) {
  const bar = snackbar(t('Saving “{title}” for offline…', { title: title }), { duration: 600_000 });
  try {
    await saveBook(bookId, {
      onProgress: (f) => {
        bar.querySelector('.msg').textContent = t('Saving “{title}” for offline… {value}%', { title: title, value: Math.round(f * 100) });
      },
    });
    snackbar(t('“{title}” is saved on this device', { title: title }), { action: t('Saved books'), onAction: () => navigate('/offline') });
    return true;
  } catch (e) {
    snackbar(e.message, { duration: 6000 });
    return false;
  }
}

/** Save the next few unread books of a series (where you'd carry on reading). */
async function saveNextOffline(s, n) {
  const full = await api.series(s.id);
  const start = Math.max(0, full.books.findIndex((b) => !b.progress?.finished));
  const next = full.books.slice(start, start + n).filter((b) => !isSaved(b.id));
  if (!next.length) return snackbar(t('Those are already saved on this device'));
  let saved = 0;
  for (const b of next) if (await saveOffline(b.id, b.label || b.title)) saved++;
  if (saved > 1) snackbar(t('{saved} books from {name} are saved on this device', { saved: saved, name: s.name }), { action: t('Saved books'), onAction: () => navigate('/offline') });
}

/** ⋮ actions for a single volume/book. */
export function bookActions(anchor, b, { onChange, series, at } = {}) {
  const changed = () => onChange?.();
  const done = b.progress?.finished;
  const items = [
    { label: b.progress && !done ? t('Continue reading') : t('Read'), icon: 'menu_book', onClick: () => navigate(`/read/${b.id}`) },
    { label: t('Details'), icon: 'info', onClick: () => import('./book-info.js').then((m) => m.showBookInfo(b.id)) },
    { label: t('Mark as read'), icon: 'done_all', disabled: done, onClick: async () => { await api.setFinished(b.id, true); snackbar(t('Marked as read')); changed(); } },
    { label: t('Mark as unread'), icon: 'remove_done', disabled: !b.progress, onClick: async () => { await api.setFinished(b.id, false); snackbar(t('Marked as unread')); changed(); } },
    b.seriesId && { label: t('Add to category'), icon: 'playlist_add', onClick: () => addToCollection([b.seriesId], `“${series?.name || b.series}”`).then(changed) },
    { label: t('Add to reading list'), icon: 'format_list_numbered', onClick: () => addToReadingList({ bookIds: [b.id] }, `“${b.label || b.title}”`) },
    canDownload() && { label: t('Send to…'), icon: 'send_to_mobile', onClick: () => sendTo({ book: b }) },
    canDownload() && { label: t('Download'), icon: 'download', onClick: () => download(downloadUrl(b), b.label || b.title, b.size) },
    offlineItem(b),
  ];
  if (isAdmin()) {
    items.push('-',
      { label: t('Edit volume'), icon: 'edit', onClick: () => import('./editors.js').then((m) => m.editVolume(b).then(changed)) },
      b.seriesId && b.coverUrl && { label: t('Use as series artwork'), icon: 'wallpaper', onClick: async () => { await api.setSeriesCoverFromBook(b.seriesId, b.id); snackbar(t('Series artwork updated')); changed(); } },
    );
  }
  // The server decides: admins may delete anything, others only their own libraries' books and their downloads.
  if (b.canMove || b.canDelete) items.push('-');
  if (b.canMove) items.push({ label: t('Move to library…'), icon: 'drive_file_move', onClick: () => moveTo({ book: b }, { onChange }) });
  if (b.canDelete) items.push({ label: t('Delete'), icon: 'delete', onClick: () => deleteBook(b, { onChange }) });
  return actions(anchor, items, { title: b.label || b.title, at });
}

