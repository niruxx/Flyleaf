import { t } from './i18n.js';
// Reader key bindings (customisable in Settings → Key binds).

export const ACTIONS = [
  { id: 'pageRight', get label() { return t('Page right'); }, get hint() { return t('Next page in left-to-right books, previous in manga'); } },
  { id: 'pageLeft', get label() { return t('Page left'); }, get hint() { return t('Previous page in left-to-right books, next in manga'); } },
  { id: 'next', get label() { return t('Next page'); } },
  { id: 'prev', get label() { return t('Previous page'); } },
  { id: 'first', get label() { return t('First page'); } },
  { id: 'last', get label() { return t('Last page'); } },
  { id: 'toggleMenu', get label() { return t('Show / hide menu'); } },
  { id: 'bookmark', get label() { return t('Bookmark this page'); } },
  { id: 'contents', get label() { return t('Contents & annotations'); } },
  { id: 'settings', get label() { return t('Reader settings'); } },
  { id: 'fullscreen', get label() { return t('Full screen'); } },
  { id: 'nextBook', get label() { return t('Next volume / chapter'); } },
  { id: 'prevBook', get label() { return t('Previous volume / chapter'); } },
  { id: 'autoScroll', get label() { return t('Start / pause auto-scroll'); }, get hint() { return t('Webtoon mode'); } },
  { id: 'scrollFaster', get label() { return t('Auto-scroll faster'); } },
  { id: 'scrollSlower', get label() { return t('Auto-scroll slower'); } },
  { id: 'close', get label() { return t('Close the book'); } },
];

export const DEFAULT_KEYBINDS = {
  pageRight: ['ArrowRight', 'D'],
  pageLeft: ['ArrowLeft', 'A'],
  next: ['Space', 'PageDown', 'J'],
  prev: ['Shift+Space', 'PageUp', 'K'],
  first: ['Home'],
  last: ['End'],
  toggleMenu: ['M', 'Enter'],
  bookmark: ['B'],
  contents: ['T'],
  settings: ['S'],
  fullscreen: ['F'],
  nextBook: ['Shift+N'],
  prevBook: ['Shift+P'],
  autoScroll: ['P'],
  scrollFaster: ['=', '+'],
  scrollSlower: ['-'],
  close: ['Escape'],
};

/** Normalise a keyboard event to a string such as "Shift+Space" or "Ctrl+K". */
export function keyString(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.metaKey) mods.push('Meta');
  let k = e.key;
  if (k === ' ') k = 'Space';
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(k)) return null;
  if (k.length === 1) k = k.toUpperCase();
  // Shift is implied by the character for symbols/letters typed with it, except for named keys and Space.
  if (e.shiftKey && (k.length > 1 || /[A-Z]/.test(k))) mods.push('Shift');
  return [...mods, k].join('+');
}

export function resolveKeybinds(custom) {
  return { ...DEFAULT_KEYBINDS, ...(custom || {}) };
}

/** Find the action for a key event. */
export function actionFor(e, binds) {
  const k = keyString(e);
  if (!k) return null;
  for (const [action, keys] of Object.entries(binds)) if (keys.includes(k)) return action;
  return null;
}
