// Settings → Notifications (everyone) and Settings → Backup & restore (admin).

import { api } from '../api.js';
import { session, isAdmin } from '../router.js';
import { h, icon, button, snackbar, toggleSwitch, confirmDialog, dialog, loading, formatBytes, timeAgo, copyText } from '../ui.js';

const row = (ic, title, sub, control) => h('div.setting-row', ic && icon(ic), h('div.text', h('div', title), sub && h('div.s', sub)), control);
const group = (...rows) => h('div.settings-group', ...rows);

// ---------------------------------------------------------------------------
// Notifications

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function notificationsPanel(panel, stale) {
  panel.append(h('h2', 'Notifications'), loading());
  const info = await api.push();
  if (stale()) return;
  panel.lastChild.remove();

  if (!pushSupported() || !window.isSecureContext) {
    panel.append(
      h('div.settings-group', row('notifications_off', 'Not available here',
        !window.isSecureContext
          ? 'Push notifications need HTTPS (or localhost). Put Flyleaf behind an HTTPS reverse proxy to use them.'
          : 'This browser doesn’t support push notifications. On iPhone, add Flyleaf to your Home Screen first, then open it from there.')),
    );
    return;
  }

  const sub = await currentSubscription().catch(() => null);
  const here = sub && info.devices.some((d) => d.endpoint === sub.endpoint);
  const draw = (devices, subscribedHere) => {
    const toggleHere = button(subscribedHere ? 'Turn off on this device' : 'Turn on for this device', {
      variant: subscribedHere ? 'outlined' : 'filled',
      icon: subscribedHere ? 'notifications_off' : 'notifications_active',
      onclick: async () => {
        try {
          if (subscribedHere) {
            const s = await currentSubscription();
            await s?.unsubscribe();
            const r = await api.pushRemove({ endpoint: s?.endpoint });
            draw(r.devices, false);
            snackbar('Notifications turned off on this device');
          } else {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') return snackbar('Notifications are blocked. Allow them in your browser’s site settings.', { duration: 6000 });
            const reg = await navigator.serviceWorker.ready;
            const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.publicKey) });
            const r = await api.pushSubscribe(s.toJSON());
            draw(r.devices, true);
            snackbar('Notifications turned on');
          }
        } catch (e) {
          snackbar(e.message || 'Couldn’t change notifications.', { duration: 6000 });
        }
      },
    });

    const notify = { ...session.user.prefs.notify };
    const kind = (key, ic, title, sub) => row(ic, title, sub, toggleSwitch(Boolean(notify[key]), async (v) => {
      notify[key] = v;
      session.user.prefs = await api.savePrefs({ notify });
    }, title));

    // filter: the DOM's replaceChildren would print `false`.
    panel.replaceChildren(...[
      h('h2', 'Notifications'),
      group(
        row(subscribedHere ? 'notifications_active' : 'notifications', subscribedHere ? 'On for this device' : 'Off for this device',
          'Get a notification on this phone or computer, even when Flyleaf isn’t open.', null),
        h('div.setting-row', h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          toggleHere,
          devices.length > 0 && button('Send a test', { variant: 'text', icon: 'send', onclick: async () => {
            try {
              const r = await api.pushTest();
              snackbar(r.failed ? `Sent to ${r.sent}, ${r.failed} failed: ${r.error}` : `Sent to ${r.sent} ${r.sent === 1 ? 'device' : 'devices'}`);
            } catch (e) {
              snackbar(e.message);
            }
          } }))),
      ),
      h('div.sub-head', 'Notify me about'),
      group(
        kind('newChapters', 'new_releases', 'New chapters', 'When a series you follow (or downloaded) gets new chapters or volumes'),
        kind('downloads', 'download_done', 'My downloads', 'When a Content Finder download finishes or fails'),
        kind('newBooks', 'library_add', 'New books', 'When a scan adds books to a library you can see (one notification per library)'),
        isAdmin() && kind('admin', 'admin_panel_settings', 'Sign-ups and uploads', 'When someone creates an account or uploads files'),
      ),
      devices.length > 0 && h('div.sub-head', 'Your devices'),
      devices.length > 0 && group(...devices.map((d) => row(
        /iphone|android|mobile/i.test(d.userAgent || '') ? 'smartphone' : 'computer',
        deviceName(d.userAgent),
        `Added ${timeAgo(d.createdAt)}${d.lastError ? ` · last error: ${d.lastError}` : ''}${sub?.endpoint === d.endpoint ? ' · this device' : ''}`,
        button('Remove', { variant: 'text', onclick: async () => {
          const r = await api.pushRemove({ id: d.id });
          draw(r.devices, subscribedHere && sub?.endpoint !== d.endpoint);
        } }),
      ))),
    ].filter(Boolean));
  };
  draw(info.devices, here);
}

