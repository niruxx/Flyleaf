// Settings: personal panels here; admin panels in settings-admin.js.

import { api, can } from '../api.js';
import { isAdmin, session, navigate } from '../router.js';
import { prefs, setPref, setTheme } from '../prefs.js';
import { THEMES, themeState } from '../theme.js';
import { BG_DEFAULTS } from '../background.js';
import { ACTIONS, DEFAULT_KEYBINDS, keyString, resolveKeybinds } from '../keybinds.js';
import {
  h, icon, iconButton, button, field, formError, snackbar, segmented, toggleSwitch, confirmDialog, formDialog, copyText, timeAgo, loading, AGE_RATINGS,
  avatar, fillAvatar,
} from '../ui.js';
import { trackingSettings } from '../components/tracking-settings.js';
import { readerSettingsForm } from '../components/reader-settings.js';
import { signOut, refreshAvatarInShell, initShell } from '../shell.js';
import { t, plural, N_, languages, currentLanguage, setLanguage } from '../i18n.js';

const PANELS = [
  { group: N_('You') },
  { id: 'account', label: N_('Account'), icon: 'manage_accounts' },
  { id: 'preferences', label: N_('Preferences'), icon: 'tune' },
  { id: 'appearance', label: N_('Themes'), icon: 'palette' },
  { id: 'mylibs', label: N_('My libraries'), icon: 'folder_special', home: true },
  { id: 'notifications', label: N_('Notifications'), icon: 'notifications' },
  { group: N_('Reading') },
  { id: 'reading', label: N_('Reading profiles'), icon: 'chrome_reader_mode' },
  { id: 'keybinds', label: N_('Key binds'), icon: 'keyboard' },
  { id: 'fonts', label: N_('EPUB fonts'), icon: 'font_download' },
  { group: N_('Connections') },
  { id: 'opds', label: N_('OPDS & clients'), icon: 'rss_feed', perm: 'apiAccess' },
  { id: 'api', label: N_('API & webhooks'), icon: 'api', perm: 'apiAccess' },
  { id: 'devices', label: N_('Send-to devices'), icon: 'send_to_mobile', perm: 'download' },
  { id: 'import', label: N_('Import (MAL)'), icon: 'upload_file' },
  { group: N_('Server'), admin: true },
  { id: 'libraries', label: N_('Libraries'), icon: 'folder_managed', admin: true },
  { id: 'users', label: N_('Users'), icon: 'group', admin: true },
  { id: 'activity', label: N_('Activity'), icon: 'history', admin: true },
  { id: 'metadata', label: N_('Metadata sources'), icon: 'travel_explore', admin: true },
  { id: 'plugins', label: N_('Content Finder plugins'), icon: 'extension', admin: true },
  { id: 'server', label: N_('Server & email'), icon: 'dns', admin: true },
  { id: 'backup', label: N_('Backup & restore'), icon: 'backup', admin: true },
];

export async function settingsView(view, params, stale) {
  const panels = PANELS.filter((p) => (!p.admin || isAdmin()) && (!p.perm || can(session.user, p.perm)) && (!p.home || (session.user.homeDir && !isAdmin())));
  const current = params.tab && panels.some((p) => p.id === params.tab) ? params.tab : 'account';
  const nav = h('nav.settings-nav', panels.map((p) =>
    p.group
      ? h('div.group', t(p.group))
      : h('a.nav-item', { href: `#/settings/${p.id}`, 'aria-current': p.id === current ? 'page' : null }, icon(p.icon), h('span.label', t(p.label))),
  ));
  const select = h('select', { 'aria-label': t('Settings section'), onchange: (event) => navigate(`/settings/${event.target.value}`) });
  let optionGroup = select;
  for (const item of panels) {
    if (item.group) { optionGroup = h('optgroup', { label: t(item.group) }); select.append(optionGroup); }
    else optionGroup.append(h('option', { value: item.id, selected: item.id === current }, t(item.label)));
  }
  const mobileNav = h('label.settings-mobile-select', h('span', t('Settings section')), select);
  const panel = h('div.settings-panel.enter');
  const page = h('div.page.settings-page', h('div.page-head', h('div', h('div.page-eyebrow', t('Make yourself at home')), h('h1', t('Settings')), h('p.muted', t('Your account, reading preferences, and connected services.')))), mobileNav, h('div.settings-layout', nav, panel));
  view.append(page);
  requestAnimationFrame(() => nav.querySelector('[aria-current]')?.scrollIntoView({ inline: 'center', block: 'nearest' }));

  const render = {
    account: accountPanel,
    preferences: preferencesPanel,
    appearance: appearancePanel,
    reading: readingPanel,
    keybinds: keybindsPanel,
    fonts: fontsPanel,
    opds: opdsPanel,
    devices: devicesPanel,
    import: importPanel,
  }[current];
  if (render) return render(panel, stale);
  if (current === 'api') return (await import('./settings-api.js')).apiPanel(panel, stale);
  if (current === 'mylibs') return (await import('./settings-mylibs.js')).mylibsPanel(panel, stale);
  if (current === 'plugins') return (await import('./settings-plugins.js')).pluginsPanel(panel, stale);
  if (current === 'notifications') return (await import('./settings-platform.js')).notificationsPanel(panel, stale);
  if (current === 'backup') return (await import('./settings-platform.js')).backupPanel(panel, stale);
  const admin = await import('./settings-admin.js');
  return admin[`${current}Panel`](panel, stale);
}

