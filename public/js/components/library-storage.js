import { api } from '../api.js';
import { t } from '../i18n.js';
import { button, h, icon } from '../ui.js';

export function storageNotice(library, refresh) {
  const message = h('span', { role: 'status' }, t('Storage unavailable. Reconnect the drive or check folder permissions.'));
  const check = button(t('Check again'), { variant: 'text', onclick: async () => {
    check.disabled = true;
    try {
      const result = await api.checkLibraryStorage(library.id);
      if (!result.available) message.textContent = t('The server still cannot reach this library’s storage.');
      else if (result.needsScan) {
        message.textContent = t('The folder is reachable. Flyleaf is checking the library.');
        for (let attempt = 0; attempt < 8 && message.isConnected; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (!message.isConnected) return;
          const libs = await api.libraries(library.ownerId ? 'all' : undefined);
          if (libs.some(lib => lib.id === library.id && !lib.storageUnavailable)) { refresh(); return; }
        }
        if (message.isConnected) message.textContent = t('The library check is still running or part of the storage is unavailable.');
      }
      else refresh();
    } catch (error) { message.textContent = error.message; }
    finally { check.disabled = false; }
  } });
  return h('div.home-card', icon('hard_drive'), h('div', h('strong', library.name),
    library.path && h('div.body-small.mono', library.path), h('div', message), check));
}