function deviceName(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

// ---------------------------------------------------------------------------
// Backup & restore

export async function backupPanel(panel, stale) {
  panel.append(h('h2', 'Backup & restore'), loading());
  const [est, health] = await Promise.all([api.backupEstimate(), api.health().catch(() => null)]);
  if (stale()) return;
  panel.lastChild.remove();

  const dbSize = est.database + est.data;
  const download = (books) => {
    const a = h('a', { href: api.backupUrl(books), download: '' });
    document.body.append(a);
    a.click();
    a.remove();
    snackbar(books ? 'Preparing the backup – large libraries take a while to download' : 'Downloading the backup');
  };

  panel.append(
    h('div.sub-head', 'Back up'),
    group(
      row('database', 'Database only',
        `Users, reading progress, stats, collections, bookmarks, reviews, settings, plugins, covers, profile pictures and fonts · about ${formatBytes(dbSize)}`,
        button('Download', { variant: 'tonal', icon: 'download', onclick: () => download(false) })),
      row('library_books', 'Database and books',
        `Everything above plus all ${est.bookFiles.toLocaleString()} book files from every library · about ${formatBytes(dbSize + est.books)}`,
        button('Download', { variant: 'tonal', icon: 'download', onclick: () => download(true) })),
    ),
    h('p.note', 'The backup is taken while Flyleaf keeps running. Book files are stored uncompressed, so a backup with books is about as big as your libraries.'),
    h('div.sub-head', 'Restore'),
    restoreGroup({ setup: false }),
    h('div.sub-head', 'Monitoring'),
    group(
      row(health?.status === 'ok' ? 'check_circle' : 'error', health?.status === 'ok' ? 'Server is healthy' : 'Health check failed',
        health ? `Version ${health.version} · up ${formatUptime(health.uptime)} · database ${health.database}` : 'Couldn’t reach /api/health'),
      row('monitor_heart', 'Health endpoint', `${location.origin}/api/health – no sign-in needed, for uptime checkers and Docker health checks`,
        button('Copy', { variant: 'text', icon: 'content_copy', onclick: () => copyText(`${location.origin}/api/health`).then(() => snackbar('Copied')) })),
      row('query_stats', 'Prometheus metrics', `${location.origin}/api/metrics – send an admin API key as “Authorization: Bearer <key>”`,
        button('Copy', { variant: 'text', icon: 'content_copy', onclick: () => copyText(`${location.origin}/api/metrics`).then(() => snackbar('Copied')) })),
    ),
  );
}

const formatUptime = (s) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);

/**
 * Pick a backup zip, upload it, then choose what to restore. Used in Settings and on the
 * first-run setup page (`setup: true`), where `onDone` takes over afterwards.
 */