const row = (ic, title, sub, control, cls = '') => h(`div.setting-row${cls}`, ic && icon(ic), h('div.text', h('div', title), sub && h('div.s', sub)), control);
const group = (...rows) => h('div.settings-group', ...rows);

// ---------------------------------------------------------------------------

async function accountPanel(panel, stale) {
  const u = session.user;
  const username = field(t('Username'), { value: u.username, disabled: !isAdmin(), support: isAdmin() ? null : t('Only the admin can change usernames.') });
  const display = field(t('Display name'), { value: u.displayName });
  const email = field(t('Email'), { value: u.email || '', type: 'email', autocomplete: 'email', support: t('You can sign in with this too.') });
  const err = h('div');
  const save = button(t('Save changes'), { icon: 'check', onclick: async () => {
    err.replaceChildren();
    try {
      const me = await api.updateMe({ username: username.input.value.trim(), displayName: display.input.value, email: email.input.value.trim() });
      Object.assign(session.user, me);
      snackbar(t('Account updated'));
    } catch (e) {
      err.append(formError(e.message));
    }
  } });
  const age = AGE_RATINGS.find((a) => a.value === u.maxAgeRating);

  // Profile picture: shown in the top bar and to the admin.
  const pic = avatar(u, 88);
  const picInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const removePic = button(t('Remove'), { variant: 'text', icon: 'delete', disabled: !u.avatarUrl, onclick: async () => {
    await api.removeAvatar();
    session.user.avatarUrl = null;
    fillAvatar(pic, session.user);
    removePic.disabled = true;
    refreshAvatarInShell();
    snackbar(t('Profile picture removed'));
  } });
  picInput.addEventListener('change', async () => {
    const file = picInput.files[0];
    if (!file) return;
    try {
      const r = await api.uploadAvatar(file);
      session.user.avatarUrl = r.avatarUrl;
      fillAvatar(pic, session.user);
      removePic.disabled = false;
      refreshAvatarInShell();
      snackbar(t('Profile picture updated'));
    } catch (e) {
      snackbar(e.message, { duration: 6000 });
    }
    picInput.value = '';
  });
  const picRow = h('div.setting-row.profile-pic', pic,
    h('div.text', h('div', t('Profile picture')), h('div.s', t('JPEG, PNG, WebP or GIF. It’s cropped to a circle.'))),
    h('div.pic-actions', button(u.avatarUrl ? t('Change') : t('Upload'), { variant: 'tonal', icon: 'add_a_photo', onclick: () => picInput.click() }), removePic),
    picInput);

  panel.append(
    h('h2', t('Account')),
    group(picRow),
    group(h('div.setting-row.stack', err, username, display, email, h('div', save))),
    group(
      h('button.setting-row.state', { type: 'button', onclick: changePassword }, icon('key'), h('div.text', h('div', t('Password')), h('div.s', t('Change your password'))), icon('chevron_right')),
      row('shield_person', t('Age restriction'), u.maxAgeRating == null ? t('No restriction') : t('Up to {value}{value2}{value3}', { value: age?.label, value2: u.ageIncludeUnknown ? t(', including unrated') : t(', unrated hidden'), value3: isAdmin() ? '' : t(' · set by the admin') })),
      row(u.role === 'admin' ? 'admin_panel_settings' : 'person', t('Role'), u.role === 'admin' ? t('Admin – full access') : t('Guest – read-only access to the library')),
      h('button.setting-row.state', { type: 'button', onclick: signOut }, icon('logout'), h('div.text', h('div', t('Sign out'))), icon('chevron_right')),
    ),
  );
  const tracking = h('section');
  panel.append(tracking);
  await trackingSettings(tracking, stale);
}

async function changePassword() {
  const current = field(t('Current password'), { type: 'password', required: true, autocomplete: 'current-password' });
  const next = field(t('New password'), { type: 'password', required: true, autocomplete: 'new-password', support: t('At least 8 characters.') });
  await formDialog({ title: t('Change password'), icon: 'key', fields: [current, next], onSubmit: () => api.changePassword(current.input.value, next.input.value) });
}

// ---------------------------------------------------------------------------

