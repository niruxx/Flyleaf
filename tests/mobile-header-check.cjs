// Start a headless browser with --remote-debugging-port=9227 before running.
// Uses the real styles and index.html without a database or signed-in account.
// Start scripts/screenshot-server.cjs and set MOBILE_TEST_WEB=http://127.0.0.1:8197
// to also check signed-in routes with fictional API data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const app = express();
const root = path.resolve(__dirname, '..');
app.get('/', (req, res) => res.type('html').send(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').replace('<script type="module" src="/js/main.js"></script>', '')));
app.use('/vendor/roboto-flex', express.static(path.join(root, 'node_modules/@fontsource-variable/roboto-flex')));
app.use('/vendor/symbols', express.static(path.join(root, 'node_modules/material-symbols')));
app.use(express.static(path.join(root, 'public')));
const server = app.listen(0, '127.0.0.1', async () => {
  let socket;
  try {
    const endpoint = process.env.EBOOK_TEST_CDP || 'http://127.0.0.1:9227';
    const target = await (await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        message.error ? request.reject(message.error) : request.resolve(message.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    for (let i = 0; i < 50; i++) {
      if (await evaluate('document.readyState === "complete"')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await evaluate(`(async () => {
      document.body.classList.remove('bare');
      document.querySelector('.app-search').innerHTML = '<div class="search-bar"><span class="icon">search</span><input type="search" placeholder="Search your library"><kbd>/</kbd><button class="icon-btn"><span class="icon">close</span></button></div>';
      document.querySelector('.end').innerHTML = '<button class="icon-btn">help</button><button class="icon-btn bell"><span class="icon">notifications</span></button><button class="avatar">A</button>';
      await document.fonts.ready;
    })()`);
    const resize = async (width, height = 850) => {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 1024 });
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    };
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const width of [320, 360, 384, 412, 599, 600, 768, 1024, 1440]) {
      await resize(width);
      const result = await evaluate(`(async () => {
        await new Promise(resolve => requestAnimationFrame(resolve));
        await document.fonts.ready;
        const rect = s => document.querySelector(s).getBoundingClientRect();
        const search = rect('.app-search'), start = rect('.start'), end = rect('.end'), bar = rect('.app-bar'), input = rect('.search-bar input');
        const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        return { overlap: overlap(search, start) || overlap(search, end), fits: search.left >= -1 && search.right <= innerWidth + 1 && search.bottom <= bar.bottom + 1, input: input.width, search: search.toJSON(), bar: bar.toJSON(), innerWidth };
      })()`);
      assert.equal(result.overlap, false, `overlap at ${width}px`);
      assert.equal(result.fits, true, `search outside header at ${width}px: ${JSON.stringify(result)}`);
      assert.ok(result.input >= 60, `input too narrow at ${width}px: ${JSON.stringify(result)}`);
    }
    console.log('Header fits without overlap at 320–1440px.');
    await checkReader(resize, evaluate);
    if (process.env.MOBILE_TEST_WEB) await checkRoutes(send, resize, evaluate);
    await send('Page.close');
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    socket?.close(); server.close();
  }
});

async function checkReader(resize, evaluate) {
  await evaluate(`(async () => {
    const { AudioEngine } = await import('/js/reader/audio.js');
    const { readerSettingsForm } = await import('/js/components/reader-settings.js');
    const { h, sheet } = await import('/js/ui.js');
    document.body.classList.add('bare');
    const stage = h('div.stage');
    document.querySelector('#view').replaceChildren(h('div.reader.audio', stage));
    const audio = new AudioEngine({ title: 'The Midnight Garden' }, { stage }, {});
    audio.buildUi();
    sheet(() => readerSettingsForm({ layout: 'single', scaling: 'screen', pageSplit: 'none' }, () => {}, { show: 'pages' }));
  })()`);
  for (const [width, height] of [[320, 568], [360, 740], [430, 900], [667, 375], [768, 900]]) {
    await resize(width, height);
    const fits = await evaluate(`(() => {
      const inside = (el, box) => el.left >= box.left - 1 && el.right <= box.right + 1;
      const stage = document.querySelector('.audio-stage').getBoundingClientRect();
      const audio = [...document.querySelectorAll('.audio-controls button')].every(button => inside(button.getBoundingClientRect(), stage));
      const settings = [...document.querySelectorAll('dialog.sheet .segmented')].every(group => {
        const box = group.getBoundingClientRect();
        return [...group.children].every(button => {
          const rect = button.getBoundingClientRect();
          const text = document.createRange();
          text.selectNode(button.lastChild);
          return inside(rect, box) && [...text.getClientRects()].every(line => inside(line, rect));
        });
      });
      return { audio, settings };
    })()`);
    assert.ok(fits.audio, `Audio controls overflow at ${width}×${height}`);
    assert.ok(fits.settings, `Reader settings labels clip at ${width}×${height}`);
  }
  console.log('Reader settings and audiobook controls fit phone portrait, landscape and tablet viewports.');
}

async function checkRoutes(send, resize, evaluate) {
  const base = process.env.MOBILE_TEST_WEB;
  const routes = [
    ['/', '.home-hero'],
    ['/library', '.library-controls'],
    ['/series/1', '.series-hero'],
    ['/settings/preferences', '.lang-select'],
    ['/settings/appearance', '.setting-row .segmented'],
    ['/finder', '.finder-actions'],
  ];
  for (const [route, selector] of routes) {
    await send('Page.navigate', { url: `${base}/#${route}` });
    const loaded = await evaluate(`(async () => {
      const selector = ${JSON.stringify(selector)};
      for (let i = 0; i < 60; i++) {
        if (document.querySelector(selector)) {
          await document.fonts.ready;
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    })()`);
    assert.ok(loaded, `Missing ${selector} on ${route}`);
    for (const width of [320, 390, 599, 600, 768, 1024]) {
      await resize(width);
      const layout = await evaluate(`(() => {
        const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
        const label = rect('.setting-row:has(.lang-select) .text');
        const control = rect('.lang-select');
        const art = rect('.series-hero .cover-col'), info = rect('.series-hero .info');
        const heading = rect('.finder .page-head h1'), actions = rect('.finder-actions');
        const browse = rect('.home-hero .hero-actions a[href="#/library"]');
        return {
          fits: document.documentElement.scrollWidth <= ${width} + 1,
          preference: !label || (label.width >= 120 && (innerWidth >= 600 || control.top >= label.bottom)),
          series: !art || (matchMedia('(max-width: 599px)').matches ? art.width <= 173 : art.right <= info.left + 1),
          finder: !heading || innerWidth >= 600 || actions.top >= heading.bottom,
          browse: !document.querySelector('.home-hero') || Boolean(browse?.height),
          metrics: { width: innerWidth, art: art?.toJSON(), info: info?.toJSON() },
        };
      })()`);
      const { metrics, ...checks } = layout;
      for (const [group, fits] of Object.entries(checks)) assert.ok(fits, `${group} at ${width}px on ${route}: ${JSON.stringify(metrics)}`);
    }
  }
  await resize(320);
  assert.ok(await evaluate(`(async () => {
    const { setLanguage } = await import('/js/i18n.js');
    const { initShell } = await import('/js/shell.js');
    await setLanguage('es');
    initShell({ again: true });
    if (document.querySelector('[data-nav="bookmarks"] .nav-label').textContent !== 'Marcadores') return false;
    const labels = [...document.querySelectorAll('.bottom-nav .nav-label')];
    labels[1].textContent = 'Bibliotheksübersicht';
    labels[2].textContent = 'Möchte ich noch lesen';
    return labels.every(label => {
      const box = label.parentElement.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(label);
      return box.height >= 44 && [...range.getClientRects()].every(line => line.left >= box.left - 1 && line.right <= box.right + 1);
    });
  })()`), 'Localized bottom navigation overlaps at 320px');
  console.log('Signed-in layouts and translated navigation fit at 320–1024px.');
}
