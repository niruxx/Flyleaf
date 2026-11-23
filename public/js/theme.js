// Themes, light/dark mode and motion preferences.

import { syncThemeColor } from './ui.js';

const FLYLEAF = { id: 'flyleaf', name: 'Flyleaf', hue: 158, chroma: 0.9, preview: ['#f8f8f1', '#14654c', '#cfe9db', '#a64a32'] };

export const THEMES = [
  FLYLEAF,
  { id: 'periwinkle', name: 'Periwinkle', hue: 268, chroma: 1 },
  { id: 'ocean', name: 'Ocean', hue: 228, chroma: 1 },
  { id: 'sakura', name: 'Sakura', hue: 350, chroma: 0.9 },
  { id: 'forest', name: 'Forest', hue: 150, chroma: 0.9 },
  { id: 'ember', name: 'Ember', hue: 40, chroma: 1.1 },
  { id: 'paper', name: 'Paper', hue: 75, chroma: 0.45 },
  { id: 'lagoon', name: 'Lagoon', hue: 190, chroma: 0.95 },
  { id: 'marigold', name: 'Marigold', hue: 95, chroma: 1.05 },
  { id: 'mulberry', name: 'Mulberry', hue: 322, chroma: 0.85 },
  { id: 'dracula', name: 'Dracula', hue: 295, chroma: 1.2 },
  { id: 'graphite', name: 'Graphite', hue: 260, chroma: 0.08 },
  { id: 'midnight', name: 'Midnight (OLED)', hue: 255, chroma: 0.8, oled: true, mode: 'dark' },
];

const KEY = 'flyleaf.themeState';
export const DEFAULT_THEME = { mode: 'system', theme: FLYLEAF.id, hue: FLYLEAF.hue, chroma: FLYLEAF.chroma, oled: false, noMotion: false };

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}
function write(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
}

export function themeState() {
  const s = { ...DEFAULT_THEME, ...read() };
  if (s.theme === FLYLEAF.id) Object.assign(s, { hue: FLYLEAF.hue, chroma: FLYLEAF.chroma, oled: false });
  return s;
}

/** Apply theme state to the document (and remember it for flash-free loads). */
export function applyTheme(partial = {}) {
  const s = { ...themeState(), ...partial };
  const preset = THEMES.find((t) => t.id === s.theme);
  if (preset && partial.theme) {
    s.hue = preset.hue;
    s.chroma = preset.chroma;
    s.oled = Boolean(preset.oled);
    if (preset.mode && partial.mode == null) s.mode = preset.mode;
  }
  const r = document.documentElement;
  if (s.theme === FLYLEAF.id) r.dataset.palette = FLYLEAF.id;
  else delete r.dataset.palette;
  if (s.eink) r.dataset.theme = 'light';
  else if (s.mode === 'light' || s.mode === 'dark') r.dataset.theme = s.mode;
  else delete r.dataset.theme;
  r.style.setProperty('--seed-hue', s.hue);
  r.style.setProperty('--seed-chroma', s.chroma);
  if (s.oled) r.dataset.oled = '';
  else delete r.dataset.oled;
  r.classList.toggle('no-motion', Boolean(s.noMotion || s.eink));
  r.classList.toggle('eink', Boolean(s.eink));
  write(s);
  syncThemeColor();
  return s;
}

export function isDark() {
  if (themeState().eink) return false;
  const m = themeState().mode;
  return m === 'dark' || (m === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}

export const motionEnabled = () => !document.documentElement.classList.contains('no-motion') && !matchMedia('(prefers-reduced-motion: reduce)').matches;
