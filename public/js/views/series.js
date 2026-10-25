// Series overview: artwork, title, creators, links, actions, status, tags,
// genres, people, publication info, summary, related series and volumes.

import { api, seriesDownloadUrl } from '../api.js';
import { isAdmin, navigate, render } from '../router.js';
import { prefs } from '../prefs.js';
import { h, icon, iconButton, button, cover, menu, snackbar, stagger, emptyState, skeleton, STATUS_LABEL, USER_STATUS, timeAgo, formatBytes, formatDuration, segmented } from '../ui.js';
import { volumeCard, seriesCard } from '../components/cards.js';
import { seriesActions, bookActions, addToCollection, sendTo, download, canDownload } from '../components/actions.js';
import { RELATION_LABEL } from '../components/editors.js';

const LINK_ICON = { MyAnimeList: 'tv', AniList: 'stacks', MangaDex: 'auto_stories', MangaUpdates: 'update', ComicVine: 'local_library', Goodreads: 'reviews', 'Open Library': 'local_library', 'Google Books': 'book_2', Kitsu: 'pets', Amazon: 'shopping_bag', BookWalker: 'storefront', Wikipedia: 'public' };

export async function seriesView(view, params, stale) {
  const page = h('div.page');
  view.append(page);
  page.append(skeleton('series'));
  const s = await api.series(params.id).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
  if (stale()) return;
  page.replaceChildren();
  if (!s) return page.append(emptyState('search_off', 'Series not found', 'It may have been removed, or it’s outside your age restriction.', h('a.btn.tonal', { href: '#/library' }, 'Browse library')));

  const p = prefs();
  const reload = () => render();
  const started = s.books.some((b) => b.progress);
  const next = s.books.find((b) => b.id === s.nextBookId);

  // ----- Hero -----
  const art = cover({ ...s, title: s.name }, { showProgress: false });
  art.style.viewTransitionName = 'hero-cover';
  art.addEventListener('click', () => s.blur && art.classList.toggle('blurred'));
  if (s.blur) art.title = 'Tap to reveal';

  const writers = s.people.filter((x) => /writer|author|story|creator/i.test(x.role));
  const creators = (writers.length ? writers : s.people).slice(0, 4);

  let readLabel = 'Start reading';
  let readIcon = 'play_arrow';
  if (next?.progress && !next.progress.finished) readLabel = `Continue ${next.label}`;
  else if (started && s.readCount === s.count) {
    readLabel = 'Read again';
    readIcon = 'replay';
  } else if (started && next) readLabel = `Read ${next.label}`;
  else if (s.count > 1 && next) readLabel = `Start ${next.label}`;

  const wantBtn = iconButton(s.wantToRead ? 'bookmark_heart' : 'bookmark_add', s.wantToRead ? 'Remove from Want to read' : 'Want to read', async () => {
    s.wantToRead = !s.wantToRead;
    await api.setSeriesUser(s.id, { wantToRead: s.wantToRead });
    wantBtn.querySelector('.icon').textContent = s.wantToRead ? 'bookmark_heart' : 'bookmark_add';
    wantBtn.classList.toggle('selected', s.wantToRead);
    snackbar(s.wantToRead ? 'Added to Want to read' : 'Removed from Want to read');
  }, 'tonal');
  wantBtn.classList.toggle('selected', s.wantToRead);

  // "Edit" button: admin metadata tools + download options (per spec).
  const editBtn = button(isAdmin() ? 'Edit' : 'Options', { variant: 'outlined', icon: isAdmin() ? 'edit' : 'tune' });
  editBtn.append(icon('arrow_drop_down'));
  editBtn.addEventListener('click', () => {
    const items = [];
    if (isAdmin()) {
      items.push(
        { label: 'Edit metadata', icon: 'edit_note', onClick: () => import('../components/editors.js').then((m) => m.editSeries(s.id).then(reload)) },
        { label: 'Fetch metadata online', icon: 'travel_explore', onClick: () => import('../components/editors.js').then((m) => m.fetchMetadata(s).then(reload)) },
        { label: 'Change artwork', icon: 'image', onClick: () => import('../components/editors.js').then((m) => m.editSeries(s.id).then(reload)) },
        { label: 'Refresh from files', icon: 'refresh', onClick: async () => { await api.refreshSeries(s.id); snackbar('Metadata re-read from files'); reload(); } },
        '-',
      );
    }
    if (canDownload()) {
      items.push(
        { header: 'Download' },
        { label: 'Download whole series (.zip)', icon: 'folder_zip', onClick: () => download(seriesDownloadUrl(s.id), `${s.name} – all volumes`) },
        ...s.books.slice(0, 40).map((b) => ({ label: b.label, icon: 'download', trailing: b.format.toUpperCase(), onClick: () => download(`/api/books/${b.id}/download`, b.label, b.size) })),
        '-',
        { label: 'Send to…', icon: 'send_to_mobile', onClick: () => sendTo({ series: s }) },
      );
    }
    items.push(
      { label: 'Add to category', icon: 'playlist_add', onClick: () => addToCollection([s.id], `“${s.name}”`).then(reload) },
      { label: s.userBlur ? 'Unblur artwork' : 'Blur artwork (NSFW)', icon: s.userBlur ? 'visibility' : 'visibility_off', onClick: async () => { await api.setSeriesUser(s.id, { blur: !s.userBlur }); reload(); } },
      { label: 'Reading profile…', icon: 'chrome_reader_mode', onClick: () => pickProfile(s) },
    );
    menu(editBtn, items);
  });

  const moreBtn = iconButton('more_vert', 'More', () => seriesActions(moreBtn, { ...s, blur: s.userBlur }, { onChange: reload }));

  // ----- Status + user tags -----
  const statusRow = h('div.chip-set', USER_STATUS.map((u) =>
    h('button.chip.state', { type: 'button', 'aria-pressed': String(s.userStatus === u.value), onclick: async (e) => {
      const nextStatus = s.userStatus === u.value ? null : u.value;
      await api.setSeriesUser(s.id, { status: nextStatus });
      s.userStatus = nextStatus;
      for (const c of statusRow.children) c.setAttribute('aria-pressed', String(c === e.currentTarget && nextStatus !== null));
    } }, icon(u.icon), u.label),
  ));
  const tagSet = h('div.chip-set');
  const renderTags = () => {
    tagSet.replaceChildren(
      ...s.userTags.map((t, i) => h('span.chip.input-chip.selected',
        h('a', { href: `#/tag/${encodeURIComponent(t)}`, style: { color: 'inherit', textDecoration: 'none' } }, `#${t}`),
        h('button', { type: 'button', 'aria-label': `Remove tag ${t}`, onclick: async () => {
          s.userTags.splice(i, 1);
          await api.setSeriesUser(s.id, { tags: s.userTags });
          renderTags();
        } }, icon('close')))),
      h('button.chip.state', { type: 'button', onclick: addTag }, icon('add'), 'Add tag'),
    );
  };
  async function addTag() {
    const existing = await api.userTags().catch(() => []);
    const input = h('input', { type: 'text', placeholder: 'New tag', list: 'tag-suggest', style: { border: 'none', outline: 'none', background: 'transparent', width: '120px', fontSize: '14px' } });
    const chip = h('span.chip.selected', icon('sell'), input, h('datalist#tag-suggest', existing.map((t) => h('option', { value: t.name }))));
    tagSet.lastChild.replaceWith(chip);
    input.focus();
    const commit = async () => {
      const v = input.value.trim().replace(/^#/, '');
      if (v && !s.userTags.includes(v)) {
        s.userTags.push(v);
        await api.setSeriesUser(s.id, { tags: s.userTags });
      }
      renderTags();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') renderTags();
    });
    input.addEventListener('blur', commit);
  }
  renderTags();

  // ----- Facts -----
  const st = s.stats || {};
  const FMT = (f) => f.toUpperCase();
  const facts = [
    ['Publication', s.status ? h('span.status-pill', { class: s.status }, STATUS_LABEL[s.status]) : 'Unknown'],
    s.year && ['Released', String(s.year)],
    s.publisher && ['Publisher', s.publisher],
    ['Age rating', s.ageRatingLabel],
    ['In library', `${s.count} ${s.count === 1 ? 'item' : 'items'}`],
    ['Your progress', s.readCount ? `${s.readCount} of ${s.count} read` : started ? 'Started' : 'Not started'],
    s.language && ['Language', s.language],
    s.lastRead && ['Last read', timeAgo(s.lastRead)],
    st.secondsRead > 0 && ['Time spent reading', `${formatDuration(st.secondsRead)} over ${st.daysRead} ${st.daysRead === 1 ? 'day' : 'days'}`],
    st.highlights + st.bookmarks > 0 && ['Your notes', `${st.highlights} highlights · ${st.bookmarks} bookmarks`],
    st.formats?.length > 0 && ['Formats', st.formats.map((f) => (st.formats.length > 1 ? `${FMT(f.format)} ×${f.count}` : FMT(f.format))).join(', ')],
    st.size > 0 && ['Size on disk', formatBytes(st.size)],
    st.pages > 0 && ['Pages', st.pages.toLocaleString()],
    st.firstAdded && ['Added', new Date(st.firstAdded).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })],
    st.lastAdded && st.lastAdded - st.firstAdded > 86400_000 && ['Newest file', timeAgo(st.lastAdded)],
    st.folder && ['Folder', h('span.mono', st.folder)],
  ].filter(Boolean);

  // ----- Summary -----
  let summary = null;
  if (s.summary) {
    const text = h('p.summary.clamped.body-large', s.summary);
    text.addEventListener('click', () => text.classList.toggle('clamped'));
    summary = h('div.summary-wrap', text);
    if (p.blurUnreadSummaries && !started) {
      text.classList.add('spoiler');
      const reveal = button('Show summary', { variant: 'tonal', icon: 'visibility', onclick: () => {
        text.classList.remove('spoiler');
        reveal.parentElement.remove();
      } });
      summary.append(h('div.reveal', reveal));
    }
  }

  const eyebrow = h('div.eyebrow',
    h('a', { href: `#/library/${s.libraryId}` }, s.libraryName),
    s.collections.map((c) => [h('span', '·'), h('a', { href: `#/collection/${c.id}` }, c.name)]),
  );

  const info = h('div.info',
    eyebrow,
    h('h1', s.name),
    s.localizedName && s.localizedName !== s.name && h('div.alt', s.localizedName),
    creators.length > 0 && h('div.creators', 'by ', creators.map((c, i) => [i ? ', ' : '', h('a', { href: `#/person/${encodeURIComponent(c.name)}` }, c.name)])),
    s.links.length > 0 && h('div.chip-set', s.links.map((l) =>
      h('a.chip.link-chip.state', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, icon(LINK_ICON[l.source] || 'open_in_new'), l.source))),
    h('div.actions',
      s.count > 0 && next && h('a.btn.filled.large.state', { href: `#/read/${next.id}`, onclick: async (e) => {
        if (readIcon === 'replay') {
          e.preventDefault();
          await api.setSeriesFinished(s.id, false);
          navigate(`/read/${s.books[0].id}`);
        }
      } }, icon(readIcon, 'filled'), readLabel),
      wantBtn,
      editBtn,
      moreBtn,
    ),
    s.progress > 0 && h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', maxWidth: '460px', width: '100%' } },
      h('div.progress', { style: { flex: '1' } }, h('span', { style: { width: `${Math.round(s.progress * 100)}%` } })),
      h('span.label-medium.muted', `${Math.round(s.progress * 100)}%`)),
    h('div.info-block', h('span.label', 'Your status'), statusRow),
    h('div.info-block', h('span.label', 'Your tags'), tagSet),
    s.genres.length > 0 && h('div.info-block', h('span.label', 'Genres'),
      h('div.chip-set', s.genres.map((g) => h('a.chip.genre-chip.state', { href: `#/genre/${encodeURIComponent(g)}` }, g)))),
    s.tags.length > 0 && h('div.info-block', h('span.label', 'Tags'),
      h('div.chip-set', s.tags.slice(0, 24).map((t) => h('span.chip', t)))),
    s.people.length > 0 && h('div.info-block', h('span.label', 'Writers & artists'),
      h('div.people', s.people.map((x) =>
        h('a.person', { href: `#/person/${encodeURIComponent(x.name)}` }, h('span.avatar', x.name[0]), h('span', h('div.n', x.name), h('div.r', x.role)))))),
    h('div.facts', facts.map(([k, v]) => h('div.fact', h('div.k', k), h('div.v', v)))),
    summary && h('div.info-block', h('span.label', 'Summary'), summary),
  );

  const scape = h('div.scape');
  page.append(h('div.series-view', scape, h('section.series-hero.enter', h('div.cover-col', art), info)));
  if (p.colorScape) applyColorScape(art, scape, page);

  // ----- Related -----
  if (s.relations.length) {
    const grid = stagger(h('div.grid', s.relations.map((r) => {
      const card = seriesCard(r.series, { onChange: reload });
      card.querySelector('.t-sub').textContent = RELATION_LABEL[r.kind] || r.kind;
      return card;
    })));
    const details = h('details.section', { open: !p.collapseRelationships },
      h('summary.section-head', { style: { cursor: 'pointer', listStyle: 'none' } }, h('h2', 'Related series'), icon('expand_more')),
      grid,
    );
    page.append(details);
  }

  // ----- Volumes -----
  const groups = [
    ['Volumes', s.books.filter((b) => !b.special && b.volume != null && b.chapter == null)],
    ['Chapters', s.books.filter((b) => !b.special && b.chapter != null)],
    [s.kind === 'books' ? 'Books' : 'Other', s.books.filter((b) => !b.special && b.volume == null && b.chapter == null)],
    ['Specials', s.books.filter((b) => b.special)],
  ].filter(([, list]) => list.length);
  const single = groups.length === 1;
  // Grid of covers, or a detailed list with format, pages, size and progress.
  let layout = readVolLayout();
  const volumes = h('div');
  const drawVolumes = () => volumes.replaceChildren(...groups.map(([label, list]) =>
    h('div.vol-group', !single && h('h3.title-medium', { style: { margin: '0 0 12px' } }, label),
      layout === 'list'
        ? stagger(h('div.vol-list', list.map((b) => volumeRow(b, s, reload))))
        : stagger(h('div.grid', list.map((b) => volumeCard(b, { series: s, onChange: reload })))))));
  drawVolumes();
  const layoutToggle = segmented([
    { value: 'grid', icon: 'grid_view', label: '', title: 'Covers' },
    { value: 'list', icon: 'view_list', label: '', title: 'Details' },
  ], layout, (v) => {
    layout = v;
    saveVolLayout(v);
    drawVolumes();
  });
  layoutToggle.classList.add('compact');
  page.append(
    h('section.section',
      h('div.section-head', h('h2', single && groups[0][0] !== 'Other' ? `${groups[0][0]} (${s.books.length})` : `In this series (${s.books.length})`), layoutToggle),
      volumes,
    ),
  );

  // ----- Ratings & reviews -----
  const reviews = h('section.section.reviews');
  page.append(reviews);
  api.reviews(s.id).then((r) => reviews.isConnected && renderReviews(reviews, s, r)).catch(() => {});

  // ----- More like this -----
  // Loaded after the page shows: series sharing genres, tags and creators, best first.
  const more = h('section.section.more-like', { hidden: true });
  page.append(more);
  api.similarSeries(s.id, 18).then((list) => {
    if (!list.length || !more.isConnected) return;
    more.append(
      h('div.section-head', h('h2', 'More like this')),
      stagger(h('div.grid', list.map((x) => seriesCard(x)))),
    );
    more.hidden = false;
  }).catch(() => {});
}

