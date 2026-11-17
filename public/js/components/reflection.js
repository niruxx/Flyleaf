import { api, localDay } from '../api.js';
import { h, field, formDialog } from '../ui.js';
import { t } from '../i18n.js';

export const MOODS = { reflective: 'Reflective', delighted: 'Delighted', curious: 'Curious', moved: 'Moved', challenged: 'Challenged', disappointed: 'Disappointed' };
export async function editReflection({ entry, books = [], book, day } = {}) {
  const choices = [...new Map([book, entry?.book, ...books].filter(Boolean).map(b => [b.id, b])).values()];
  const date = field(t('Date'), { type: 'date', min: '1970-01-01', max: '9998-12-31', value: entry?.day || day || localDay(), required: true });
  const selection = field(t('Book'), { value: entry?.book?.id || book?.id || '', options: [{ value: '', label: t('General reflection') }, ...choices.map(b => ({ value: b.id, label: b.series && b.series !== b.title ? `${b.series} · ${b.label || b.title}` : b.title }))] });
  const mood = field(t('How did it leave you?'), { value: entry?.mood || '', options: [{ value: '', label: t('No mood selected') }, ...Object.entries(MOODS).map(([value, label]) => ({ value, label: t(label) }))] });
  const body = field(t('Your reflection'), { multiline: true, rows: 7, maxlength: 10000, required: true, value: entry?.body || '', support: t('What stayed with you? A thought, a question, or something to revisit. Private to your account.') });
  let saved = false;
  await formDialog({ title: t(entry ? 'Edit reflection' : 'Add a reflection'), icon: 'edit_note', fields: [date, selection, mood, body], submit: t('Save'),
    onSubmit: async () => {
      const value = { day: date.input.value, bookId: selection.input.value ? Number(selection.input.value) : null, mood: mood.input.value || null, body: body.input.value };
      if (entry) await api.updateReflection(entry.id, value);
      else await api.addReflection(value);
      saved = value.day;
    } });
  return saved;
}

export function journalMarkdown(data) {
  const lines = [`# Reading journal — ${data.month}`, ''];
  for (const day of [...new Set([...data.reading.map(r => r.day), ...data.entries.map(e => e.day)])].sort().reverse()) {
    lines.push(`## ${day}`, '');
    for (const row of data.reading.filter(r => r.day === day)) lines.push(`- ${row.book.title}: ${Math.round(row.seconds / 60)} min${row.pages ? `, ${row.pages} pages` : ''}`);
    for (const entry of data.entries.filter(e => e.day === day)) lines.push('', `### ${entry.book?.title || 'Reflection'}${entry.mood ? ` · ${entry.mood}` : ''}`, '', entry.body, '');
    lines.push('');
  }
  if (data.highlights.length) lines.push('## Highlights saved this month', '');
  for (const item of data.highlights) {
    lines.push(`### ${item.book.title}`, '', ...(item.text || '').split('\n').map(line => `> ${line}`), '', item.note || '', '');
  }
  return lines.join('\n');
}
