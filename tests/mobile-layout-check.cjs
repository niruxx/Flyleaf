// Run with Playwright and the browser engines installed. PLAYWRIGHT_MODULE can
// point at an external Playwright or Playwright Core installation.
// node tests/mobile-layout-check.cjs [webkit firefox chromium]
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const browsers = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const longName = 'ExtraLongUnbrokenTitleForMobileLayout'.repeat(5);
const servers = [];

async function fixture(script, portVariable) {
  const child = spawn(process.execPath, [script], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, [portVariable]: '0' },
  });
  servers.push(child);
  const [line] = await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error(`${script} exited with ${code}`); }),
  ]);
  return String(line).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
}

async function fit(page, selector, { scroll = true, insets = [0, 0] } = {}) {
  const size = await page.locator(selector).first().evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, width: document.documentElement.clientWidth,
      scroll: element.scrollWidth, client: element.clientWidth };
  });
  const context = `${page.url()} ${selector} at ${size.width}px: ${JSON.stringify(size)}`;
  assert.ok(size.left >= insets[0] - 1 && size.right <= size.width - insets[1] + 1, context);
  if (scroll && size.client) assert.ok(size.scroll <= size.client + 1, context);
}

async function seedContent(page) {
  await page.route(/\/api\/(?:series\/1|collections|finder\/(?:sources|follows)|books\/1\/info)(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    let payload;
    if (url.pathname === '/api/series/1') {
      payload = await (await fetch(url)).json();
      payload.name = longName;
      payload.people[0].name = longName;
      payload.books[0].label = longName;
    }
    if (url.pathname === '/api/collections') {
      payload = await (await fetch(url)).json();
      payload[0].name = longName;
    }
    if (url.pathname === '/api/finder/sources') payload = [{ id: 'source', name: longName }];
    if (url.pathname === '/api/finder/follows') {
      payload = { follows: [{ id: 1, plugin: 'source', title: longName, library: longName, known: 3 }] };
    }
    if (url.pathname === '/api/books/1/info') {
      payload = { id: 1, title: longName, label: longName, format: 'cbz', engine: 'pages', pageCount: 12,
        reading: { percent: 0.5, bookmarks: 0, highlights: 0 }, meta: { publisher: longName },
        file: { name: longName, relPath: `${longName}/book.cbz` }, library: { id: 1, name: longName } };
    }
    if (payload === undefined) await route.continue();
    else await route.fulfill({ json: payload });
  });
}

