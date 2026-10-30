import { t } from '../i18n.js';
import { languageName } from '../languages.js';
import { h, icon } from '../ui.js';

export function languageBadge(value, { source = false } = {}) {
  const name = languageName(value);
  if (!name) return null;
  const label = source ? t('Source language: {language}', { language: name }) : t('Language: {language}', { language: name });
  return h('span.language-badge', { title: label, 'aria-label': label }, icon('translate'), h('span', name));
}