function preferencesPanel(panel) {
  const p = prefs();
  const tog = (key, ic, title, sub) => row(ic, title, sub, toggleSwitch(Boolean(p[key]), (v) => setPref(key, v), title));
  panel.append(
    h('h2', t('Preferences')),
    group(languageRow()),
    group(
      tog('blurUnreadSummaries', 'blur_on', t('Blur unread summaries'), t('Hide series summaries behind a blur until you start reading – no spoilers.')),
      tog('promptOnDownload', 'download', t('Prompt on download'), t('Ask before downloading a book or series to this device.')),
      tog('disableAnimations', 'animation', t('Disable animations'), t('Turn off page transitions, ripples and other motion.')),
      tog('collapseRelationships', 'hub', t('Collapse series relationships'), t('Start the “Related series” section collapsed.')),
      tog('colorScape', 'gradient', t('Use colorscape'), t('Tint each series page with colours taken from its artwork.')),
      tog('dataSaver', 'data_saver_on', t('Data saver mode'), t('Load smaller, compressed page images when reading comics and manga.')),
      tog('blurMature', 'visibility_off', t('Blur adult artwork'), t('Automatically blur covers of series rated Adults only (18+).')),
    ),
  );
  if (can(session.user, 'contentFinder')) finderRecsSection(panel);
}

/** Language of the app: “Automatic” follows the browser. Saved to your account, so it follows you. */
function languageRow() {
  const select = h('select.lang-select', { 'aria-label': t('Language') }, h('option', { value: '' }, t('Automatic (browser)')));
  languages().then((list) => {
    for (const l of list) select.append(h('option', { value: l.code, selected: prefs().language === l.code }, l.name));
  });
  select.addEventListener('change', async () => {
    setPref('language', select.value || null);
    await setLanguage(select.value || (navigator.languages || [navigator.language])[0].split('-')[0]);
    initShell({ again: true });
    navigate('/settings/preferences', { replace: true });
  });
  return row('translate', t('Language'), t('Translations come from the community – untranslated text stays in English.'), select);
}

/** Which Content Finder sources “Discover in Content Finder” searches. */
async function finderRecsSection(panel) {
  let opts = { enabled: true, sources: [], nsfw: false, ...(prefs().finderRecs || {}) };
  const save = (patch) => {
    opts = { ...opts, ...patch };
    setPref('finderRecs', opts);
    sourcesRow.hidden = !opts.enabled;
    nsfwRow.hidden = !opts.enabled || opts.sources.length > 0;
  };
  const chips = h('div.chip-set', loading());
  const sourcesRow = h('div.setting-row.stack',
    h('div.text', h('div', t('Sources to search')), h('div.s', t('None picked: Flyleaf chooses up to four that fit what you read. Fewer sources means faster suggestions.'))),
    chips);
  const nsfwRow = row('explicit', t('Include 18+ sources'), t('When choosing sources automatically.'), toggleSwitch(opts.nsfw, (v) => save({ nsfw: v }), t('Include 18+ sources')));
  panel.append(
    h('div.sub-head', t('Recommendations')),
    group(
      row('travel_explore', t('Suggest from Content Finder'), t('Search your Content Finder sources for creators and genres you like, and show what you don’t have yet on Home.'),
        toggleSwitch(opts.enabled, (v) => save({ enabled: v }), t('Suggest from Content Finder'))),
      sourcesRow,
      nsfwRow,
    ),
    h('p.note', t('Suggestions are refreshed every few hours. Searching other websites is done by this server, not your device.')),
  );
  save({});
  try {
    const sources = (await api.finderSources()).filter((s) => !s.needsSetup && !s.error);
    if (!sources.length) return chips.replaceChildren(h('span.muted', t('No Content Finder sources are ready yet.')));
    chips.replaceChildren(...sources.map((s) => h('button.chip.state', {
      type: 'button',
      'aria-pressed': String(opts.sources.includes(s.id)),
      onclick: (e) => {
        const on = !opts.sources.includes(s.id);
        e.currentTarget.setAttribute('aria-pressed', String(on));
        save({ sources: on ? [...opts.sources, s.id] : opts.sources.filter((x) => x !== s.id) });
      },
    }, s.name, s.nsfw ? ' · 18+' : '')));
  } catch (e) {
    chips.replaceChildren(h('span.muted', e.message));
  }
}

// ---------------------------------------------------------------------------