export function restoreGroup({ setup = false, onDone } = {}) {
  const input = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
  const bar = h('div.progress', { hidden: true, style: { marginTop: '8px' } }, h('span', { style: { width: '0%' } }));
  const status = h('div.s');
  const pick = button('Choose backup file', { variant: 'tonal', icon: 'upload_file', onclick: () => input.click() });
  const wrap = h('div.settings-group',
    h('div.setting-row', icon('settings_backup_restore'),
      h('div.text', h('div', 'Restore from a backup'), status, bar),
      pick),
    input);
  status.textContent = setup
    ? 'Moving Flyleaf to a new server? Start from a backup made in Settings → Backup & restore.'
    : 'Replaces everything in this Flyleaf with the backup. You’ll need to sign in again afterwards.';

  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    pick.disabled = true;
    bar.hidden = false;
    status.textContent = `Uploading ${file.name}…`;
    let up;
    try {
      up = await api.uploadBackup(file, (f) => {
        bar.firstChild.style.width = `${Math.round(f * 100)}%`;
        status.textContent = f < 1 ? `Uploading ${file.name}… ${Math.round(f * 100)}%` : 'Checking the backup…';
      }, { setup });
    } catch (e) {
      status.textContent = e.message;
      pick.disabled = false;
      bar.hidden = true;
      return;
    }
    bar.hidden = true;
    pick.disabled = false;
    status.textContent = 'Uploaded – choose what to restore.';
    chooseRestore(up, { setup, onDone, status });
  });
  return wrap;
}

function chooseRestore(up, { setup, onDone, status }) {
  const m = up.manifest;
  const created = new Date(m.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  let books = false;
  const choice = (value, ic, title, sub, disabled) => {
    const radio = h('input', { type: 'radio', name: 'restore-what', checked: value === books, disabled, onchange: () => (books = value) });
    return h(`label.restore-choice${disabled ? '.disabled' : ''}`, radio, icon(ic), h('div', h('div.body-large', title), h('div.body-small.muted', sub)));
  };
  const run = async () => {
    status.textContent = books ? 'Restoring the database and book files… this can take a while.' : 'Restoring the database…';
    try {
      const r = await api.restoreBackup(up.id, books, { setup });
      const extra = r.bookFiles ? ` and ${r.bookFiles.toLocaleString()} book files` : '';
      const fails = r.failed?.length ? ` Some files couldn’t be written (${r.failed[0]}).` : '';
      if (onDone) return onDone(r);
      await dialog({
        title: 'Backup restored',
        icon: 'task_alt',
        content: h('p', `Restored the backup from ${created}${extra}.${fails} Sign in with an account from the backup.`),
        actions: [{ label: 'Sign in', variant: 'filled' }],
        dismissible: false,
      });
      location.hash = '#/login';
      location.reload();
    } catch (e) {
      status.textContent = e.message;
    }
  };
  dialog({
    title: 'Restore this backup?',
    icon: 'settings_backup_restore',
    content: h('div',
      h('p.body-medium', `Made ${created} with Flyleaf ${m.version}${m.libraries.length ? ` · ${m.libraries.length} ${m.libraries.length === 1 ? 'library' : 'libraries'}` : ''}.`),
      h('div.restore-choices',
        choice(false, 'database', 'Database only', 'Users, progress, stats, settings and covers. Book files on this server stay as they are.'),
        choice(true, 'library_books', 'Database and books',
          m.includesBooks ? `Also writes ${m.bookFiles.toLocaleString()} book files back into the library folders, overwriting files with the same name.` : 'This backup doesn’t include book files.',
          !m.includesBooks)),
      !setup && h('p.body-small', { style: { color: 'var(--md-error)', marginTop: '12px' } }, 'Everything in this Flyleaf’s database is replaced. This can’t be undone – download a backup first if you might want it.'),
    ),
    actions: [
      { label: 'Cancel', onClick: () => {
        if (!setup) api.cancelRestore(up.id).catch(() => {});
        status.textContent = 'Restore cancelled.';
        return true;
      } },
      { label: 'Restore', variant: 'filled', onClick: async () => {
        if (!setup && !(await confirmDialog({ title: 'Replace everything?', message: 'Users, progress and settings on this server will be replaced by the backup.', confirm: 'Restore', danger: true, icon: 'warning' }))) return false;
        run();
        return true;
      } },
    ],
  });
}
