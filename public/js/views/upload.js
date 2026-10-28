import { t, plural } from '../i18n.js';
// Upload: send books, comics and image folders from this device into a library
// folder, optionally adding the result to a collection.

import { api, can } from '../api.js';
import { session, navigate, onLeave, isAdmin } from '../router.js';
import { h, icon, iconButton, button, field, formDialog, snackbar, emptyState, formatBytes, loading, libraryOptions } from '../ui.js';
import { refreshShell } from '../shell.js';

const KIND_LABEL = { get books() { return t('Books'); }, get manga() { return t('Manga'); }, get comics() { return t('Comics'); } };
const BOOK_EXT = ['epub', 'kepub', 'mobi', 'azw', 'azw3', 'prc', 'fb2', 'txt', 'pdf', 'docx', 'rtf', 'cbz', 'zip', 'cbr', 'rar', 'cb7', '7z', 'cbt', 'tar'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'jxl'];
const ACCEPT = [...BOOK_EXT, ...IMAGE_EXT].map((e) => `.${e}`).join(',');
const CONCURRENCY = 3;

const extOf = (name) => (name.toLowerCase().endsWith('.kepub.epub') ? 'kepub' : name.split('.').pop().toLowerCase());
const isSupported = (name) => !name.split('/').pop().startsWith('.') && (BOOK_EXT.includes(extOf(name)) || IMAGE_EXT.includes(extOf(name)) || /(^|\/)comicinfo\.xml$/i.test(name));
const fileIcon = (name) => (IMAGE_EXT.includes(extOf(name)) ? 'image' : ['pdf'].includes(extOf(name)) ? 'picture_as_pdf' : ['cbz', 'zip', 'cbr', 'rar', 'cb7', '7z', 'cbt', 'tar'].includes(extOf(name)) ? 'photo_library' : 'menu_book');

// Upload state survives leaving the page, so uploads keep going in the background.
const state = {
  libraryId: null,
  folder: '',
  collectionId: '',
  items: [], // { id, file, name, size, status: waiting|uploading|done|failed, loaded, error, xhr, path }
  running: false,
  finished: null, // { libraryId, count, collection }
  rerender: null,
};
let nextId = 1;

function warnOnClose(e) {
  if (state.running) {
    e.preventDefault();
    e.returnValue = '';
  }
}
addEventListener('beforeunload', warnOnClose);

