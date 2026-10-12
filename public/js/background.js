// Per-user app background: an uploaded image/GIF or an image URL, dimmed with the
// theme's surface colour (so text stays readable) and optionally blurred.

export const BG_DEFAULTS = { dim: 70, blur: 0, fit: 'cover' };

/**
 * @param bg prefs.background: { source: 'upload' | 'url', url, dim, blur, fit } or null
 * @param uploadUrl the user's uploaded background (session.user.backgroundUrl)
 */
export function applyBackground(bg, uploadUrl) {
  const root = document.documentElement;
  const url = bg?.source === 'upload' ? uploadUrl : bg?.source === 'url' ? bg.url : null;
  if (!url) {
    root.classList.remove('has-bg');
    root.style.removeProperty('--user-bg');
    return;
  }
  const s = { ...BG_DEFAULTS, ...bg };
  // JSON-quote the URL so quotes or brackets in it can't break out of url().
  root.style.setProperty('--user-bg', `url(${JSON.stringify(String(url))})`);
  root.style.setProperty('--bg-dim', String(Math.min(Math.max(Number(s.dim) || 0, 0), 95) / 100));
  root.style.setProperty('--bg-blur', `${Math.min(Math.max(Number(s.blur) || 0, 0), 30)}px`);
  root.dataset.bgFit = ['cover', 'contain', 'tile'].includes(s.fit) ? s.fit : 'cover';
  root.classList.add('has-bg');
}
