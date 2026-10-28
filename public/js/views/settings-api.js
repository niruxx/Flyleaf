import { t, plural } from '../i18n.js';
// Settings → API & webhooks: personal API keys, the endpoint reference
// (rendered from /api/openapi.json) and, for the admin, outgoing webhooks.

import { api } from '../api.js';
import { isAdmin, navigate } from '../router.js';
import { h, icon, iconButton, button, field, snackbar, confirmDialog, formDialog, copyText, timeAgo, loading, segmented, toggleSwitch } from '../ui.js';

const row = (ic, title, sub, control) => h('div.setting-row', ic && icon(ic), h('div.text', h('div', title), sub && h('div.s', sub)), control);
const group = (...rows) => h('div.settings-group', ...rows);
const reload = () => location.hash.startsWith('#/settings/api') && navigate('/settings/api', { replace: true });

export async function apiPanel(panel, stale) {
  panel.append(h('h2', t('API & webhooks')), loading());
  const [keys, spec, hooks] = await Promise.all([api.apiKeys(), api.openapi(), isAdmin() ? api.webhooks() : null]);
  if (stale()) return;
  panel.lastChild.remove();
  const base = `${location.origin}/api`;
  const sample = keys.find((k) => k.scope === 'full') || keys[0];

  panel.append(
    h('p.note', { style: { margin: '-8px 4px 16px' } },
      t('Everything the app does goes through a REST API, so your own scripts and tools can do it too: read your library, track progress, add books, manage collections and more. Requests act as you and see exactly what you can see.')),
    h('div.sub-head', t('API keys')),
    keys.length ? group(...keys.map(keyRow)) : h('p.note', t('No keys yet.')),
    h('div', { style: { marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      button(t('Create API key'), { variant: 'tonal', icon: 'add', onclick: createKey }),
      h('a.btn.text.state', { href: '/api/openapi.json', target: '_blank', rel: 'noopener' }, icon('data_object'), t('OpenAPI spec')),
    ),
    h('div.sub-head', t('Quick start')),
    group(h('div.setting-row.stack',
      h('div.s', t('Send your key in the Authorization header:')),
      codeBlock(`curl -H "Authorization: Bearer ${sample?.key || '<your key>'}" \\\n  ${base}/series?sort=added&limit=5`),
      h('div.s', t('Save reading progress (needs a full-access key):')),
      codeBlock(`curl -X PUT -H "Authorization: Bearer ${sample?.key || '<your key>'}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"page": 42}' ${base}/books/123/progress`),
    )),
    h('div.sub-head', t('Endpoints ({length})', { length: Object.keys(spec.paths).length })),
    endpointBrowser(spec),
  );
  if (hooks) panel.append(...webhookSection(hooks));
}

/** `code` and **bold** from the OpenAPI descriptions, as DOM nodes. */
function inlineMarkdown(text) {
  return String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/).filter(Boolean).map((part) =>
    part.startsWith('`') ? h('code', part.slice(1, -1)) : part.startsWith('**') ? h('strong', part.slice(2, -2)) : part);
}

function codeBlock(text) {
  return h('div.code-block', h('pre', text), iconButton('content_copy', t('Copy'), () => copyText(text)));
}

function keyRow(k) {
  return h('div.setting-row.stack',
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      icon(k.scope === 'full' ? 'admin_panel_settings' : 'visibility'),
      h('div.text', h('div', k.name, ' ', h('span.mini-chip', k.scope === 'full' ? t('Full access') : t('Read only'))),
        h('div.s', t('Created {value} · last used {value2}', { value: timeAgo(k.createdAt), value2: timeAgo(k.lastUsedAt) }))),
      iconButton('autorenew', t('Regenerate key'), async () => {
        if (!(await confirmDialog({ title: t('Regenerate this key?'), message: t('Scripts and apps using the old key stop working until you update them.'), confirm: t('Regenerate') }))) return;
        await api.regenerateApiKey(k.id);
        reload();
      }),
      iconButton('delete', t('Delete key'), async () => {
        if (!(await confirmDialog({ title: t('Delete “{name}”?', { name: k.name }), message: t('Anything using it loses access.'), confirm: t('Delete'), danger: true }))) return;
        await api.deleteApiKey(k.id);
        reload();
      }),
    ),
    h('div.copy-field', h('span.mono', k.key), iconButton('content_copy', t('Copy key'), () => copyText(k.key))),
  );
}