export async function uploadView(view, params, stale) {
  if (!can(session.user, 'upload')) {
    view.append(emptyState('lock', t('Uploading isn’t enabled'), t('Ask the admin to turn on uploads for your account.')));
    return;
  }
  view.append(loading());
  // The admin may also upload into users' personal libraries.
  const [allLibraries, collections, limits] = await Promise.all([api.libraries(isAdmin() ? 'all' : undefined), api.collections().catch(() => []), api.uploadLimits().catch(() => ({ maxBytes: 0 }))]);
  // Only libraries you may write into (with a personal folder: your own libraries).
  const libraries = allLibraries.filter((l) => l.writable);
  if (stale()) return;
  view.replaceChildren();
  if (!libraries.length) {
    view.append(h('div.page', h('div.page-head.enter', h('h1', t('Upload'))), session.user.homeDir
      ? emptyState('create_new_folder', t('Create a library first'), t('Uploads go into your own libraries. Create one in your personal folder.'), button(t('My libraries'), { icon: 'folder_special', onclick: () => navigate('/settings/mylibs') }))
      : emptyState('folder_off', t('No libraries to upload into'), t('The admin needs to add a library first.'))));
    return;
  }
  if (!libraries.some((l) => l.id === state.libraryId)) {
    state.libraryId = Number(params.query.get('library')) || libraries[0].id;
    state.folder = '';
  }
  const owned = collections.filter((c) => c.owned);

  // ----- Destination -----
  const libField = field(t('Library'), { value: state.libraryId, options: libraryOptions(libraries, (l) => `${l.name} · ${KIND_LABEL[l.kind]}`) });
  libField.input.addEventListener('change', () => {
    state.libraryId = Number(libField.input.value);
    state.folder = '';
    loadFolders();
  });
  const crumbs = h('div.up-crumbs');
  const folderList = h('div.up-folders');
  const hint = h('p.body-small.muted.up-hint');
  const newFolder = button(t('New folder'), { variant: 'text', icon: 'create_new_folder', onclick: async () => {
    const name = field(t('Folder name'), { required: true, support: t('For example the series or author name.') });
    await formDialog({ title: t('New folder'), icon: 'create_new_folder', fields: [name], submit: t('Create'), onSubmit: async () => {
      const r = await api.createUploadFolder({ libraryId: state.libraryId, path: state.folder, name: name.input.value });
      state.folder = r.path;
    } });
    loadFolders();
  } });

  async function loadFolders() {
    folderList.replaceChildren(h('div.up-folder-loading', h('div.loader.small', h('span'))));
    let r;
    try {
      r = await api.uploadFolders(state.libraryId, state.folder);
    } catch (e) {
      folderList.replaceChildren(h('div.form-error', icon('error'), e.message));
      return;
    }
    const parts = r.path ? r.path.split('/') : [];
    crumbs.replaceChildren(
      h('button.chip.state', { type: 'button', 'aria-pressed': String(!parts.length), onclick: () => { state.folder = ''; loadFolders(); } }, icon('home'), r.library.name),
      ...parts.flatMap((p, i) => [icon('chevron_right'), h('button.chip.state', { type: 'button', 'aria-pressed': String(i === parts.length - 1), onclick: () => { state.folder = parts.slice(0, i + 1).join('/'); loadFolders(); } }, p)]),
    );
    folderList.replaceChildren(
      ...(r.folders.length
        ? r.folders.map((f) => h('button.up-folder.state', { type: 'button', onclick: () => { state.folder = r.path ? `${r.path}/${f}` : f; loadFolders(); } }, icon('folder', 'filled'), h('span.up-folder-name', f), icon('chevron_right')))
        : [h('div.up-empty-folder', icon('folder_open'), r.files ? plural(r.files, '{files} file here, no sub-folders', '{files} files here, no sub-folders', { files: r.files }) : t('Empty folder'))]),
    );
    const mode = r.library.mode;
    hint.textContent = mode === 'komga'
      ? t('This library treats every folder as one series – upload each series into its own folder.')
      : mode === 'kavita'
        ? t('Series come from file names here (e.g. “Series v01.cbz”), so any folder works.')
        : t('Each book is its own entry here; series come from the book’s own metadata. Any folder works.');
    target.textContent = `${r.library.name}${r.path ? ` / ${r.path.split('/').join(' / ')}` : ''}`;
  }

  const collField = field(t('Add to collection'), {
    value: state.collectionId,
    options: [{ value: '', label: t('Don’t add to a collection') }, ...owned.map((c) => ({ value: c.id, label: c.name })), { value: 'new', label: t('+ New collection…') }],
  });
  collField.input.addEventListener('change', async () => {
    if (collField.input.value !== 'new') {
      state.collectionId = collField.input.value;
      return;
    }
    const name = field(t('Collection name'), { required: true });
    let created = null;
    await formDialog({ title: t('New collection'), icon: 'library_add', fields: [name], submit: t('Create'), onSubmit: async () => {
      created = await api.createCollection({ name: name.input.value });
    } });
    if (created) {
      state.collectionId = String(created.id);
      collField.input.append(h('option', { value: created.id }, name.input.value));
      refreshShell();
    }
    collField.input.value = state.collectionId;
  });

  const target = h('strong');
  const destination = h('section.up-card.up-dest.enter',
    h('h2.title-medium', icon('folder_managed'), t('Destination')),
    libField,
    h('div.label-large.up-label', t('Folder')),
    crumbs,
    folderList,
    h('div.up-folder-actions', newFolder),
    hint,
    collField,
  );

  // ----- Drop zone -----
  const filesInput = h('input', { type: 'file', multiple: true, accept: ACCEPT, hidden: true });
  const dirInput = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true });
  filesInput.addEventListener('change', () => addFiles([...filesInput.files].map((f) => ({ file: f, name: f.name }))));
  dirInput.addEventListener('change', () => addFiles([...dirInput.files].map((f) => ({ file: f, name: f.webkitRelativePath || f.name }))));
  const zone = h('div.dropzone', { tabindex: 0, role: 'button', 'aria-label': t('Add files to upload') },
    h('div.dz-orb', icon('cloud_upload', 'filled')),
    h('div.title-large', t('Drop books, comics or folders here')),
    h('p.body-medium.muted', t('EPUB, MOBI/AZW3, PDF, DOCX, RTF, FB2, TXT, CBZ, CBR, CB7, CBT – or a folder of images for a chapter.')),
    h('div.dz-actions',
      button(t('Choose files'), { icon: 'note_add', onclick: (e) => { e.stopPropagation(); filesInput.click(); } }),
      button(t('Choose a folder'), { variant: 'tonal', icon: 'drive_folder_upload', onclick: (e) => { e.stopPropagation(); dirInput.click(); } }),
    ),
    limits.maxBytes ? h('p.body-small.muted', t('Up to {value} per file.{value2}', { value: formatBytes(limits.maxBytes), value2: limits.storage?.quota ? t(' Your personal folder has {value} left of {value2}.', { value: formatBytes(Math.max(0, limits.storage.quota - limits.storage.used)), value2: formatBytes(limits.storage.quota) }) : '' })) : null,
    filesInput, dirInput,
  );
  zone.addEventListener('click', () => filesInput.click());
  zone.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), filesInput.click()));
  let depth = 0;
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    zone.classList.add('over');
  });
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      zone.classList.remove('over');
    }
  });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove('over');
    addFiles(await droppedFiles(e.dataTransfer));
  });

  // ----- Queue -----
  const queue = h('section.up-card.up-queue');
  function addFiles(list) {
    const skipped = list.filter((x) => !isSupported(x.name));
    const tooBig = list.filter((x) => isSupported(x.name) && limits.maxBytes && x.file.size > limits.maxBytes);
    const ok = list.filter((x) => isSupported(x.name) && !(limits.maxBytes && x.file.size > limits.maxBytes));
    for (const x of ok) {
      if (state.items.some((i) => i.name === x.name && i.size === x.file.size && i.status !== 'done')) continue;
      state.items.push({ id: nextId++, file: x.file, name: x.name, size: x.file.size, status: 'waiting', loaded: 0 });
    }
    state.finished = null;
    if (skipped.length) snackbar(plural(skipped.length, 'Skipped {length} file Flyleaf can’t read', 'Skipped {length} files Flyleaf can’t read', { length: skipped.length }), { duration: 5000 });
    if (tooBig.length) snackbar(t('{length} {value} over the size limit', { length: tooBig.length, value: tooBig.length === 1 ? t('file is') : t('files are') }), { duration: 5000 });
    drawQueue();
  }

  function drawQueue() {
    const items = state.items;
    if (state.finished && !items.length) {
      queue.replaceChildren(finishedCard());
      return;
    }
    if (!items.length) {
      queue.replaceChildren(h('div.up-queue-empty', icon('inbox'), h('span.body-medium.muted', t('Files you add appear here.'))));
      return;
    }
    const total = items.reduce((a, i) => a + i.size, 0);
    const loaded = items.reduce((a, i) => a + (i.status === 'done' ? i.size : i.loaded), 0);
    const waiting = items.filter((i) => i.status === 'waiting' || i.status === 'failed');
    const done = items.filter((i) => i.status === 'done').length;
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    queue.replaceChildren(...[
      h('div.up-queue-head',
        h('div', h('div.title-medium', state.running ? t('Uploading {value} of {length}…', { value: done + 1 > items.length ? items.length : done + 1, length: items.length }) : plural(items.length, '{length} file · {value2}', '{length} files · {value2}', { length: items.length, value2: formatBytes(total) })),
          h('div.body-small.muted', state.running ? t('{value} of {value2}', { value: formatBytes(loaded), value2: formatBytes(total) }) : t('Into {textContent}', { textContent: target.textContent }))),
        !state.running && iconButton('delete_sweep', t('Clear list'), () => {
          state.items = [];
          drawQueue();
        }),
      ),
      h('div.progress.up-total', h('span', { style: { width: `${pct}%` } })),
      h('div.up-list', items.slice(0, 400).map(row)),
      items.length > 400 && h('p.body-small.muted', t('…and {value} more', { value: items.length - 400 })),
      h('div.up-queue-actions',
        state.running
          ? button(t('Cancel'), { variant: 'text', icon: 'close', onclick: cancelAll })
          : button(waiting.length ? plural(waiting.length, 'Upload {length} file', 'Upload {length} files', { length: waiting.length }) : t('Done'), {
            icon: 'upload',
            disabled: !waiting.length,
            onclick: start,
          }),
      ),
    ].filter(Boolean));
  }

  function row(i) {
    const pct = i.status === 'done' ? 100 : i.size ? Math.round((i.loaded / i.size) * 100) : 0;
    return h(`div.upload-row.${i.status}`,
      h('span.up-icon', icon(i.status === 'done' ? 'check_circle' : i.status === 'failed' ? 'error' : fileIcon(i.name))),
      h('div.up-text',
        h('div.up-name', i.name),
        h('div.body-small.muted', i.status === 'failed' ? i.error : i.status === 'done' ? t('{value} · saved{value2}', { value: formatBytes(i.size), value2: i.renamed ? t(' as {value}', { value: i.path.split('/').pop() }) : '' }) : i.status === 'uploading' ? t('{value} of {value2}', { value: formatBytes(i.loaded), value2: formatBytes(i.size) }) : formatBytes(i.size)),
        i.status === 'uploading' && h('div.progress', h('span', { style: { width: `${pct}%` } })),
      ),
      !state.running && i.status !== 'done' && iconButton('close', t('Remove'), () => {
        state.items = state.items.filter((x) => x !== i);
        drawQueue();
      }),
    );
  }

  function finishedCard() {
    const f = state.finished;
    return h('div.up-finished',
      h('div.up-check', icon('check', 'filled')),
      h('div.title-large', plural(f.count, '{count} file uploaded', '{count} files uploaded', { count: f.count })),
      h('p.body-medium.muted', t('Flyleaf is scanning {libraryName}{value}.', { libraryName: f.libraryName, value: f.collection ? t(' and will add the new series to “{collection}”', { collection: f.collection }) : '' })),
      h('div.dz-actions',
        button(t('Open library'), { icon: 'local_library', onclick: () => navigate(`/library/${f.libraryId}`) }),
        button(t('Upload more'), { variant: 'tonal', icon: 'add', onclick: () => {
          state.finished = null;
          drawQueue();
        } }),
      ),
    );
  }

  // ----- Running -----
  async function start() {
    const todo = state.items.filter((i) => i.status === 'waiting' || i.status === 'failed');
    if (!todo.length) return;
    state.running = true;
    for (const i of todo) {
      i.status = 'waiting';
      i.error = null;
      i.loaded = 0;
    }
    const libraryId = state.libraryId;
    const folder = state.folder;
    const collectionId = state.collectionId && state.collectionId !== 'new' ? Number(state.collectionId) : null;
    const rerender = () => state.rerender?.();
    rerender();
    let cursor = 0;
    async function worker() {
      while (state.running && cursor < todo.length) {
        const item = todo[cursor++];
        item.status = 'uploading';
        rerender();
        try {
          const r = await send(item, libraryId, folder, rerender);
          item.status = 'done';
          item.path = r.path;
          item.renamed = r.renamed;
        } catch (e) {
          item.status = 'failed';
          item.error = e.message;
        }
        rerender();
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
    state.running = false;
    const doneItems = todo.filter((i) => i.status === 'done');
    if (doneItems.length) {
      try {
        await api.finishUpload({ libraryId, files: doneItems.map((i) => i.path), collectionId });
      } catch (e) {
        snackbar(e.message, { duration: 6000 });
      }
      const lib = libraries.find((l) => l.id === libraryId);
      const failed = state.items.filter((i) => i.status === 'failed');
      if (!failed.length) {
        state.items = [];
        state.finished = { libraryId, libraryName: lib?.name || t('the library'), count: doneItems.length, collection: owned.find((c) => c.id === collectionId)?.name || null };
      }
      snackbar(plural(doneItems.length, 'Uploaded {length} file{value2}', 'Uploaded {length} files{value2}', { length: doneItems.length, value2: failed.length ? t(' · {length} failed', { length: failed.length }) : '' }));
      refreshShell();
    }
    rerender();
  }

  function cancelAll() {
    state.running = false;
    for (const i of state.items) {
      if (i.status === 'uploading') {
        i.xhr?.abort();
      }
    }
  }

  // ----- Layout -----
  view.append(h('div.page.upload-page',
    h('div.page-head.enter', h('h1', t('Upload')), h('span.body-medium.muted', t('Into '), target)),
    h('div.up-layout', destination, h('div.up-main', zone, queue)),
  ));
  state.rerender = drawQueue;
  onLeave(() => {
    if (state.rerender === drawQueue) state.rerender = null;
  });
  loadFolders();
  drawQueue();
}

/** Upload one file with progress (fetch can't report upload progress, XHR can). */
function send(item, libraryId, folder, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    const qs = new URLSearchParams({ library: String(libraryId), folder, name: item.name });
    xhr.open('PUT', `/api/uploads/file?${qs}`);
    xhr.setRequestHeader('X-Flyleaf', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    let last = 0;
    xhr.upload.onprogress = (e) => {
      item.loaded = e.loaded;
      if (Date.now() - last > 120) {
        last = Date.now();
        onProgress();
      }
    };
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.error || t('Upload failed (HTTP {status})', { status: xhr.status })));
    };
    xhr.onerror = () => reject(new Error(t('Network error – check your connection.')));
    xhr.onabort = () => reject(new Error(t('Cancelled')));
    xhr.send(item.file);
  });
}

/** Files from a drop, walking into dropped folders (keeping their relative paths). */
async function droppedFiles(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])].map((f) => ({ file: f, name: f.name }));
  const out = [];
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, name: `${prefix}${file.name}` });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e, '');
  return out;
}
