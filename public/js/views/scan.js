import { api } from '../api.js';
import { onLeave } from '../router.js';
import { h } from '../ui.js';

/** Small pill that shows while the library is being scanned; polls until idle. */
export function scanIndicator(onDone) {
  const el = h('span.scan-pill', { hidden: true }, h('span.spinner'), h('span.txt', 'Scanning…'));
  let timer;
  let wasRunning = false;
  let stopped = false;
  async function poll() {
    if (stopped) return;
    try {
      const s = await api.scanStatus();
      el.hidden = !s.running;
      if (s.running) {
        el.querySelector('.txt').textContent =
          s.phase === 'metadata' && s.total ? `Reading metadata ${s.processed}/${s.total}` : s.phase === 'walking' ? `Scanning… ${s.found} found` : 'Scanning…';
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
  onLeave(() => {
    stopped = true;
    clearTimeout(timer);
  });
  return el;
}