function appearancePanel(panel) {
  const s = themeState();
  const cards = h('div.theme-grid', THEMES.map((localT) => {
    const prev = `oklch(0.47 ${0.15 * localT.chroma} ${localT.hue})`;
    const cont = `oklch(0.91 ${0.055 * localT.chroma} ${localT.hue})`;
    const tert = `oklch(0.6 ${0.1 * localT.chroma} ${localT.hue + 60})`;
    const surf = localT.oled ? '#000' : `oklch(0.97 ${0.008 * localT.chroma} ${localT.hue})`;
    return h('button.theme-card', {
      type: 'button',
      'aria-pressed': String(s.theme === localT.id),
      onclick: (e) => {
        setTheme({ theme: localT.id });
        for (const c of cards.children) c.setAttribute('aria-pressed', String(c === e.currentTarget));
        modeSeg.setValue(themeState().mode);
        hue.value = localT.hue;
      },
    }, h('div.preview', { style: { background: surf } }, h('span', { style: { background: prev } }), h('span', { style: { background: cont } }), h('span', { style: { background: tert } })), h('span.name', localT.name));
  }));
  const modeSeg = segmented([
    { value: 'light', label: t('Light'), icon: 'light_mode' },
    { value: 'dark', label: t('Dark'), icon: 'dark_mode' },
    { value: 'system', label: t('Auto'), icon: 'brightness_auto' },
  ], s.mode, (v) => setTheme({ mode: v }));
  const hue = h('input.slider', { type: 'range', min: 0, max: 359, value: s.hue, 'aria-label': t('Custom hue') });
  hue.style.background = 'linear-gradient(to right, oklch(0.65 0.15 0), oklch(0.65 0.15 60), oklch(0.65 0.15 120), oklch(0.65 0.15 180), oklch(0.65 0.15 240), oklch(0.65 0.15 300), oklch(0.65 0.15 359))';
  hue.style.borderRadius = '22px';
  hue.addEventListener('input', () => setTheme({ theme: 'custom', hue: Number(hue.value), chroma: 1, oled: false }));
  hue.addEventListener('change', () => {
    for (const c of cards.children) c.setAttribute('aria-pressed', 'false');
  });
  panel.append(
    h('h2', t('Themes')),
    group(row('contrast', t('Mode'), t('Follow your device, or always use light or dark.'), modeSeg, '.wrap')),
    h('div.sub-head', t('Theme')),
    group(cards, h('div.setting-row.stack', h('div.text', h('div', t('Custom colour')), h('div.s', t('Drag to generate a Material You palette from any hue.'))), hue)),
    h('p.note', t('Themes and mode are saved to your account, so they follow you to other devices.')),
    h('div.sub-head', t('Background')),
    backgroundSection(),
  );
}

/** Personal background: an uploaded picture or GIF, or a link to one. */
function backgroundSection() {
  let bg = { ...BG_DEFAULTS, ...(prefs().background || {}) };
  const save = (patch) => {
    bg = { ...bg, ...patch };
    setPref('background', bg.source ? bg : null);
    paint();
  };
  const current = () => (bg.source === 'upload' ? session.user.backgroundUrl : bg.source === 'url' ? bg.url : null);

  const img = h('div.img');
  const tint = h('div.tint');
  const sample = h('div.sample', t('No background'));
  const preview = h('div.bg-preview', img, tint, sample);
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const removeBtn = button(t('Remove'), { variant: 'text', icon: 'delete', onclick: async () => {
    if (session.user.backgroundUrl) await api.removeBackground().catch(() => {});
    session.user.backgroundUrl = null;
    save({ source: null, url: null });
    snackbar(t('Background removed'));
  } });
  const dim = h('input.slider', { type: 'range', min: 0, max: 95, value: bg.dim, 'aria-label': t('Dim') });
  const blur = h('input.slider', { type: 'range', min: 0, max: 30, value: bg.blur, 'aria-label': t('Blur') });
  dim.addEventListener('input', () => save({ dim: Number(dim.value) }));
  blur.addEventListener('input', () => save({ blur: Number(blur.value) }));
  const fit = segmented([
    { value: 'cover', label: t('Fill') },
    { value: 'contain', label: t('Fit') },
    { value: 'tile', label: t('Tile') },
  ], bg.fit, (v) => save({ fit: v }));
  const tuning = group(row('brightness_6', t('Dim'), t('Fade the picture into your theme so text stays readable.'), dim, '.wrap'),
    row('blur_on', t('Blur'), null, blur, '.wrap'), row('fit_screen', t('Size'), null, fit, '.wrap'));

  function paint() {
    const url = current();
    img.style.backgroundImage = url ? `url(${JSON.stringify(url)})` : '';
    img.style.filter = `blur(${(bg.blur || 0) / 3}px)`;
    tint.style.opacity = url ? String(bg.dim / 100) : '0';
    sample.textContent = url ? t('Text stays readable') : t('No background');
    removeBtn.disabled = !url;
    tuning.hidden = !url;
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    snackbar(t('Uploading background…'), { duration: 30000 });
    try {
      const r = await api.uploadBackground(file);
      session.user.backgroundUrl = r.backgroundUrl;
      save({ source: 'upload', url: null });
      snackbar(t('Background updated'));
    } catch (e) {
      snackbar(e.message, { duration: 6000 });
    }
  });
  const fromUrl = async () => {
    const f = field(t('Image URL'), { type: 'url', required: true, value: bg.source === 'url' ? bg.url : '', support: t('A link to a picture or GIF (https://…).') });
    await formDialog({ title: t('Background from a link'), icon: 'link', fields: [f], onSubmit: () => {
      const v = f.input.value.trim();
      if (!/^https?:\/\//i.test(v)) throw new Error(t('Enter a link starting with http:// or https://'));
      save({ source: 'url', url: v });
    } });
  };
  paint();
  return h('div', group(
    h('div.setting-row.stack', preview,
      h('div.bg-actions',
        button(t('Upload picture or GIF'), { variant: 'tonal', icon: 'upload', onclick: () => fileInput.click() }),
        button(t('Use a link'), { variant: 'text', icon: 'link', onclick: fromUrl }),
        removeBtn),
      h('p.bg-hint', t('Only you see your background. Animated GIFs keep moving; large pictures are resized for speed.')),
      fileInput)),
    tuning,
  );
}

