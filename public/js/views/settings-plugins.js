import { t, plural } from '../i18n.js';
// Settings → Content Finder plugins (admin): installed sources, repositories,
// and installing plugins from a repository, a URL or a .lua file.

import { api } from '../api.js';
import { navigate } from '../router.js';
import { h, icon, iconButton, button, field, snackbar, confirmDialog, formDialog, dialog, loading, toggleSwitch, menu, setButtonLabel, formatBytes } from '../ui.js';

const group = (...rows) => h('div.settings-group', ...rows);
// Refresh the panel – unless the user has already gone elsewhere (closing a dialog also runs this).
const reload = () => location.hash.startsWith('#/settings/plugins') && navigate('/settings/plugins', { replace: true });
const KIND_LABEL = { get books() { return t('Books'); }, get manga() { return t('Manga'); }, get comics() { return t('Comics'); } };

function pluginIcon(p) {
  const fallback = h('span.plugin-icon', icon('extension'));
  if (!p.icon) return fallback;
  const img = h('img.plugin-icon', { src: p.icon, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(fallback));
  return img;
}

export async function pluginsPanel(panel, stale) {
  panel.append(h('h2', t('Content Finder plugins')), loading());
  const { installed, repos } = await api.plugins();
  if (stale()) return;
  panel.lastChild.remove();

  const catalogBox = h('div', loading());
  panel.append(
    h('p.note', { style: { margin: '-8px 4px 16px' } },
      t('Plugins are small Lua scripts that teach Content Finder how to search a website and download from it. They run in a sandbox with no access to your files. Only install plugins for sources you’re allowed to download from.')),
    h('div.sub-head', t('Mihon & Tachiyomi extensions')),
    runtimeCard(stale),
    h('div.sub-head', t('Installed ({length})', { length: installed.length })),
    installed.length ? group(...installed.map(installedRow)) : h('p.note', t('No plugins installed.')),
    h('div', { style: { marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      button(t('Install from URL'), { variant: 'tonal', icon: 'link', onclick: installFromUrl }),
      button(t('Upload .lua file'), { variant: 'tonal', icon: 'upload_file', onclick: installFromFile }),
      h('a.btn.text.state', { href: 'https://github.com/niruxx/Flyleaf/blob/main/docs/plugins.md', target: '_blank', rel: 'noopener' }, icon('menu_book'), t('Write your own')),
    ),
    h('div.sub-head', t('Available from repositories')),
    catalogBox,
    h('div.sub-head', t('Repositories')),
    group(...repos.map((r) => h('div.setting-row',
      icon(r.builtin ? 'verified' : 'cloud'),
      h('div.text', h('div', r.name || r.url), h('div.s', r.builtin ? t('Ships with Flyleaf') : r.url)),
      !r.builtin && iconButton('delete', t('Remove repository'), async () => {
        if (!(await confirmDialog({ title: t('Remove this repository?'), message: t('Plugins you installed from it stay installed.'), confirm: t('Remove'), danger: true }))) return;
        await api.removePluginRepo(r.id);
        reload();
      }),
    ))),
    h('div', { style: { marginTop: '12px' } }, button(t('Add repository'), { variant: 'tonal', icon: 'add_link', onclick: addRepo })),
    h('p.note', t('A repository is a URL to an index.json that lists plugins – the same idea as Mihon/Tachiyomi extension repos. See docs/plugins.md for the format.')),
  );

  api.pluginCatalog().then(({ plugins, errors }) => {
    if (stale()) return;
    const notInstalled = plugins.filter((p) => !p.installed || p.update);
    catalogBox.replaceChildren(
      ...errors.map((e) => h('div.form-error', icon('error'), `${e.name}: ${e.error}`)),
      notInstalled.length
        ? group(...notInstalled.map((p) => h('div.setting-row',
          pluginIcon(p),
          h('div.text', h('div', p.name, ' ', h('span.mini-chip', p.version || '?')), h('div.s', [p.description, p.repoName].filter(Boolean).join(' · '))),
          button(p.update ? t('Update to {version}', { version: p.version }) : t('Install'), { variant: p.update ? 'filled' : 'tonal', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await api.installPlugin({ id: p.id, repo: p.repo });
              snackbar(`${p.name} ${p.update ? 'updated' : 'installed'}`);
              reload();
            } catch (err) {
              snackbar(err.message, { duration: 6000 });
              e.currentTarget.disabled = false;
            }
          } }),
        )))
        : h('p.note', t('Everything from your repositories is installed and up to date.')),
    );
  }).catch((e) => catalogBox.replaceChildren(h('div.form-error', icon('error'), e.message)));
}

// ---------------------------------------------------------------------------
// The built-in extension runtime: Suwayomi-Server, downloaded and run by Flyleaf.

const PHASE = { get running() { return t('Running'); }, get starting() { return t('Starting'); }, get stopping() { return t('Stopping'); }, get stopped() { return t('Stopped'); } };

function runtimeCard(stale) {
  const box = h('div', loading());
  let timer = null;
  async function draw() {
    clearTimeout(timer);
    if (stale() || (box.dataset.drawn && !box.isConnected)) return;
    let st;
    try {
      st = await api.extRuntime();
    } catch (e) {
      box.replaceChildren(h('div.form-error', icon('error'), e.message));
      return;
    }
    if (stale()) return;
    box.dataset.drawn = '1';
    box.replaceChildren(...runtimeView(st, draw).filter(Boolean));
    // Keep the card live while something is happening.
    if (['installing', 'starting', 'stopping'].includes(st.phase)) timer = setTimeout(draw, 1500);
  }
  draw();
  return box;
}

function runtimeView(st, redraw) {
  const act = (fn, done) => async () => {
    try {
      await fn();
      if (done) snackbar(done);
    } catch (e) {
      snackbar(e.message, { duration: 7000 });
    }
    redraw();
  };
  const error = st.error && h('div.form-error', { style: { marginTop: '8px' } }, icon('error'), st.error);

  if (st.phase === 'absent') {
    return [
      group(h('div.setting-row', icon('extension'),
        h('div.text', h('div', t('Extension runtime')),
          h('div.s', t('Use Mihon and Tachiyomi extensions, including old APKs, as Content Finder sources.'))),
        button(t('Set up'), { icon: 'download', onclick: act(() => api.installExtRuntime()) }))),
      error,
      h('p.note', t('Flyleaf downloads, runs and updates Suwayomi-Server and Java for you: about 230 MB to download, 340 MB on disk, and around 500 MB of memory while it runs. Already have your own Suwayomi-Server? Install the “Mihon extensions” plugin below and point it at that instead.')),
    ];
  }

  if (st.phase === 'installing') {
    const pct = st.total ? Math.min(100, Math.round((st.received / st.total) * 100)) : null;
    return [group(h('div.setting-row', icon('downloading'),
      h('div.text', h('div', st.step || t('Setting up…')),
        h('div.s', st.received ? t('{value}{value2}', { value: formatBytes(st.received), value2: st.total ? t(' of {value}', { value: formatBytes(st.total) }) : '' }) : t('This only happens once.')),
        h(`div.progress${pct == null ? '.indeterminate' : ''}`, { style: { marginTop: '8px' } }, h('span', { style: pct == null ? {} : { width: `${pct}%` } }))),
    ))];
  }

  const running = st.phase === 'running';
  const busy = st.phase === 'starting' || st.phase === 'stopping';
  const more = iconButton('more_vert', t('Runtime options'), () => menu(more, [
    running && { label: t('Restart'), icon: 'restart_alt', onClick: act(() => api.restartExtRuntime(), t('Extension runtime restarted')) },
    { label: t('Check for updates'), icon: 'system_update', onClick: act(async () => {
      const u = await api.extRuntimeUpdate(true);
      if (!u.update) return snackbar(t('Up to date ({current})', { current: u.current }));
      if (await confirmDialog({ title: t('Update to {latest}?', { latest: u.latest }), message: t('Suwayomi-Server {latest} is available (you have {current}). Extensions keep working; the runtime restarts once it’s downloaded.', { latest: u.latest, current: u.current }), confirm: t('Update'), icon: 'system_update' })) await api.installExtRuntime();
    }) },
    { label: t('Memory limit…'), icon: 'memory', onClick: () => memoryDialog(st).then(redraw) },
    { label: t('View log'), icon: 'article', onClick: () => runtimeLog() },
    '-',
    { label: t('Remove…'), icon: 'delete', onClick: () => removeRuntime().then(redraw) },
  ]));
  return [
    group(h('div.setting-row', icon('extension'),
      h('div.text',
        h('div', t('Extension runtime '), h('span.mini-chip', PHASE[st.phase] || st.phase)),
        h('div.s', st.phase === 'starting'
          ? t('Starting… the first start can take a minute.')
          : [`Suwayomi-Server ${st.version || ''}`.trim(), st.java && t('Java {value}', { value: st.java.replace(/^jdk-?/, '') }), running && t('only reachable from this server')].filter(Boolean).join(' · ')),
        busy && h('div.progress.indeterminate', { style: { marginTop: '8px' } }, h('span'))),
      toggleSwitch(st.enabled && st.phase !== 'stopped', async (v) => {
        await act(() => (v ? api.startExtRuntime() : api.stopExtRuntime()), v ? t('Starting the extension runtime…') : t('Extension runtime stopped'))();
      }, t('Run the extension runtime')),
      more)),
    error,
    running && h('div', { style: { marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      button(t('Extensions'), { variant: 'tonal', icon: 'extension', onclick: () => mihonDialog() }),
      button(t('Install APK'), { variant: 'tonal', icon: 'install_mobile', onclick: () => pickApks(redraw) })),
    !st.enabled && h('p.note', t('Turned off: it won’t start with Flyleaf, and its sources are unavailable until you turn it back on.')),
  ];
}

/** Pick one or more extension .apk files and install them. */
function pickApks(onDone) {
  const input = h('input', { type: 'file', accept: '.apk,application/vnd.android.package-archive', multiple: true });
  input.addEventListener('change', async () => {
    const files = [...input.files];
    if (!files.length) return;
    const done = [];
    const failed = [];
    for (const [i, file] of files.entries()) {
      snackbar(files.length > 1 ? t('Installing {value} of {length}: {name}…', { value: i + 1, length: files.length, name: file.name }) : t('Installing {name}…', { name: file.name }));
      try {
        const r = await api.installMihonApk(file);
        const what = `${r.name} ${r.version || ''}`.trim();
        done.push(r.already ? (r.newer ? t('A newer {name} ({version}) is already installed', { name: r.name, version: r.version }) : t('{what} is already installed', { what: what })) : r.updated ? t('Updated {what}', { what: what }) : t('Installed {what}', { what: what }));
      } catch (e) {
        failed.push({ file, message: e.message });
      }
    }
    if (failed.length) {
      dialog({
        title: done.length ? t('Some extensions weren’t installed') : t('Extension not installed'),
        icon: 'error',
        content: h('div',
          done.length && h('p', { style: { marginBottom: '8px' } }, `${done.join('. ')}.`),
          failed.map((f) => h('p', { style: { marginBottom: '8px' } }, h('b', f.file.name), h('br'), f.message))),
        actions: [{ label: t('Close') }],
      });
    } else snackbar(`${done.join('. ')}.`, { duration: 6000 });
    if (done.length) onDone?.();
  });
  input.click();
}

async function memoryDialog(st) {
  const limit = field(t('Memory limit'), {
    value: st.heapMb ?? '',
    options: [{ value: '', label: t('Automatic (Java decides)') }, ...[512, 1024, 2048, 4096].map((v) => ({ value: v, label: `${v >= 1024 ? `${v / 1024} GB` : `${v} MB`}` }))],
    support: t('Most setups are fine with 512 MB–1 GB. Changing it restarts the runtime.'),
  });
  await formDialog({ title: t('Extension runtime memory'), icon: 'memory', fields: [limit], onSubmit: () => api.configureExtRuntime({ heapMb: limit.input.value ? Number(limit.input.value) : null }) });
}

async function runtimeLog() {
  const pre = h('pre.source-view', t('Loading…'));
  const load = async () => {
    pre.textContent = (await api.extRuntimeLog().catch((e) => e.message)) || t('Nothing logged yet.');
    pre.scrollTop = pre.scrollHeight;
  };
  load();
  await dialog({ title: t('Extension runtime log'), icon: 'article', className: 'wide', content: pre, actions: [{ label: t('Refresh'), onClick: () => {
    load();
    return false;
  } }, { label: t('Close') }] });
}

async function removeRuntime() {
  const keep = h('input', { type: 'checkbox', checked: true });
  const ok = await dialog({
    title: t('Remove the extension runtime?'),
    icon: 'delete',
    content: h('div',
      h('p', { style: { marginBottom: '12px' } }, t('Flyleaf stops it and deletes Suwayomi-Server and Java. Books you already downloaded stay in your libraries.')),
      h('label.check', keep, t('Keep installed extensions for when I set it up again'))),
    actions: [{ label: t('Cancel'), value: false }, { label: t('Remove'), value: true, variant: 'text danger' }],
  });
  if (!ok) return;
  try {
    await api.removeExtRuntime(keep.checked);
    snackbar(t('Extension runtime removed'));
  } catch (e) {
    snackbar(e.message, { duration: 7000 });
  }
}

function installedRow(p) {
  const more = iconButton('more_vert', t('Plugin options'), () => menu(more, [
    p.settings?.length && { label: t('Settings'), icon: 'tune', onClick: () => settingsDialog(p) },
    p.origin && { label: t('Check for update'), icon: 'system_update', onClick: async () => {
      try {
        const r = await api.updatePlugin(p.id);
        snackbar(r.version === p.version ? t('Already up to date') : t('Updated to {version}', { version: r.version }));
        reload();
      } catch (e) {
        snackbar(e.message, { duration: 6000 });
      }
    } },
    { label: t('View source'), icon: 'code', onClick: () => viewSource(p) },
    '-',
    { label: t('Uninstall'), icon: 'delete', onClick: async () => {
      if (!(await confirmDialog({ title: t('Uninstall {name}?', { name: p.name }), message: t('Books you downloaded with it stay in your libraries.'), confirm: t('Uninstall'), danger: true }))) return;
      await api.removePlugin(p.id);
      reload();
    } },
  ]));
  const sub = p.error
    ? t('Couldn’t load: {error}', { error: p.error })
    : [`v${p.version}`, (p.kinds || []).map((k) => KIND_LABEL[k]).join(', '), p.needsSetup ? t('Needs setup: {value}', { value: p.needsSetup.join(', ') }) : p.description].filter(Boolean).join(' · ');
  return h('div.setting-row',
    pluginIcon(p),
    h('div.text', h('div', p.name, p.nsfw ? h('span.mini-chip', '18+') : null), h('div.s', sub)),
    p.needsSetup && button(t('Set up'), { variant: 'tonal', onclick: () => settingsDialog(p) }),
    p.id === 'mihon' && !p.needsSetup && button(t('Extensions'), { variant: 'tonal', icon: 'extension', onclick: () => mihonDialog() }),
    toggleSwitch(p.enabled, async (v) => {
      await api.configurePlugin(p.id, { enabled: v });
      snackbar(v ? t('{name} on', { name: p.name }) : t('{name} off', { name: p.name }));
    }, t('Enable {name}', { name: p.name })),
    more,
  );
}

async function settingsDialog(p) {
  const inputs = p.settings.map((s) => {
    const value = p.values?.[s.key] ?? s.default ?? '';
    if (s.type === 'toggle') {
      const input = h('input', { type: 'checkbox', checked: Boolean(value) });
      input.dataset.key = s.key;
      return { s, el: h('label.check', input, s.label), get: () => input.checked };
    }
    const f = s.type === 'select'
      ? field(s.label, { value, options: (s.options || []).map((o) => ({ value: o, label: o })), support: s.help })
      : field(s.label, { value, type: s.type === 'password' ? 'password' : s.type === 'number' ? 'number' : 'text', required: s.required, support: s.help, autocomplete: 'off' });
    return { s, el: f, get: () => (s.type === 'number' ? Number(f.input.value) : f.input.value) };
  });
  await formDialog({
    title: t('{name} settings', { name: p.name }),
    icon: 'tune',
    fields: inputs.map((i) => i.el),
    onSubmit: () => api.configurePlugin(p.id, { settings: Object.fromEntries(inputs.map((i) => [i.s.key, i.get()])) }),
  });
  reload();
}

async function viewSource(p) {
  const src = await (await fetch(`/api/admin/plugins/${encodeURIComponent(p.id)}/source`)).text();
  await dialog({ title: t('{name} – source', { name: p.name }), icon: 'code', className: 'wide', content: h('pre.source-view', src), actions: [{ label: t('Close') }] });
}

async function installFromUrl() {
  const url = field(t('Plugin URL'), { type: 'url', required: true, support: t('A direct link to a .lua file. You can update it later from the same URL.') });
  await formDialog({ title: t('Install from URL'), icon: 'link', fields: [url], submit: t('Install'), onSubmit: async () => {
    const r = await api.installPlugin({ url: url.input.value.trim() });
    snackbar(`${r.name} ${r.updated ? 'updated' : 'installed'}`);
  } });
  reload();
}

function installFromFile() {
  const input = h('input', { type: 'file', accept: '.lua,text/plain' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const r = await api.installPlugin({ source: await file.text() });
      snackbar(`${r.name} ${r.updated ? 'updated' : 'installed'}`);
      reload();
    } catch (e) {
      snackbar(e.message, { duration: 7000 });
    }
  });
  input.click();
}

async function addRepo() {
  const url = field(t('Repository URL'), { type: 'text', required: true, support: t('Link to the repository’s index.json. Mihon links (index.pb, mihon://…) are added to Suwayomi.') });
  await formDialog({ title: t('Add plugin repository'), icon: 'add_link', fields: [url], submit: t('Add'), onSubmit: async () => {
    const r = await api.addPluginRepo(url.input.value.trim());
    if (r.mihon) snackbar(r.already ? t('Suwayomi already has that Mihon repository.') : t('Added to Suwayomi. Install its extensions under Mihon extensions → Extensions.'), { duration: 6000 });
    else snackbar(t('Added {value} ({count} plugins)', { value: r.name || 'repository', count: r.count }));
  } });
  reload();
}

// ---------------------------------------------------------------------------
// Mihon extensions (on the connected Suwayomi-Server)

async function mihonDialog() {
  const body = h('div.mihon', loading());
  await dialog({
    title: t('Mihon extensions'),
    icon: 'extension',
    className: 'wide fullscreen-compact',
    content: body,
    actions: [{ label: t('Done') }],
    onOpen: () => renderMihon(body),
  });
  reload();
}

async function renderMihon(body) {
  let status;
  let repos;
  try {
    [status, repos] = await Promise.all([api.mihonStatus(), api.mihonRepos()]);
  } catch (e) {
    body.replaceChildren(h('div.form-error', icon('error'), e.message),
      h('p.body-medium', { style: { marginTop: '12px' } }, t('If you use Flyleaf’s extension runtime, check that it’s running (Settings → Plugins). Otherwise check the Suwayomi URL in this plugin’s settings, and that Suwayomi-Server is running.')));
    return;
  }

  const repoList = h('div.settings-group');
  const drawRepos = () => repoList.replaceChildren(...(repos.length
    ? repos.map((r) => h('div.setting-row', icon('cloud'), h('div.text', h('div.mono', { style: { wordBreak: 'break-all' } }, r)),
      iconButton('delete', t('Remove repository'), async () => {
        repos = await api.setMihonRepos(repos.filter((x) => x !== r));
        drawRepos();
        drawSuggested();
        loadExtensions();
      })))
    : [h('div.setting-row', icon('info'), h('div.text', h('div', t('No extension repositories yet')), h('div.s', t('Add the index.min.json URL of a Mihon extension repository to see its extensions.'))))]));
  drawRepos();
  const repoField = field(t('Repository URL'), { type: 'text', support: t('An index.pb or index.min.json URL, or a mihon:// “add repo” link. Only add repositories you trust.') });

  // One-click repositories from the community list at wotaku.wiki.
  const suggested = h('div.settings-group', h('div.setting-row', loading()));
  const suggestedNote = h('p.body-small.muted', { style: { margin: '8px 0 0' } });
  let suggestions = [];
  // Suwayomi lists a repository by its repo.json or index.pb, so compare by folder.
  const base = (u) => String(u).replace(/\/(?:index\.min\.json|repo\.json|index\.pb)(?:\?.*)?$/i, '').toLowerCase();
  const drawSuggested = () => {
    const has = (u) => repos.some((r) => base(r) === base(u));
    suggested.replaceChildren(...suggestions.map((r) => {
      const needsUpdate = r.format === 'pb' && !status.nativeStores;
      const add = button(has(r.url) ? t('Added') : t('Add'), { variant: has(r.url) ? 'text' : 'tonal', icon: has(r.url) ? 'check' : 'add', disabled: has(r.url) || !r.supported || needsUpdate, onclick: async () => {
        add.disabled = true;
        try {
          repos = await api.setMihonRepos([...repos, r.url]);
          snackbar(t('Added {name}', { name: r.name }));
          drawRepos();
          drawSuggested();
          loadExtensions();
        } catch (e) {
          snackbar(e.message, { duration: 6000 });
          add.disabled = false;
        }
      } });
      return h('div.setting-row', icon(r.nsfw ? 'explicit' : 'inventory_2'),
        h('div.text', h('div', r.name, r.nsfw ? h('span.mini-chip', '18+') : null),
          h('div.s', needsUpdate ? t('Needs Suwayomi v2.3 or newer (index.pb repository).') : r.supported ? r.description || r.url : t('Couldn’t be reached just now.'))),
        add);
    }));
  };
  api.mihonSuggestedRepos().then((r) => {
    suggestions = r.list;
    suggestedNote.replaceChildren(r.source
      ? h('span', t('From '), h('a', { href: r.source, target: '_blank', rel: 'noopener noreferrer' }, 'wotaku.wiki'), t('. Anime (Aniyomi) repositories there aren’t supported by Suwayomi, so they’re left out.'))
      : t('wotaku.wiki couldn’t be reached, so this is Flyleaf’s built-in list.'));
    drawSuggested();
  }).catch((e) => suggested.replaceChildren(h('div.setting-row', icon('error'), h('div.text', h('div.s', e.message)))));
  const addRepo = button(t('Add'), { variant: 'tonal', icon: 'add', onclick: async () => {
    const url = repoField.input.value.trim();
    if (!url) return;
    try {
      repos = await api.setMihonRepos([...repos, url]);
      repoField.input.value = '';
      drawRepos();
      drawSuggested();
      loadExtensions();
    } catch (e) {
      snackbar(e.message, { duration: 6000 });
    }
  } });

  const filter = h('input.search-input', { type: 'search', placeholder: t('Filter extensions…'), 'aria-label': t('Filter extensions') });
  const lang = h('select.search-input', { 'aria-label': t('Language') });
  const list = h('div.settings-group.ext-list', loading());
  let all = [];

  // 18+ extensions are listed unless you choose to hide them (remembered on this device).
  let showNsfw = true;
  try {
    showNsfw = localStorage.getItem('flyleaf.mihonNsfw') !== 'hide';
  } catch {}
  const nsfwToggle = h('label.check', h('input', { type: 'checkbox', checked: showNsfw, onchange: (e) => {
    showNsfw = e.target.checked;
    try {
      localStorage.setItem('flyleaf.mihonNsfw', showNsfw ? 'show' : 'hide');
    } catch {}
    limit = 300;
    draw();
  } }), t('Show 18+ extensions'));
  let limit = 300;
  let shown = [];
  function draw() {
    const term = filter.value.trim().toLowerCase();
    shown = all.filter((e) => (showNsfw || !e.nsfw || e.installed) && (!term || e.name.toLowerCase().includes(term) || e.pkgName.includes(term)) && (!lang.value || e.lang === lang.value));
    const hiddenNsfw = showNsfw ? 0 : all.filter((e) => e.nsfw && !e.installed).length;
    const rows = shown.length ? shown.slice(0, limit).map(extRow) : [h('div.setting-row', icon('search_off'), h('div.text', t('No extensions match.')))];
    if (shown.length > limit) {
      rows.push(h('div.setting-row', h('div.text', h('div.s', t('Showing {value} of {value2}', { value: limit.toLocaleString(), value2: shown.length.toLocaleString() }))),
        button(t('Show more'), { variant: 'text', onclick: () => { limit += 300; draw(); } }),
        button(t('Show all'), { variant: 'text', onclick: () => { limit = Infinity; draw(); } })));
    }
    if (hiddenNsfw) rows.push(h('div.setting-row', icon('visibility_off'), h('div.text', h('div.s', t('{value} 18+ {value2} hidden – tick “Show 18+ extensions” to list them.', { value: hiddenNsfw.toLocaleString(), value2: hiddenNsfw === 1 ? t('extension is') : t('extensions are') })))));
    list.replaceChildren(...rows);
    if (!bulkState?.running) drawBulk();
  }

  // Install or update everything in the list at once (runs on the server; closing this is fine).
  const bulkBar = h('div.ext-bulk');
  let bulkState = null;
  let bulkTimer = null;
  let seenFinish = null;
  async function pollBulk() {
    clearTimeout(bulkTimer);
    if (!bulkBar.isConnected && bulkState) return;
    try {
      bulkState = await api.mihonBulk();
    } catch {
      return;
    }
    drawBulk();
    if (bulkState.running) bulkTimer = setTimeout(pollBulk, 2000);
    else if (bulkState.finishedAt && bulkState.finishedAt !== seenFinish) {
      if (seenFinish !== null || Date.now() - bulkState.finishedAt < 10_000) {
        const ok = bulkState.done - bulkState.failedCount;
        snackbar(plural(ok, '{value} {ok} extension{value3}{value4}', '{value} {ok} extensions{value3}{value4}', { value: bulkState.action === 'update' ? t('Updated') : t('Installed'), ok: ok, value3: bulkState.failedCount ? t(', {failedCount} failed', { failedCount: bulkState.failedCount }) : '', value4: bulkState.cancelled ? ' (stopped)' : '' }), { duration: 6000 });
        loadExtensions();
      }
      seenFinish = bulkState.finishedAt;
    }
  }
  function drawBulk() {
    const st = bulkState;
    if (st?.running) {
      const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
      bulkBar.replaceChildren(h('div.settings-group', { style: { marginBottom: '8px' } }, h('div.setting-row', icon(st.action === 'update' ? 'system_update' : 'download'),
        h('div.text',
          h('div', t('{value} {value2} of {value3} extensions{value4}', { value: st.action === 'update' ? t('Updating') : t('Installing'), value2: st.done.toLocaleString(), value3: st.total.toLocaleString(), value4: st.cancelled ? ' – stopping…' : '' })),
          h('div.s', st.failedCount ? t('{failedCount} failed so far · you can close this window', { failedCount: st.failedCount }) : t('Runs in the background, so you can close this window.')),
          h('div.progress', { style: { marginTop: '8px' } }, h('span', { style: { width: `${pct}%` } }))),
        !st.cancelled && button(t('Stop'), { variant: 'text', onclick: async () => {
          bulkState = await api.cancelMihonBulk();
          drawBulk();
        } }))));
      return;
    }
    const toInstall = shown.filter((e) => !e.installed && !e.obsolete);
    const toUpdate = all.filter((e) => e.installed && e.hasUpdate);
    const filtered = Boolean(filter.value.trim() || lang.value);
    const start = (action, items) => async () => {
      const n = items.length;
      const what = action === 'update' ? plural(n, 'Update {n} extension?', 'Update {n} extensions?', { n: n }) : plural(n, 'Install {value} extension?', 'Install {value} extensions?', { value: n.toLocaleString() });
      const message = action === 'update'
        ? t('Every extension with an update is updated, two at a time, in the background.')
        : t('This installs every extension{value}, two at a time, in the background. Each one becomes a Content Finder source. {value2}Only use sources you’re allowed to download from.', { value: filtered ? t(' that matches your filter') : t(' in the list'), value2: n > 100 ? t('That many takes a while (and uses more memory); a language filter keeps the list manageable. ') : '' });
      if (!(await confirmDialog({ title: what, message, confirm: action === 'update' ? t('Update all') : t('Install all'), icon: action === 'update' ? 'system_update' : 'download' }))) return;
      try {
        bulkState = await api.startMihonBulk(action, items.map((e) => e.pkgName));
        drawBulk();
        pollBulk();
      } catch (e) {
        snackbar(e.message, { duration: 7000 });
      }
    };
    const failedNote = st?.failedCount && !st.running
      ? button(t('{failedCount} failed last time', { failedCount: st.failedCount }), { variant: 'text', icon: 'error', onclick: () => dialog({
        title: t('Extensions that didn’t install'),
        icon: 'error',
        className: 'wide',
        content: h('div', st.failed.map((f) => h('p', { style: { marginBottom: '8px' } }, h('b', all.find((e) => e.pkgName === f.pkgName)?.name || f.pkgName), h('br'), h('span.body-small.muted', f.error)))),
        actions: [{ label: t('Close') }],
      }) })
      : null;
    bulkBar.replaceChildren(h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', margin: '0 0 8px' } },
      button(toInstall.length ? t('Install all ({value})', { value: toInstall.length.toLocaleString() }) : t('Install all'), { variant: 'tonal', icon: 'download', disabled: !toInstall.length, onclick: start('install', toInstall) }),
      toUpdate.length > 0 && button(t('Update all ({length})', { length: toUpdate.length }), { variant: 'tonal', icon: 'system_update', onclick: start('update', toUpdate) }),
      failedNote));
  }

  function extRow(e) {
    const action = async (btn, act, label) => {
      btn.disabled = true;
      setButtonLabel(btn, `${label}…`);
      try {
        await api.mihonAction(e.pkgName, act);
        snackbar(`${e.name} ${act === 'uninstall' ? 'removed' : act === 'update' ? 'updated' : 'installed'}`);
        loadExtensions();
      } catch (err) {
        snackbar(err.message, { duration: 7000 });
        btn.disabled = false;
      }
    };
    const img = e.icon ? h('img.plugin-icon', { src: e.icon, alt: '', loading: 'lazy' }) : h('span.plugin-icon', icon('extension'));
    const buttons = [];
    if (e.installed && e.hasUpdate) {
      const b = button(t('Update'), { onclick: () => action(b, 'update', t('Updating')) });
      buttons.push(b);
    }
    if (e.installed) {
      const b = button(t('Remove'), { variant: 'text', onclick: () => action(b, 'uninstall', t('Removing')) });
      buttons.push(b);
    } else {
      const b = button(t('Install'), { variant: 'tonal', onclick: () => action(b, 'install', t('Installing')) });
      buttons.push(b);
    }
    return h('div.setting-row', img,
      h('div.text', h('div', e.name, e.nsfw ? h('span.mini-chip', '18+') : null, e.obsolete ? h('span.mini-chip', t('Obsolete')) : null),
        h('div.s', [e.lang, `v${e.version}`, e.installed ? t('Installed') : null].filter(Boolean).join(' · '))),
      ...buttons);
  }

  async function loadExtensions() {
    list.replaceChildren(loading());
    try {
      all = (await api.mihonExtensions()).sort((a, b) => Number(b.installed) - Number(a.installed) || Number(b.hasUpdate) - Number(a.hasUpdate) || a.name.localeCompare(b.name));
    } catch (e) {
      list.replaceChildren(h('div.form-error', icon('error'), e.message));
      return;
    }
    const langs = [...new Set(all.map((e) => e.lang))].sort();
    const current = lang.value;
    lang.replaceChildren(h('option', { value: '' }, t('All languages')), ...langs.map((l) => h('option', { value: l }, l)));
    lang.value = langs.includes(current) ? current : '';
    draw();
  }
  filter.addEventListener('input', draw);
  lang.addEventListener('change', draw);

  body.replaceChildren(
    h('p.body-medium', t('Connected to Suwayomi {value} at {url}. Extensions you install appear as sources in Content Finder.', { value: status.version || '', url: status.url })),
    status.nativeStores
      ? h('p.body-small.muted', { style: { marginTop: '6px' } }, t('This Suwayomi reads Mihon’s newer index.pb repositories (Keiyoushi, Yūzōnō…) itself.'))
      : h('div.form-error', { style: { marginTop: '10px' } }, icon('system_update'),
        h('span', t('Suwayomi {value} only accepts GitHub index.min.json repositories. Mihon’s newer index.pb repositories, including Keiyoushi’s full list and Yūzōnō, need Suwayomi v2.3 or newer. Update Suwayomi-Server, then reopen this dialog.', { value: status.version || '' }))),
    h('p.label-large', { style: { margin: '16px 0 8px' } }, t('Repositories')),
    repoList,
    h('div.repo-add', repoField, addRepo),
    h('p.label-large', { style: { margin: '16px 0 8px' } }, t('Popular repositories')),
    suggested,
    suggestedNote,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '16px 0 8px' } },
      h('p.label-large', { style: { flex: '1' } }, t('Extensions')),
      button(t('Install APK'), { variant: 'tonal', icon: 'install_mobile', onclick: () => pickApks(loadExtensions) })),
    h('p.body-small.muted', { style: { margin: '-4px 0 8px' } }, t('Have an extension that’s no longer in any repository, like an old Tachiyomi one? Install its .apk file.')),
    h('div.ext-filters', filter, lang),
    nsfwToggle,
    bulkBar,
    list,
    h('p.body-small.muted', { style: { marginTop: '12px' } }, t('Only use extensions for sources you’re allowed to download from.')),
  );
  loadExtensions();
  pollBulk();
}
