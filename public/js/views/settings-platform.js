import { t, plural } from '../i18n.js';
// Settings → Notifications (everyone) and Settings → Backup & restore (admin).

import { api } from '../api.js';
import { session, isAdmin } from '../router.js';
import { h, icon, iconButton, button, setButtonLabel, field, formError, snackbar, toggleSwitch, confirmDialog, dialog, loading, formatBytes, timeAgo, copyText } from '../ui.js';

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
  panel.append(h('h2', t('Notifications')), loading());
  const info = await api.push();
  if (stale()) return;
  panel.lastChild.remove();

  if (!pushSupported() || !window.isSecureContext) {
    panel.append(
      h('div.settings-group', row('notifications_off', t('Not available here'),
        !window.isSecureContext
          ? t('Push notifications need HTTPS (or localhost). Put Flyleaf behind an HTTPS reverse proxy to use them.')
          : t('This browser doesn’t support push notifications. On iPhone, add Flyleaf to your Home Screen first, then open it from there.'))),
    );
    return;
  }

  const sub = await currentSubscription().catch(() => null);
  const here = sub && info.devices.some((d) => d.endpoint === sub.endpoint);
  const draw = (devices, subscribedHere) => {
    const toggleHere = button(subscribedHere ? t('Turn off on this device') : t('Turn on for this device'), {
      variant: subscribedHere ? 'outlined' : 'filled',
      icon: subscribedHere ? 'notifications_off' : 'notifications_active',
      onclick: async () => {
        try {
          if (subscribedHere) {
            const s = await currentSubscription();
            await s?.unsubscribe();
            const r = await api.pushRemove({ endpoint: s?.endpoint });
            draw(r.devices, false);
            snackbar(t('Notifications turned off on this device'));
          } else {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') return snackbar(t('Notifications are blocked. Allow them in your browser’s site settings.'), { duration: 6000 });
            const reg = await navigator.serviceWorker.ready;
            const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.publicKey) });
            const r = await api.pushSubscribe(s.toJSON());
            draw(r.devices, true);
            snackbar(t('Notifications turned on'));
          }
        } catch (e) {
          snackbar(e.message || t('Couldn’t change notifications.'), { duration: 6000 });
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
      h('h2', t('Notifications')),
      group(
        row(subscribedHere ? 'notifications_active' : 'notifications', subscribedHere ? t('On for this device') : t('Off for this device'),
          t('Get a notification on this phone or computer, even when Flyleaf isn’t open.'), null),
        h('div.setting-row', h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          toggleHere,
          devices.length > 0 && button(t('Send a test'), { variant: 'text', icon: 'send', onclick: async () => {
            try {
              const r = await api.pushTest();
              snackbar(r.failed ? t('Sent to {sent}, {failed} failed: {error}', { sent: r.sent, failed: r.failed, error: r.error }) : plural(r.sent, 'Sent to {sent} device', 'Sent to {sent} devices', { sent: r.sent }));
            } catch (e) {
              snackbar(e.message);
            }
          } }))),
      ),
      h('div.sub-head', t('Notify me about')),
      group(
        kind('newChapters', 'new_releases', t('New chapters'), t('When a series you follow (or downloaded) gets new chapters or volumes')),
        kind('downloads', 'download_done', t('My downloads'), t('When a Content Finder download finishes or fails')),
        kind('newBooks', 'library_add', t('New books'), t('When a scan adds books to a library you can see (one notification per library)')),
        isAdmin() && kind('admin', 'admin_panel_settings', t('Sign-ups and uploads'), t('When someone creates an account or uploads files')),
        isAdmin() && kind('security', 'gpp_maybe', t('Failed sign-ins'), t('When someone keeps getting a password wrong, for one address or one account')),
      ),
      devices.length > 0 && h('div.sub-head', t('Your devices')),
      devices.length > 0 && group(...devices.map((d) => row(
        /iphone|android|mobile/i.test(d.userAgent || '') ? 'smartphone' : 'computer',
        deviceName(d.userAgent),
        t('Added {value}{value2}{value3}', { value: timeAgo(d.createdAt), value2: d.lastError ? t(' · last error: {lastError}', { lastError: d.lastError }) : '', value3: sub?.endpoint === d.endpoint ? t(' · this device') : '' }),
        button(t('Remove'), { variant: 'text', onclick: async () => {
          const r = await api.pushRemove({ id: d.id });
          draw(r.devices, subscribedHere && sub?.endpoint !== d.endpoint);
        } }),
      ))),
    ].filter(Boolean));
  };
  draw(info.devices, here);
}

