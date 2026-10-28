import { t, N_ } from '../i18n.js';
// Admin editors: series metadata, artwork, relations, provider matching, volume details.

import { api } from '../api.js';
import { h, icon, iconButton, button, dialog, field, chipInput, formError, snackbar, cover, AGE_RATINGS, STATUS_LABEL, confirmDialog } from '../ui.js';
import { refreshDrawer } from '../shell.js';

const ROLES = [N_('Writer'), N_('Artist'), N_('Penciller'), N_('Inker'), N_('Colorist'), N_('Letterer'), N_('Cover artist'), N_('Editor'), N_('Translator'), N_('Publisher'), N_('Creator')];
const RELATIONS = [
  ['sequel', N_('Sequel')],
  ['prequel', N_('Prequel')],
  ['spin_off', N_('Spin-off')],
  ['side_story', N_('Side story')],
  ['adaptation', N_('Adaptation')],
  ['alternative', N_('Alternative version')],
  ['other', N_('Related')],
];
export const RELATION_LABEL = Object.fromEntries(RELATIONS);

function tabs(names, onSelect) {
  const bar = h('div.tabs', { role: 'tablist' });
  names.forEach(([id, label, ic], i) =>
    bar.append(h('button', { type: 'button', role: 'tab', 'aria-selected': String(i === 0), onclick: (e) => {
      for (const b of bar.children) b.setAttribute('aria-selected', String(b === e.currentTarget));
      e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      onSelect(id);
    } }, ic && icon(ic), label)),
  );
  return bar;
}

