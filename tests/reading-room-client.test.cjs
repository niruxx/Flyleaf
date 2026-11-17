const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
async function load(file, context = vm.createContext({ Intl })) {
  const mod = new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { context });
  await mod.link(() => new vm.SourceTextModule('export const syncThemeColor = () => {};', { context }));
  await mod.evaluate();
  return mod.namespace;
}
test('spoiler frontier follows progress and keeps future titles protected across partial and completed reads', async () => {
  const { spoilerHiddenIds } = await load('public/js/spoilers.js');
  const books = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  assert.equal(Array.from(spoilerHiddenIds(books)).join(','), '2,3,4');
  books[0].progress = { finished: true, percent: 1 };
  assert.equal(Array.from(spoilerHiddenIds(books)).join(','), '3,4');
  books[1].progress = { percent: .5 };
  assert.equal(Array.from(spoilerHiddenIds(books)).join(','), '3,4');
  books[2].progress = { percent: .1 };
  assert.equal(Array.from(spoilerHiddenIds(books)).join(','), '4');
  books[3].progress = { finished: true };
  assert.equal(spoilerHiddenIds(books).size, 0);
  assert.equal(spoilerHiddenIds([]).size, 0);
});
test('e-ink temporarily overrides dark mode and motion while preserving the original theme settings', async () => {
  const classes = new Set(), cache = new Map();
  const root = { dataset: {}, style: { setProperty() {} }, classList: { contains: key => classes.has(key), toggle: (key, on) => on ? classes.add(key) : classes.delete(key) } };
  const context = vm.createContext({ document: { documentElement: root }, localStorage: { getItem: key => cache.get(key), setItem: (key, value) => cache.set(key, value) }, matchMedia: () => ({ matches: false }) });
  const theme = await load('public/js/theme.js', context);
  theme.applyTheme({ mode: 'dark', noMotion: false });
  theme.applyTheme({ eink: true });
  assert.equal(root.dataset.theme, 'light');
  assert.equal(theme.themeState().mode, 'dark');
  assert.equal(theme.isDark(), false);
  assert.equal(theme.motionEnabled(), false);
  assert.equal(classes.has('eink'), true);
  theme.applyTheme({ eink: false });
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(theme.isDark(), true);
  assert.equal(classes.has('no-motion'), false);
  theme.applyTheme({ noMotion: true, eink: true });
  theme.applyTheme({ eink: false });
  assert.equal(classes.has('no-motion'), true);
});
test('journal Markdown preserves private reflections and highlighted passages', () => {
  const source = fs.readFileSync('public/js/components/reflection.js', 'utf8');
  const markdown = vm.runInNewContext(source.slice(source.indexOf('export function journalMarkdown')).replace('export ', '') + '\njournalMarkdown');
  const result = markdown({ month: '2026-11', reading: [{ day: '2026-11-04', seconds: 600, pages: 12, book: { title: 'My book' } }], entries: [{ day: '2026-11-04', body: 'A thought to keep.', mood: 'moved', book: { title: 'My book' } }], highlights: [{ text: 'A passage\nwith two lines', book: { title: 'My book' }, note: 'My note' }] });
  assert.match(result, /10 min, 12 pages/);
  assert.match(result, /A thought to keep\./);
  assert.match(result, /> A passage\n> with two lines/);
  assert.match(result, /My note/);
});


test('e-ink engine overlays leave saved profile and per-series settings intact', async () => {
  const { displaySettings } = await load('public/js/reading-display.js');
  const saved = { look: 'book', pageTurn: 'book', textTheme: 'dark', fontSize: 110 };
  let eink = true;
  const display = displaySettings(saved, () => eink);
  assert.equal(display.look, 'eink');
  assert.equal(display.pageTurn, 'none');
  assert.equal(display.textTheme, 'light');
  assert.equal(saved.look, 'book');
  assert.equal(saved.pageTurn, 'book');
  display.fontSize = 120;
  assert.equal(saved.fontSize, 120);
  eink = false;
  assert.equal(display.look, 'book');
  assert.equal(display.textTheme, 'dark');
});