function deviceName(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : t('Browser');
  const os = /iPhone|iPad/.test(ua) ? t('iPhone / iPad') : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? t('{browser} on {os}', { browser: browser, os: os }) : browser;
}

// ---------------------------------------------------------------------------
// Backup & restore

export async function backupPanel(panel, stale) {
  panel.append(h('h2', t('Backup & restore')), loading());
  const [est, health] = await Promise.all([api.backupEstimate(), api.health().catch(() => null)]);
  if (stale()) return;
  panel.lastChild.remove();

  const dbSize = est.database + est.data;
  const download = (books) => {
    const a = h('a', { href: api.backupUrl(books), download: '' });
    document.body.append(a);
    a.click();
    a.remove();
    snackbar(books ? t('Preparing the backup – large libraries take a while to download') : t('Downloading the backup'));
  };

  panel.append(
    h('div.sub-head', t('Back up')),
    group(
      row('database', t('Database only'),
        t('Users, reading progress, stats, collections, bookmarks, reviews, settings, plugins, covers, profile pictures and fonts · about {value}', { value: formatBytes(dbSize) }),
        button(t('Download'), { variant: 'tonal', icon: 'download', onclick: () => download(false) })),
      row('library_books', t('Database and books'),
        t('Everything above plus all {value} book files from every library · about {value2}', { value: est.bookFiles.toLocaleString(), value2: formatBytes(dbSize + est.books) }),
        button(t('Download'), { variant: 'tonal', icon: 'download', onclick: () => download(true) })),
    ),
    h('p.note', t('The backup is taken while Flyleaf keeps running. Book files are stored uncompressed, so a backup with books is about as big as your libraries.')),
    h('div.sub-head', t('Automatic backups')),
    scheduledGroup(),
    h('div.sub-head', t('Restore')),
    restoreGroup({ setup: false }),
    h('div.sub-head', t('Monitoring')),
    group(
      row(health?.status === 'ok' ? 'check_circle' : 'error', health?.status === 'ok' ? t('Server is healthy') : t('Health check failed'),
        health ? t('Version {version} · up {value} · database {database}', { version: health.version, value: formatUptime(health.uptime), database: health.database }) : t('Couldn’t reach /api/health')),
      row('monitor_heart', t('Health endpoint'), t('{origin}/api/health – no sign-in needed, for uptime checkers and Docker health checks', { origin: location.origin }),
        button(t('Copy'), { variant: 'text', icon: 'content_copy', onclick: () => copyText(`${location.origin}/api/health`).then(() => snackbar(t('Copied'))) })),
      row('query_stats', t('Prometheus metrics'), t('{origin}/api/metrics – send an admin API key as “Authorization: Bearer <key>”', { origin: location.origin }),
        button(t('Copy'), { variant: 'text', icon: 'content_copy', onclick: () => copyText(`${location.origin}/api/metrics`).then(() => snackbar(t('Copied'))) })),
    ),
  );
}