// ---------------------------------------------------------------------------

async function readingPanel(panel, stale) {
  panel.append(h('h2', t('Reading profiles')), loading());
  const [{ profiles }, libraries, fonts] = await Promise.all([api.profiles(), api.libraries(), api.fonts()]);
  if (stale()) return;
  panel.lastChild.remove();
  panel.append(
    h('p.note', { style: { margin: '-8px 4px 16px' } }, t('A profile bundles scaling, page splitting, reading direction, layout, background colour, menu behaviour and ebook fonts. Assign profiles to libraries here, or to a single series from its Options menu. Tweaks you make inside the reader are remembered per series.')),
  );
  for (const p of profiles) {
    const settings = { ...p.settings };
    const saveBtn = button(t('Save profile'), { icon: 'save', disabled: true, onclick: async () => {
      await api.updateProfile(p.id, { settings });
      saveBtn.disabled = true;
      snackbar(t('“{name}” saved', { name: p.name }));
    } });
    const form = readerSettingsForm(settings, () => {
      saveBtn.disabled = false;
    }, { show: 'all', fonts });
    const libChecks = libraries.map((l) => {
      const input = h('input', { type: 'checkbox', checked: p.libraries.includes(l.id) });
      input.addEventListener('change', async () => {
        const ids = libChecks.filter((c) => c.querySelector('input').checked).map((c) => Number(c.dataset.id));
        await api.updateProfile(p.id, { libraries: ids });
        snackbar(t('Library assignment saved'));
      });
      const label = h('label.check', { dataset: { id: String(l.id) } }, input, l.name);
      return label;
    });
    const details = h('details.settings-group', { open: profiles.length === 1 },
      h('summary.setting-row.state', { style: { cursor: 'pointer', listStyle: 'none' } },
        icon(p.isDefault ? 'star' : 'chrome_reader_mode'),
        h('div.text', h('div', p.name), h('div.s', p.isDefault ? t('Default for everything without another profile') : p.libraries.length ? plural(p.libraries.length, 'Used by {length} library', 'Used by {length} libraries', { length: p.libraries.length }) : t('Not assigned'))),
        icon('expand_more')),
      !p.isDefault && libraries.length > 0 && h('div.sheet-section', h('h3', t('Use for libraries')), h('div.check-grid', libChecks)),
      form,
      h('div.sheet-footer',
        saveBtn,
        !p.isDefault && button(t('Rename'), { variant: 'text', onclick: async () => {
          const name = field(t('Name'), { value: p.name, required: true });
          await formDialog({ title: t('Rename profile'), fields: [name], onSubmit: () => api.updateProfile(p.id, { name: name.input.value }) });
          navigate('/settings/reading', { replace: true });
        } }),
        !p.isDefault && button(t('Delete'), { variant: 'text danger', onclick: async () => {
          if (!(await confirmDialog({ title: t('Delete “{name}”?', { name: p.name }), message: t('Libraries using it will fall back to the default profile.'), confirm: t('Delete'), danger: true }))) return;
          await api.deleteProfile(p.id);
          navigate('/settings/reading', { replace: true });
        } }),
      ),
    );
    panel.append(details);
  }
  panel.append(h('div', { style: { marginTop: '16px' } }, button(t('New profile'), { variant: 'tonal', icon: 'add', onclick: async () => {
    const name = field(t('Profile name'), { required: true, support: t('e.g. “Manga on phone”, “Webtoons”, “Night reading”') });
    await formDialog({ title: t('New reading profile'), fields: [name], submit: t('Create'), onSubmit: () => api.createProfile({ name: name.input.value }) });
    navigate('/settings/reading', { replace: true });
  } })));
}

// ---------------------------------------------------------------------------