/** Star i (1–5) for a 1–10 rating: filled, half or empty. */
const starIcon = (rating, i) => (rating >= i * 2 ? icon('star', 'filled') : rating === i * 2 - 1 ? icon('star_half', 'filled') : icon('star'));

/** Stars for a 1–10 (half-star) rating. */
function stars(rating) {
  const out = h('span.stars', { title: `${rating / 2} of 5 stars` });
  for (let i = 1; i <= 5; i++) out.append(starIcon(rating, i));
  return out;
}

/** Tap a star for a whole star, tap it again for half. */
function starInput(value, onChange) {
  const wrap = h('span.stars.input', { role: 'radiogroup', 'aria-label': 'Your rating' });
  const draw = () => wrap.replaceChildren(...[1, 2, 3, 4, 5].map((i) =>
    h('button', { type: 'button', 'aria-label': `${i} ${i === 1 ? 'star' : 'stars'}`, onclick: () => {
      value = value === i * 2 ? i * 2 - 1 : value === i * 2 - 1 && i === 1 ? null : i * 2;
      draw();
      onChange(value);
    } }, starIcon(value, i))));
  draw();
  return wrap;
}

function renderReviews(section, s, r) {
  const mine = r.mine || { rating: null, body: '', spoiler: false };
  let rating = mine.rating;
  const text = h('textarea.review-input', { rows: 3, maxlength: 5000, placeholder: 'What did you think? (optional)' });
  text.value = mine.body || '';
  const spoiler = h('input', { type: 'checkbox', checked: mine.spoiler });
  const save = button(r.mine ? 'Update review' : 'Post', { variant: 'tonal', icon: 'rate_review', onclick: async () => {
    const next = await api.saveReview(s.id, { rating, body: text.value, spoiler: spoiler.checked });
    snackbar(rating || text.value.trim() ? 'Review saved' : 'Review removed');
    renderReviews(section, s, next);
  } });
  const remove = r.mine && button('Delete', { variant: 'text', icon: 'delete', onclick: async () => {
    renderReviews(section, s, await api.deleteReview(s.id));
    snackbar('Review removed');
  } });

  const others = r.reviews.filter((x) => !x.mine);
  // The DOM's replaceChildren would print `false`; h() skips it.
  section.replaceChildren(h('div',
    h('div.section-head', h('h2', 'Ratings & reviews')),
    r.count > 0 && h('div.rating-summary',
      h('span.big', (r.average / 2).toFixed(1)),
      h('div', stars(Math.round(r.average)), h('div.body-small.muted', `${r.count} ${r.count === 1 ? 'rating' : 'ratings'} on this server`))),
    h('div.review',
      h('div.review-head', h('div.who.title-small', r.mine ? 'Your review' : 'Rate this series'), starInput(rating, (v) => (rating = v))),
      text,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } },
        h('label.check', { style: { flex: '1' } }, spoiler, 'Contains spoilers'),
        remove, save)),
    others.length > 0 && h('div.review-list', { style: { marginTop: '12px' } }, others.map((x) => {
      const body = x.body && h(`p.review-body.body-medium${x.spoiler ? '.spoiler' : ''}`, { title: x.spoiler ? 'Spoiler – tap to reveal' : null, onclick: (e) => e.currentTarget.classList.remove('spoiler') }, x.body);
      return h('div.review',
        h('div.review-head',
          avatarFor(x.user),
          h('div.who', h('div.title-small', x.user.displayName), h('div.body-small.muted', timeAgo(x.updatedAt))),
          x.rating && stars(x.rating),
          isAdmin() && iconButton('delete', 'Remove this review', async () => {
            renderReviews(section, s, await api.removeReview(s.id, x.user.id));
            snackbar('Review removed');
          })),
        body);
    }))));
}

