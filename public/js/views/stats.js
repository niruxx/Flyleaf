import { api } from '../api.js';
import { onLeave } from '../router.js';
import { h, icon, topBar, cover, formatDuration, segmented, emptyState } from '../ui.js';
import { accountButton } from './common.js';

const KIND_LABEL = { books: 'Books', manga: 'Manga', comics: 'Comics' };

export async function statsView(view, params, stale) {
  const bar = topBar('Reading stats', accountButton());
  onLeave(bar.cleanup);
  const page = h('div.page');
  view.append(bar, page);

  let days = 30;
  const body = h('div');
  page.append(
    h('div', { style: { margin: '8px 0 16px' } },
      segmented([{ value: 7, label: 'Week' }, { value: 30, label: 'Month' }, { value: 365, label: 'Year' }], days, (v) => {
        days = v;
        load();
      }),
    ),
    body,
  );

  async function load() {
    const s = await api.stats(days);
    if (stale()) return;
    body.replaceChildren();

    if (!s.totalSeconds && !s.finished) {
      body.append(emptyState('insights', 'No reading yet', 'Your reading time, streaks and finished books will show up here once you start reading.'));
      return;
    }

    const periodSeconds = s.daily.reduce((a, d) => a + d.seconds, 0);
    const activeInPeriod = s.daily.filter((d) => d.seconds > 0).length;

    body.append(
      h('div.stat-grid',
        stat('schedule', formatDuration(periodSeconds, { short: true }), days === 7 ? 'This week' : days === 30 ? 'Last 30 days' : 'Last 12 months'),
        stat('local_fire_department', `${s.streak} ${s.streak === 1 ? 'day' : 'days'}`, 'Current streak'),
        stat('task_alt', String(s.finished), 'Finished'),
        stat('hourglass_top', formatDuration(s.totalSeconds, { short: true }), 'All-time reading'),
      ),
      h('section.section', chart(s, days), h('p.body-small.muted', { style: { marginTop: '8px' } },
        `${activeInPeriod} active ${activeInPeriod === 1 ? 'day' : 'days'} · average ${formatDuration(activeInPeriod ? periodSeconds / activeInPeriod : 0, { short: true })} per reading day`)),
    );

    if (s.byKind.length > 1) {
      const total = s.byKind.reduce((a, k) => a + k.seconds, 0) || 1;
      body.append(
        h('section.section', h('div.section-head', h('h2', 'By type')),
          h('div.chart-card', s.byKind.map((k) =>
            h('div', { style: { margin: '8px 0' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between' }, class: 'body-medium' },
                h('span', KIND_LABEL[k.kind] || k.kind), h('span.muted', formatDuration(k.seconds, { short: true }))),
              h('div.progress', { style: { marginTop: '6px', height: '8px' } }, h('span', { style: { width: `${(k.seconds / total) * 100}%` } })),
            ),
          )),
        ),
      );
    }

    if (s.topBooks.length) {
      body.append(
        h('section.section', h('div.section-head', h('h2', 'Most read')),
          h('div.list.card', s.topBooks.map(({ book, seconds }) =>
            h('a.list-item.state', { href: `#/book/${book.id}` },
              h('div', { style: { width: '40px', flex: 'none' } }, cover(book, { showProgress: false })),
              h('div.text', h('div.headline', book.title), h('div.supporting', book.series || book.author || '')),
              h('span.trailing', formatDuration(seconds, { short: true })),
            ),
          )),
        ),
      );
    }
  }

  await load();
}

function stat(ic, value, label) {
  return h('div.stat', icon(ic), h('div.value', value), h('div.label', label));
}

function chart(s, days) {
  // Build a dense series of buckets (days, or months for the year view).
  const map = new Map(s.daily.map((d) => [d.day, d.seconds]));
  const buckets = [];
  const start = new Date(`${s.startDay}T00:00:00`);
  if (days > 60) {
    const months = new Map();
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const iso = isoDay(d);
      const m = months.get(key) || { label: d.toLocaleDateString(undefined, { month: 'short' }), seconds: 0, today: false };
      m.seconds += map.get(iso) || 0;
      if (iso === s.today) m.today = true;
      months.set(key, m);
    }
    buckets.push(...months.values());
  } else {
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = isoDay(d);
      buckets.push({
        label: days <= 7 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        seconds: map.get(iso) || 0,
        today: iso === s.today,
      });
    }
  }
  const max = Math.max(...buckets.map((b) => b.seconds), 60);
  return h('div.chart-card',
    h('div.title-small', { style: { marginBottom: '4px' } }, 'Time spent reading'),
    h('div.bars', { role: 'img', 'aria-label': 'Reading time chart' },
      buckets.map((b) =>
        h(`div.b${b.seconds ? '' : '.zero'}${b.today ? '.today' : ''}`, {
          style: { height: `${b.seconds ? Math.max(4, (b.seconds / max) * 100) : 2}%` },
          title: `${b.label}: ${formatDuration(b.seconds)}`,
        }),
      ),
    ),
    h('div.bars-axis', h('span', buckets[0]?.label), buckets.length > 2 && h('span', buckets[Math.floor(buckets.length / 2)].label), h('span', buckets.at(-1)?.label)),
  );
}

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
