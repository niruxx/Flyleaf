import { api } from '../api.js';
import { t, plural } from '../i18n.js';
import { button, copyText, dialog, field, formDialog, h, iconButton, snackbar, timeAgo } from '../ui.js';

export function shareAddresses(info) {
  const addresses = [
    ...(info.public ? [{ value: info.public, label: t('Public address'), icon: 'public' }] : []),
    ...(info.local || []).filter((address) => address !== info.public)
      .map((value) => ({ value, label: t('Private address'), icon: 'home' })),
  ];
  if (!addresses.length) addresses.push({ value: location.origin, label: t('Current server address'), icon: 'link' });
  return addresses;
}

export function shareAddressField(info) {
  const addresses = shareAddresses(info);
  return field(t('Share using'), { value: addresses[0].value,
    options: addresses.map(({ value, label }) => ({ value, label: `${label} · ${value}` })) });
}

export async function shareBook(book, position) {
  const [info, existing] = await Promise.all([api.shareInfo(), api.bookShares(book.id)]);
  const address = shareAddressField(info);
  const start = field(t('Open at'), { value: position ? 'position' : 'start', options: [
    { value: 'start', label: t('Beginning of book') },
    ...(position ? [{ value: 'position', label: position.chapter || (position.page != null
      ? t('Page {page}', { page: position.page + 1 }) : t('Current reading position')) }] : []),
  ] });
  const days = field(t('Link expires in'), { value: '7', options: [1, 7, 30].map((n) => ({
    value: n, label: plural(n, '{n} day', '{n} days'),
  })) });
  const download = h('input', { type: 'checkbox' });
  const activeLinks = h('div');
  if (existing.length) activeLinks.append(h('h3.title-small', t('Active links')));
  for (const share of existing) {
    const revoke = iconButton('link_off', t('Revoke link'), async () => {
      try {
        await api.revokeBookShare(share.id);
        row.remove();
        if (activeLinks.children.length === 1) activeLinks.replaceChildren();
      } catch (e) {
        snackbar(e.message);
      }
    });
    const row = h('div.list-item.static', h('div.text',
      h('div.headline', share.locator ? t('Reading position link') : t('Book link')),
      h('div.supporting', t('Created {time}', { time: timeAgo(share.createdAt) }))), revoke);
    activeLinks.append(row);
  }
  let url;
  await formDialog({
    title: t('Share book'),
    icon: 'share',
    fields: [h('p.body-medium', t('Anyone with this link can open this book.')),
      !info.public && h('p.note', t('Set a Public URL in server settings to share outside your network.')),
      address, start, days, h('label.check', download, t('Allow recipient to download')), activeLinks],
    submit: t('Create link'),
    onSubmit: async () => {
      const result = await api.createBookShare(book.id, {
        locator: start.input.value === 'position' ? position.locator : null,
        allowDownload: download.checked,
        days: Number(days.input.value),
      });
      url = address.input.value.replace(/\/+$/, '') + result.path;
    },
  });
  if (!url) return;
  const link = field(t('Book link'), { value: url, readOnly: true, onclick: (e) => e.currentTarget.select() });
  await dialog({
    title: t('Share book'),
    icon: 'link',
    content: h('div', link, button(t('Copy link'), { icon: 'content_copy', onclick: () => copyText(url) })),
    actions: [{ label: t('Close') }],
    onOpen: () => link.input.select(),
  });
}