/** Backups on a schedule, kept in a folder on the server (another disk if you like). */
function scheduledGroup() {
  const wrap = h('div', loading());
  async function load() {
    let d;
    try {
      d = await api.backups();
    } catch (e) {
      wrap.replaceChildren(h('p.note', e.message));
      return;
    }
    const s = d.schedule;
    const enabled = toggleSwitch(s.enabled, () => {}, t('Back up automatically'));
    const every = field(t('How often'), { value: s.every, options: [{ value: 'daily', label: t('Every day') }, { value: 'weekly', label: t('Every week') }] });
    const hour = field(t('At'), { value: s.hour, options: Array.from({ length: 24 }, (_, i) => ({ value: i, label: new Date(2000, 0, 1, i).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) })) });
    const keep = field(t('Keep the newest'), { value: s.keep, type: 'number', min: 1, max: 100, support: t('Older backups are deleted.') });
    const books = h('input', { type: 'checkbox', checked: s.includeBooks });
    const folder = field(t('Folder'), { value: s.folder, autocomplete: 'off', support: t('Leave empty for {folder}. Use a folder on another disk to survive a disk failure.', { folder: d.folder }) });
    const err = h('div');
    const save = button(t('Save'), { icon: 'save', onclick: async () => {
      err.replaceChildren();
      try {
        await api.saveBackupSchedule({
          enabled: enabled.querySelector('input').checked, every: every.input.value, hour: Number(hour.input.value),
          keep: Number(keep.input.value), includeBooks: books.checked, folder: folder.input.value,
        });
        snackbar(t('Backup schedule saved'));
        load();
      } catch (e) {
        err.append(formError(e.message));
      }
    } });
    const now = button(t('Back up now'), { variant: 'tonal', icon: 'backup', onclick: async () => {
      now.disabled = true;
      setButtonLabel(now, t('Backing up…'));
      try {
        const r = await api.runBackup();
        snackbar(t('Saved {name}', { name: r.name }));
      } catch (e) {
        snackbar(e.message, { duration: 6000 });
      }
      load();
    } });
    const last = d.last
      ? d.last.error ? t('Last backup failed {value}: {error}', { value: timeAgo(d.last.at), error: d.last.error }) : t('Last backup {value}', { value: timeAgo(d.last.at) })
      : t('No automatic backups yet');
    const rows = d.backups.map((b) => h('div.setting-row', icon(b.books ? 'library_books' : 'database'),
      h('div.text', h('div', new Date(b.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })), h('div.s', `${formatBytes(b.size)}${b.books ? t(' · with books') : ''} · ${b.name}`)),
      iconButton('download', t('Download'), () => {
        const a = h('a', { href: api.storedBackupUrl(b.name), download: b.name });
        document.body.append(a);
        a.click();
        a.remove();
      }),
      iconButton('settings_backup_restore', t('Restore this backup'), async () => {
        if (!(await confirmDialog({ title: t('Restore this backup?'), message: t('Everything in this Flyleaf’s database is replaced by the backup from {value}.{value2} Everyone signs in again afterwards.', { value: new Date(b.createdAt).toLocaleString(), value2: b.books ? t(' Book files are written back too.') : '' }), confirm: t('Restore'), danger: true, icon: 'warning' }))) return;
        snackbar(t('Restoring…'), { duration: 120_000 });
        try {
          await api.restoreStoredBackup(b.name, b.books);
          location.hash = '#/login';
          location.reload();
        } catch (e) {
          snackbar(e.message, { duration: 8000 });
        }
      }),
      iconButton('delete', t('Delete'), async () => {
        if (!(await confirmDialog({ title: t('Delete this backup?'), message: b.name, confirm: t('Delete'), danger: true }))) return;
        await api.deleteStoredBackup(b.name);
        load();
      })));
    wrap.replaceChildren(
      h('div.settings-group',
        h('div.setting-row', icon('schedule'), h('div.text', h('div', t('Back up automatically')), h('div.s', last)), enabled),
        h('div.setting-row.stack', err,
          h('div.ob-grid2', every, hour),
          h('div.ob-grid2', keep, h('label.check', books, t('Include book files'))),
          folder,
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, save, now))),
      rows.length > 0 && h('div.settings-group', { style: { marginTop: '12px' } }, ...rows),
    );
  }
  load();
  return wrap;
}

const formatUptime = (s) => (s < 3600 ? t('{value} min', { value: Math.max(1, Math.round(s / 60)) }) : s < 86400 ? t('{value} h', { value: Math.round(s / 3600) }) : t('{value} days', { value: Math.round(s / 86400) }));

