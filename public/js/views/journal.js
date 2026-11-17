import { api, localDay } from '../api.js';
import { h, icon, button, field, cover, pageHeader, formatDuration, emptyState, confirmDialog, snackbar, skeleton } from '../ui.js';
import { t, plural } from '../i18n.js';
import { editReflection, MOODS, journalMarkdown } from '../components/reflection.js';

export async function journalView(view, params, stale) {
  const page = h('div.page.journal-page');
  const month = field(t('Month'), { type: 'month', value: /^\d{4}-(0[1-9]|1[0-2])$/.test(params.query.get('month') || '') ? params.query.get('month') : localDay().slice(0, 7), min: '1970-01', max: '9998-12' });
  const body = h('div');
  let data = null, run = 0;
  const add = button(t('Add a reflection'), { icon: 'edit_note', onclick: async () => {
    const saved = await editReflection({ books: (data?.reading || []).map(row => row.book), day: month.input.value === localDay().slice(0, 7) ? localDay() : `${month.input.value}-01` });
    if (saved) { month.input.value = saved.slice(0, 7); load(); }
  } });
  const exportBtn = button(t('Export month'), { variant: 'outlined', icon: 'download', disabled: true, onclick: () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([journalMarkdown(data)], { type: 'text/markdown;charset=utf-8' }));
    const a = h('a', { href: url, download: `flyleaf-journal-${data.month}.md` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  page.append(pageHeader(t('Reading journal')), h('p.muted', t('Your reading days, the passages you kept, and the thoughts you want to remember. Private to your account.')),
    h('div.reading-room-toolbar', month, add, exportBtn), body);
  view.append(page);
  month.input.addEventListener('change', () => load());
  async function load() {
    const token = ++run;
    exportBtn.disabled = true;
    data = null;
    body.replaceChildren(skeleton('list'));
    try {
      const value = month.input.value;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(t('Choose a valid month.'));
      const [year, index] = value.split('-').map(Number);
      const result = await api.journal(value, new Date(year, index - 1, 1).getTime(), new Date(year, index, 1).getTime());
      if (stale() || token !== run) return;
      data = result; exportBtn.disabled = false;
      draw();
    } catch (e) { if (!stale() && token === run) body.replaceChildren(emptyState('cloud_off', t('Couldn’t load your journal'), e.message, button(t('Try again'), { onclick: load }))); }
  }
  function draw() {
    const days = [...new Set([...data.reading.map(r => r.day), ...data.entries.map(e => e.day), ...data.highlights.map(a => localDay(new Date(a.createdAt)))])].sort().reverse();
    const stats = h('div.journal-summary',
      h('div', icon('schedule'), h('strong', formatDuration(data.reading.reduce((sum, r) => sum + r.seconds, 0), { short: true })), h('span', t('Time reading'))),
      h('div', icon('auto_stories'), h('strong', String(new Set(data.reading.map(r => r.book.id)).size)), h('span', t('Books visited'))),
      h('div', icon('edit_note'), h('strong', String(data.entries.length)), h('span', t('Reflections'))),
      h('div', icon('format_quote'), h('strong', String(data.highlights.length)), h('span', t('Highlights saved'))));
    body.replaceChildren(stats, ...days.map(day => {
      const reads = data.reading.filter(r => r.day === day), entries = data.entries.filter(e => e.day === day);
      const highlights = data.highlights.filter(a => localDay(new Date(a.createdAt)) === day);
      return h('section.journal-day', h('h2', new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })),
        ...reads.map(row => h('a.journal-reading.state', { href: `#/series/${row.book.seriesId}` },
          h('div.journal-cover', cover(row.book, { showProgress: false })), h('div', h('div.title-medium', row.book.title), h('p.muted', `${formatDuration(row.seconds, { short: true })}${row.pages ? ` · ${t('{n} pages', { n: row.pages })}` : ''}`)), icon('chevron_right'))),
        ...entries.map(entry => h('article.reflection-card',
          h('div.section-head', h('h3', entry.book?.title || t('A moment to reflect')), entry.mood && h('span.chip.static', t(MOODS[entry.mood] || entry.mood))),
          h('p.reflection-text', entry.body),
          h('div.reflection-actions',
            button(t('Edit'), { variant: 'text', icon: 'edit', onclick: async () => { const saved = await editReflection({ entry, books: data.reading.map(row => row.book) }); if (saved) { month.input.value = saved.slice(0, 7); load(); } } }),
            button(t('Delete'), { variant: 'text', icon: 'delete', onclick: async () => {
              if (!await confirmDialog({ title: t('Delete this reflection?'), message: t('This removes it from your private journal.'), danger: true })) return;
              try { await api.deleteReflection(entry.id); load(); } catch (e) { snackbar(e.message); }
            } })))),
        highlights.length > 0 && h('details.journal-highlights', h('summary', plural(highlights.length, '{n} highlight saved', '{n} highlights saved')),
          highlights.map(item => h('blockquote', h('p', item.text || ''), item.note && h('p.muted', item.note), h('a', { href: `#/read/${item.book.id}?loc=${encodeURIComponent(item.locator)}` }, item.book.title)))));
    }), ...(!days.length ? [emptyState('auto_stories', t('A fresh page'), t('Your reading activity will appear here. Add a reflection whenever a story gives you something to keep.'))] : []));
  }
  await load();
}
