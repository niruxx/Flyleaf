// Browser smoke test against screenshot-server.cjs. Launch a disposable headless
// Chromium profile with --remote-debugging-port=9233 before running this script.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const endpoint = process.env.SCREENSHOT_CDP || 'http://127.0.0.1:9233';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const target = await (await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map(), errors = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const items = [
    { id: 'download-1', downloadId: 1, kind: 'download', title: 'The Orchard · Chapter 2', status: 'running', done: 500, total: 1000, cancel: true, createdAt: Date.now() },
    { id: 'task-2', taskId: 2, kind: 'scan', title: 'Books', status: 'failed', error: 'Library folder not found. Check the configured path.', retry: true, createdAt: Date.now() - 5000 },
    { id: 'task-3', taskId: 3, kind: 'backup', title: 'Scheduled backup', status: 'done', createdAt: Date.now() - 10000 },
  ];
  ws.onmessage = async event => {
    const m = JSON.parse(event.data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params.exceptionDetails));
    if (m.method === 'Fetch.requestPaused') {
      const { requestId, request } = m.params;
      if (request.method === 'DELETE') { items[0].status = 'cancelled'; items[0].cancel = false; }
      if (request.method === 'POST') { items[1].status = 'running'; items[1].retry = false; items[1].error = null; }
      await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ items })).toString('base64') });
    }
  };
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const shot = async name => {
    const image = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync('data/ui-checks', { recursive: true });
    fs.writeFileSync(`data/ui-checks/${name}.png`, Buffer.from(image.data, 'base64'));
  };
  try {
    await send('Runtime.enable'); await send('Page.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/tasks*' }, { urlPattern: '*/api/finder/downloads/*' }] });
    for (const width of [1440, 390]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width === 390 });
      await send('Page.navigate', { url: 'http://127.0.0.1:8197/#/' }); await pause(1000);
      assert.equal(await evaluate("document.querySelector('.home-page') !== null"), true);
      await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Customize home')).click()"); await pause(150);
      assert.equal(await evaluate("document.querySelectorAll('.home-section-choice').length"), 12);
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
      await shot(`customize-home-${width}`);
      await evaluate(`(() => { const d=document.querySelector('dialog');[...d.querySelectorAll('button')].find(b=>b.textContent==='Reset to defaults').click(); const select=d.querySelector('select');select.value='az';select.dispatchEvent(new Event('change'));const checks=d.querySelectorAll('input');checks[0].click();checks[2].click();d.querySelector('[data-section="libraries"] button').click();[...d.querySelectorAll('button')].find(b=>b.textContent==='Save').click(); })()`);
      await pause(600);
      assert.equal(await evaluate("document.querySelector('.home-hero').hidden && document.querySelector('.home-page').classList.contains('home-compact')"), true);
      assert.equal(await evaluate("(async () => (await import('/js/router.js')).session.user.prefs.home.sort)()"), 'az');
      await evaluate("(async () => (await import('/js/router.js')).navigate('/activity'))()"); await pause(700);
      assert.equal(await evaluate("document.querySelectorAll('.task-card').length"), 3);
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
      await shot(`activity-${width}`);
      await evaluate("(()=>{const select=document.querySelector('.activity-filters select');select.value='failed';select.dispatchEvent(new Event('change'));})()");
      assert.equal(await evaluate("document.querySelectorAll('.task-card').length"), 1);
      if (width === 390) {
        await evaluate("document.querySelector('.task-actions button').click()"); await pause(300);
        assert.equal(await evaluate("document.querySelectorAll('.task-card').length"), 0);
        await evaluate("(()=>{const select=document.querySelector('.activity-filters select');select.value='all';select.dispatchEvent(new Event('change'));[...document.querySelectorAll('.task-actions button')].find(b=>b.textContent.includes('Cancel')).click();})()"); await pause(300);
        assert.equal(await evaluate("document.querySelector('[data-status=cancelled]') !== null"), true);
      }
      console.log(`${width}px: home preferences, activity filters, layout passed`);
    }
    assert.deepEqual(errors, []);
  } finally { await send('Page.close'); ws.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
