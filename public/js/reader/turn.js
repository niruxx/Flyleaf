// "Book" page turns: the page swings over on its spine in 3D, like turning a page of a real
// book. For comics and PDFs the turning leaf carries the real pages – the old page on its front
// and, in two-page spreads, the next left-hand page on its back – while the page underneath is
// already the new one. Ebooks (an iframe that can't be copied) lift the current page off and
// let a blank leaf fall the rest of the way (see TextEngine.turnBook).

const DURATION = 620;
const EASE = 'cubic-bezier(0.32, 0.08, 0.2, 1)';
let running = null;

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('no-motion');

/** Finish a turn still in progress straight away (a quick second tap). */
export function finishTurn() {
  running?.();
  running = null;
}

const relRect = (el, stage) => {
  const r = el.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  return { left: r.left - s.left, top: r.top - s.top, width: r.width, height: r.height };
};
const place = (el, r) => Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

/** A copy of a page element for the back of the leaf (canvases need their pixels copied). */
function copyOf(el) {
  if (el.tagName === 'CANVAS') {
    const c = document.createElement('canvas');
    c.width = el.width;
    c.height = el.height;
    c.getContext('2d').drawImage(el, 0, 0);
    c.style.cssText = el.style.cssText;
    return c;
  }
  return el.cloneNode(true);
}

const pagesOf = (wrap) => [...(wrap?.children || [])].filter((e) => e.matches('img, canvas'));

/**
 * Turn from the spread on screen (`oldWrap`, already out of the page) to `newWrap` (in place).
 * `toLeft`: the leaf travels right → left (next page in left-to-right books, previous in manga).
 */
export function turnPages({ stage, oldWrap, oldRects, newWrap, toLeft, paper = '#fbf8f1' }) {
  finishTurn();
  const oldPages = pagesOf(oldWrap).map((el, i) => ({ el, rect: oldRects[i] })).sort((a, b) => a.rect.left - b.rect.left);
  if (!oldPages.length) return;
  const newPages = pagesOf(newWrap).map((el) => ({ el, rect: relRect(el, stage) })).sort((a, b) => a.rect.left - b.rect.left);

  // The leaf: the page on the side we're turning from. The one beside it (in a spread) stays put
  // on top of the new page until the leaf lands over it.
  const turning = toLeft ? oldPages.at(-1) : oldPages[0];
  const staying = oldPages.length > 1 ? (toLeft ? oldPages[0] : oldPages.at(-1)) : null;
  // Its back is the new page that ends up on the other side (two-page spreads), or plain paper.
  const backSource = oldPages.length > 1 && newPages.length > 1 ? (toLeft ? newPages[0] : newPages.at(-1)) : null;

  const layer = document.createElement('div');
  layer.className = 'turn-layer';
  if (staying) {
    const under = document.createElement('div');
    under.className = 'turn-under';
    place(under, staying.rect);
    under.append(staying.el);
    layer.append(under);
  }
  const leaf = document.createElement('div');
  leaf.className = `turn-leaf ${toLeft ? 'hinge-left' : 'hinge-right'}`;
  place(leaf, turning.rect);
  const front = document.createElement('div');
  front.className = 'turn-face front';
  front.append(turning.el);
  const frontShade = document.createElement('div');
  frontShade.className = 'turn-shade';
  front.append(frontShade);
  const back = document.createElement('div');
  back.className = 'turn-face back';
  back.style.background = paper;
  if (backSource) back.append(copyOf(backSource.el));
  const backShade = document.createElement('div');
  backShade.className = 'turn-shade';
  back.append(backShade);
  leaf.append(front, back);
  // The shadow the lifting page casts on the page beneath.
  const cast = document.createElement('div');
  cast.className = `turn-cast ${toLeft ? 'from-right' : 'from-left'}`;
  place(cast, turning.rect);
  layer.append(cast, leaf);
  stage.append(layer);

  const end = toLeft ? -180 : 180;
  const opts = { duration: DURATION, easing: EASE, fill: 'forwards' };
  const anims = [
    leaf.animate([{ transform: 'perspective(2400px) rotateY(0deg)' }, { transform: `perspective(2400px) rotateY(${end * 0.5}deg) translateZ(18px)`, offset: 0.5 }, { transform: `perspective(2400px) rotateY(${end}deg)` }], opts),
    frontShade.animate([{ opacity: 0 }, { opacity: 0.5, offset: 0.5 }, { opacity: 0.6 }], opts),
    backShade.animate([{ opacity: 0.55 }, { opacity: 0.25, offset: 0.6 }, { opacity: 0 }], opts),
    cast.animate([{ opacity: 0 }, { opacity: 0.55, offset: 0.35 }, { opacity: 0 }], opts),
  ];
  // One page at a time: the leaf ends up beside the page, so it fades as it lands. (The faces
  // fade, not the leaf: opacity on the leaf would flatten its 3D and show the front through.)
  if (!backSource) {
    for (const face of [front, back]) anims.push(face.animate([{ opacity: 1 }, { opacity: 1, offset: 0.62 }, { opacity: 0 }], opts));
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    anims.forEach((a) => a.cancel());
    layer.remove();
  };
  anims[0].finished.then(finish, finish);
  running = finish;
}

/** Where each page of a spread is on screen, measured before it's taken down. */
export const measure = (wrap, stage) => pagesOf(wrap).map((el) => relRect(el, stage));

/**
 * A blank leaf falling the rest of the way (ebooks): from edge-on to flat on the other side,
 * over `rect`, hinged on the side the page turns from.
 */
export function fallingLeaf({ stage, rect, toLeft, paper, from = 90, grain = false }) {
  const layer = document.createElement('div');
  layer.className = 'turn-layer';
  const leaf = document.createElement('div');
  leaf.className = `turn-leaf ${toLeft ? 'hinge-left' : 'hinge-right'}`;
  place(leaf, rect);
  const face = document.createElement('div');
  face.className = 'turn-face plain';
  face.style.background = paper;
  if (grain) face.style.backgroundImage = 'var(--paper-grain)';
  const shade = document.createElement('div');
  shade.className = 'turn-shade';
  face.append(shade);
  leaf.append(face);
  layer.append(leaf);
  stage.append(layer);
  const end = toLeft ? -180 : 180;
  // From flat (a whole turn) or from edge-on (finishing a turn the page itself started).
  const whole = from === 0;
  const opts = { duration: whole ? DURATION : DURATION * 0.5, easing: whole ? EASE : 'cubic-bezier(0.1, 0.4, 0.3, 1)', fill: 'forwards' };
  const a = leaf.animate([{ transform: `perspective(2400px) rotateY(${whole ? 0 : end * 0.5}deg)` }, { transform: `perspective(2400px) rotateY(${end}deg)` }], opts);
  shade.animate(whole ? [{ opacity: 0 }, { opacity: 0.5, offset: 0.5 }, { opacity: 0.15 }] : [{ opacity: 0.5 }, { opacity: 0.15 }], opts);
  layer.animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], opts);
  const finish = () => layer.remove();
  a.finished.then(finish, finish);
}

export const TURN_DURATION = DURATION;
