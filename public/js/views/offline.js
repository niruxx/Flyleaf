// #/offline – books saved on this device, readable without a connection.

import { navigate } from '../router.js';
import { h, icon, iconButton, button, cover, emptyState, stagger, pageBanner, formatBytes, timeAgo, confirmDialog, snackbar } from '../ui.js';
import { savedBooks, removeBook, removeAll, storageEstimate, offlineSupported, onSavedChange } from '../offline.js';
import { t, plural } from '../i18n.js';

export async function offlineView(view) {
  const page = h('div.page');
  view.append(page);
  const banner = pageBanner({
    icon: 'offline_pin',
    eyebrow: navigator.onLine ? t('On this device') : t('You’re offline'),
    title: t('Saved for offline'),
    sub: navigator.onLine ? t('Books you can read without a connection. Your progress syncs when you’re back online.') : t('These books are on this device. Your reading progress is kept and sent when you’re back online.'),
  });
  const body = h('div');
  page.append(banner, body);

  async function draw() {
    const list = savedBooks();
    banner.setArt(list.map((b) => b.coverUrl).filter(Boolean));
    if (!offlineSupported()) {
      body.replaceChildren(emptyState('cloud_off', t('Not available in this browser'), t('Saving books needs HTTPS (or localhost) and a browser with service workers. Put Flyleaf behind an HTTPS reverse proxy to use it on your phone.')));
      return;
    }
    const total = list.reduce((a, b) => a + (b.size || 0), 0);
    const est = await storageEstimate();
    const usage = h('div.offline-usage',
      icon('storage'),
      h('span', `${plural(list.length, '{n} book', '{n} books')} · ${formatBytes(total)}`),
      est?.quota ? h('span.muted', ` · ${t('{used} used of about {quota} available to Flyleaf', { used: formatBytes(est.usage), quota: formatBytes(est.quota) })}`) : null,
      list.length > 0 && button(t('Remove all'), { variant: 'text', icon: 'delete_sweep', onclick: async () => {
        if (!(await confirmDialog({ title: 'Remove all saved books?', message: 'They’re removed from this device only. Your progress isn’t affected.', confirm: 'Remove', danger: true }))) return;
        await removeAll();
        snackbar('Removed from this device');
      } }));
    body.replaceChildren(
      usage,
      list.length
        ? stagger(h('div.grid', list.map((b) => {
            const remove = iconButton('delete', t('Remove from this device'), async (e) => {
              e.preventDefault();
              e.stopPropagation();
              await removeBook(b.id);
            });
            remove.classList.add('more');
            return h('a.tile', { href: `#/read/${b.id}`, title: b.title },
              cover({ id: b.id, title: b.label || b.title, coverUrl: b.coverUrl, format: b.format }, { showProgress: false }),
              remove,
              h('div.t-title', b.series && b.label !== b.series ? `${b.series} · ${b.label}` : b.title),
              h('div.t-sub', `${formatBytes(b.size)} · saved ${timeAgo(b.savedAt)}`));
          })))
        : emptyState('download_for_offline', t('Nothing saved yet'), t('Open a book’s ⋮ menu and choose “Save for offline”, or “Save next 3 for offline” on a series.'),
            navigator.onLine && button(t('Browse library'), { icon: 'local_library', onclick: () => navigate('/library') })),
    );
  }
  const off = onSavedChange(draw);
  import('../router.js').then(({ onLeave }) => onLeave(off));
  await draw();
}
