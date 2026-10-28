// Translations. UI text is written in English and wrapped in t():
//
//   t('Continue reading')
//   t('{n} new in {title}', { n: 3, title: 'Berserk' })
//
// The English text is the key, so code stays readable and untranslated text simply shows in
// English. Each language is a JSON file in /locales (English → translation), listed in
// /locales/index.json. `npm run i18n` collects every t('…') into /locales/template.json and adds
// new keys to each language file. See docs/translating.md.

const STORE = 'flyleaf.lang';
let dict = {};
let lang = 'en';

/** Translate `text`, filling {placeholders} from `vars`. */
export function t(text, vars) {
  let out = dict[text] || text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return out;
}

/**
 * Marks text for translation without translating it yet – for lists defined when a file loads,
 * before the language is known. Translate where it's shown: t(item.label).
 */
export const N_ = (text) => text;

/** "1 book" / "3 books" (plural forms are their own keys: t('{n} book') and t('{n} books')). */
export const plural = (n, one, many, vars = {}) => t(n === 1 ? one : many, { n: n.toLocaleString(lang), ...vars });

export const currentLanguage = () => lang;

/** The languages there are files for: [{ code, name }]. */
export async function languages() {
  try {
    return await (await fetch('/locales/index.json')).json();
  } catch {
    return [{ code: 'en', name: 'English' }];
  }
}

/** The best language for this browser among `available`. */
function pick(wanted, available) {
  const codes = available.map((l) => l.code);
  for (const w of wanted.filter(Boolean)) {
    const base = w.toLowerCase().split('-')[0];
    const hit = codes.find((c) => c.toLowerCase() === w.toLowerCase()) || codes.find((c) => c.split('-')[0] === base);
    if (hit) return hit;
  }
  return 'en';
}

/**
 * Load a language: `preferred` (the user's setting), else the one used last on this device,
 * else the browser's. Call before the first render.
 */
export async function initLanguage(preferred = null) {
  let saved = null;
  try {
    saved = localStorage.getItem(STORE);
  } catch {}
  const available = await languages();
  const code = pick([preferred, preferred ? null : saved, ...(navigator.languages || [navigator.language])], available);
  await setLanguage(code);
  return code;
}

export async function setLanguage(code) {
  lang = code || 'en';
  dict = {};
  if (lang !== 'en') {
    try {
      const all = await (await fetch(`/locales/${lang}.json`)).json();
      // Untranslated (empty) entries fall back to English.
      for (const [k, v] of Object.entries(all)) if (v) dict[k] = v;
    } catch {
      lang = 'en';
    }
  }
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(STORE, lang);
  } catch {}
}