async function createKey() {
  const name = field(t('Name'), { value: 'My script', required: true, support: t('What will use it, e.g. “Home Assistant”, “backup script”') });
  let scope = 'read';
  const seg = segmented([
    { value: 'read', label: t('Read only'), icon: 'visibility' },
    { value: 'full', label: t('Full access'), icon: 'edit' },
  ], scope, (v) => (scope = v));
  await formDialog({
    title: t('New API key'),
    icon: 'key',
    fields: [name, h('p.label-large', { style: { margin: '12px 0 8px' } }, t('Access')), seg,
      h('p.body-small.muted', { style: { marginTop: '8px' } }, t('Read-only keys can only make GET requests. Full-access keys can do anything you can, except manage API keys or change your password.'))],
    submit: t('Create'),
    onSubmit: () => api.createApiKey(name.input.value, scope),
  });
  reload();
}

// ---------------------------------------------------------------------------
// Endpoint reference

const METHOD_CLASS = { get: 'get', post: 'post', put: 'put', patch: 'patch', delete: 'delete' };

function endpointBrowser(spec) {
  const byTag = new Map();
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const tag = op.tags?.[0] || t('Other');
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ path, method, op });
    }
  }
  const filter = h('input.search-input', { type: 'search', placeholder: t('Filter endpoints…'), 'aria-label': t('Filter endpoints') });
  const groups = [...byTag].map(([tag, list]) =>
    h('details.settings-group.api-group',
      h('summary.setting-row.state', icon('api'), h('div.text', h('div', tag), h('div.s', plural(list.length, '{length} endpoint', '{length} endpoints', { length: list.length }))), icon('expand_more')),
      list.map(({ path, method, op }) => {
        const params = op.parameters || [];
        const body = op.requestBody?.content?.['application/json']?.schema?.properties;
        const raw = op.requestBody && !body ? Object.keys(op.requestBody.content)[0] : null;
        return h('details.api-op', { dataset: { search: `${method} ${path} ${op.summary}`.toLowerCase() } },
          h('summary', h(`span.method.${METHOD_CLASS[method]}`, method.toUpperCase()), h('code', path), h('span.op-summary', op.summary)),
          h('div.api-op-body',
            op.description && h('p.body-small.muted', inlineMarkdown(op.description)),
            params.length > 0 && h('table.api-params', h('tbody', params.map((p) => h('tr', h('td', h('code', p.name)), h('td.muted', p.in), h('td', p.schema?.description || p.schema?.type || ''))))),
            body && h('div', h('div.label-medium', t('JSON body')), h('table.api-params', h('tbody', Object.entries(body).map(([k, s]) => h('tr', h('td', h('code', k)), h('td', s.description || s.type)))))),
            raw && h('p.body-small', t('Body: raw {raw}', { raw: raw })),
            h('p.body-small.muted', t('Returns: {value}', { value: op.responses?.[200]?.description || 'JSON' })),
          ));
      })),
  );
  filter.addEventListener('input', () => {
    const term = filter.value.trim().toLowerCase();
    for (const g of groups) {
      let any = false;
      for (const op of g.querySelectorAll('.api-op')) {
        const hit = !term || op.dataset.search.includes(term);
        op.hidden = !hit;
        any ||= hit;
      }
      g.hidden = !any;
      if (term) g.open = any;
    }
  });
  return h('div.api-browser', filter, groups);
}

// ---------------------------------------------------------------------------
// Webhooks (admin)

