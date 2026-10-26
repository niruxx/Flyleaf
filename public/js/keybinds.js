// Reader key bindings (customisable in Settings → Key binds).

export const ACTIONS = [
  { id: 'pageRight', label: 'Page right', hint: 'Next page in left-to-right books, previous in manga' },
  { id: 'pageLeft', label: 'Page left', hint: 'Previous page in left-to-right books, next in manga' },
  { id: 'next', label: 'Next page' },
  { id: 'prev', label: 'Previous page' },
  { id: 'first', label: 'First page' },
  { id: 'last', label: 'Last page' },
  { id: 'toggleMenu', label: 'Show / hide menu' },
  { id: 'bookmark', label: 'Bookmark this page' },
  { id: 'contents', label: 'Contents & annotations' },
  { id: 'settings', label: 'Reader settings' },
  { id: 'fullscreen', label: 'Full screen' },
  { id: 'nextBook', label: 'Next volume / chapter' },
  { id: 'prevBook', label: 'Previous volume / chapter' },
  { id: 'autoScroll', label: 'Start / pause auto-scroll', hint: 'Webtoon mode' },
  { id: 'scrollFaster', label: 'Auto-scroll faster' },
  { id: 'scrollSlower', label: 'Auto-scroll slower' },
  { id: 'close', label: 'Close the book' },
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
