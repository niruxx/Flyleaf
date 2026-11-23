import { api } from '../api.js';
import { t } from '../i18n.js';
import { h } from '../ui.js';
import { HIGHLIGHT_COLORS } from '../views/bookmarks.js';

const full = { x: 0, y: 0, w: 1, h: 1 };
const clamp = (n) => Math.max(0, Math.min(1, n));

export function pageFromLocator(locator) {
  const page = /^\d+(?=$|@)/.exec(String(locator))?.[0];
  return page == null ? null : Number(page);
}

/** Convert a page rectangle to the visible part after cropping or splitting a scan. */
export function visibleArea(area, bounds) {
  const x = clamp((area.x - bounds.x) / bounds.w);
  const y = clamp((area.y - bounds.y) / bounds.h);
  const w = clamp((area.x + area.w - bounds.x) / bounds.w) - x;
  const h = clamp((area.y + area.h - bounds.y) / bounds.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function areaFromLocator(locator) {
  const parts = /^\d+@([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/.exec(locator)?.slice(1).map(Number);
  if (!parts || !parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) return null;
  const [x, y, w, h] = parts;
  return { x, y, w, h };
}

function position(node, { x, y, w, h }) {
  Object.assign(node.style, { left: `${100 * x}%`, top: `${100 * y}%`, width: `${100 * w}%`, height: `${100 * h}%` });
}

function projectedArea(start, finish) {
  return { x: Math.min(start.x, finish.x), y: Math.min(start.y, finish.y), w: Math.abs(start.x - finish.x), h: Math.abs(start.y - finish.y) };
}

export class PageAnnotations {
  constructor(book, shell) {
    this.book = book;
    this.shell = shell;
  }

  toggle(on = !this.active) {
    this.active = on;
    this.shell.root.classList.toggle('draw-highlight', on);
    this.shell.highlightMode(on);
    if (on) this.shell.toast(t('Drag over an area to highlight it'), 2500);
  }

  paint(layer, page, bounds) {
    const marks = [];
    for (const a of this.shell.annotations) {
      if (a.kind !== 'highlight' || a.page !== page) continue;
      const area = areaFromLocator(a.locator);
      const visible = area && visibleArea(area, bounds);
      if (!visible) continue;
      const mark = h('span.page-highlight', { style: { '--mark': HIGHLIGHT_COLORS[a.color] || HIGHLIGHT_COLORS.yellow } });
      position(mark, visible);
      marks.push(mark);
    }
    layer.replaceChildren(...marks);
  }

  refresh() {
    for (const layer of this.shell.stage.querySelectorAll('.page-highlight-layer')) layer.paint();
  }

  wrap(image, page, count) {
    const layer = h('div.page-highlight-layer', { 'aria-hidden': 'true' });
    const bounds = image.pageBounds || full;
    layer.paint = () => this.paint(layer, page, bounds);
    layer.paint();
    let drag;
    const point = (e) => {
      const r = layer.getBoundingClientRect();
      return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
    };
    layer.addEventListener('pointerdown', (e) => {
      if (!this.active || drag || e.button !== 0) return;
      e.stopPropagation();
      const preview = h('span.page-highlight.preview');
      drag = { id: e.pointerId, start: point(e), preview };
      layer.append(preview);
      layer.setPointerCapture(e.pointerId);
    });
    layer.addEventListener('pointermove', (e) => {
      if (drag?.id !== e.pointerId) return;
      e.stopPropagation();
      position(drag.preview, projectedArea(drag.start, point(e)));
    });
    const end = (e) => {
      if (drag?.id !== e.pointerId) return;
      e.stopPropagation();
      const { start, preview } = drag;
      drag = null;
      preview.remove();
      if (e.type !== 'pointerup') return;
      const area = projectedArea(start, point(e));
      if (area.w * layer.clientWidth < 3 || area.h * layer.clientHeight < 3) return;
      const parts = [
        bounds.x + area.x * bounds.w, bounds.y + area.y * bounds.h, area.w * bounds.w, area.h * bounds.h,
      ].map((n) => n.toFixed(5));
      this.toggle(false);
      api.addAnnotation(this.book.id, { kind: 'highlight', locator: `${page}@${parts.join(',')}`, page, percent: (page + 1) / count })
        .then((annotation) => {
          this.shell.annotations = [...this.shell.annotations, annotation];
          this.refresh();
          this.shell.toast(t('Highlight saved'));
        }).catch((e) => this.shell.toast(e.message));
    };
    layer.addEventListener('pointerup', end);
    layer.addEventListener('pointercancel', end);
    layer.addEventListener('lostpointercapture', end);
    layer.addEventListener('click', (e) => e.stopPropagation());
    return h('div.annotated-page', image, layer);
  }
}
