# 🌍 Translating Flyleaf

Flyleaf's interface is written in English. Each other language is one JSON file in
[`public/locales/`](../public/locales) that maps the English text to its translation:

```json
{
  "Continue reading": "Seguir leyendo",
  "{n} new in {title}": "{n} nuevos en {title}"
}
```

Text without a translation (an empty string, or a key that's missing) simply shows in English,
so a language can be added a little at a time.

## Adding a language

1. Add it to [`public/locales/index.json`](../public/locales/index.json), for example
   `{ "code": "fr", "name": "Français" }`. Use the language's own name, and an
   [IETF code](https://en.wikipedia.org/wiki/IETF_language_tag) (`fr`, `pt-BR`…).
2. Run `npm run i18n`. It creates `public/locales/fr.json` with every string to translate.
3. Fill in the translations and open a pull request.

People choose the language in **Settings → Preferences → Language**. *Automatic* uses the
browser's language when there's a file for it.

## Rules for translators

- Keep `{placeholders}` exactly as they are; you can move them around the sentence.
- Plurals are separate keys: `"{n} book"` and `"{n} books"`.
- Keep `(B)`, `(T)`, `(/)` and other keyboard hints in titles.
- Don't translate *Flyleaf*, *OPDS*, *EPUB* and other names.

## For developers: making text translatable

Wrap UI text in `t()` from [`public/js/i18n.js`](../public/js/i18n.js), always with the English
text written out (the extractor reads it from the code):

```js
import { t, plural, N_ } from '../i18n.js';

button(t('Download'));
t('{n} new in {title}', { n: 3, title: s.name });
plural(count, '{n} book', '{n} books');
```

Lists defined when a file loads (before the language is known) mark their text with `N_('…')`
and translate it where it's shown: `t(item.label)`.

Then run `npm run i18n` to update `template.json` and every language file
(`npm run i18n -- --prune` also removes strings that are no longer used).

### What's translatable so far

The navigation, top bar and notifications, Home, sign-in / sign-up / setup, the settings
navigation and Preferences, the reader's controls and search, and the saved-offline page.
The rest of the interface still needs wrapping in `t()`. Pull requests that convert a view
at a time are welcome.
