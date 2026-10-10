import { api } from '../api.js';
import { session, navigate, onLeave, isAdmin } from '../router.js';
import { h, icon, menu, getTheme, setTheme, isDark, iconButton } from '../ui.js';

export function accountButton() {
  const u = session.user;
  const initial = (u?.displayName || u?.username || '?').trim()[0];
  const btn = h('button.avatar', { type: 'button', title: u?.displayName, 'aria-label': 'Account' }, initial);
  btn.addEventListener('click', () => {
    const theme = getTheme();
    menu(btn, [
      { label: `${u.displayName} · ${u.role === 'admin' ? 'Admin' : 'Guest'}`, icon: u.role === 'admin' ? 'shield_person' : 'person' },
      '-',
      { label: 'Light', icon: 'light_mode', checked: theme === 'light', onClick: () => setTheme('light') },
      { label: 'Dark', icon: 'dark_mode', checked: theme === 'dark', onClick: () => setTheme('dark') },
      { label: 'System', icon: 'contrast', checked: theme === 'system', onClick: () => setTheme('system') },
      '-',
      { label: 'Sign out', icon: 'logout', onClick: signOut },
    ]);
  });
  return btn;
}

export function themeToggle() {
  const btn = iconButton(isDark() ? 'light_mode' : 'dark_mode', 'Toggle dark mode', () => {
    setTheme(isDark() ? 'light' : 'dark');
    btn.querySelector('.icon').textContent = isDark() ? 'light_mode' : 'dark_mode';
  });
  return btn;
}

export async function signOut() {
  await api.logout().catch(() => {});
  session.user = null;
  navigate('/login', { replace: true });
}

/** Small pill that shows while the library is being scanned; polls until idle. */
export function scanIndicator(onDone) {
  const el = h('span.scan-pill', { hidden: true }, h('span.spinner'), h('span.txt', 'Scanning…'));
  let timer;
  let wasRunning = false;
  async function poll() {
    try {
      const s = await api.scanStatus();
      el.hidden = !s.running;
      if (s.running) {
        const txt =
          s.phase === 'metadata' && s.total ? `Reading metadata ${s.processed}/${s.total}` : s.phase === 'walking' ? `Scanning… ${s.found} found` : 'Scanning…';
        el.querySelector('.txt').textContent = txt;
        wasRunning = true;
      } else if (wasRunning) {
        wasRunning = false;
        onDone?.();
      }
      timer = setTimeout(poll, s.running ? 1500 : 10000);
    } catch {
      timer = setTimeout(poll, 15000);
    }
  }
  poll();
  onLeave(() => clearTimeout(timer));
  return el;
}

export { isAdmin, icon };
