import { api } from '../api.js';
import { session, navigate } from '../router.js';
import { h, icon, button, cover, formatDuration, segmented, emptyState, pageHeader, stagger, field, formDialog, snackbar } from '../ui.js';

const KIND_LABEL = { books: 'Books', manga: 'Manga', comics: 'Comics' };
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: 'short' }));
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2000, 0, 2 + i).toLocaleDateString(undefined, { weekday: 'short' }));

export async function statsView(view, params, stale) {
  const page = h('div.page', { style: { maxWidth: '1100px' } });
  view.append(page, );
  page.append(pageHeader('Reading stats'));

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

    const year = s.goal.year;
    body.append(goalsRow(s, load), reviewBanner(year));

    if (!s.totalSeconds && !s.finished) {
      body.append(emptyState('insights', 'No reading yet', 'Your reading time, streaks and finished books will show up here once you start reading.'));
      return;
    }

    const periodSeconds = s.daily.reduce((a, d) => a + d.seconds, 0);
    const activeInPeriod = s.daily.filter((d) => d.seconds > 0).length;
    const best = s.longestStreak?.days || 0;

    body.append(
      stagger(h('div.stat-grid',
        stat('schedule', formatDuration(periodSeconds, { short: true }), days === 7 ? 'This week' : days === 30 ? 'Last 30 days' : 'Last 12 months'),
        stat('local_fire_department', `${s.streak} ${s.streak === 1 ? 'day' : 'days'}`, best > s.streak ? `Current streak · best ${best}` : 'Current streak · your best'),
        stat('task_alt', String(s.finished), 'Finished'),
        stat('hourglass_top', formatDuration(s.totalSeconds, { short: true }), 'All-time reading'),
      )),
      h('section.section', chart(s, days), h('p.body-small.muted', { style: { marginTop: '8px' } },
        `${activeInPeriod} active ${activeInPeriod === 1 ? 'day' : 'days'} · average ${formatDuration(activeInPeriod ? periodSeconds / activeInPeriod : 0, { short: true })} per reading day`)),
      h('section.section', h('div.section-head', h('h2', 'Reading activity')), heatmap(s)),
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
            h('a.list-item.state', { href: `#/series/${book.seriesId}` },
              h('div', { style: { width: '40px', flex: 'none' } }, cover(book, { showProgress: false })),
              h('div.text', h('div.headline', book.series || book.title), h('div.supporting', book.label || book.author || '')),
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

// ---------------------------------------------------------------------------
// Goals

/** A progress ring (0–1) with text in the middle. */
function ring(fraction, centre, { size = 96, stroke = 9 } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.classList.add('ring');
  for (const [cls, len] of [['track', c], ['fill', c * Math.min(1, Math.max(0, fraction))]]) {
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', size / 2);
    circle.setAttribute('cy', size / 2);
    circle.setAttribute('r', r);
    circle.setAttribute('stroke-width', stroke);
    circle.setAttribute('class', cls);
    circle.style.strokeDasharray = `${len} ${c}`;
    svg.append(circle);
  }
  return h('div.ring-wrap', { style: { width: `${size}px`, height: `${size}px` } }, svg, h('div.ring-text', centre));
}

function goalsRow(s, reload) {
  const { goal } = s;
  const dailyMin = s.dailyGoalMinutes;
  const todayMin = Math.floor(s.todaySeconds / 60);
  const now = new Date();
  const dayOfYear = (now - new Date(now.getFullYear(), 0, 1)) / 86400_000 + 1;
  const expected = goal.books ? Math.floor((goal.books * dayOfYear) / 365) : 0;
  const pace = !goal.books ? null : goal.finished >= goal.books ? 'Goal reached 🎉' : goal.finished >= expected ? `On track · ${goal.books - goal.finished} to go` : `${expected - goal.finished} behind pace`;

  const edit = button('Set goals', { variant: 'text', icon: 'flag', onclick: () => goalDialog(s, reload) });
  return h('section.goals',
    h('div.goal-card',
      ring(goal.books ? goal.finished / goal.books : 0, goal.books ? [h('strong', String(goal.finished)), h('span', `of ${goal.books}`)] : [h('strong', String(goal.finished)), h('span', 'books')]),
      h('div.goal-text',
        h('div.title-medium', `${goal.year} reading goal`),
        h('div.body-medium.muted', goal.books ? `${goal.finished} of ${goal.books} books finished` : 'Set a number of books to finish this year.'),
        pace && h('div.label-large.goal-pace', pace)),
    ),
    h('div.goal-card',
      ring(dailyMin ? todayMin / dailyMin : 0, [h('strong', String(todayMin)), h('span', 'min')]),
      h('div.goal-text',
        h('div.title-medium', 'Today'),
        h('div.body-medium.muted', dailyMin ? `${todayMin} of ${dailyMin} minutes` : `${todayMin} minutes read today`),
        dailyMin > 0 && h('div.label-large.goal-pace', todayMin >= dailyMin ? 'Daily goal done ✓' : `${dailyMin - todayMin} min to go`)),
    ),
    h('div.goals-edit', edit),
  );
}

async function goalDialog(s, reload) {
  const books = field(`Books to finish in ${s.goal.year}`, { type: 'number', value: s.goal.books ?? '', min: 0, max: 10000, support: 'Leave empty for no yearly goal.' });
  const minutes = field('Minutes a day', { type: 'number', value: s.dailyGoalMinutes || '', min: 0, max: 1440, support: 'Leave empty for no daily goal.' });
  await formDialog({
    title: 'Reading goals',
    icon: 'flag',
    fields: [books, minutes],
    onSubmit: async () => {
      await api.setReadingGoal(s.goal.year, books.input.value === '' ? null : Number(books.input.value));
      const m = Math.max(0, Math.min(1440, Math.round(Number(minutes.input.value) || 0)));
      session.user.prefs = await api.savePrefs({ dailyGoalMinutes: m });
      snackbar('Goals saved');
      reload();
    },
  });
}

function reviewBanner(year) {
  // From December on, the year so far is worth a look; before that, last year's.
  const month = new Date().getMonth();
  const y = month >= 11 ? year : year - 1;
  return h('a.review-banner.state', { href: `#/stats/year/${y}` },
    icon('auto_awesome'),
    h('div', h('div.title-medium', `Your ${y} in review`), h('div.body-small', 'Books, time, favourites and streaks – with a card to share')),
    icon('chevron_right'));
}

// ---------------------------------------------------------------------------
// Charts

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
  return barChart(buckets, 'Time spent reading');
}

function barChart(buckets, title, { height } = {}) {
  const max = Math.max(...buckets.map((b) => b.seconds), 60);
  return h('div.chart-card',
    h('div.title-small', { style: { marginBottom: '4px' } }, title),
    h('div.bars', { role: 'img', 'aria-label': title, style: height ? { height } : null },
      buckets.map((b) =>
        h(`div.b${b.seconds ? '' : '.zero'}${b.today ? '.today' : ''}`, {
          style: { height: `${b.seconds ? Math.max(4, (b.seconds / max) * 100) : 2}%` },
          title: `${b.label}: ${formatDuration(b.seconds)}`,
        }),
      ),
    ),
    buckets.length <= 12
      ? h('div.bars-axis.every', buckets.map((b) => h('span', b.label)))
      : h('div.bars-axis', h('span', buckets[0]?.label), buckets.length > 2 && h('span', buckets[Math.floor(buckets.length / 2)].label), h('span', buckets.at(-1)?.label)),
  );
}

/** GitHub-style year of reading days: one column per week, darker = more time. */
function heatmap(s) {
  const map = new Map(s.heatmap.map((d) => [d.day, d.seconds]));
  const values = s.heatmap.map((d) => d.seconds).filter(Boolean).sort((a, b) => a - b);
  const q = (p) => values[Math.floor((values.length - 1) * p)] || 0;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (sec) => (!sec ? 0 : sec <= cuts[0] ? 1 : sec <= cuts[1] ? 2 : sec <= cuts[2] ? 3 : 4);

  const cells = [];
  const months = [];
  const start = new Date(`${s.heatStartDay}T00:00:00`);
  let lastMonth = -1;
  for (let i = 0; ; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = isoDay(d);
    if (iso > s.today) break;
    const week = Math.floor(i / 7);
    if (d.getDay() === 0 && d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth();
      // A partial first month gets no label if the next one starts right after it.
      if (months.length && week - months.at(-1).week < 3) months.pop();
      months.push({ week, label: MONTHS[lastMonth] });
    }
    const sec = map.get(iso) || 0;
    cells.push(h(`span.cell.l${level(sec)}${iso === s.today ? '.today' : ''}`, {
      style: { gridColumn: String(week + 1), gridRow: String(d.getDay() + 1) },
      title: `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}: ${sec ? formatDuration(sec) : 'no reading'}`,
    }));
  }
  const best = s.longestStreak;
  return h('div.chart-card',
    h('div.heatmap-scroll',
      h('div.heatmap',
        h('div.heat-months', months.map((m) => h('span', { style: { gridColumn: `${m.week + 1} / span 4` } }, m.label))),
        h('div.heat-days', [1, 3, 5].map((n) => h('span', { style: { gridRow: String(n + 1) } }, WEEKDAYS[n]))),
        h('div.heat-grid', cells),
      )),
    h('div.heat-foot',
      h('span.body-small.muted', best?.days ? `Longest streak: ${best.days} ${best.days === 1 ? 'day' : 'days'} (${shortDate(best.start)} – ${shortDate(best.end)})` : ''),
      h('span.heat-legend', 'Less', [0, 1, 2, 3, 4].map((l) => h(`span.cell.l${l}`)), 'More')),
  );
}

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shortDate = (day) => (day ? new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

// ---------------------------------------------------------------------------
// Year in review

export async function yearReviewView(view, params, stale) {
  const year = Number(params.year) || new Date().getFullYear();
  const page = h('div.page.year-review', { style: { maxWidth: '1000px' } });
  view.append(page);
  const r = await api.statsYear(year);
  if (stale()) return;

  const years = [...new Set([...r.years, new Date().getFullYear()])].sort((a, b) => b - a);
  const picker = h('div.chip-set', years.map((y) => h('a.chip.state', { href: `#/stats/year/${y}`, 'aria-pressed': String(y === year) }, String(y))));

  const hero = h('section.yr-hero.enter',
    h('div.yr-glow'),
    h('div.label-large', 'Year in review'),
    h('h1.yr-year', String(year)),
    h('p.body-large', r.totalSeconds
      ? `You read for ${formatDuration(r.totalSeconds)} on ${r.activeDays} ${r.activeDays === 1 ? 'day' : 'days'}${r.finished ? ` and finished ${r.finished} ${r.finished === 1 ? 'book' : 'books'}` : ''}.`
      : 'No reading recorded this year yet.'),
    h('div.yr-actions',
      button('Back to stats', { variant: 'text', icon: 'arrow_back', onclick: () => navigate('/stats') }),
      r.totalSeconds > 0 && button('Share card', { variant: 'tonal', icon: 'ios_share', onclick: () => shareCard(r) })),
  );
  page.append(hero, h('div', { style: { margin: '16px 0' } }, picker));
  if (!r.totalSeconds && !r.finished) {
    page.append(emptyState('auto_stories', `Nothing for ${year}`, 'Read something and it’ll show up here.'));
    return;
  }

  const favDay = r.byWeekday.indexOf(Math.max(...r.byWeekday));
  page.append(
    stagger(h('div.stat-grid',
      stat('hourglass_top', formatDuration(r.totalSeconds, { short: true }), 'Time reading'),
      stat('task_alt', String(r.finished), r.goal ? `Finished · goal ${r.goal}` : 'Books finished'),
      stat('description', r.pages ? r.pages.toLocaleString() : '–', 'Pages in finished books'),
      stat('local_fire_department', `${r.longestStreak.days} ${r.longestStreak.days === 1 ? 'day' : 'days'}`, 'Longest streak'),
      stat('calendar_month', String(r.activeDays), 'Reading days'),
      stat('today', new Date(2000, 0, 2 + favDay).toLocaleDateString(undefined, { weekday: 'long' }), 'Favourite day'),
      stat('trending_up', r.busiestDay ? formatDuration(r.busiestDay.seconds, { short: true }) : '–', r.busiestDay ? `Biggest day · ${shortDate(r.busiestDay.day)}` : 'Biggest day'),
      stat('ink_highlighter', String(r.highlights), 'Highlights made'),
    )),
    h('section.section', barChart(r.byMonth.map((seconds, i) => ({ label: MONTHS[i], seconds })), 'Month by month')),
  );

  if (r.topSeries.length) {
    page.append(h('section.section', h('div.section-head', h('h2', 'Your top series')),
      stagger(h('div.yr-top', r.topSeries.map(({ series, seconds }, i) =>
        h('a.yr-top-item.state', { href: `#/series/${series.id}` },
          h('span.yr-rank', String(i + 1)),
          cover({ ...series, title: series.name }, { showProgress: false }),
          h('div.text', h('div.title-small', series.name), h('div.body-small.muted', formatDuration(seconds, { short: true })))))))));
  }

  const ranked = (title, list) => list.length > 0 && h('div.chart-card',
    h('div.title-small', { style: { marginBottom: '8px' } }, title),
    list.map((x) => h('div', { style: { margin: '8px 0' } },
      h('div.body-medium', { style: { display: 'flex', justifyContent: 'space-between' } }, h('span', x.name), h('span.muted', formatDuration(x.seconds, { short: true }))),
      h('div.progress', { style: { marginTop: '6px', height: '8px' } }, h('span', { style: { width: `${(x.seconds / list[0].seconds) * 100}%` } })))));
  if (r.topGenres.length || r.topCreators.length) {
    page.append(h('section.section.yr-pair', ranked('Top genres', r.topGenres), ranked('Top writers', r.topCreators)));
  }

  if (r.finishedBooks.length) {
    page.append(h('section.section', h('div.section-head', h('h2', `Finished in ${year} (${r.finishedBooks.length})`)),
      stagger(h('div.grid', r.finishedBooks.slice().reverse().map((b) =>
        h('a.tile', { href: `#/series/${b.seriesId}`, title: b.label },
          cover(b, { showProgress: false }),
          h('div.t-title', b.series || b.title),
          h('div.t-sub', new Date(b.finishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))))))));
  }
}

/** Draws a shareable 1080×1350 summary card and shares or downloads it. */
async function shareCard(r) {
  const W = 1080;
  const H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const color = (v, f) => css.getPropertyValue(v).trim() || f;
  const primary = color('--md-primary', '#6750a4');
  const tertiary = color('--md-tertiary', '#7d5260');
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, primary);
  g.addColorStop(1, tertiary);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgb(0 0 0 / 0.25)';
  ctx.fillRect(0, 0, W, H);

  const font = (size, weight = 400) => `${weight} ${size}px "Roboto Flex", system-ui, sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.font = font(44, 500);
  ctx.fillText('My year in reading', 80, 140);
  ctx.font = font(220, 800);
  ctx.fillText(String(r.year), 70, 360);

  const tiles = [
    [formatDuration(r.totalSeconds, { short: true }), 'reading'],
    [String(r.finished), r.finished === 1 ? 'book finished' : 'books finished'],
    [String(r.activeDays), 'reading days'],
    [`${r.longestStreak.days}`, 'day longest streak'],
  ];
  tiles.forEach(([value, label], i) => {
    const x = 80 + (i % 2) * 470;
    const y = 470 + Math.floor(i / 2) * 210;
    ctx.fillStyle = 'rgb(255 255 255 / 0.14)';
    ctx.beginPath();
    ctx.roundRect(x, y, 440, 180, 36);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = font(80, 700);
    ctx.fillText(value, x + 36, y + 100);
    ctx.font = font(34);
    ctx.fillText(label, x + 36, y + 148);
  });

  ctx.font = font(36, 600);
  ctx.fillText('Top series', 80, 950);
  ctx.font = font(34);
  r.topSeries.slice(0, 4).forEach((t, i) => {
    let name = `${i + 1}. ${t.series.name}`;
    while (ctx.measureText(name).width > W - 160 && name.length > 4) name = `${name.slice(0, -2)}…`;
    ctx.fillText(name, 80, 1010 + i * 56);
  });
  ctx.font = font(30, 500);
  ctx.fillStyle = 'rgb(255 255 255 / 0.8)';
  ctx.fillText('Flyleaf', 80, H - 70);

  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  const file = new File([blob], `flyleaf-${r.year}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `My ${r.year} in reading` });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
