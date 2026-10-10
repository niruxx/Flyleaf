// Themes, light/dark mode and motion preferences.

import { syncThemeColor } from './ui.js';

export const THEMES = [
  { id: 'flyleaf', name: 'Flyleaf', hue: 268, chroma: 1 },
  { id: 'ocean', name: 'Ocean', hue: 228, chroma: 1 },
  { id: 'sakura', name: 'Sakura', hue: 350, chroma: 0.9 },
  { id: 'forest', name: 'Forest', hue: 150, chroma: 0.9 },
  { id: 'ember', name: 'Ember', hue: 40, chroma: 1.1 },
  { id: 'paper', name: 'Paper', hue: 75, chroma: 0.45 },
  { id: 'dracula', name: 'Dracula', hue: 295, chroma: 1.2 },
  { id: 'graphite', name: 'Graphite', hue: 260, chroma: 0.08 },
  { id: 'midnight', name: 'Midnight (OLED)', hue: 255, chroma: 0.8, oled: true, mode: 'dark' },
];

const KEY = 'flyleaf.themeState';

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

export const themeState = () => ({ mode: 'system', theme: 'flyleaf', hue: 268, chroma: 1, oled: false, noMotion: false, ...read() });

/** Apply theme state to the document (and remember it for flash-free loads). */
export function applyTheme(partial = {}) {
  const s = { ...themeState(), ...partial };
  const preset = THEMES.find((t) => t.id === s.theme);
  if (preset && partial.theme) {
    s.hue = preset.hue;
    s.chroma = preset.chroma;
    s.oled = Boolean(preset.oled);
    if (preset.mode) s.mode = preset.mode;
  }
  const r = document.documentElement;
  if (s.mode === 'light' || s.mode === 'dark') r.dataset.theme = s.mode;
  else delete r.dataset.theme;
  r.style.setProperty('--seed-hue', s.hue);
  r.style.setProperty('--seed-chroma', s.chroma);
  if (s.oled) r.dataset.oled = '';
  else delete r.dataset.oled;
  r.classList.toggle('no-motion', Boolean(s.noMotion));
  write(s);
  syncThemeColor();
  return s;
}

export function isDark() {
  const m = themeState().mode;
  return m === 'dark' || (m === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}

export const motionEnabled = () => !document.documentElement.classList.contains('no-motion') && !matchMedia('(prefers-reduced-motion: reduce)').matches;
