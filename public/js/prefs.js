// User preferences (stored server-side so they follow you between devices).

import { api } from './api.js';
import { session } from './router.js';
import { applyTheme } from './theme.js';
import { applyBackground } from './background.js';
import { applyCatalogPrefs } from './catalog-prefs.js';

export const prefs = () => session.user?.prefs || {};

/** Apply everything visual from the signed-in user's prefs. */
export function applyUserPrefs() {
  const p = prefs();
  applyCatalogPrefs(session.user);
  applyTheme({ mode: 'system', theme: 'flyleaf', hue: 268, chroma: 1, oled: false,
    ...(p.theme || {}), noMotion: Boolean(p.disableAnimations), eink: Boolean(p.einkMode) });
  applyBackground(p.einkMode ? null : p.background, session.user?.backgroundUrl);
}

let saveTimer;
let pending = {};
let pendingUser;
export function setPref(key, value) {
  const user = session.user;
  if (!user) return;
  if (pendingUser !== user) {
    pending = {};
    pendingUser = user;
  }
  user.prefs = { ...prefs(), [key]: value };
  pending[key] = value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const body = pending;
    pending = {};
    if (session.user === user) api.savePrefs(body).catch(() => {});
  }, 400);
  if (key === 'disableAnimations' || key === 'einkMode') applyUserPrefs();
  if (key === 'background') applyBackground(prefs().einkMode ? null : value, session.user?.backgroundUrl);
}

/** Change theme (mode/preset/hue) and remember it on the account. */
export function setTheme(partial) {
  const s = applyTheme(partial);
  setPref('theme', { mode: s.mode, theme: s.theme, hue: s.hue, chroma: s.chroma, oled: s.oled });
  return s;
}
