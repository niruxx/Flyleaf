import { api } from '../api.js';
import { t } from '../i18n.js';
import { navigate, onLeave, session } from '../router.js';
import { button, emptyState, field, formDialog, formatBytes, h, icon, loading, pageHeader, snackbar } from '../ui.js';

const bookFormats = new Set(['txt', 'docx', 'rtf', 'audio']);
const providerName = { openlibrary: 'Open Library', googlebooks: 'Google Books' };

export async function bookDropView(view, params, stale) {
  const content = h('div.book-drop-content');
  view.append(h('div.page', content));
  if (session.user?.role !== 'admin') {
    content.append(emptyState('lock', t('Administrator access required')));
    return;
  }
  const folder = h('p.note.mono', { hidden: true });
  const results = h('div', loading());
  content.append(pageHeader(t('BookDrop')), h('p.muted', t('Review files from your import folder.')), folder, results);

  const libraries = await api.libraries('all');
  if (stale()) return;

  let state = '';
  let sequence = 0;
  async function refresh() {
    const ticket = ++sequence;
    try {
      const inbox = await api.bookDrop();
      if (stale() || ticket !== sequence) return;
      const next = JSON.stringify(inbox);
      if (next === state) return;
      state = next;
      folder.textContent = inbox.folder || '';
      folder.hidden = !inbox.folder;
      if (!inbox.enabled) {
        results.replaceChildren(emptyState('folder_off', t('BookDrop is disabled'), t('Set BOOKDROP_DIR to a separate folder on your server and restart Flyleaf.')));
      } else if (inbox.error) {
        results.replaceChildren(emptyState('error', t('BookDrop unavailable'), inbox.error));
      } else if (!inbox.items.length) {
        results.replaceChildren(emptyState('inbox', t('Inbox is empty'), t('Copy a book file into this folder. It will appear here when the copy is complete.')));
      } else {
        results.replaceChildren(h('div.settings-group', inbox.items.map(row)));
      }
    } catch (error) {
      if (stale() || ticket !== sequence) return;
      state = '';
      results.replaceChildren(emptyState('error', t('BookDrop unavailable'), error.message));
    }
  }

  function row(item) {
    const m = item.metadata;
    const libraryOptions = libraries.filter((l) => !l.storageUnavailable && (!bookFormats.has(m.format) || l.kind === 'books'));
    return h('div.setting-row', icon('book_2'), h('div.text', h('div', m.title || item.name),
      h('div.s', [m.author, item.name, formatBytes(item.size)].filter(Boolean).join(' · ')),
      m.isbn && h('div.s', `ISBN ${m.isbn}`),
      m.match && h('div.s', t('Match from {source} · {title}', { source: providerName[m.match.provider] || m.match.provider, title: m.match.title })),
      m.error && h('div.s', m.error)),
    h('div', button(t('Dismiss'), { variant: 'text', onclick: async (event) => {
      const control = event.currentTarget;
      control.disabled = true;
      try { await api.dismissBookDrop(item.id); await refresh(); } catch (e) { snackbar(e.message); }
      finally { control.disabled = false; }
    } }), button(t('Import'), { icon: 'download', disabled: !libraryOptions.length || !m.format, onclick: () => importDialog(item, libraryOptions) })));
  }

  function importDialog(item, options) {
    const m = item.metadata;
    const library = field(t('Destination library'), { required: true, options: [{ label: t('Choose a library'), value: '' }, ...options.map((l) => ({ value: l.id, label: l.name }))] });
    const subfolder = field(t('Subfolder (optional)'), { maxlength: 1000 });
    const useMatch = h('input', { type: 'checkbox', checked: true });
    const summary = m.match?.summary || m.description;
    formDialog({ title: t('Import {title}', { title: m.title || item.name }), icon: 'move_to_inbox', submit: t('Import'),
      fields: [library, subfolder, summary && h('p.note', summary.slice(0, 700)), m.match && h('label', useMatch, ' ', t('Use online metadata for a standalone book'))].filter(Boolean),
      onSubmit: async () => {
        const result = await api.importBookDrop(item.id, { libraryId: Number(library.input.value), folder: subfolder.input.value, useMatch: Boolean(m.match && useMatch.checked) });
        await refresh();
        if (stale()) return;
        if (result.warning) snackbar(result.warning);
        else snackbar(t('Book imported'), { action: t('Open book'), onAction: () => navigate(`/series/${result.seriesId}`) });
      },
    });
  }

  const timer = setInterval(refresh, 5000);
  onLeave(() => clearInterval(timer));
  await refresh();
}
