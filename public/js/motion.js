// App-wide motion: scroll reveal, cover tilt & sheen, direction-aware page
// transitions and the circular theme reveal. Everything is skipped when the user
// turns animations off or the system asks for reduced motion.

import { motionEnabled } from './theme.js';

const fine = matchMedia('(hover: hover) and (pointer: fine)');

// ---------------------------------------------------------------------------
// Scroll reveal: content below the fold rises in as it scrolls into view.
// (Content visible on arrival is animated by .stagger / .enter instead.)

const REVEAL = [
  '.grid > *', '.shelf > *', '.section', '.settings-group', '.download-row', '.source-card',
  '.resume-card', '.vol-row', '.finder-section', '.upload-row', '.info-card',
].join(',');

let io = null;
let batch = [];
let flush = 0;

function onIntersect(entries) {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    io.unobserve(e.target);
    batch.push(e.target);
  }
  if (batch.length && !flush) {
    flush = requestAnimationFrame(() => {
      // Items that arrive together cascade.
      batch.forEach((el, i) => {
        el.style.setProperty('--reveal-delay', `${Math.min(i, 10) * 35}ms`);
        el.classList.add('revealed');
      });
      batch = [];
      flush = 0;
    });
  }
}

function watch(root) {
  if (!motionEnabled() || !('IntersectionObserver' in window)) return;
  io ||= new IntersectionObserver(onIntersect, { rootMargin: '0px 0px -6% 0px', threshold: 0.01 });
  const vh = innerHeight;
  const els = root.matches?.(REVEAL) ? [root] : [];
  els.push(...(root.querySelectorAll?.(REVEAL) || []));
  for (const el of els) {
    if (el.dataset.revealSeen) continue;
    el.dataset.revealSeen = '1';
    // Only hide what starts off-screen, so nothing visible ever flickers.
    const top = el.getBoundingClientRect().top;
    if (top > vh) {
      el.classList.add('reveal');
      io.observe(el);
    }
  }
}

function initReveal() {
  const view = document.getElementById('view');
  if (!view) return;
  let pending = new Set();
  let raf = 0;
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) pending.add(n);
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        const nodes = pending;
        pending = new Set();
        for (const n of nodes) if (n.isConnected) watch(n);
      });
    }
  }).observe(view, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Cover tilt & sheen on hover (mouse only).

function initTilt() {
  let current = null;
  let raf = 0;
  let last = null;
  const reset = (el) => {
    el.style.removeProperty('--rx');
    el.style.removeProperty('--ry');
    el.classList.remove('tilting');
  };
  document.addEventListener('pointermove', (e) => {
    if (!fine.matches || !motionEnabled() || e.pointerType !== 'mouse') return;
    const cover = e.target.closest?.('.tile .cover, .series-hero .cover-col .cover, .finder-detail-top .cover');
    if (current && current !== cover) reset(current);
    current = cover;
    if (!cover) return;
    last = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!current || !last) return;
      const r = current.getBoundingClientRect();
      const x = (last.clientX - r.left) / r.width;
      const y = (last.clientY - r.top) / r.height;
      current.classList.add('tilting');
      current.style.setProperty('--rx', `${((0.5 - y) * 7).toFixed(2)}deg`);
      current.style.setProperty('--ry', `${((x - 0.5) * 9).toFixed(2)}deg`);
      current.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
      current.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
    });
  }, { passive: true });
  document.addEventListener('pointerleave', () => current && reset(current), true);
  document.addEventListener('scroll', () => current && reset(current), { passive: true, capture: true });
}

// ---------------------------------------------------------------------------
// Page transitions know whether you went forward or back.

let goingBack = false;
addEventListener('popstate', () => {
  goingBack = true;
});
/** Called by the router right before a view transition starts. */
export function markNavigation() {
  document.documentElement.dataset.nav = goingBack ? 'back' : 'forward';
  goingBack = false;
}

// ---------------------------------------------------------------------------
// Theme changes ripple out from where you clicked.

export function themeReveal(event, change) {
  const reduce = !motionEnabled() || !document.startViewTransition;
  if (reduce) return change();
  const x = event?.clientX ?? innerWidth - 40;
  const y = event?.clientY ?? 32;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  document.documentElement.dataset.nav = 'theme';
  const vt = document.startViewTransition(() => change());
  vt.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 520, easing: 'cubic-bezier(0.2, 0, 0, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => {});
  vt.finished.finally(() => delete document.documentElement.dataset.nav);
}

// ---------------------------------------------------------------------------
// Closing animations for dialogs, sheets, menus and snackbars.

/** Play the element's exit animation (class `leaving`), then run `done`. */
export function leave(el, done) {
  if (!el?.isConnected || !motionEnabled()) return done();
  if (el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  el.addEventListener('animationend', (e) => e.target === el && finish());
  setTimeout(finish, 320); // in case the animation never runs
}

export function initMotion() {
  initReveal();
  initTilt();
}
