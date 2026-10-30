const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { patchPaginator } = require('../server/foliate-patch');
const upstream = fs.readFileSync('node_modules/foliate-js/paginator.js', 'utf8');

test('compatibility patch validates the pinned source and includes load cancellation', () => {
  const patched = patchPaginator(upstream);
  assert.match(patched, /#cancelLoad/);
  assert.match(patched, /Ebook section load timed out/);
  assert.throws(() => patchPaginator(upstream.replace('snap(vx, vy)', 'snapChanged(vx, vy)')), /compatibility patch/);
});

test('page strides use iframe viewport pixels despite transforms and fractional bounds', () => {
  const patched = patchPaginator(upstream);
  const getters = patched.slice(patched.indexOf('    get size() {'), patched.indexOf('    scrollBy(dx, dy) {'));
  const Metrics = vm.runInNewContext(`(class {
    #container; #view;
    constructor(container, element, sideProp) {
      this.#container = container; this.#view = { element }; this.sideProp = sideProp;
    }
    ${getters}
  })`);
  for (const side of ['width', 'height']) {
    const container = { clientWidth: 366, clientHeight: 750,
      getBoundingClientRect() { throw new Error('Transformed bounds must not set page strides'); } };
    const element = { clientWidth: 366 * 42, clientHeight: 750 * 42 };
    const metrics = new Metrics(container, element, side);
    assert.equal(metrics.size, side === 'width' ? 366 : 750);
    assert.equal(metrics.pages, 42);
  }
  assert.match(patched, /clientWidth: width, clientHeight: height/);
});

function engine() {
  const source = fs.readFileSync('public/js/reader/text.js', 'utf8').replace(/^import .*;\r?$/gm, '').replace('export class TextEngine', 'class TextEngine');
  const m = { exports: {} };
  let timer;
  const context = { module: m, console: { warn() {} }, t: (s) => s, TEXT_THEMES: { light: { bg: '#fff' } }, LOOKS: {},
    reducedMotion: () => false, fallingLeaf() {},
    setTimeout: (fn) => { timer = fn; return 1; }, clearTimeout: () => { timer = null; },
  };
  vm.runInNewContext(source + '\nmodule.exports = TextEngine;', context);
  const chrome = [], toasts = [];
  const shell = { settings: { pageTurn: 'book', flow: 'paginated', textTheme: 'light' }, stage: {},
    root: { classList: { contains: () => false } }, showChrome: (on) => chrome.push(on), toast: (text) => toasts.push(text) };
  const instance = new m.exports({ id: 1 }, shell, {});
  let cancelled = 0;
  instance.view = { renderer: { atEnd: false, atStart: false }, book: { dir: 'ltr' }, style: {},
    parentElement: { clientWidth: 390, clientHeight: 800 },
    animate: () => ({ finished: Promise.resolve(), cancel: () => cancelled++ }), next: async () => {}, goTo: async () => {} };
  return { instance, chrome, toasts, get cancelled() { return cancelled; }, fireTimer: () => timer?.() };
}

test('a failed book turn always cancels its edge-on animation', async () => {
  const state = engine();
  state.instance.view.next = async () => { throw new Error('Chapter load failed'); };
  await state.instance.next();
  assert.ok(state.cancelled > 0);
  assert.equal(state.instance.view.style.transformOrigin, '');
  assert.equal(state.instance.turning, false);
  assert.equal(state.instance.navigating, false);
  assert.equal(state.chrome.at(-1), true);
  assert.equal(state.toasts.length, 1);
});

test('repeated taps do not start overlapping ebook turns', async () => {
  const state = engine();
  let release, calls = 0;
  state.instance.s.pageTurn = 'slide';
  state.instance.view.next = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  const first = state.instance.next();
  state.instance.next(); state.instance.next();
  assert.equal(calls, 1);
  state.fireTimer();
  assert.equal(state.chrome.at(-1), true);
  release(); await first;
  assert.equal(state.instance.navigating, false);
});

test('failed navigation restores the saved reading location and leaves controls open', async () => {
  const state = engine();
  const restored = [];
  state.instance.view.lastLocation = { cfi: 'epubcfi(/6/2!/4/2)' };
  state.instance.view.goTo = async (cfi) => { restored.push(cfi); };
  state.instance.view.next = async () => { throw new Error('Failed'); };
  await state.instance.next();
  assert.deepEqual(restored, ['epubcfi(/6/2!/4/2)']);
  assert.equal(state.chrome.at(-1), true);
});

test('renderer navigation measures the page only after the live iframe lift is cancelled', async () => {
  const state = engine();
  state.instance.view.next = async () => {
    assert.ok(state.cancelled > 0, 'the 90-degree transform must be cancelled before Foliate measures its viewport');
  };
  await state.instance.next();
  assert.equal(state.toasts.length, 0);
});
