import { t, plural } from '../i18n.js';
// First-run setup wizard: account (on /setup), then look & feel, reading, preferences,
// and for the admin, libraries and sharing. Everything here can be changed later in Settings.

import { api } from '../api.js';
import { session, isAdmin, navigate } from '../router.js';
import { prefs, setPref, setTheme } from '../prefs.js';
import { THEMES, themeState } from '../theme.js';
import { h, icon, button, field, formError, segmented, toggleSwitch, snackbar, loading, setButtonLabel } from '../ui.js';
import { TEXT_THEMES } from '../components/reader-settings.js';

export const STEPS = [
  { id: 'account', icon: 'person', get label() { return t('Your account'); }, admin: true },
  { id: 'look', icon: 'palette', get label() { return t('Look & feel'); } },
  { id: 'reading', icon: 'chrome_reader_mode', get label() { return t('Reading'); } },
  { id: 'prefs', icon: 'tune', get label() { return t('Preferences'); } },
  { id: 'library', icon: 'folder_managed', get label() { return t('Libraries'); }, admin: true },
  { id: 'sharing', icon: 'share', get label() { return t('Sharing & sources'); }, admin: true },
  { id: 'done', icon: 'celebration', get label() { return t('All set'); } },
];

const stepsFor = (admin) => STEPS.filter((s) => admin || !s.admin);

/**
 * The wizard's frame: a step rail (desktop) or progress bar (phone), a header, content and footer.
 * `index` is the position in `steps`; `back` animates the content in from the left.
 */
export function onboardFrame(steps, index, { title, subtitle, content, actions, back = false }) {
  const step = steps[index];
  const rail = h('ol.ob-steps', steps.map((s, i) =>
    h('li', { dataset: { state: i < index ? 'done' : i === index ? 'current' : 'todo' } },
      h('span.ob-dot', icon(i < index ? 'check' : s.icon)),
      h('span', s.label)),
  ));
  const pct = Math.round((index / (steps.length - 1)) * 100);
  return h('div.onboard',
    h('aside.ob-rail',
      h('div.ob-brand', h('span.ob-logo', icon('auto_stories', 'filled')), h('span', 'Flyleaf')),
      h('p.ob-rail-title', t('Let’s set up your library')),
      rail,
      h('p.ob-rail-note', icon('info'), t('Everything here can be changed later in Settings.')),
    ),
    h('main.ob-main',
      h('div.ob-top',
        h('div.ob-brand', h('span.ob-logo', icon('auto_stories', 'filled')), h('span', 'Flyleaf')),
        h('span.label-medium.muted', t('Step {value} of {length}', { value: index + 1, length: steps.length })),
        h('div.ob-bar', h('span', { style: { width: `${Math.max(pct, 4)}%` } })),
      ),
      h(`section.ob-stage.${back ? 'ob-in-back' : 'ob-in'}`,
        h('header.ob-head',
          h('span.ob-icon', icon(step.icon, 'filled')),
          h('div', h('h1', title), subtitle && h('p', subtitle))),
        content,
      ),
      actions && h('footer.ob-foot', actions),
    ),
  );
}

// ---------------------------------------------------------------------------

export async function welcomeView(view) {
  const steps = stepsFor(isAdmin());
  // Admins already did "Your account" on /setup.
  let index = steps[0].id === 'account' ? 1 : 0;
  let current = null; // { save?: () => Promise }
  let renderToken = 0;

  async function finish() {
    session.user.prefs = { ...prefs(), onboarded: true };
    await api.savePrefs({ onboarded: true }).catch(() => {});
    navigate('/', { replace: true });
  }

  async function show(i, back = false) {
    const token = ++renderToken;
    index = i;
    const step = steps[i];
    const spec = STEP_RENDER[step.id];
    view.replaceChildren(onboardFrame(steps, i, { title: spec.title(), subtitle: spec.subtitle, content: loading(), back }));
    current = await spec.render();
    if (token !== renderToken) return;

    const isLast = i === steps.length - 1;
    const next = button(isLast ? t('Start reading') : t('Continue'), {
      icon: isLast ? 'auto_stories' : 'arrow_forward',
      onclick: async () => {
        next.disabled = true;
        try {
          await current.save?.();
        } catch (e) {
          snackbar(e.message, { duration: 6000 });
          next.disabled = false;
          return;
        }
        if (isLast) finish();
        else show(i + 1);
      },
    });
    const firstShown = steps[0].id === 'account' ? 1 : 0;
    const actions = [
      i > firstShown ? button(t('Back'), { variant: 'text', icon: 'arrow_back', onclick: () => show(i - 1, true) }) : h('span'),
      h('div.grow'),
      !isLast && button(t('Skip setup'), { variant: 'text', onclick: finish }),
      next,
    ];
    view.replaceChildren(onboardFrame(steps, i, { title: spec.title(), subtitle: spec.subtitle, content: current.el, actions, back }));
    view.querySelector('.ob-foot .btn.filled')?.focus({ preventScroll: true });
  }

  show(index);
}