function keybindsPanel(panel) {
  let binds = resolveKeybinds(prefs().keybinds);
  const save = () => setPref('keybinds', binds);
  const table = group();
  const renderRows = () => {
    table.replaceChildren(...ACTIONS.map((a) => {
      const keys = h('div.keys');
      const draw = () => keys.replaceChildren(
        ...binds[a.id].map((k, i) => h('span.kbd', k, h('button', { type: 'button', 'aria-label': t('Remove {k}', { k: k }), onclick: () => {
          binds = { ...binds, [a.id]: binds[a.id].filter((_, j) => j !== i) };
          save();
          draw();
        } }, icon('close')))),
        iconButton('add', t('Add key'), () => {
          const listen = h('span.kbd.listening', t('Press a key…'));
          keys.lastChild.replaceWith(listen);
          const onKey = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const k = keyString(e);
            if (!k) return;
            removeEventListener('keydown', onKey, true);
            if (k !== 'Escape' || a.id === 'close') {
              // A key can only do one thing.
              for (const id of Object.keys(binds)) binds[id] = binds[id].filter((x) => x !== k);
              binds = { ...binds, [a.id]: [...binds[a.id], k] };
              save();
            }
            renderRows();
          };
          addEventListener('keydown', onKey, true);
        }),
      );
      draw();
      return h('div.setting-row.wrap', h('div.text', h('div', a.label), a.hint && h('div.s', a.hint)), keys);
    }));
  };
  renderRows();
  panel.append(
    h('h2', t('Key binds')),
    h('p.note', { style: { margin: '-8px 4px 16px' } }, t('Keyboard shortcuts for the reader. Click + and press a key to add it.')),
    table,
    h('div', { style: { marginTop: '16px' } }, button(t('Reset to defaults'), { variant: 'text', icon: 'restart_alt', onclick: () => {
      binds = { ...DEFAULT_KEYBINDS };
      save();
      renderRows();
      snackbar(t('Key binds reset'));
    } })),
  );
}

// ---------------------------------------------------------------------------

async function fontsPanel(panel, stale) {
  panel.append(h('h2', t('EPUB fonts')), loading());
  const fonts = await api.fonts();
  if (stale()) return;
  panel.lastChild.remove();
  let enabled = prefs().enabledFonts;
  const isOn = (id) => !enabled || enabled.includes(id);
  // Load font stylesheets for previews.
  for (const f of fonts) {
    if (f.css && !document.querySelector(`link[href="${f.css}"]`)) document.head.append(h('link', { rel: 'stylesheet', href: f.css }));
    if (f.url && !document.getElementById(`ff-${f.id}`)) document.head.append(h('style', { id: `ff-${f.id}` }, `@font-face{font-family:"${f.family}";src:url("${f.url}")}`));
  }
  const fontRow = (f) =>
    row(null, f.name, f.custom ? (f.own ? t('Yours') : t('Shared by the admin')) : null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
        h('span.muted', { style: { fontFamily: f.family || 'inherit', fontSize: '17px', whiteSpace: 'nowrap' } }, t('Aa Bb Cc 123')),
        f.canDelete && iconButton('delete', t('Delete {name}', { name: f.name }), async () => {
          if (!(await confirmDialog({ title: t('Delete {name}?', { name: f.name }), message: f.shared ? t('Everyone using it will fall back to the publisher font.') : t('Books using it will fall back to the publisher font.'), confirm: t('Delete'), danger: true }))) return;
          await api.deleteFont(f.id.replace('custom-', ''));
          navigate('/settings/fonts', { replace: true });
        }),
        f.id !== 'publisher' && toggleSwitch(isOn(f.id), (v) => {
          const all = fonts.map((x) => x.id);
          const current = enabled || all;
          enabled = v ? [...new Set([...current, f.id])] : current.filter((x) => x !== f.id);
          setPref('enabledFonts', enabled);
        }, t('Use {name}', { name: f.name })),
      ),
    );
  const upload = button(t('Upload a font'), { variant: 'tonal', icon: 'upload', onclick: () => {
    const input = h('input', { type: 'file', accept: '.woff2,.woff,.ttf,.otf', multiple: true });
    input.addEventListener('change', async () => {
      const files = [...input.files];
      if (!files.length) return;
      const nice = (file) => file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
      const name = files.length === 1 && field(t('Font name'), { value: nice(files[0]), required: true });
      const share = h('input', { type: 'checkbox', checked: true });
      await formDialog({
        title: files.length === 1 ? t('Add font') : t('Add {length} fonts', { length: files.length }),
        icon: 'font_download',
        fields: [
          name || h('p.body-medium', files.map(nice).join(', ')),
          isAdmin() && h('label.check', share, t('Share with everyone (otherwise only you see it)')),
        ],
        submit: t('Upload'),
        onSubmit: async () => {
          for (const file of files) {
            const r = await api.uploadFont(name ? name.input.value : nice(file), file, { private: isAdmin() ? !share.checked : true });
            // With a hand-picked font list, a new font would otherwise stay hidden from the reader.
            if (enabled) {
              enabled = [...enabled, `custom-${r.id}`];
              setPref('enabledFonts', enabled);
            }
          }
        },
      });
      navigate('/settings/fonts', { replace: true });
    });
    input.click();
  } });
  const bundled = fonts.filter((f) => !f.custom);
  const mine = fonts.filter((f) => f.custom && f.own);
  const shared = fonts.filter((f) => f.custom && !f.own);
  panel.append(...[
    h('p.note', { style: { margin: '-8px 4px 16px' } }, t('Choose which fonts appear in the ebook reader’s font menu.')),
    mine.length > 0 && h('div.sub-head', t('Your fonts')),
    mine.length > 0 && group(...mine.map(fontRow)),
    shared.length > 0 && h('div.sub-head', t('Shared fonts')),
    shared.length > 0 && group(...shared.map(fontRow)),
    h('div.sub-head', t('Bundled fonts')),
    group(...bundled.map(fontRow)),
    h('div', { style: { marginTop: '16px' } }, upload,
      h('p.note', isAdmin()
        ? t('Add .woff2, .woff, .ttf or .otf fonts – for everyone, or just for you.')
        : t('Add your own .woff2, .woff, .ttf or .otf fonts. Only you see them.'))),
  ].filter(Boolean));
}

