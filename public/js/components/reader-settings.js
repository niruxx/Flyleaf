import { t } from '../i18n.js';
// Form for reader settings – used by Reading profiles (settings page) and the in-reader sheet.

import { h, icon, segmented, toggleSwitch, field } from '../ui.js';

export const BACKGROUNDS = ['#000000', '#16161a', '#2b2b30', '#5c5c66', '#f4ecd8', '#ffffff'];
/** Paper colours for the Book and E-ink looks (Reader settings → Look). */
export const LOOKS = {
  book: { bg: '#f7f1e3', fg: '#2a241c', link: '#7a4b1c', surround: '#26231f' },
  eink: { bg: '#edede8', fg: '#141414', link: '#141414', surround: '#dcdcd6' },
};
/** Paper grain, as a tiny SVG noise tile (used by the Book look). */
export const PAPER_GRAIN = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0.45  0 0 0 0 0.38  0 0 0 0 0.28  0 0 0 0.09 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>')}")`;

export const TEXT_THEMES = {
  light: { bg: '#fbfaf7', fg: '#1f1d1a', link: '#4a4fb5', get label() { return t('Paper'); } },
  sepia: { bg: '#f3ead6', fg: '#4f3d2e', link: '#8a5a2b', get label() { return t('Sepia'); } },
  dark: { bg: '#1b1c20', fg: '#dcdbe2', link: '#b9b8ff', get label() { return t('Dark'); } },
  black: { bg: '#000000', fg: '#c8c8c8', link: '#a3a8ff', get label() { return t('Black'); } },
};

function section(title, ...content) {
  return h('div.sheet-section', h('h3', title), ...content);
}
function toggle(label, sub, value, onChange) {
  return h('div.toggle-row', h('div', h('div.body-large', label), sub && h('div.s', sub)), toggleSwitch(value, onChange, label));
}

/**
 * @param settings current values (mutated in place)
 * @param onChange (key, value) callback
 * @param opts.show 'pages' | 'text' | 'all'
 * @param opts.fonts list of {id, name}
 */
