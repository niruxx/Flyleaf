import { api } from '../api.js';
import { h, icon, button, field, cover, pageBanner, emptyState, skeleton } from '../ui.js';
import { t } from '../i18n.js';

export async function tonightView(view, params, stale) {
  const page = h('div.page.tonight-page');
  const minutes = field(t('Time available'), { value: '30', options: [5, 10, 15, 20, 30, 45, 60, 90, 120].map(n => ({ value: n, label: t('{n} minutes', { n }) })) });
  const kind = field(t('Format'), { value: '', options: [['', 'Anything'], ['text', 'Books'], ['comic', 'Manga & comics'], ['pdf', 'PDFs'], ['audio', 'Audiobooks']].map(([value, label]) => ({ value, label: t(label) })) });
  const speed = field(t('Listening speed'), { value: '1', options: [.75, 1, 1.25, 1.5, 1.75, 2].map(n => ({ value: n, label: `${n}×` })) });
  speed.hidden = true;
  const results = h('div');
  const banner = pageBanner({ icon: 'bedtime', eyebrow: t('A little time for a story'), title: t('What can I finish tonight?'), sub: t('Find a book, volume, or chapter file that fits the time you have. Already-started books and your reading wishlist come first.') });
  page.append(banner, h('div.reading-room-toolbar', minutes, kind, speed), results);
  view.append(page);
  let run = 0;
  for (const control of [minutes, kind, speed]) control.input.addEventListener('change', () => { speed.hidden = kind.input.value !== 'audio'; if (speed.hidden) speed.input.value = '1'; load(); });
  async function load() {
    const token = ++run;
    results.replaceChildren(skeleton('grid'));
    try {
      const data = await api.tonight({ minutes: minutes.input.value, kind: kind.input.value, speed: speed.input.value });
      if (stale() || token !== run) return;
      const reason = { personal: t('Based on your reading pace'), typical: t('Based on a typical reading pace'), duration: t('Based on audiobook duration and listening speed') };
      results.replaceChildren(
        h('p.muted', t('Estimates include only the next unread item in each series. Reading pace varies; these are guides, not deadlines.')),
        data.items.length ? h('div.tonight-grid', data.items.map(({ book, seconds, basis }) => h('article.tonight-card',
          h('a.tonight-art', { href: `#/series/${book.seriesId}` }, cover(book, { showProgress: false })),
          h('div.tonight-info', h('span.tonight-time', icon('schedule'), t('About {n} min left', { n: Math.ceil(seconds / 60) })),
            h('h2.title-large', book.title), book.series && book.series !== book.title && h('p.muted', book.series),
            h('p.body-small', reason[basis]),
            h('a.btn.tonal.state', { href: `#/read/${book.id}` }, icon('play_arrow'), book.progress?.percent ? t('Continue reading') : t('Start reading'))))))
          : emptyState('bedtime', t('Nothing fits this time yet'), t('Try a longer session or another format. Books need indexed text, page counts, or a known audio duration to be estimated.')),
        data.unknown > 0 && h('p.body-small.muted', t('{n} next reads have no reliable length yet and were left out.', { n: data.unknown })),
        data.total > data.items.length && h('p.body-small.muted', t('Showing {n} of {total} matching reads.', { n: data.items.length, total: data.total })),
      );
    } catch (e) { if (!stale() && token === run) results.replaceChildren(emptyState('cloud_off', t('Couldn’t find a read'), e.message, button(t('Try again'), { onclick: load }))); }
  }
  await load();
}