const avatarFor = (u) => h('span.avatar', { style: { width: '32px', height: '32px', fontSize: '14px', flex: 'none', backgroundImage: u.avatarUrl ? `url("${u.avatarUrl}")` : null, backgroundSize: 'cover' } }, u.avatarUrl ? '' : (u.displayName || '?')[0].toUpperCase());

const VOL_LAYOUT = 'flyleaf.volumeLayout';
function readVolLayout() {
  try {
    return localStorage.getItem(VOL_LAYOUT) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}
function saveVolLayout(v) {
  try {
    localStorage.setItem(VOL_LAYOUT, v);
  } catch {}
}

/** One volume in the detailed list. */
function volumeRow(b, s, onChange) {
  const p = b.progress;
  const pct = p?.finished ? 100 : Math.round((p?.percent || 0) * 100);
  const meta = [
    b.format.toUpperCase(),
    b.pageCount ? `${b.pageCount} pages` : null,
    b.size ? formatBytes(b.size) : null,
    `added ${timeAgo(b.addedAt)}`,
  ].filter(Boolean).join(' · ');
  const info = iconButton('info', 'Details', (e) => {
    e.preventDefault();
    e.stopPropagation();
    import('../components/book-info.js').then((m) => m.showBookInfo(b.id));
  });
  const more = iconButton('more_vert', 'More actions', (e) => {
    e.preventDefault();
    e.stopPropagation();
    bookActions(more, b, { series: s, onChange });
  });
  return h('a.vol-row.state', { href: `#/read/${b.id}` },
    cover({ ...b, title: b.label }, { showProgress: false }),
    h('div.vol-text',
      h('div.vol-title', b.label, b.label !== b.title && s.kind !== 'books' ? h('span.muted', ` · ${b.title}`) : null),
      h('div.vol-meta', meta),
      h('div.vol-progress',
        p?.finished
          ? h('span.mini-chip', icon('check'), 'Finished')
          : pct > 0
            ? [h('div.progress', h('span', { style: { width: `${pct}%` } })), h('span.label-small', `${pct}%${p?.updatedAt ? ` · ${timeAgo(p.updatedAt)}` : ''}`)]
            : h('span.label-small.muted', 'Not started')),
    ),
    info,
    more,
  );
}

/** Kavita-style "colour scape": tint the page with colours sampled from the artwork. */
function applyColorScape(art, scape, page) {
  const img = art.querySelector('img');
  if (!img) return;
  const run = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 24;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 24, 24);
      const d = ctx.getImageData(0, 0, 24, 24).data;
      const buckets = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max ? (max - min) / max : 0;
        if (sat < 0.25 || max < 40) continue;
        const hue = Math.round(rgbHue(r, g, b) / 30) * 30;
        const e = buckets.get(hue) || { weight: 0, count: 0, r: 0, g: 0, b: 0 };
        e.weight += sat;
        e.count++;
        e.r += r;
        e.g += g;
        e.b += b;
        buckets.set(hue, e);
      }
      const top = [...buckets.values()].sort((a, b) => b.weight - a.weight).slice(0, 2);
      if (!top.length) return;
      const avg = (e) => ({ r: e.r / e.count, g: e.g / e.count, b: e.b / e.count });
      const c1 = avg(top[0]);
      const c2 = top[1] ? avg(top[1]) : c1;
      scape.style.setProperty('--scape-1', `rgb(${c1.r | 0} ${c1.g | 0} ${c1.b | 0})`);
      scape.style.setProperty('--scape-2', `rgb(${c2.r | 0} ${c2.g | 0} ${c2.b | 0})`);
      scape.classList.add('on');
      // Re-seed the Material colour scheme for this page from the artwork.
      page.style.setProperty('--seed-hue', String(Math.round(rgbHue(c1.r, c1.g, c1.b))));
      page.classList.add('reseed');
    } catch {}
  };
  if (img.complete && img.naturalWidth) run();
  else img.addEventListener('load', run, { once: true });
}

function rgbHue(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return 0;
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

async function pickProfile(s) {
  const { profiles } = await api.profiles();
  const m = menu(document.activeElement || document.body, [
    { header: 'Reading profile for this series' },
    { label: 'Use library default', icon: 'restart_alt', onClick: async () => { await api.setSeriesProfile(s.id, null); snackbar('Using the library’s profile'); } },
    ...profiles.map((p) => ({ label: p.name, icon: 'chrome_reader_mode', onClick: async () => { await api.setSeriesProfile(s.id, p.id); snackbar(`“${p.name}” will be used for this series`); } })),
  ]);
  return m;
}