export function readerSettingsForm(settings, onChange, { show = 'all', fonts = [] } = {}) {
  const set = (k) => (v) => {
    settings[k] = v;
    onChange(k, v);
  };
  const pages = show === 'pages' || show === 'all';
  const text = show === 'text' || show === 'all';
  const out = h('div');

  // How pages look and turn – for every kind of book.
  out.append(
    section(t('Look'), h('p.body-small.muted', { style: { margin: '-4px 0 8px' } }, t('Book: white paper with page edges and a spine, like a printed book. E-ink: a calm grey screen like an e-reader.')),
      segmented([
        { value: 'plain', label: t('Plain'), icon: 'crop_square' },
        { value: 'book', label: t('Book'), icon: 'auto_stories' },
        { value: 'eink', label: t('E-ink'), icon: 'tablet' },
      ], settings.look || 'plain', set('look'))),
    section(t('Page turn'), segmented([
      { value: 'slide', label: t('Slide'), icon: 'swipe_left' },
      { value: 'book', label: t('Book'), icon: 'menu_book' },
      { value: 'none', label: t('None'), icon: 'block' },
    ], settings.pageTurn || 'slide', set('pageTurn'))),
  );

  if (pages) {
    if (show === 'all') out.append(h('div.sub-head', { style: { margin: '8px 24px 0' } }, t('Manga, comics & PDF')));
    const custom = h('input', { type: 'color', value: settings.background, 'aria-label': t('Custom background colour'), oninput: (e) => {
      set('background')(e.target.value);
      for (const b of bgRow.querySelectorAll('.swatch')) b.setAttribute('aria-pressed', 'false');
    } });
    const bgRow = h('div.bg-swatches',
      BACKGROUNDS.map((c) => h('button.swatch', { type: 'button', 'aria-label': c, 'aria-pressed': String(settings.background === c), style: { background: c }, onclick: (e) => {
        for (const b of bgRow.querySelectorAll('.swatch')) b.setAttribute('aria-pressed', String(b === e.currentTarget));
        custom.value = c;
        set('background')(c);
      } })),
      custom,
    );
    out.append(
      section(t('Layout mode'), segmented([
        { value: 'single', label: t('Single'), icon: 'crop_portrait' },
        { value: 'double', label: t('Double'), icon: 'menu_book' },
        { value: 'webtoon', label: t('Webtoon'), icon: 'view_day' },
      ], settings.layout, set('layout'))),
      section(t('Reading direction'), segmented([
        { value: 'auto', label: t('Auto'), icon: 'auto_mode', title: t('Right-to-left for manga libraries') },
        { value: 'ltr', label: t('Left → right'), icon: 'arrow_forward' },
        { value: 'rtl', label: t('Right → left'), icon: 'arrow_back' },
      ], settings.direction, set('direction'))),
      section(t('Scaling'), segmented([
        { value: 'screen', label: t('Fit screen'), icon: 'fit_screen' },
        { value: 'width', label: t('Width'), icon: 'width' },
        { value: 'height', label: t('Height'), icon: 'height' },
        { value: 'original', label: t('Original'), icon: 'zoom_in' },
      ], settings.scaling, set('scaling'))),
      section(t('Page splitting'), h('p.body-small.muted', { style: { margin: '-4px 0 8px' } }, t('How wide double-page scans are shown in single-page mode.')),
        segmented([
          { value: 'none', label: t('Off') },
          { value: 'split', label: t('Split') },
          { value: 'split-reverse', label: t('Split reversed') },
          { value: 'fit', label: t('Fit') },
        ], settings.pageSplit, set('pageSplit'))),
      settings.layout === 'double' || show === 'all'
        ? h('div.sheet-section', h('h3', t('Double pages')),
          toggle(t('Smart spreads'), t('Show wide pages (two-page scans) on their own and keep the pages after them paired correctly'), settings.smartSpreads !== false, set('smartSpreads')),
          toggle(t('Cover on its own'), t('Start pairing from the second page, like a printed book'), settings.coverAlone !== false, set('coverAlone')))
        : '',
      h('div.sheet-section', h('h3', t('Image')),
        toggle(t('Auto-crop borders'), t('Trim blank margins around scanned pages so the art fills the screen'), Boolean(settings.autoCrop), set('autoCrop')),
        toggle(t('Whiten yellowed pages'), t('Turn yellowed or grey paper in old scans back to white'), Boolean(settings.whitenPaper), set('whitenPaper')),
        h('div.filter-row', icon('brightness_6'), h('span.filter-label', t('Brightness')), rangeInput(50, 150, 5, Number(settings.filterBrightness) || 100, set('filterBrightness'), (v) => `${v}%`, { live: true })),
        h('div.filter-row', icon('contrast'), h('span.filter-label', t('Contrast')), rangeInput(50, 150, 5, Number(settings.filterContrast) || 100, set('filterContrast'), (v) => `${v}%`, { live: true })),
        toggle(t('Greyscale'), t('Black and white – handy for colour-tinted scans'), Boolean(settings.filterGreyscale), set('filterGreyscale')),
        toggle(t('Invert (night mode)'), t('Light text on dark pages; colours keep their hue'), Boolean(settings.filterInvert), set('filterInvert'))),
      section(t('Background colour'), bgRow),
      settings.layout === 'webtoon' || show === 'all'
        ? section(t('Webtoon page gap'), h('div.row', rangeInput(0, 40, 2, settings.webtoonGap, set('webtoonGap'), (v) => `${v}px`)))
        : '',
      settings.layout === 'webtoon' || show === 'all'
        ? section(t('Auto-scroll speed'), h('p.body-small.muted', { style: { margin: '-4px 0 8px' } }, t('Start it with the play button in the reader menu or P. Touching the screen pauses it while your finger is down.')),
          h('div.row', icon('slow_motion_video'), rangeInput(1, 10, 1, Number(settings.autoScrollSpeed) || 3, set('autoScrollSpeed'), (v) => String(v)), icon('speed')))
        : '',
    );
  }

  if (text) {
    if (show === 'all') out.append(h('div.sub-head', { style: { margin: '16px 24px 0' } }, t('Ebooks')));
    const themeRow = h('div.swatches', { style: { justifyContent: 'space-between' } },
      [['auto', t('Auto')], ...Object.entries(TEXT_THEMES).map(([k, v]) => [k, v.label])].map(([key, label]) => {
        const localT = TEXT_THEMES[key];
        return h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' } },
          h('button.swatch', {
            type: 'button',
            'aria-label': label,
            'aria-pressed': String(settings.textTheme === key),
            style: { background: localT ? localT.bg : 'linear-gradient(135deg, #fbfaf7 50%, #1b1c20 50%)', color: localT ? localT.fg : '#888', boxShadow: 'inset 0 0 0 1px rgb(127 127 127 / 0.5)', fontWeight: '600' },
            onclick: (e) => {
              for (const b of themeRow.querySelectorAll('.swatch')) b.setAttribute('aria-pressed', String(b === e.currentTarget));
              set('textTheme')(key);
            },
          }, 'Aa'),
          h('span.label-small', label));
      }),
    );
    const fontOptions = (fonts.length ? fonts : [{ id: 'publisher', name: 'Publisher default' }]).map((f) => ({ value: f.id, label: f.name }));
    const fontField = field(t('Font family'), { value: settings.fontFamily, options: fontOptions });
    fontField.input.addEventListener('change', () => set('fontFamily')(fontField.input.value));
    out.append(
      section(t('Theme'), themeRow),
      section(t('Font'), fontField),
      section(t('Text size'), h('div.row', icon('text_decrease'), rangeInput(70, 220, 5, settings.fontSize, set('fontSize'), (v) => `${v}%`), icon('text_increase'))),
      section(t('Line spacing'), segmented([
        { value: 1.3, label: t('Tight'), icon: 'density_small' },
        { value: 1.5, label: t('Normal'), icon: 'density_medium' },
        { value: 1.8, label: t('Loose'), icon: 'density_large' },
      ], settings.lineHeight, set('lineHeight'))),
      section(t('Margins'), segmented([
        { value: 'narrow', label: t('Narrow') },
        { value: 'normal', label: t('Normal') },
        { value: 'wide', label: t('Wide') },
      ], settings.margin, set('margin'))),
      section(t('Layout'), segmented([
        { value: 'paginated', label: t('Pages'), icon: 'auto_stories' },
        { value: 'scrolled', label: t('Scroll'), icon: 'swap_vert' },
      ], settings.flow, set('flow'))),
      section(t('Columns'), segmented([
        { value: 'auto', label: t('Auto') },
        { value: '1', label: t('One') },
        { value: '2', label: t('Two') },
      ], String(settings.columns), set('columns'))),
      h('div.sheet-section',
        toggle(t('Justify text'), null, settings.justify, set('justify')),
        toggle(t('Hyphenation'), null, settings.hyphenate, set('hyphenate')),
      ),
    );
  }

  out.append(
    h('div.sheet-section', h('h3', t('Behaviour')),
      toggle(t('Tap to paginate'), t('Tap the left/right edges to turn pages'), settings.tapToPaginate, set('tapToPaginate')),
      toggle(t('Swipe to paginate'), t('Swipe sideways to turn pages'), settings.swipeToPaginate, set('swipeToPaginate')),
      toggle(t('Auto-hide menu'), t('Hide the reader menu after a moment and when you turn a page. When off, tap the middle of the page to show or hide it'), settings.autoCloseMenu, set('autoCloseMenu')),
      toggle(t('Immersive mode'), t('Hide all chrome and page numbers while reading'), settings.immersive, set('immersive')),
    ),
  );
  return out;
}

function rangeInput(min, max, step, value, onCommit, fmt, { live = false } = {}) {
  const label = h('span.label-large', { style: { minWidth: '52px', textAlign: 'right' } }, fmt(value));
  const input = h('input.slider', { type: 'range', min, max, step, value });
  const fill = () => input.style.setProperty('--fill', `${((input.value - min) / (max - min)) * 100}%`);
  fill();
  // live: report while dragging (cheap previews such as image filters), not only on release.
  input.addEventListener('input', () => {
    fill();
    label.textContent = fmt(Number(input.value));
    if (live) onCommit(Number(input.value));
  });
  input.addEventListener('change', () => onCommit(Number(input.value)));
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flex: '1' } }, input, label);
}