// ---------------------------------------------------------------------------
// Steps

const firstName = () => (session.user?.displayName || session.user?.username || '').split(' ')[0];

const STEP_RENDER = {
  look: {
    title: () => t('Make it yours{value}', { value: firstName() ? `, ${firstName()}` : '' }),
    get subtitle() { return t('Pick light or dark and a colour theme. The preview updates as you choose.'); },
    render: lookStep,
  },
  reading: {
    title: () => t('How do you like to read?'),
    get subtitle() { return t('These become your default reading profile. You can tweak them per series from inside the reader.'); },
    render: readingStep,
  },
  prefs: {
    title: () => t('A few preferences'),
    get subtitle() { return t('Small things that change how Flyleaf behaves.'); },
    render: prefsStep,
  },
  library: {
    title: () => t('Add your first library'),
    get subtitle() { return t('Point Flyleaf at a folder of books, manga or comics on this server. It indexes it and keeps it up to date.'); },
    render: libraryStep,
  },
  sharing: {
    title: () => t('Sharing & metadata sources'),
    get subtitle() { return t('Optional. Let reading apps connect over OPDS, invite read-only guests, and add API keys for richer metadata.'); },
    render: sharingStep,
  },
  done: {
    title: () => t('You’re all set'),
    subtitle: null,
    render: doneStep,
  },
};

function lookStep() {
  const s = themeState();
  const cards = h('div.ob-themes', THEMES.map((localT) => {
    const prev = `oklch(0.55 ${0.15 * localT.chroma} ${localT.hue})`;
    const cont = `oklch(0.88 ${0.07 * localT.chroma} ${localT.hue})`;
    const tert = `oklch(0.65 ${0.11 * localT.chroma} ${localT.hue + 60})`;
    return h('button.ob-theme', {
      type: 'button',
      'aria-pressed': String(s.theme === localT.id),
      onclick: (e) => {
        setTheme({ theme: localT.id });
        for (const c of cards.children) c.setAttribute('aria-pressed', String(c === e.currentTarget));
        modeSeg.setValue(themeState().mode);
        hue.value = localT.hue;
      },
    },
    h('span.ob-swatch', { style: { background: localT.oled ? '#000' : cont } }, h('span', { style: { background: prev } }), h('span', { style: { background: tert } })),
    h('span.name', localT.name));
  }));
  const modeSeg = segmented([
    { value: 'light', label: t('Light'), icon: 'light_mode' },
    { value: 'dark', label: t('Dark'), icon: 'dark_mode' },
    { value: 'system', label: t('Auto'), icon: 'brightness_auto' },
  ], s.mode, (v) => setTheme({ mode: v }));
  const hue = h('input.slider.hue-slider', { type: 'range', min: 0, max: 359, value: s.hue, 'aria-label': t('Custom colour') });
  hue.addEventListener('input', () => {
    setTheme({ theme: 'custom', hue: Number(hue.value), chroma: 1, oled: false });
    for (const c of cards.children) c.setAttribute('aria-pressed', 'false');
  });

  const tile = (i) => h('span.pv-tile', { style: { '--i': i } }, h('span.pv-art'), h('span.pv-line'), h('span.pv-line.short'));
  const preview = h('div.ob-preview', { 'aria-hidden': 'true' },
    h('div.pv-bar', h('span.pv-round'), h('span.pv-search', icon('search')), h('span.pv-round.accent')),
    h('div.pv-hero',
      h('span.pv-cover'),
      h('div.pv-lines', h('span.pv-line'), h('span.pv-line.short'), h('div.pv-progress', h('span')), h('span.pv-btn', icon('play_arrow', 'filled'), t('Resume')))),
    h('div.pv-label', t('On deck')),
    h('div.pv-row', [0, 1, 2, 3].map(tile)),
  );

  return {
    el: h('div.ob-split',
      h('div.ob-col',
        h('div.ob-field', h('h3', t('Mode')), modeSeg),
        h('div.ob-field', h('h3', t('Theme')), cards),
        h('div.ob-field', h('h3', t('Or any colour')), hue),
      ),
      preview,
    ),
  };
}