// ---------------------------------------------------------------------------

async function opdsPanel(panel, stale) {
  panel.append(h('h2', t('OPDS & third-party clients')), loading());
  const [keys, server] = await Promise.all([api.apiKeys(), isAdmin() ? api.adminSettings().catch(() => null) : null]);
  if (stale()) return;
  panel.lastChild.remove();
  const base = (server?.publicUrl || location.origin).replace(/\/+$/, '');
  const p = prefs();
  const opdsUrl = (k) => `${base}/api/opds/${k}`;

  const keyRows = keys.map((k) =>
    h('div.setting-row.stack',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        icon('key'),
        h('div.text', h('div', k.name), h('div.s', t('Created {value} · last used {value2}', { value: timeAgo(k.createdAt), value2: timeAgo(k.lastUsedAt) }))),
        iconButton('autorenew', t('Regenerate key'), async () => {
          if (!(await confirmDialog({ title: t('Regenerate this key?'), message: t('Apps using the old OPDS URL will stop working until you update them.'), confirm: t('Regenerate') }))) return;
          await api.regenerateApiKey(k.id);
          navigate('/settings/opds', { replace: true });
        }),
        iconButton('delete', t('Delete key'), async () => {
          if (!(await confirmDialog({ title: t('Delete “{name}”?', { name: k.name }), message: t('Apps using it will lose access.'), confirm: t('Delete'), danger: true }))) return;
          await api.deleteApiKey(k.id);
          navigate('/settings/opds', { replace: true });
        }),
      ),
      h('div.label-medium.muted', t('OPDS URL')),
      h('div.copy-field', h('span.mono', opdsUrl(k.key)), iconButton('content_copy', t('Copy OPDS URL'), () => copyText(opdsUrl(k.key)))),
      h('div.label-medium.muted', t('Auth key')),
      h('div.copy-field', h('span.mono', k.key), iconButton('content_copy', t('Copy key'), () => copyText(k.key))),
    ),
  );

  panel.append(
    h('div.sub-head', t('OPDS settings')),
    group(
      row('donut_large', t('Embed progress indicator'), t('Show ◔ 40% / ✓ in titles so you can see progress in your reading app.'), toggleSwitch(p.opdsEmbedProgress, (v) => setPref('opdsEmbedProgress', v), t('Embed progress indicator'))),
      row('play_circle', t('Include “Continue from” entry'), t('Put a “Continue reading: Vol. 3” entry at the top of each series feed.'), toggleSwitch(p.opdsContinueFrom, (v) => setPref('opdsContinueFrom', v), t('Include continue from entry'))),
    ),
    h('div.sub-head', t('Auth keys & OPDS URL')),
    keys.length ? group(...keyRows) : h('p.note', t('You don’t have an auth key yet. Create one to connect a reading app.')),
    h('div', { style: { marginTop: '12px' } }, button(t('Create auth key'), { variant: 'tonal', icon: 'add', onclick: async () => {
      const name = field(t('Name'), { value: 'My reading app', required: true, support: t('e.g. “Panels on iPad”, “KOReader”') });
      await formDialog({ title: t('New auth key'), fields: [name], submit: t('Create'), onSubmit: () => api.createApiKey(name.input.value) });
      navigate('/settings/opds', { replace: true });
    } })),
    h('div.sub-head', t('3rd-party clients')),
    group(
      row('phone_iphone', t('Panels, Chunky, KyBook (iPhone / iPad)'), t('Add an OPDS catalog and paste the OPDS URL. Comics stream page-by-page and your progress syncs back to Flyleaf.')),
      row('tablet_android', t('KOReader, Moon+ Reader, Librera (Android / e-ink)'), t('Add a catalog / network library with the OPDS URL. Leave username and password empty – the key is in the URL.')),
      row('desktop_windows', t('Thorium, Calibre and others'), t('Any OPDS 1.2 client works. Search is supported.')),
    ),
    h('p.note', server ? t('URLs use {base}. Set a public URL in Settings → Server if you reach Flyleaf through a domain or reverse proxy.', { base: base }) : t('Treat the OPDS URL like a password – anyone with it can browse and download your library.')),
  );
}