async function checkCatalog(page, base) {
  await seedContent(page);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.home-hero').waitFor();
  const open = (route) => page.evaluate(async (path) => {
    const { navigate } = await import('/js/router.js');
    navigate(path);
  }, route);
  for (const viewport of [{ width: 320, height: 650 }, { width: 360, height: 760 },
    { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    for (const [route, content] of [
      ['/', '.home-hero .hero-actions'], ['/library', '.library-controls'],
      ['/series/1', '.series-hero .creators'], ['/finder', '.finder-results .empty h2'],
      ['/finder/following', '.follow-card .title-medium'], ['/collections', '.collection-card .n'],
      ['/settings/reading', '.settings-panel .segmented'],
    ]) {
      await open(route);
      try {
        await page.locator(content).first().waitFor();
      } catch (error) {
        const rendered = (await page.locator('#view').innerText()).slice(0, 300);
        throw new Error(`${route} at ${viewport.width}px did not render ${content}: ${rendered}`, { cause: error });
      }
      const safeArea = viewport.width === 844
        ? await page.addStyleTag({ content: ':root { --safe-left: 44px; --safe-right: 44px; }' })
        : null;
      if (safeArea) {
        await fit(page, '.app-search', { insets: [44, 44] });
      }
      await fit(page, 'html');
      await fit(page, content);
      if (route === '/') {
        await fit(page, '.app-search input', { scroll: false });
        const search = await page.locator('.app-search input').evaluate((input) => ({
          width: input.getBoundingClientRect().width, fontSize: parseFloat(getComputedStyle(input).fontSize),
        }));
        assert.ok(search.width >= 60 && search.fontSize >= 16, JSON.stringify(search));
      }
      for (const label of await page.locator('.segmented .segment-label').all()) {
        assert.ok(await label.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), await label.textContent());
      }
      await safeArea?.evaluate((style) => style.remove());
    }
  }
  await page.setViewportSize({ width: 320, height: 650 });
  await open('/series/1');
  await page.locator('.series-hero').waitFor();
  await page.evaluate(async () => {
    const { showBookInfo } = await import('/js/components/book-info.js');
    void showBookInfo(1);
  });
  await page.locator('.info-card.wide').waitFor();
  await fit(page, '.info-dialog .dialog-body');
  await page.locator('.info-dialog .dialog-body').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.getByRole('dialog', { name: 'Details' }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.info-dialog').waitFor({ state: 'detached' });
}

async function checkReader(page, base) {
  await page.setViewportSize({ width: 320, height: 650 });
  await page.route('**/api/books/1/reader', async (route) => {
    const payload = await (await fetch(route.request().url())).json();
    payload.settings.autoCloseMenu = false;
    await route.fulfill({ json: payload });
  });
  await page.goto(`${base}/reader-layout`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.results?.ready);
  await page.locator('.reader:not(.chrome-hidden)').waitFor();
  await fit(page, '.chrome-top');
  await fit(page, '.chrome-tools');
  await fit(page, '.chrome-bottom .row:has(input)');
  await page.getByRole('button', { name: 'Reader settings (S)' }).click();
  await page.locator('.reader-sheet-head').waitFor();
  await fit(page, 'dialog.sheet');
  await page.getByRole('dialog', { name: 'Reader settings' }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('dialog.sheet').waitFor({ state: 'detached' });
  await page.evaluate(() => {
    const doc = document.querySelector('foliate-view').renderer.getContents()[0].doc;
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector('h1'));
    doc.getSelection().removeAllRanges();
    doc.getSelection().addRange(range);
    doc.dispatchEvent(new Event('selectionchange'));
  });
  await page.locator('.sel-toolbar').waitFor();
  await fit(page, '.sel-toolbar');
}

async function checkKeyboard(page, base) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: innerHeight, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { value: viewport });
    window.resizeTestViewport = (height, offsetTop = 0, scale = 1) => {
      Object.assign(viewport, { height, offsetTop, scale });
      viewport.dispatchEvent(new Event('resize'));
    };
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.home-hero').waitFor();
  await page.addStyleTag({ content: ':root { --safe-top: 44px; }' });
  for (const type of ['dialog', 'sheet']) {
    const top = type === 'dialog' ? 0 : 56;
    await page.evaluate(async ({ type, top }) => {
      const ui = await import('/js/ui.js');
      const field = ui.field('Type here', { multiline: true });
      const content = ui.h('div', field, ui.h('div', { style: { height: '500px' } }));
      if (type === 'sheet') ui.sheet(() => content);
      else void ui.dialog({ title: 'Edit', content, actions: [{ label: 'Save', value: true }] });
      field.input.focus();
      window.resizeTestViewport(440, top);
    }, { type, top });
    await page.locator('html.keyboard-open').waitFor({ state: 'attached' });
    await page.locator('.bottom-nav').waitFor({ state: 'hidden', timeout: 3000 });
    const popup = page.locator(`dialog.${type}[open]`);
    await popup.evaluate((node) => Promise.allSettled(node.getAnimations().map((animation) => animation.finished)));
    const box = await popup.boundingBox();
    assert.ok(box.y >= Math.max(top, 44) - 1 && box.y + box.height <= top + 441, JSON.stringify(box));
    if (type === 'dialog') {
      const action = await popup.getByRole('button', { name: 'Save' }).boundingBox();
      assert.ok(action.y + action.height <= top + 441, JSON.stringify(action));
    }
    await page.evaluate(() => window.resizeTestViewport(innerHeight - 64));
    await page.locator('html.keyboard-open').waitFor({ state: 'detached' });
    await popup.evaluate((node) => node.close());
  }
  await page.locator('.app-search input').focus();
  await page.evaluate(() => window.resizeTestViewport(300, 50, 2));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('html.keyboard-open').count(), 0);
}

(async () => {
  const [web, reader] = await Promise.all([
    fixture('scripts/screenshot-server.cjs', 'FLYLEAF_PREVIEW_PORT'),
    fixture('tests/ebook-browser-server.cjs', 'FLYLEAF_EBOOK_FIXTURE_PORT'),
  ]);
  for (const engine of process.argv.slice(2).length ? process.argv.slice(2) : ['webkit', 'firefox', 'chromium']) {
    const browser = await browsers[engine].launch(engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
    try {
      const options = { isMobile: engine !== 'firefox', hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' };
      const catalogPage = await browser.newPage(options);
      catalogPage.setDefaultTimeout(8000);
      await checkCatalog(catalogPage, web);
      await checkKeyboard(await browser.newPage(options), web);
      const readerPage = await browser.newPage(options);
      readerPage.setDefaultTimeout(8000);
      await checkReader(readerPage, reader);
      console.log(`${engine} passed compact layout, reader, and simulated keyboard checks`);
    } finally {
      await browser.close();
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => servers.forEach((server) => server.kill()));