async function readingStep() {
  const { profiles } = await api.profiles();
  const profile = profiles.find((p) => p.isDefault) || profiles[0];
  const st = { ...profile.settings };
  const changed = {};
  const set = (k, v) => {
    st[k] = v;
    changed[k] = v;
    updateText();
  };

  const layoutCard = (value, label, text, art) => h('button.ob-choice', {
    type: 'button',
    'aria-pressed': String(st.layout === value),
    onclick: (e) => {
      for (const c of layouts.children) c.setAttribute('aria-pressed', String(c === e.currentTarget));
      set('layout', value);
    },
  }, h(`span.ob-art.${art}`, h('span'), h('span'), h('span')), h('strong', label), h('span', text));
  const layouts = h('div.ob-choices',
    layoutCard('single', t('Single page'), t('One page at a time. Best on phones.'), 'single'),
    layoutCard('double', t('Two-page spread'), t('Like an open book. Best on tablets and desktops.'), 'double'),
    layoutCard('webtoon', t('Webtoon'), t('One long vertical strip you scroll through.'), 'webtoon'),
  );

  const sample = h('div.ob-text-sample',
    h('strong', t('Chapter One')),
    h('p', t('The lamps along the harbour were still burning when Mara opened the book again. She had promised herself one more chapter, and then another, until the gulls began to call and the sky turned the colour of old paper.')));
  function updateText() {
    const localT = TEXT_THEMES[st.textTheme] || TEXT_THEMES.light;
    sample.style.background = localT.bg;
    sample.style.color = localT.fg;
    sample.style.fontSize = `${(15 * st.fontSize) / 100}px`;
    sample.style.lineHeight = String(st.lineHeight);
  }
  updateText();

  const textThemes = h('div.ob-text-themes', [['auto', t('Match app')], ...Object.entries(TEXT_THEMES).map(([k, v]) => [k, v.label])].map(([key, label]) => {
    const localT = TEXT_THEMES[key];
    return h('button.ob-text-theme', {
      type: 'button',
      'aria-pressed': String(st.textTheme === key),
      onclick: (e) => {
        for (const b of textThemes.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
        set('textTheme', key);
      },
    }, h('span.aa', { style: { background: localT ? localT.bg : 'linear-gradient(135deg, #fbfaf7 50%, #1b1c20 50%)', color: localT ? localT.fg : '#888' } }, 'Aa'), h('span', label));
  }));
  const size = h('input.slider', { type: 'range', min: 70, max: 200, step: 5, value: st.fontSize, 'aria-label': t('Text size') });
  const sizeOut = h('span.label-large', `${st.fontSize}%`);
  const fill = () => size.style.setProperty('--fill', `${((size.value - 70) / 130) * 100}%`);
  fill();
  size.addEventListener('input', () => {
    fill();
    sizeOut.textContent = `${size.value}%`;
    set('fontSize', Number(size.value));
  });

  const toggle = (key, title, sub) => h('label.ob-toggle',
    h('div', h('div.title-small', title), h('div.body-small.muted', sub)),
    toggleSwitch(Boolean(st[key]), (v) => set(key, v), title));

  return {
    el: h('div.ob-stack',
      h('div.ob-section-title', icon('auto_stories'), t('Manga & comics')),
      layouts,
      h('div.ob-field', h('h3', t('Reading direction')),
        segmented([
          { value: 'auto', label: t('Automatic'), icon: 'auto_mode', title: t('Right-to-left for manga libraries, left-to-right otherwise') },
          { value: 'ltr', label: t('Left → right'), icon: 'arrow_forward' },
          { value: 'rtl', label: t('Right → left'), icon: 'arrow_back' },
        ], st.direction, (v) => set('direction', v)),
        h('p.body-small.muted', t('Automatic reads manga right-to-left and everything else left-to-right.'))),
      h('div.ob-section-title', icon('menu_book'), t('Ebooks')),
      h('div.ob-split.tight',
        h('div.ob-col',
          h('div.ob-field', h('h3', t('Page colour')), textThemes),
          h('div.ob-field', h('h3', t('Text size')), h('div.ob-slider-row', icon('text_decrease'), size, icon('text_increase'), sizeOut)),
          h('div.ob-field', h('h3', t('Line spacing')), segmented([
            { value: 1.3, label: t('Tight') },
            { value: 1.5, label: t('Normal') },
            { value: 1.8, label: t('Loose') },
          ], st.lineHeight, (v) => set('lineHeight', v))),
        ),
        sample,
      ),
      h('div.ob-section-title', icon('touch_app'), t('Controls')),
      h('div.ob-toggles',
        toggle('tapToPaginate', t('Tap to turn pages'), t('Tap the left or right edge of the screen.')),
        toggle('swipeToPaginate', t('Swipe to turn pages'), t('Swipe sideways on touch screens.')),
        toggle(t('immersive'), t('Immersive mode'), t('Hide page numbers and all controls while reading.')),
      ),
    ),
    save: () => (Object.keys(changed).length ? api.updateProfile(profile.id, { settings: changed }) : null),
  };
}

function prefsStep() {
  const p = prefs();
  const card = (key, ic, title, sub) => h('label.ob-pref',
    h('span.ob-pref-icon', icon(ic)),
    h('div', h('div.title-small', title), h('div.body-small.muted', sub)),
    toggleSwitch(Boolean(p[key]), (v) => setPref(key, v), title));
  return {
    el: h('div.ob-prefs',
      card('colorScape', 'gradient', t('Colorscape'), t('Tint each series page with colours from its artwork.')),
      card('blurUnreadSummaries', 'blur_on', t('Spoiler-free summaries'), t('Blur a series summary until you start reading it.')),
      card('blurMature', 'visibility_off', t('Blur adult artwork'), t('Blur covers of series rated Adults only (18+).')),
      card('promptOnDownload', 'download', t('Ask before downloading'), t('Confirm before a book or series downloads to this device.')),
      card('dataSaver', 'data_saver_on', t('Data saver'), t('Load smaller page images. Handy on mobile data.')),
      card('disableAnimations', 'animation', t('Reduce motion'), t('Turn off page transitions and other animations.')),
      card('collapseRelationships', 'hub', t('Collapse related series'), t('Start the “Related series” section closed.')),
    ),
  };
}

const KIND_ICON = { books: 'menu_book', manga: 'auto_stories', comics: 'photo_library' };

async function libraryStep() {
  const admin = await import('./settings-admin.js');
  const list = h('div.ob-libs');
  let providers = null;

  async function refresh() {
    const libs = await api.libraries();
    list.replaceChildren(...(libs.length
      ? libs.map((l) => h('div.ob-lib',
        h('span.ob-pref-icon', icon(KIND_ICON[l.kind] || 'folder')),
        h('div', h('div.title-small', l.name), h('div.body-small.muted', `${l.path} · ${admin.MODE_LABEL[l.mode] || l.mode}`)),
        l.seriesCount ? h('span.ob-badge', icon('check'), t('{seriesCount} series', { seriesCount: l.seriesCount })) : h('span.ob-badge', h('span.spinner.small'), t('Scanning…'))))
      : [h('div.ob-empty', icon('folder_open'), h('div.title-small', t('No libraries yet')), h('div.body-small.muted', t('You can also skip this and add one later from Settings → Libraries.')))]));
    setButtonLabel(addBtn, libs.length ? t('Add another library') : t('Add a library'));
    // Keep counts fresh while the first scan runs.
    clearTimeout(poll);
    if (libs.some((l) => !l.seriesCount)) poll = setTimeout(() => list.isConnected && refresh(), 2500);
  }
  let poll;
  const addBtn = button(t('Add a library'), {
    icon: 'create_new_folder',
    variant: 'tonal',
    onclick: async () => {
      providers ||= await api.providers();
      await admin.libraryDialog(null, providers, { onSaved: refresh });
    },
  });
  await refresh();

  const kinds = [
    ['menu_book', t('Regular books'), t('EPUB, MOBI, AZW3, FB2, TXT, PDF. Each book is its own entry; series come from book metadata.')],
    ['text_fields', t('Kavita style'), t('Series from file names like “One Piece v01.cbz”. Folders don’t matter.')],
    ['folder_open', t('Komga style'), t('Every folder is one series, named after the folder.')],
  ];
  return {
    el: h('div.ob-stack',
      list,
      h('div', addBtn),
      h('div.ob-section-title', icon('lightbulb'), t('Three ways to organise')),
      h('div.ob-hints', kinds.map(([ic, localT, s]) => h('div.ob-hint', icon(ic), h('div', h('div.title-small', localT), h('div.body-small.muted', s))))),
      h('p.body-small.muted', t('New libraries are private to you. Choose “Shared with users” in the library dialog to let guests read it, or give a library to a specific user. If Flyleaf runs as a service, the service user needs permission to read the folder.')),
    ),
  };
}

async function sharingStep() {
  const s = await api.adminSettings();
  const publicUrl = field(t('Public URL'), { value: s.publicUrl || '', type: 'url', support: t('If people reach Flyleaf from outside your network, e.g. https://books.example.com. Used for OPDS links.') });
  let opds = s.opdsEnabled !== false;
  const comicvine = field(t('ComicVine API key'), { value: s.comicvineKey || '', autocomplete: 'off', support: t('Free at comicvine.gamespot.com/api – needed for western comics.') });
  const google = field(t('Google Books API key'), { value: s.googleBooksKey || '', autocomplete: 'off', support: t('Optional – avoids the shared rate limit.') });
  const mal = field(t('MyAnimeList Client ID'), { value: s.malClientId || '', autocomplete: 'off', support: t('Optional – uses the official MAL API instead of Jikan.') });
  const err = h('div');
  const guests = h('div.ob-libs');
  const admin = await import('./settings-admin.js');

  async function refreshGuests() {
    const users = (await api.users()).filter((u) => u.role !== 'admin');
    guests.replaceChildren(...users.map((u) => h('div.ob-lib',
      h('span.avatar', { style: { width: '36px', height: '36px', cursor: 'default' } }, (u.displayName || u.username)[0]),
      h('div', h('div.title-small', u.displayName), h('div.body-small.muted', t('@{username} · read-only', { username: u.username }))))));
  }
  await refreshGuests();

  return {
    el: h('div.ob-stack',
      err,
      h('div.ob-section-title', icon('rss_feed'), t('Reading apps (OPDS)')),
      h('label.ob-toggle',
        h('div', h('div.title-small', t('Enable the OPDS catalog')), h('div.body-small.muted', t('Lets apps like Panels, KOReader and Moon+ Reader browse and stream your library. Each user gets a personal link in Settings → OPDS.'))),
        toggleSwitch(opds, (v) => (opds = v), t('Enable OPDS'))),
      publicUrl,
      h('div.ob-section-title', icon('group'), t('Guests')),
      h('p.body-small.muted', t('Guests can read and keep their own progress, but can’t change libraries or metadata.')),
      guests,
      h('div', button(t('Add a guest'), { variant: 'tonal', icon: 'person_add', onclick: () => admin.userDialog(null, { onSaved: refreshGuests }) })),
      h('details.ob-details',
        h('summary', icon('key'), t('Metadata API keys (optional)'), icon('expand_more')),
        h('div.ob-stack', comicvine, google, mal)),
    ),
    save: async () => {
      err.replaceChildren();
      try {
        await api.saveAdminSettings({
          publicUrl: publicUrl.input.value,
          opdsEnabled: opds,
          comicvineKey: comicvine.input.value,
          googleBooksKey: google.input.value,
          malClientId: mal.input.value,
        });
      } catch (e) {
        err.append(formError(e.message));
        throw e;
      }
    },
  };
}

async function doneStep() {
  const libs = isAdmin() ? await api.libraries().catch(() => []) : [];
  const localT = themeState();
  const themeName = THEMES.find((x) => x.id === localT.theme)?.name || t('Custom colour');
  const items = [
    ['palette', t('{themeName} theme', { themeName: themeName }), { light: t('Light mode'), dark: t('Dark mode'), system: t('Follows your device') }[localT.mode]],
    ['chrome_reader_mode', t('Reading profile saved'), t('Change it any time in Settings → Reading profiles')],
    isAdmin() && ['folder_managed', libs.length ? plural(libs.length, '{length} library', '{length} libraries', { length: libs.length }) : t('No libraries yet'), libs.length ? t('Scanning in the background') : t('Add one from Settings → Libraries')],
  ].filter(Boolean);
  return {
    el: h('div.ob-done',
      h('div.ob-burst', { 'aria-hidden': 'true' }, Array.from({ length: 12 }, (_, i) => h('span', { style: { '--i': i } })), h('span.ob-burst-icon', icon('auto_stories', 'filled'))),
      h('p.body-large', t('Your library is ready. Here’s what you set up:')),
      h('div.ob-summary', items.map(([ic, title, sub], i) => h('div.ob-lib', { style: { '--i': i } },
        h('span.ob-pref-icon', icon(ic)), h('div', h('div.title-small', title), h('div.body-small.muted', sub))))),
      h('p.body-small.muted', t('Tip: on iPhone, tap Share → Add to Home Screen to use Flyleaf like an app.')),
    ),
  };
}