// ---------------------------------------------------------------------------

async function devicesPanel(panel, stale) {
  panel.append(h('h2', t('Send-to devices')), loading());
  const { devices, emailConfigured } = await api.devices();
  if (stale()) return;
  panel.lastChild.remove();
  const PLATFORM = { kindle: t('Kindle'), kobo: t('Kobo'), pocketbook: t('PocketBook'), other: t('Other e-reader') };
  panel.append(
    h('p.note', { style: { margin: '-8px 4px 16px' } }, t('Books are emailed to these addresses with “Send to…”. For Kindle, add the server’s From address to your Amazon “Approved Personal Document E-mail List”.')),
    emailConfigured ? '' : h('div.form-error', { style: { marginBottom: '16px' } }, icon('info'), h('span', isAdmin() ? t('Email isn’t set up yet – add SMTP details in Server & email.') : t('The admin needs to set up email before books can be sent.'))),
    devices.length
      ? group(...devices.map((d) => row(d.platform === 'kindle' ? 'tablet_android' : 'tablet', d.name, `${PLATFORM[d.platform]} · ${d.email}`, iconButton('delete', t('Remove {name}', { name: d.name }), async () => {
          await api.deleteDevice(d.id);
          navigate('/settings/devices', { replace: true });
        }))))
      : h('p.note', t('No devices yet.')),
    h('div', { style: { marginTop: '12px' } }, button(t('Add device'), { variant: 'tonal', icon: 'add', onclick: async () => {
      const name = field(t('Device name'), { required: true, value: 'My Kindle' });
      const email = field(t('Device email address'), { type: 'email', required: true, support: t('e.g. yourname_abc@kindle.com') });
      const platform = field(t('Type'), { value: 'kindle', options: Object.entries(PLATFORM).map(([value, label]) => ({ value, label })) });
      await formDialog({ title: t('Add device'), icon: 'send_to_mobile', fields: [name, email, platform], submit: t('Add'), onSubmit: () => api.addDevice({ name: name.input.value, email: email.input.value, platform: platform.input.value }) });
      navigate('/settings/devices', { replace: true });
    } })),
  );
}

// ---------------------------------------------------------------------------

function importPanel(panel) {
  const stackUrl = field(t('MyAnimeList stack URL'), { type: 'url', support: t('e.g. https://myanimelist.net/stacks/12345') });
  const out = h('div');
  const result = (r) => {
    out.replaceChildren(
      h('div.card.filled', { style: { padding: '16px', marginTop: '12px', borderRadius: 'var(--shape-lg)' } },
        h('div.title-medium', t('Matched {matched} of {total}', { matched: r.matched, total: r.total })),
        r.collectionId && h('a.btn.text.state', { href: `#/collection/${r.collectionId}`, style: { marginLeft: '-12px' } }, t('Open “{name}”', { name: r.name }), icon('chevron_right')),
        r.unmatched?.length > 0 && h('details', h('summary.body-medium', t('{length} not in your library', { length: r.unmatched.length })), h('p.body-small.muted', r.unmatched.join(' · '))),
      ),
    );
  };
  panel.append(
    h('h2', t('Import from MyAnimeList')),
    h('div.sub-head', t('MAL Stack import')),
    group(h('div.setting-row.stack',
      h('div.s.muted', t('Turns a public MyAnimeList interest stack into a collection, matching titles against your library.')),
      stackUrl,
      h('div', button(t('Import stack'), { icon: 'playlist_add', onclick: async (e) => {
        e.currentTarget.disabled = true;
        out.replaceChildren(loading());
        try {
          result(await api.importMalStack(stackUrl.input.value.trim()));
        } catch (err) {
          out.replaceChildren(formError(err.message));
        } finally {
          e.target.closest('button').disabled = false;
        }
      } })),
    )),
    h('div.sub-head', t('MAL list export')),
    group(h('div.setting-row.stack',
      h('div.s.muted', t('Upload your manga list export (myanimelist.net → Profile → Export → Manga List). Statuses are copied, and “Plan to Read” is added to Want to read.')),
      h('div', button(t('Choose export file'), { variant: 'tonal', icon: 'upload_file', onclick: () => {
        const input = h('input', { type: 'file', accept: '.xml,.gz,application/xml,application/gzip' });
        input.addEventListener('change', async () => {
          if (!input.files[0]) return;
          out.replaceChildren(loading());
          try {
            result(await api.importMalList(input.files[0]));
          } catch (err) {
            out.replaceChildren(formError(err.message));
          }
        });
        input.click();
      } })),
    )),
    out,
  );
}

