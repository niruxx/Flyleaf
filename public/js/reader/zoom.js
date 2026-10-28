// Zoom the rendered spread, leaving the reader chrome and browser viewport alone.
export class PageZoom {
  constructor(viewport, changed = () => {}) {
    this.viewport = viewport;
    this.changed = changed;
    this.scale = 1;
    this.x = this.y = this.appliedX = this.appliedY = 0;
  }
  get active() { return this.scale > 1; }
  reset() {
    if (this.target) this.target.style.transform = '';
    this.target = null;
    this.scale = 1;
    this.x = this.y = this.appliedX = this.appliedY = 0;
    this.viewport.classList.remove('zoomed');
    this.changed(false);
  }
  zoom(scale, clientX, clientY) {
    const target = this.viewport.querySelector('.spread:not(.end-spread)');
    if (!target) return;
    if (this.target !== target) {
      this.reset();
      this.target = target;
    }
    // Measure the untransformed page, including its current native scroll position.
    const rect = target.getBoundingClientRect();
    const left = rect.left;
    const top = rect.top;
    const ratio = Math.max(1, Math.min(4, scale)) / this.scale;
    this.x += (clientX - left) * (1 - ratio);
    this.y += (clientY - top) * (1 - ratio);
    this.scale *= ratio;
    if (this.scale <= 1.01) return this.reset();
    this.paint();
  }
  pan(dx, dy) {
    this.x += dx;
    this.y += dy;
    this.paint();
  }
  paint() {
    if (!this.target) return;
    const v = this.viewport.getBoundingClientRect();
    const r = this.target.getBoundingClientRect();
    const left = r.left - this.appliedX;
    const top = r.top - this.appliedY;
    const width = this.target.offsetWidth * this.scale;
    const height = this.target.offsetHeight * this.scale;
    const bound = (value, origin, size, start, length) => size <= length
      ? start + (length - size) / 2 - origin
      : Math.max(start + length - origin - size, Math.min(start - origin, value));
    this.x = bound(this.x, left, width, v.left, v.width);
    this.y = bound(this.y, top, height, v.top, v.height);
    this.target.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    this.appliedX = this.x;
    this.appliedY = this.y;
    this.viewport.classList.add('zoomed');
    this.changed(true);
  }
}
