import { api } from '../api.js';
import { onLeave, isAdmin } from '../router.js';
import { h, icon, button, field, pageHeader, emptyState, snackbar, formatBytes, copyText } from '../ui.js';
import { t } from '../i18n.js';
import { migrationStage, movePersonalFolderDialog } from '../components/storage-migration.js';

const KINDS = { download: 'Download', upload: 'Upload', scan: 'Library scan', metadata: 'Metadata', index: 'Search indexing', backup: 'Backup', 'backup-download': 'Backup download', restore: 'Backup restore', conversion: 'Reader conversion', 'device-sync': 'Device sync', 'storage-migration': 'Personal folder migration', 'finder-relink': 'Content Finder source scan' };
const ICONS = { download: 'download', upload: 'upload', scan: 'sync', metadata: 'auto_awesome', index: 'manage_search', backup: 'backup', 'backup-download': 'download', restore: 'restore', conversion: 'menu_book', 'device-sync': 'sync', 'storage-migration': 'drive_file_move' };
const STATUS = { queued: 'Queued', running: 'In progress', done: 'Completed', failed: 'Failed', cancelled: 'Cancelled', retried: 'Retried' };
export async function activityView(view, params, stale) {
  const page = h('div.page.activity-page');
  const body = h('div.task-list');
  const message = h('p.muted', { role: 'status' }, t('Loading activity…'));
  const summary = h('p.muted', { 'aria-live': 'polite' });
  let items = [], stopped = false, timer, signature = '';
  let status = 'all', kind = 'all';
  const filters = h('div.activity-filters');
  const statusField = field(t('Status'), { value: status, options: [
    ['all', 'All activity'], ['active', 'In progress'], ['failed', 'Needs attention'], ['done', 'Completed'], ['cancelled', 'Cancelled'],
  ].map(([value, label]) => ({ value, label: t(label) })) });
  const kindField = field(t('Task type'), { value: kind, options: [{ value: 'all', label: t('All types') }, ...Object.entries(KINDS).map(([value, label]) => ({ value, label: t(label) }))] });
  statusField.input.addEventListener('change', () => { status = statusField.input.value; draw(); });
  kindField.input.addEventListener('change', () => { kind = kindField.input.value; draw(); });
  const refresh = button(t('Refresh'), { variant: 'tonal', icon: 'refresh', onclick: () => poll() });
  filters.append(statusField, kindField, refresh);
  page.append(pageHeader(t('Activity center')), h('p.muted', isAdmin()
    ? t('Background work across your server. Active tasks appear first; recent history stays available after a restart.')
    : t('Your uploads, Content Finder downloads, and personal folder migrations.')), filters, summary, message, body);
  view.append(page);

  const act = async (item, action, btn) => {
    btn.disabled = true;
    try {
      if (action === 'cancel') await api.cancelDownload(item.downloadId);
      else if (item.downloadId) await api.retryDownload(item.downloadId);
      else await api.retryTask(item.taskId);
      await poll();
    } catch (e) { snackbar(e.message); }
    finally { btn.disabled = false; }
  };
  function draw() {
    const active = items.filter(item => ['running', 'queued'].includes(item.status)).length;
    const failed = items.filter(item => item.status === 'failed').length;
    const text = t('{active} active · {failed} need attention', { active, failed });
    if (summary.textContent !== text) summary.textContent = text;
    const visible = items.filter(item => (kind === 'all' || item.kind === kind) &&
      (status === 'all' || (status === 'active' ? ['running', 'queued'].includes(item.status) : item.status === status)));
    const focused = body.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    body.replaceChildren(...(visible.length ? visible.map(item => {
      const active = ['running', 'queued'].includes(item.status);
      const done = Math.max(0, Number(item.done) || 0);
      const total = Number(item.total) || 0;
      const progress = total > 0 ? Math.min(100, Math.round(done / total * 100)) : null;
      const details = ['download', 'upload'].includes(item.kind)
        ? total ? `${formatBytes(done)} / ${formatBytes(total)}` : done ? formatBytes(done) : ''
        : item.kind === 'storage-migration' ? `${progress ?? 0}%` : total ? `${done} / ${total}` : '';
      const controls = h('div.task-actions');
      if (item.destination) controls.append(button(t('Copy destination path'), { variant: 'text', icon: 'content_copy', dataset: { focus: `${item.id}-copy-destination` }, onclick: async () => {
        try { await copyText(item.destination); }
        catch (e) { snackbar(e.message); }
      } }));
      if (item.retryMove) controls.append(button(t('Retry move'), { variant: 'text', icon: 'refresh', dataset: { focus: `${item.id}-retry-move` }, onclick: async () => {
        try {
          const user = isAdmin() ? (await api.users()).find(user => user.id === item.userId) : undefined;
          if (isAdmin() && !user?.homeDir) return snackbar(t('This account no longer has a personal folder.'));
          await movePersonalFolderDialog(user, item.destination);
          await poll();
        } catch (e) { snackbar(e.message); }
      } }));
      for (const action of ['retry', 'cancel']) if (item[action]) {
        const btn = button(t(action === 'retry' ? 'Retry' : 'Cancel'), { variant: 'text', icon: action === 'retry' ? 'refresh' : 'close', dataset: { focus: `${item.id}-${action}` }, 'aria-label': t(action === 'retry' ? 'Retry {title}' : 'Cancel {title}', { title: item.title }) });
        btn.addEventListener('click', () => act(item, action, btn));
        controls.append(btn);
      }
      return h('article.task-card', { dataset: { status: item.status } },
        h('div.task-icon', icon(ICONS[item.kind] || 'pending_actions')),
        h('div.task-content', h('div.task-heading', h('h2.title-medium', item.title), h('span.task-status', t(STATUS[item.status] || item.status))),
          h('p.body-small.muted', `${t(KINDS[item.kind] || item.kind)} · ${new Date(item.createdAt).toLocaleString()}`),
          item.phase && h('p.body-small', item.kind === 'storage-migration' ? migrationStage(item.phase)
            : t(({ walking: 'Finding files', metadata: 'Reading metadata', grouping: 'Grouping series' })[item.phase] || 'Scanning…')),
          active && h('progress.task-progress', { max: 100, value: progress ?? undefined, 'aria-label': t('Task progress') }),
          details && h('p.body-small', details),
          item.destination && h('p.body-small.mono', item.destination),
          item.error && h('p.task-error', item.error)), controls);
    }) : [emptyState('task_alt', t('No activity to show'), t('Tasks will appear here when they run. Try another filter to see more history.'))]));
    if (focused) [...body.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === focused)?.focus({ preventScroll: true });
  }
  let pending = false;
  async function poll() {
    if (stopped || pending) return;
    clearTimeout(timer);
    pending = true;
    refresh.disabled = true;
    try {
      const data = await api.tasks();
      if (stopped || stale()) return;
      message.textContent = '';
      const next = JSON.stringify(data.items);
      if (next !== signature) { signature = next; items = data.items; draw(); }
    } catch (e) {
      if (!stopped && !stale()) message.textContent = t('Couldn’t refresh activity: {error}', { error: e.message });
    } finally {
      pending = false;
      refresh.disabled = false;
      if (!stopped) timer = setTimeout(() => document.hidden ? schedule() : poll(), 4000);
    }
  }
  function schedule() { if (!stopped) timer = setTimeout(() => document.hidden ? schedule() : poll(), 4000); }
  onLeave(() => { stopped = true; clearTimeout(timer); });
  await poll();
}