/**
 * Pick a backup zip, upload it, then choose what to restore. Used in Settings and on the
 * first-run setup page (`setup: true`), where `onDone` takes over afterwards.
 */
export function restoreGroup({ setup = false, onDone } = {}) {
  const input = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
  const bar = h('div.progress', { hidden: true, style: { marginTop: '8px' } }, h('span', { style: { width: '0%' } }));
  const status = h('div.s');
  const pick = button(t('Choose backup file'), { variant: 'tonal', icon: 'upload_file', onclick: () => input.click() });
  const wrap = h('div.settings-group',
    h('div.setting-row', icon('settings_backup_restore'),
      h('div.text', h('div', t('Restore from a backup')), status, bar),
      pick),
    input);
  status.textContent = setup
    ? t('Moving Flyleaf to a new server? Start from a backup made in Settings → Backup & restore.')
    : t('Replaces everything in this Flyleaf with the backup. You’ll need to sign in again afterwards.');

  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    pick.disabled = true;
    bar.hidden = false;
    status.textContent = t('Uploading {name}…', { name: file.name });
    let up;
    try {
      up = await api.uploadBackup(file, (f) => {
        bar.firstChild.style.width = `${Math.round(f * 100)}%`;
        status.textContent = f < 1 ? t('Uploading {name}… {value}%', { name: file.name, value: Math.round(f * 100) }) : t('Checking the backup…');
      }, { setup });
    } catch (e) {
      status.textContent = e.message;
      pick.disabled = false;
      bar.hidden = true;
      return;
    }
    bar.hidden = true;
    pick.disabled = false;
    status.textContent = t('Uploaded – choose what to restore.');
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
    status.textContent = books ? t('Restoring the database and book files… this can take a while.') : t('Restoring the database…');
    try {
      const r = await api.restoreBackup(up.id, books, { setup });
      const extra = r.bookFiles ? t(' and {value} book files', { value: r.bookFiles.toLocaleString() }) : '';
      const fails = r.failed?.length ? t(' Some files couldn’t be written ({value}).', { value: r.failed[0] }) : '';
      if (onDone) return onDone(r);
      await dialog({
        title: t('Backup restored'),
        icon: 'task_alt',
        content: h('p', t('Restored the backup from {created}{extra}.{fails} Sign in with an account from the backup.', { created: created, extra: extra, fails: fails })),
        actions: [{ label: t('Sign in'), variant: 'filled' }],
        dismissible: false,
      });
      location.hash = '#/login';
      location.reload();
    } catch (e) {
      status.textContent = e.message;
    }
  };
  dialog({
    title: t('Restore this backup?'),
    icon: 'settings_backup_restore',
    content: h('div',
      h('p.body-medium', t('Made {created} with Flyleaf {version}{value}.', { created: created, version: m.version, value: m.libraries.length ? plural(m.libraries.length, ' · {length} library', ' · {length} libraries', { length: m.libraries.length }) : '' })),
      h('div.restore-choices',
        choice(false, 'database', t('Database only'), t('Users, progress, stats, settings and covers. Book files on this server stay as they are.')),
        choice(true, 'library_books', t('Database and books'),
          m.includesBooks ? t('Also writes {value} book files back into the library folders, overwriting files with the same name.', { value: m.bookFiles.toLocaleString() }) : t('This backup doesn’t include book files.'),
          !m.includesBooks)),
      !setup && h('p.body-small', { style: { color: 'var(--md-error)', marginTop: '12px' } }, t('Everything in this Flyleaf’s database is replaced. This can’t be undone – download a backup first if you might want it.')),
    ),
    actions: [
      { label: t('Cancel'), onClick: () => {
        if (!setup) api.cancelRestore(up.id).catch(() => {});
        status.textContent = t('Restore cancelled.');
        return true;
      } },
      { label: t('Restore'), variant: 'filled', onClick: async () => {
        if (!setup && !(await confirmDialog({ title: t('Replace everything?'), message: t('Users, progress and settings on this server will be replaced by the backup.'), confirm: t('Restore'), danger: true, icon: 'warning' }))) return false;
        run();
        return true;
      } },
    ],
  });
}
