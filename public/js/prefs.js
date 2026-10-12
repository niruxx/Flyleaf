// User preferences (stored server-side so they follow you between devices).

import { api } from './api.js';
import { session } from './router.js';
import { applyTheme } from './theme.js';
import { applyBackground } from './background.js';

export const prefs = () => session.user?.prefs || {};

/** Apply everything visual from the signed-in user's prefs. */
export function applyUserPrefs() {
  const p = prefs();
  applyTheme({ ...(p.theme || {}), noMotion: Boolean(p.disableAnimations) });
  applyBackground(p.background, session.user?.backgroundUrl);
}

let saveTimer;
let pending = {};
export function setPref(key, value) {
  if (!session.user) return;
  session.user.prefs = { ...prefs(), [key]: value };
  pending[key] = value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const body = pending;
    pending = {};
    api.savePrefs(body).catch(() => {});
  }, 400);
  if (key === 'disableAnimations') applyTheme({ noMotion: Boolean(value) });
  if (key === 'background') applyBackground(value, session.user?.backgroundUrl);
}

/** Change theme (mode/preset/hue) and remember it on the account. */
export function setTheme(partial) {
  const s = applyTheme(partial);
  setPref('theme', { mode: s.mode, theme: s.theme, hue: s.hue, chroma: s.chroma, oled: s.oled });
  return s;
}
