// Form for reader settings – used by Reading profiles (settings page) and the in-reader sheet.

import { h, icon, segmented, toggleSwitch, field } from '../ui.js';

export const BACKGROUNDS = ['#000000', '#16161a', '#2b2b30', '#5c5c66', '#f4ecd8', '#ffffff'];
export const TEXT_THEMES = {
  light: { bg: '#fbfaf7', fg: '#1f1d1a', link: '#4a4fb5', label: 'Paper' },
  sepia: { bg: '#f3ead6', fg: '#4f3d2e', link: '#8a5a2b', label: 'Sepia' },
  dark: { bg: '#1b1c20', fg: '#dcdbe2', link: '#b9b8ff', label: 'Dark' },
  black: { bg: '#000000', fg: '#c8c8c8', link: '#a3a8ff', label: 'Black' },
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

  if (pages) {
    if (show === 'all') out.append(h('div.sub-head', { style: { margin: '8px 24px 0' } }, 'Manga, comics & PDF'));
    const custom = h('input', { type: 'color', value: settings.background, 'aria-label': 'Custom background colour', oninput: (e) => {
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
      section('Layout mode', segmented([
        { value: 'single', label: 'Single', icon: 'crop_portrait' },
        { value: 'double', label: 'Double', icon: 'menu_book' },
        { value: 'webtoon', label: 'Webtoon', icon: 'view_day' },
      ], settings.layout, set('layout'))),
      section('Reading direction', segmented([
        { value: 'auto', label: 'Auto', icon: 'auto_mode', title: 'Right-to-left for manga libraries' },
        { value: 'ltr', label: 'Left → right', icon: 'arrow_forward' },
        { value: 'rtl', label: 'Right → left', icon: 'arrow_back' },
      ], settings.direction, set('direction'))),
      section('Scaling', segmented([
        { value: 'screen', label: 'Fit screen', icon: 'fit_screen' },
        { value: 'width', label: 'Width', icon: 'width' },
        { value: 'height', label: 'Height', icon: 'height' },
        { value: 'original', label: 'Original', icon: 'zoom_in' },
      ], settings.scaling, set('scaling'))),
      section('Page splitting', h('p.body-small.muted', { style: { margin: '-4px 0 8px' } }, 'How wide double-page scans are shown in single-page mode.'),
        segmented([
          { value: 'none', label: 'Off' },
          { value: 'split', label: 'Split' },
          { value: 'split-reverse', label: 'Split reversed' },
          { value: 'fit', label: 'Fit' },
        ], settings.pageSplit, set('pageSplit'))),
      section('Background colour', bgRow),
      settings.layout === 'webtoon' || show === 'all'
        ? section('Webtoon page gap', h('div.row', rangeInput(0, 40, 2, settings.webtoonGap, set('webtoonGap'), (v) => `${v}px`)))
        : null,
    );
  }

  if (text) {
    if (show === 'all') out.append(h('div.sub-head', { style: { margin: '16px 24px 0' } }, 'Ebooks'));
    const themeRow = h('div.swatches', { style: { justifyContent: 'space-between' } },
      [['auto', 'Auto'], ...Object.entries(TEXT_THEMES).map(([k, v]) => [k, v.label])].map(([key, label]) => {
        const t = TEXT_THEMES[key];
        return h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' } },
          h('button.swatch', {
            type: 'button',
            'aria-label': label,
            'aria-pressed': String(settings.textTheme === key),
            style: { background: t ? t.bg : 'linear-gradient(135deg, #fbfaf7 50%, #1b1c20 50%)', color: t ? t.fg : '#888', boxShadow: 'inset 0 0 0 1px rgb(127 127 127 / 0.5)', fontWeight: '600' },
            onclick: (e) => {
              for (const b of themeRow.querySelectorAll('.swatch')) b.setAttribute('aria-pressed', String(b === e.currentTarget));
              set('textTheme')(key);
            },
          }, 'Aa'),
          h('span.label-small', label));
      }),
    );
    const fontOptions = (fonts.length ? fonts : [{ id: 'publisher', name: 'Publisher default' }]).map((f) => ({ value: f.id, label: f.name }));
    const fontField = field('Font family', { value: settings.fontFamily, options: fontOptions });
    fontField.input.addEventListener('change', () => set('fontFamily')(fontField.input.value));
    out.append(
      section('Theme', themeRow),
      section('Font', fontField),
      section('Text size', h('div.row', icon('text_decrease'), rangeInput(70, 220, 5, settings.fontSize, set('fontSize'), (v) => `${v}%`), icon('text_increase'))),
      section('Line spacing', segmented([
        { value: 1.3, label: 'Tight', icon: 'density_small' },
        { value: 1.5, label: 'Normal', icon: 'density_medium' },
        { value: 1.8, label: 'Loose', icon: 'density_large' },
      ], settings.lineHeight, set('lineHeight'))),
      section('Margins', segmented([
        { value: 'narrow', label: 'Narrow' },
        { value: 'normal', label: 'Normal' },
        { value: 'wide', label: 'Wide' },
      ], settings.margin, set('margin'))),
      section('Layout', segmented([
        { value: 'paginated', label: 'Pages', icon: 'auto_stories' },
        { value: 'scrolled', label: 'Scroll', icon: 'swap_vert' },
      ], settings.flow, set('flow'))),
      section('Columns', segmented([
        { value: 'auto', label: 'Auto' },
        { value: '1', label: 'One' },
        { value: '2', label: 'Two' },
      ], String(settings.columns), set('columns'))),
      h('div.sheet-section',
        toggle('Justify text', null, settings.justify, set('justify')),
        toggle('Hyphenation', null, settings.hyphenate, set('hyphenate')),
      ),
    );
  }

  out.append(
    h('div.sheet-section', h('h3', 'Behaviour'),
      toggle('Tap to paginate', 'Tap the left/right edges to turn pages', settings.tapToPaginate, set('tapToPaginate')),
      toggle('Swipe to paginate', 'Swipe sideways to turn pages', settings.swipeToPaginate, set('swipeToPaginate')),
      toggle('Auto-close menu', 'Hide the reader menu when you turn a page', settings.autoCloseMenu, set('autoCloseMenu')),
      toggle('Immersive mode', 'Hide all chrome and page numbers while reading', settings.immersive, set('immersive')),
    ),
  );
  return out;
}

function rangeInput(min, max, step, value, onCommit, fmt) {
  const label = h('span.label-large', { style: { minWidth: '52px', textAlign: 'right' } }, fmt(value));
  const input = h('input.slider', { type: 'range', min, max, step, value });
  const fill = () => input.style.setProperty('--fill', `${((input.value - min) / (max - min)) * 100}%`);
  fill();
  input.addEventListener('input', () => {
    fill();
    label.textContent = fmt(Number(input.value));
  });
  input.addEventListener('change', () => onCommit(Number(input.value)));
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flex: '1' } }, input, label);
}
