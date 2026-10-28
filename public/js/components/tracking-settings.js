import { api } from '../api.js';
import { h, button, field, formDialog, confirmDialog, toggleSwitch, snackbar, loading, timeAgo } from '../ui.js';
import { t, plural } from '../i18n.js';

export async function trackingSettings(host, stale = () => false) {
  const note = h('p.note', t('When you finish a matched book, Flyleaf updates your chapter or volume progress and Reading / Completed status on connected services. Remote progress is never reduced.'));
  host.replaceChildren(h('h3', t('Tracking accounts')), note, loading());
  const result = new URLSearchParams(location.hash.split('?')[1] || '').get('tracking');
  if (result) {
    snackbar(result === 'connected' ? t('Tracking account connected') : t('Could not authorize the tracking account. Try connecting again.'));
    history.replaceState(null, '', '#/settings/account');
  }
  async function draw() {
    try {
      const accounts = await api.trackingAccounts();
      if (stale() || !host.isConnected) return;
      host.replaceChildren(h('div.row', h('h3', t('Tracking accounts')), button(t('Refresh'), { variant: 'text', icon: 'refresh', onclick: (e) => act(e, async () => {}) })), note, ...accounts.map(card));
    } catch (err) {
      if (!stale() && host.isConnected) host.replaceChildren(h('p.form-error', err.message), button(t('Try again'), { onclick: draw }));
    }
  }
  async function act(event, fn) {
    const control = event.currentTarget;
    control.disabled = true;
    try { await fn(); await draw(); }
    catch (err) { snackbar(err.message); }
    finally { control.disabled = false; }
  }
  async function connect(account) {
    if (account.auth === 'oauth') {
      const { url } = await api.connectTracking(account.provider);
      location.assign(url);
      return;
    }
    const username = field(account.provider === 'kitsu' ? t('Email or username') : t('Username'), { required: true, autocomplete: 'username' });
    const password = field(t('Password'), { type: 'password', required: true, autocomplete: 'current-password' });
    await formDialog({ title: t('Connect {service}', { service: account.name }), icon: 'link',
      fields: [h('p.note', t('Your credentials are sent to this service to obtain an access token. Flyleaf does not save your password.')), username, password],
      submit: t('Connect'), onSubmit: async () => {
        try { await api.loginTracking(account.provider, { username: username.input.value.trim(), password: password.input.value }); }
        finally { password.input.value = ''; }
      } });
  }
  function card(a) {
    const controls = a.connected ? [
      button(t('Import score and status'), { variant: 'text', icon: 'sync', onclick: (e) => act(e, async () => {
        if (!await confirmDialog({ title: t('Import from {service}?', { service: a.name }),
          message: t('Replace your local ratings and reading statuses for matched series with values from this service? Book progress and written reviews are kept.'), confirm: t('Import') })) return;
        const r = await api.pullTracking(a.provider);
        snackbar(plural(r.queued, 'Queued {n} series for import', 'Queued {n} series for import'));
      }) }),
      button(t('Disconnect'), { variant: 'text', icon: 'link_off', onclick: (e) => act(e, async () => {
        if (await confirmDialog({ title: t('Disconnect {service}?', { service: a.name }), message: t('Pending syncs are cancelled. Existing tracker entries and local reading progress are kept.'), confirm: t('Disconnect') })) await api.disconnectTracking(a.provider);
      }) }),
    ] : [];
    // Reconnecting is also available when a token has expired or been revoked.
    controls.unshift(button(a.connected ? t('Reconnect') : t('Connect'), { variant: a.connected ? 'text' : 'tonal', disabled: !a.configured,
      onclick: (e) => act(e, () => connect(a)) }));
    const toggle = a.connected && toggleSwitch(a.pullEnabled, async (enabled) => {
      try { await api.updateTracking(a.provider, { pullEnabled: enabled }); }
      catch (err) { snackbar(err.message); }
      await draw();
    }, t('Import score and status after sync'));
    return h('div.settings-group', h('div.setting-row.stack',
      h('div.title-medium', a.name),
      h('div.body-small.muted', a.connected ? t('Connected as {name}', { name: a.username })
        : a.configured ? t('Not connected') : t('The server admin needs to configure the OAuth application first.')),
      a.provider === 'kitsu' && h('p.body-small.muted', t('Kitsu tracks chapters. Its volumes-owned field is kept unchanged.')),
      a.lastSyncAt && h('div.body-small.muted', t('Last sync: {time}', { time: timeAgo(a.lastSyncAt) })),
      a.pending > 0 && h('div.body-small.muted', plural(a.pending, '{n} series waiting to sync', '{n} series waiting to sync')),
      a.lastError && h('div.form-error', a.lastError),
      a.connected && h('label.check', toggle, t('Import score and status after sync')),
      h('div.row', { style: { flexWrap: 'wrap' } }, controls)));
  }
  await draw();
}