function webhookSection({ hooks, events }) {
  const eventNames = Object.keys(events);
  const rows = hooks.map((w) => h('div.setting-row.stack',
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      icon(w.lastError ? 'error' : 'webhook'),
      h('div.text',
        h('div.mono', { style: { wordBreak: 'break-all' } }, w.url),
        h('div.s', `${w.events.includes('*') ? t('All events') : w.events.join(', ')} · ${w.lastAt ? `last delivery ${timeAgo(w.lastAt)}: ${w.lastError || `HTTP ${w.lastStatus}`}` : t('not used yet')}`)),
      toggleSwitch(w.enabled, async (v) => {
        await api.updateWebhook(w.id, { enabled: v });
        snackbar(v ? t('Webhook on') : t('Webhook off'));
      }, t('Enabled')),
      iconButton('send', t('Send test ping'), async () => {
        const r = await api.testWebhook(w.id);
        snackbar(r.error ? t('Test failed: {error}', { error: r.error }) : t('Delivered (HTTP {status})', { status: r.status }), { duration: 5000 });
        reload();
      }),
      iconButton('edit', t('Edit'), () => hookDialog(w, eventNames, events)),
      iconButton('delete', t('Delete'), async () => {
        if (!(await confirmDialog({ title: t('Delete this webhook?'), confirm: t('Delete'), danger: true }))) return;
        await api.deleteWebhook(w.id);
        reload();
      }),
    ),
    h('div.label-medium.muted', t('Signing secret')),
    h('div.copy-field', h('span.mono', w.secret), iconButton('content_copy', t('Copy secret'), () => copyText(w.secret))),
  ));
  return [
    h('div.sub-head', t('Webhooks')),
    h('p.note', { style: { margin: '0 4px 12px' } }, t('Flyleaf POSTs JSON to these URLs when things happen. Each request is signed: X-Flyleaf-Signature is sha256=<HMAC of the body with the secret>.')),
    hooks.length ? group(...rows) : h('p.note', t('No webhooks yet.')),
    h('div', { style: { marginTop: '12px' } }, button(t('Add webhook'), { variant: 'tonal', icon: 'add', onclick: () => hookDialog(null, eventNames, events) })),
  ];
}

async function hookDialog(hook, names, descriptions) {
  const url = field(t('URL'), { value: hook?.url || '', type: 'url', required: true, support: t('e.g. https://n8n.example.com/webhook/flyleaf') });
  const current = new Set(hook?.events || ['*']);
  const all = h('input', { type: 'checkbox', checked: current.has('*') });
  const checks = names.map((n) => {
    const input = h('input', { type: 'checkbox', checked: current.has('*') || current.has(n), disabled: current.has('*') });
    input.dataset.event = n;
    return h('label.check', input, h('span', h('code', n), h('span.body-small.muted', ` – ${descriptions[n]}`)));
  });
  all.addEventListener('change', () => {
    for (const c of checks) {
      const i = c.querySelector('input');
      i.disabled = all.checked;
      if (all.checked) i.checked = true;
    }
  });
  await formDialog({
    title: hook ? t('Edit webhook') : t('Add webhook'),
    icon: 'webhook',
    fields: [url, h('p.label-large', { style: { margin: '12px 0 4px' } }, t('Events')), h('label.check', all, h('strong', t('Everything, including events added later'))), h('div', { style: { paddingLeft: '8px' } }, checks)],
    submit: hook ? t('Save') : t('Add'),
    onSubmit: async () => {
      const events = all.checked ? ['*'] : checks.map((c) => c.querySelector('input')).filter((i) => i.checked).map((i) => i.dataset.event);
      if (!events.length) throw new Error(t('Pick at least one event.'));
      if (hook) await api.updateWebhook(hook.id, { url: url.input.value.trim(), events });
      else await api.createWebhook({ url: url.input.value.trim(), events });
    },
  });
  reload();
}
