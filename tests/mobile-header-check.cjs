// Start a headless browser with --remote-debugging-port=9227 before running.
// Uses the real styles and index.html without a database or signed-in account.
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
    for (const width of [320, 360, 384, 412, 599, 600, 768, 1024, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: true });
      const result = await evaluate(`(() => {
        const rect = s => document.querySelector(s).getBoundingClientRect();
        const search = rect('.app-search'), start = rect('.start'), end = rect('.end'), bar = rect('.app-bar'), input = rect('.search-bar input');
        const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        return { overlap: overlap(search, start) || overlap(search, end), fits: search.left >= 0 && search.right <= innerWidth && search.bottom <= bar.bottom, input: input.width };
      })()`);
      assert.equal(result.overlap, false, `overlap at ${width}px`);
      assert.equal(result.fits, true, `search outside header at ${width}px`);
      assert.ok(result.input >= 60, `input too narrow at ${width}px: ${result.input}`);
    }
    console.log('Header fits without overlap at 320–1440px, including 360px and 384px mobile viewports.');
    await send('Page.close');
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    socket?.close(); server.close();
  }
});
