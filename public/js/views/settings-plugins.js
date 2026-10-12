// Settings → Content Finder plugins (admin): installed sources, repositories,
// and installing plugins from a repository, a URL or a .lua file.

import { api } from '../api.js';
import { navigate } from '../router.js';
import { h, icon, iconButton, button, field, snackbar, confirmDialog, formDialog, dialog, loading, toggleSwitch, menu, setButtonLabel } from '../ui.js';

const group = (...rows) => h('div.settings-group', ...rows);
// Refresh the panel – unless the user has already gone elsewhere (closing a dialog also runs this).
const reload = () => location.hash.startsWith('#/settings/plugins') && navigate('/settings/plugins', { replace: true });
const KIND_LABEL = { books: 'Books', manga: 'Manga', comics: 'Comics' };

function pluginIcon(p) {
  const fallback = h('span.plugin-icon', icon('extension'));
  if (!p.icon) return fallback;
  const img = h('img.plugin-icon', { src: p.icon, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(fallback));
  return img;
}

export async function pluginsPanel(panel, stale) {
  panel.append(h('h2', 'Content Finder plugins'), loading());
  const { installed, repos } = await api.plugins();
  if (stale()) return;
  panel.lastChild.remove();

  const catalogBox = h('div', loading());
  panel.append(
    h('p.note', { style: { margin: '-8px 4px 16px' } },
      'Plugins are small Lua scripts that teach Content Finder how to search a website and download from it. They run in a sandbox with no access to your files. Only install plugins for sources you’re allowed to download from.'),
    h('div.sub-head', `Installed (${installed.length})`),
    installed.length ? group(...installed.map(installedRow)) : h('p.note', 'No plugins installed.'),
    h('div', { style: { marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      button('Install from URL', { variant: 'tonal', icon: 'link', onclick: installFromUrl }),
      button('Upload .lua file', { variant: 'tonal', icon: 'upload_file', onclick: installFromFile }),
      h('a.btn.text.state', { href: 'https://github.com/niruxx/Flyleaf/blob/main/docs/plugins.md', target: '_blank', rel: 'noopener' }, icon('menu_book'), 'Write your own'),
    ),
    h('div.sub-head', 'Available from repositories'),
    catalogBox,
    h('div.sub-head', 'Repositories'),
    group(...repos.map((r) => h('div.setting-row',
      icon(r.builtin ? 'verified' : 'cloud'),
      h('div.text', h('div', r.name || r.url), h('div.s', r.builtin ? 'Ships with Flyleaf' : r.url)),
      !r.builtin && iconButton('delete', 'Remove repository', async () => {
        if (!(await confirmDialog({ title: 'Remove this repository?', message: 'Plugins you installed from it stay installed.', confirm: 'Remove', danger: true }))) return;
        await api.removePluginRepo(r.id);
        reload();
      }),
    ))),
    h('div', { style: { marginTop: '12px' } }, button('Add repository', { variant: 'tonal', icon: 'add_link', onclick: addRepo })),
    h('p.note', 'A repository is a URL to an index.json that lists plugins – the same idea as Mihon/Tachiyomi extension repos. See docs/plugins.md for the format.'),
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
          button(p.update ? `Update to ${p.version}` : 'Install', { variant: p.update ? 'filled' : 'tonal', onclick: async (e) => {
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
        : h('p.note', 'Everything from your repositories is installed and up to date.'),
    );
  }).catch((e) => catalogBox.replaceChildren(h('div.form-error', icon('error'), e.message)));
}

function installedRow(p) {
  const more = iconButton('more_vert', 'Plugin options', () => menu(more, [
    p.settings?.length && { label: 'Settings', icon: 'tune', onClick: () => settingsDialog(p) },
    p.origin && { label: 'Check for update', icon: 'system_update', onClick: async () => {
      try {
        const r = await api.updatePlugin(p.id);
        snackbar(r.version === p.version ? 'Already up to date' : `Updated to ${r.version}`);
        reload();
      } catch (e) {
        snackbar(e.message, { duration: 6000 });
      }
    } },
    { label: 'View source', icon: 'code', onClick: () => viewSource(p) },
    '-',
    { label: 'Uninstall', icon: 'delete', onClick: async () => {
      if (!(await confirmDialog({ title: `Uninstall ${p.name}?`, message: 'Books you downloaded with it stay in your libraries.', confirm: 'Uninstall', danger: true }))) return;
      await api.removePlugin(p.id);
      reload();
    } },
  ]));
  const sub = p.error
    ? `Couldn’t load: ${p.error}`
    : [`v${p.version}`, (p.kinds || []).map((k) => KIND_LABEL[k]).join(', '), p.needsSetup ? `Needs setup: ${p.needsSetup.join(', ')}` : p.description].filter(Boolean).join(' · ');
  return h('div.setting-row',
    pluginIcon(p),
    h('div.text', h('div', p.name, p.nsfw ? h('span.mini-chip', '18+') : null), h('div.s', sub)),
    p.needsSetup && button('Set up', { variant: 'tonal', onclick: () => settingsDialog(p) }),
    p.id === 'mihon' && !p.needsSetup && button('Extensions', { variant: 'tonal', icon: 'extension', onclick: () => mihonDialog() }),
    toggleSwitch(p.enabled, async (v) => {
      await api.configurePlugin(p.id, { enabled: v });
      snackbar(v ? `${p.name} on` : `${p.name} off`);
    }, `Enable ${p.name}`),
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
    title: `${p.name} settings`,
    icon: 'tune',
    fields: inputs.map((i) => i.el),
    onSubmit: () => api.configurePlugin(p.id, { settings: Object.fromEntries(inputs.map((i) => [i.s.key, i.get()])) }),
  });
  reload();
}

async function viewSource(p) {
  const src = await (await fetch(`/api/admin/plugins/${encodeURIComponent(p.id)}/source`)).text();
  await dialog({ title: `${p.name} – source`, icon: 'code', className: 'wide', content: h('pre.source-view', src), actions: [{ label: 'Close' }] });
}

async function installFromUrl() {
  const url = field('Plugin URL', { type: 'url', required: true, support: 'A direct link to a .lua file. You can update it later from the same URL.' });
  await formDialog({ title: 'Install from URL', icon: 'link', fields: [url], submit: 'Install', onSubmit: async () => {
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
  const url = field('Repository URL', { type: 'url', required: true, support: 'Link to the repository’s index.json' });
  await formDialog({ title: 'Add plugin repository', icon: 'add_link', fields: [url], submit: 'Add', onSubmit: async () => {
    const r = await api.addPluginRepo(url.input.value.trim());
    snackbar(`Added ${r.name || 'repository'} (${r.count} plugins)`);
  } });
  reload();
}

// ---------------------------------------------------------------------------
// Mihon extensions (on the connected Suwayomi-Server)

async function mihonDialog() {
  const body = h('div.mihon', loading());
  await dialog({
    title: 'Mihon extensions',
    icon: 'extension',
    className: 'wide fullscreen-compact',
    content: body,
    actions: [{ label: 'Done' }],
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
      h('p.body-medium', { style: { marginTop: '12px' } }, 'Check the Suwayomi URL in this plugin’s settings, and that Suwayomi-Server is running.'));
    return;
  }

  const repoList = h('div.settings-group');
  const drawRepos = () => repoList.replaceChildren(...(repos.length
    ? repos.map((r) => h('div.setting-row', icon('cloud'), h('div.text', h('div.mono', { style: { wordBreak: 'break-all' } }, r)),
      iconButton('delete', 'Remove repository', async () => {
        repos = await api.setMihonRepos(repos.filter((x) => x !== r));
        drawRepos();
        loadExtensions();
      })))
    : [h('div.setting-row', icon('info'), h('div.text', h('div', 'No extension repositories yet'), h('div.s', 'Add the index.min.json URL of a Mihon extension repository to see its extensions.')))]));
  drawRepos();
  const repoField = field('Repository URL', { type: 'url', support: 'Ends in index.min.json. Only add repositories you trust.' });
  const addRepo = button('Add', { variant: 'tonal', icon: 'add', onclick: async () => {
    const url = repoField.input.value.trim();
    if (!url) return;
    try {
      repos = await api.setMihonRepos([...repos, url]);
      repoField.input.value = '';
      drawRepos();
      loadExtensions();
    } catch (e) {
      snackbar(e.message, { duration: 6000 });
    }
  } });

  const filter = h('input.search-input', { type: 'search', placeholder: 'Filter extensions…', 'aria-label': 'Filter extensions' });
  const lang = h('select.search-input', { 'aria-label': 'Language' });
  const list = h('div.settings-group.ext-list', loading());
  let all = [];

  function draw() {
    const term = filter.value.trim().toLowerCase();
    const shown = all.filter((e) => (!term || e.name.toLowerCase().includes(term) || e.pkgName.includes(term)) && (!lang.value || e.lang === lang.value));
    list.replaceChildren(...(shown.length ? shown.slice(0, 300).map(extRow) : [h('div.setting-row', icon('search_off'), h('div.text', 'No extensions match.'))]));
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
      const b = button('Update', { onclick: () => action(b, 'update', 'Updating') });
      buttons.push(b);
    }
    if (e.installed) {
      const b = button('Remove', { variant: 'text', onclick: () => action(b, 'uninstall', 'Removing') });
      buttons.push(b);
    } else {
      const b = button('Install', { variant: 'tonal', onclick: () => action(b, 'install', 'Installing') });
      buttons.push(b);
    }
    return h('div.setting-row', img,
      h('div.text', h('div', e.name, e.nsfw ? h('span.mini-chip', '18+') : null, e.obsolete ? h('span.mini-chip', 'Obsolete') : null),
        h('div.s', [e.lang, `v${e.version}`, e.installed ? 'Installed' : null].filter(Boolean).join(' · '))),
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
    lang.replaceChildren(h('option', { value: '' }, 'All languages'), ...langs.map((l) => h('option', { value: l }, l)));
    lang.value = langs.includes(current) ? current : '';
    draw();
  }
  filter.addEventListener('input', draw);
  lang.addEventListener('change', draw);

  body.replaceChildren(
    h('p.body-medium', `Connected to Suwayomi ${status.version || ''} at ${status.url}. Extensions you install appear as sources in Content Finder.`),
    h('p.label-large', { style: { margin: '16px 0 8px' } }, 'Repositories'),
    repoList,
    h('div.repo-add', repoField, addRepo),
    h('p.label-large', { style: { margin: '16px 0 8px' } }, 'Extensions'),
    h('div.ext-filters', filter, lang),
    list,
    h('p.body-small.muted', { style: { marginTop: '12px' } }, 'Only use extensions for sources you’re allowed to download from.'),
  );
  loadExtensions();
}
