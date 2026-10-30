import { currentLanguage, t } from './i18n.js';

/** Metadata can contain one code, a list, or delimited language codes. */
export function languageCodes(value) {
  return [...new Set([].concat(value || []).flatMap((v) => typeof v === 'string' ? v.split(/[,;]+/) : [])
    .map((v) => v.trim().replace(/_/g, '-').toLowerCase()).filter(Boolean))];
}

export function languageName(value) {
  return languageCodes(value).map((code) => {
    if (code === 'all' || code === 'multi') return t('Multiple languages');
    if (code === 'und') return t('Unknown language');
    try {
      return new Intl.DisplayNames([currentLanguage()], { type: 'language' }).of(code) || code;
    } catch {
      return code;
    }
  }).join(', ');
}
