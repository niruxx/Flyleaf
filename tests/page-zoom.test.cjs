const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const moduleReady = import('data:text/javascript;base64,' + Buffer.from(readFileSync('public/js/reader/zoom.js')).toString('base64'));

async function setup() {
  const { PageZoom } = await moduleReady;
  const classes = new Set();
  const target = {
    offsetWidth: 400, offsetHeight: 600, style: {},
    getBoundingClientRect() {
      const match = this.style.transform?.match(/translate\(([-.0-9]+)px, ([-.0-9]+)px\) scale\(([-.0-9]+)\)/);
      const [, x = 0, y = 0, scale = 1] = match || [];
      return { left: 200 + +x, top: +y, width: 400 * scale, height: 600 * scale };
    },
  };
  const viewport = {
    querySelector: () => target,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    classList: { add: (v) => classes.add(v), remove: (v) => classes.delete(v) },
  };
  return { zoom: new PageZoom(viewport), target, classes };
}

test('zoom preserves the focal point when within pan bounds', async () => {
  const { zoom, target } = await setup();
  zoom.zoom(3, 400, 300);
  const r = target.getBoundingClientRect();
  assert.equal(r.left + 200 * zoom.scale, 400);
  assert.equal(r.top + 300 * zoom.scale, 300);
});

test('panning clamps every edge and centers smaller dimensions', async () => {
  const { zoom, target } = await setup();
  zoom.zoom(1.5, 400, 300);
  zoom.pan(10000, 10000);
  assert.equal(target.getBoundingClientRect().left, 100);
  assert.equal(target.getBoundingClientRect().top, 0);
  zoom.pan(-20000, -20000);
  assert.equal(target.getBoundingClientRect().top, -300);
  assert.equal(target.getBoundingClientRect().left, 100);
});

test('scale is capped and resetting removes transforms and zoom state', async () => {
  const { zoom, target, classes } = await setup();
  zoom.zoom(100, 400, 300);
  assert.equal(zoom.scale, 4);
  assert.ok(classes.has('zoomed'));
  zoom.zoom(0.5, 400, 300);
  assert.equal(zoom.scale, 1);
  assert.equal(zoom.active, false);
  assert.equal(target.style.transform, '');
  assert.equal(classes.has('zoomed'), false);
});

 test('successive zoom steps preserve the same content point', async () => {
  const { zoom, target } = await setup();
  zoom.zoom(3, 400, 300);
  zoom.zoom(4, 400, 300);
  const r = target.getBoundingClientRect();
  assert.equal(r.left + 200 * zoom.scale, 400);
  assert.equal(r.top + 300 * zoom.scale, 300);
});
