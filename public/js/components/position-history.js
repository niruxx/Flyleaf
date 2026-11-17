import { api } from '../api.js';
import { navigate } from '../router.js';
import { h, button, dialog, confirmDialog, emptyState, loading, snackbar } from '../ui.js';
import { t } from '../i18n.js';

export async function positionHistory(book, { beforeRestore } = {}) {
  const body = h('div.position-history', loading());
  await dialog({ title: t('Reading positions'), icon: 'history', content: body, actions: [{ label: t('Close') }],
    onOpen: async (dlg, close) => {
      const load = async () => {
        try {
          const data = await api.positionHistory(book.id);
          if (!dlg.isConnected) return;
          body.replaceChildren(
            h('p.muted', t('Recover a previous place after an accidental jump or sync. Restoring changes your current position and read status; it does not add reading time.')),
            ...data.devices.map(device => h('p.body-small', t('Last {client} position: {time}', { client: device.client, time: new Date(device.at).toLocaleString() }))),
            ...data.items.map(item => h('div.position-history-row',
              h('div', h('strong', item.page != null && book.engine === 'pages' ? t('Page {n}', { n: item.page + 1 }) : t('{n}% read', { n: Math.round(item.percent * 100) })),
                h('p.body-small.muted', new Date(item.at).toLocaleString()),
                item.finished && h('span.body-small', t('Finished')),
                !item.compatible && h('p.body-small', t('From an older file version'))),
              item.current ? h('span.body-small', t('Current')) : button(t('Restore'), { variant: 'outlined', disabled: !item.compatible, onclick: async () => {
                if (!await confirmDialog({ title: t('Restore this position?'), message: t('Your current position will remain in history so you can return to it. Close other readers before restoring to avoid another device overwriting your choice.'), confirm: t('Restore'), icon: 'history' })) return;
                try {
                  await beforeRestore?.();
                  await api.restorePosition(book.id, item.id, data.updatedAt);
                  close(); navigate(`/read/${book.id}`);
                } catch (e) { snackbar(e.message); load(); }
              } }))),
            ...(!data.items.length ? [emptyState('history', t('No saved positions yet'), t('Positions will be saved as you read.'))] : []));
        } catch (e) { if (dlg.isConnected) body.replaceChildren(emptyState('cloud_off', t('Couldn’t load positions'), e.message, button(t('Try again'), { onclick: load }))); }
      };
      await load();
    } });
}