/** Full metadata editor for a series. Resolves when closed. */
export async function editSeries(seriesId) {
  const s = await api.series(seriesId);
  const allGenres = (await api.genres().catch(() => [])).map((g) => g.name);

  // General
  const name = field(t('Title'), { value: s.name, required: true });
  const localized = field(t('Localized / original title'), { value: s.localizedName || '' });
  const sortName = field(t('Sort as'), { value: s.sortName || '', support: t('e.g. "Witcher, The"') });
  const summary = field(t('Summary'), { value: s.summary || '', multiline: true });
  const status = field(t('Publication status'), { value: s.status || '', options: [{ value: '', label: t('Unknown') }, ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))] });
  const year = field(t('Year'), { value: s.year ?? '', type: 'number', inputmode: 'numeric' });
  const publisher = field(t('Publisher'), { value: s.publisher || '' });
  const age = field(t('Age rating'), { value: s.ageRating ?? '', options: AGE_RATINGS });
  const language = field(t('Language'), { value: s.language || '' });
  const general = h('div', name, localized, sortName, summary, h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0 12px' } }, status, age, year, publisher, language));

  // Tags
  const genres = chipInput(t('Genres'), s.genres, { suggestions: allGenres });
  const tags = chipInput(t('Tags'), s.tags);
  const tagPanel = h('div', genres, tags);

  // People
  const peopleRows = h('div');
  const addPerson = (p = { name: '', role: 'Writer' }) => {
    const role = field(t('Role'), { value: p.role, options: [...new Set([...ROLES, p.role])].map((r) => ({ value: r, label: ROLES.includes(r) ? t(r) : r })) });
    const nm = field(t('Name'), { value: p.name });
    const row = h('div.row-editor', role, nm, iconButton('delete', t('Remove'), () => row.remove()));
    row.read = () => ({ name: nm.input.value.trim(), role: role.input.value });
    peopleRows.append(row);
  };
  s.people.forEach(addPerson);
  const peoplePanel = h('div', peopleRows, button(t('Add person'), { variant: 'text', icon: 'person_add', onclick: () => addPerson() }));

  // Links
  const linkRows = h('div');
  const addLink = (l = { source: '', url: '' }) => {
    const src = field(t('Label'), { value: l.source || '' });
    const url = field(t('URL'), { value: l.url || '', type: 'url' });
    const row = h('div.row-editor', src, url, iconButton('delete', t('Remove'), () => row.remove()));
    row.read = () => ({ source: src.input.value.trim() || undefined, url: url.input.value.trim() });
    linkRows.append(row);
  };
  s.links.forEach(addLink);
  const linkPanel = h('div', h('p', { style: { marginBottom: '4px' } }, t('Links to MyAnimeList, AniList, MangaDex, publisher pages… are shown on the series page.')), linkRows, button(t('Add link'), { variant: 'text', icon: 'add_link', onclick: () => addLink() }));

  // Artwork
  const preview = h('div', { style: { width: '140px' } }, cover({ ...s, blur: false }, { showProgress: false }));
  const refreshPreview = async () => {
    const fresh = await api.series(seriesId);
    preview.replaceChildren(cover({ ...fresh, blur: false }, { showProgress: false }));
  };
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  fileInput.addEventListener('change', async () => {
    if (!fileInput.files[0]) return;
    try {
      await api.setSeriesCover(seriesId, fileInput.files[0]);
      snackbar(t('Artwork updated'));
      refreshPreview();
    } catch (e) {
      snackbar(e.message);
    }
  });
  const urlField = field(t('Image URL'), { type: 'url' });
  const volumeCovers = h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: '8px', marginTop: '8px' } },
    s.books.filter((b) => b.coverUrl).slice(0, 30).map((b) =>
      h('button', { type: 'button', title: t('Use {label}', { label: b.label }), style: { border: 'none', padding: 0, background: 'none', cursor: 'pointer' }, onclick: async () => {
        await api.setSeriesCoverFromBook(seriesId, b.id);
        snackbar(t('Artwork updated'));
        refreshPreview();
      } }, cover({ ...b, blur: false }, { showProgress: false })),
    ),
  );
  const artPanel = h('div',
    h('div', { style: { display: 'flex', gap: '20px', alignItems: 'flex-start', flexWrap: 'wrap' } },
      preview,
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', flex: '1', minWidth: '200px' } },
        button(t('Upload image'), { variant: 'tonal', icon: 'upload', onclick: () => fileInput.click() }),
        button(t('Reset to first volume'), { variant: 'text', icon: 'restart_alt', onclick: async () => { await api.resetSeriesCover(seriesId); snackbar(t('Artwork reset')); refreshPreview(); } }),
        urlField,
        button(t('Use image from URL'), { variant: 'outlined', icon: 'link', onclick: async () => {
          try {
            await api.setSeriesCoverUrl(seriesId, urlField.input.value.trim());
            snackbar(t('Artwork updated'));
            refreshPreview();
          } catch (e) {
            snackbar(e.message);
          }
        } }),
      ),
    ),
    fileInput,
    s.books.some((b) => b.coverUrl) && h('p.label-large', { style: { marginTop: '16px' } }, t('Or pick a volume cover')),
    volumeCovers,
  );

  // Relations
  const relList = h('div');
  const renderRelations = (list) =>
    relList.replaceChildren(
      ...(list.length
        ? list.map((r) => h('div.list-item.static', h('div', { style: { width: '40px', flex: 'none' } }, cover({ ...r.series, blur: false }, { showProgress: false })), h('div.text', h('div.headline', r.series.name), h('div.supporting', t(RELATION_LABEL[r.kind] || r.kind))),
            iconButton('link_off', t('Remove relation'), async () => {
              await api.removeRelation(seriesId, r.series.id);
              renderRelations((await api.series(seriesId)).relations);
            })))
        : [h('p.muted', t('No related series yet.'))]),
    );
  renderRelations(s.relations);
  const relSearch = field(t('Find a series'));
  const relKind = field(t('Relationship'), { options: RELATIONS.map(([value, label]) => ({ value, label: t(label) })), value: 'sequel' });
  const relResults = h('div');
  let relTimer;
  relSearch.input.addEventListener('input', () => {
    clearTimeout(relTimer);
    relTimer = setTimeout(async () => {
      const term = relSearch.input.value.trim();
      if (!term) return relResults.replaceChildren();
      const { items } = await api.seriesList({ q: term, limit: 6 });
      relResults.replaceChildren(...items.filter((x) => x.id !== seriesId).map((x) =>
        h('button.list-item.state', { type: 'button', onclick: async () => {
          await api.addRelation(seriesId, x.id, relKind.input.value);
          relSearch.input.value = '';
          relResults.replaceChildren();
          renderRelations((await api.series(seriesId)).relations);
        } }, icon('add_link'), h('div.text', h('div.headline', x.name), h('div.supporting', x.libraryName)))));
    }, 220);
  });
  const relPanel = h('div', relList, h('p.label-large', { style: { marginTop: '16px' } }, t('Add a relation')), relKind, relSearch, relResults);

  const panels = { general, tags: tagPanel, people: peoplePanel, links: linkPanel, art: artPanel, relations: relPanel };
  const body = h('div', general);
  const tabBar = tabs([
    ['general', t('General'), 'info'],
    ['tags', t('Genres & tags'), 'sell'],
    ['people', t('People'), 'group'],
    ['links', t('Links'), 'link'],
    ['art', t('Artwork'), 'image'],
    ['relations', t('Relations'), 'hub'],
  ], (id) => body.replaceChildren(panels[id]));
  const err = h('div');
  const lockNote = s.locked.length
    ? h('p.note', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, icon('lock'), t('Locked from automatic updates: {value}', { value: s.locked.join(', ') }),
        button(t('Unlock all'), { variant: 'text', onclick: async (e) => { await api.unlockSeries(seriesId); e.currentTarget.parentElement.remove(); snackbar(t('Fields unlocked')); } }))
    : null;

  await dialog({
    title: t('Edit metadata'),
    className: 'wide fullscreen-compact',
    content: h('div', tabBar, err, body, lockNote),
    actions: [
      { label: t('Cancel') },
      {
        label: t('Save'),
        variant: 'filled',
        onClick: async () => {
          err.replaceChildren();
          try {
            await api.updateSeries(seriesId, {
              name: name.input.value,
              localizedName: localized.input.value,
              sortName: sortName.input.value,
              summary: summary.input.value,
              status: status.input.value,
              year: year.input.value,
              publisher: publisher.input.value,
              ageRating: age.input.value,
              language: language.input.value,
              genres: genres.value,
              tags: tags.value,
              people: [...peopleRows.children].map((r) => r.read()).filter((p) => p.name),
              links: [...linkRows.children].map((r) => r.read()).filter((l) => l.url),
            });
            snackbar(t('Metadata saved'));
            refreshDrawer();
            return true;
          } catch (e) {
            err.append(formError(e.message));
            return false;
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Fetch metadata from a provider

const FIELD_LABELS = {
  get name() { return t('Title'); },
  get localized_name() { return t('Original title'); },
  get summary() { return t('Summary'); },
  get status() { return t('Publication status'); },
  get year() { return t('Year'); },
  get publisher() { return t('Publisher'); },
  get age_rating() { return t('Age rating'); },
  get genres() { return t('Genres'); },
  get tags() { return t('Tags'); },
  get people() { return t('Writers & artists'); },
  get links() { return t('Links (MAL, AniList…)'); },
};

export async function fetchMetadata(series) {
  const providers = await api.providers();
  const usable = providers.filter((p) => p.configured);
  const preferred = { manga: 'anilist', comics: usable.some((p) => p.id === 'comicvine') ? 'comicvine' : 'anilist', books: 'openlibrary' }[series.kind] || 'anilist';
  let provider = usable.find((p) => p.id === preferred)?.id || usable[0]?.id;
  let selected = null;

  const query = field(t('Search'), { value: series.name.replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').trim() || series.name });
  const results = h('div', { style: { marginTop: '12px' } });
  const status = h('div');
  const provSeg = h('div.chip-set', usable.map((p) => h('button.chip.state', { type: 'button', 'aria-pressed': String(p.id === provider), onclick: (e) => {
    provider = p.id;
    for (const c of provSeg.children) c.setAttribute('aria-pressed', String(c === e.currentTarget));
    search();
  } }, p.name)));

  const checks = Object.entries(FIELD_LABELS).map(([k, label]) => {
    const input = h('input', { type: 'checkbox', checked: k !== 'name' });
    input.dataset.field = k;
    return h('label.check', input, label);
  });
  const coverCheck = h('input', { type: 'checkbox', checked: true });
  const applyPanel = h('div', { hidden: true },
    h('p.label-large', { style: { marginTop: '16px' } }, t('Fields to apply')),
    h('div.check-grid', checks, h('label.check', coverCheck, t('Artwork'))),
  );

  async function search() {
    const term = query.input.value.trim();
    if (!term || !provider) return;
    selected = null;
    applyPanel.hidden = true;
    results.replaceChildren(h('div.center-load', { style: { padding: '24px' } }, h('div.spinner')));
    try {
      const list = await api.metadataSearch(provider, term);
      results.replaceChildren(
        ...(list.length
          ? list.map((r) => {
              const el = h('button.result', { type: 'button', onclick: () => {
                for (const x of results.children) x.setAttribute('aria-pressed', 'false');
                el.setAttribute('aria-pressed', 'true');
                selected = r;
                applyPanel.hidden = false;
              } },
                h('img', { src: r.thumbUrl || r.coverUrl || '', alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }),
                h('div', { style: { minWidth: '0' } },
                  h('div.t', r.title),
                  h('div.m', [r.year, r.status && STATUS_LABEL[r.status], r.format, r.people?.[0]?.name].filter(Boolean).join(' · ')),
                  r.genres?.length && h('div.m', r.genres.slice(0, 5).join(', ')),
                  r.summary && h('div.d', r.summary),
                ),
              );
              return el;
            })
          : [h('p.muted', t('No matches. Try a different title or source.'))]),
      );
    } catch (e) {
      results.replaceChildren(formError(e.message));
    }
  }
  query.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      search();
    }
  });

  const done = await dialog({
    title: t('Fetch metadata'),
    icon: 'travel_explore',
    className: 'fullscreen-compact',
    content: h('div', { style: { width: 'min(600px, 100%)' } },
      !usable.length && formError(t('No metadata sources are configured.')),
      provSeg,
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, h('div', { style: { flex: '1' } }, query), iconButton('search', t('Search'), search, 'filled')),
      status,
      results,
      applyPanel,
    ),
    actions: [
      { label: t('Cancel') },
      {
        label: t('Apply'),
        variant: 'filled',
        icon: 'check',
        onClick: async () => {
          if (!selected) {
            snackbar(t('Pick a result first'));
            return false;
          }
          const fields = checks.map((c) => c.querySelector('input')).filter((i) => i.checked).map((i) => i.dataset.field);
          try {
            await api.applyMetadata(series.id, { provider: selected.provider, providerId: selected.id, fields, cover: coverCheck.checked });
            refreshDrawer();
            snackbar(t('Metadata applied from {value}', { value: providers.find((p) => p.id === selected.provider)?.name }));
            return true;
          } catch (e) {
            status.replaceChildren(formError(e.message));
            return false;
          }
        },
      },
    ],
    onOpen: () => search(),
  });
  return done;
}

// ---------------------------------------------------------------------------
// Volume editor

export async function editVolume(book) {
  const full = await api.book(book.id);
  const title = field(t('Title'), { value: full.title, required: true });
  const author = field(t('Author'), { value: full.author || '' });
  const volume = field(t('Volume'), { value: full.volume ?? '', type: 'number', step: 'any', inputmode: 'decimal' });
  const chapter = field(t('Chapter / issue'), { value: full.chapter ?? '', type: 'number', step: 'any', inputmode: 'decimal' });
  const desc = field(t('Description'), { value: full.description || '', multiline: true });
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  fileInput.addEventListener('change', async () => {
    if (!fileInput.files[0]) return;
    await api.setCover(book.id, fileInput.files[0]);
    snackbar(t('Cover updated'));
  });
  const err = h('div');
  await dialog({
    title: t('Edit volume'),
    className: 'fullscreen-compact',
    content: h('div', { style: { width: 'min(520px, 100%)' } },
      err, title, author,
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' } }, volume, chapter),
      desc,
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } },
        button(t('Change cover'), { variant: 'tonal', icon: 'image', onclick: () => fileInput.click() }),
        button(t('Re-read from file'), { variant: 'text', icon: 'refresh', onclick: async () => {
          if (!(await confirmDialog({ title: t('Re-read metadata?'), message: t('Manual edits for this volume will be replaced by what’s in the file.'), confirm: t('Re-read') }))) return;
          await api.refreshBook(book.id);
          snackbar(t('Volume refreshed'));
        } }),
      ),
      fileInput,
      h('p.note', { style: { overflowWrap: 'anywhere' } }, full.relPath),
    ),
    actions: [
      { label: t('Cancel') },
      {
        label: t('Save'),
        variant: 'filled',
        onClick: async () => {
          try {
            await api.updateBook(book.id, { title: title.input.value, author: author.input.value, volume: volume.input.value, chapter: chapter.input.value, description: desc.input.value });
            snackbar(t('Volume saved'));
            return true;
          } catch (e) {
            err.replaceChildren(formError(e.message));
            return false;
          }
        },
      },
    ],
  });
}
