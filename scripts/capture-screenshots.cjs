// Start screenshot-server.cjs, then a headless Chromium browser with
// --remote-debugging-port=9231 and a temporary --user-data-dir.
// Run: node scripts/capture-screenshots.cjs
const fs = require('node:fs');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const endpoint = process.env.SCREENSHOT_CDP || 'http://127.0.0.1:9231';
async function main() {
  const target = await (await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.id) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  try {
    await send('Page.enable'); await send('Runtime.enable');
    for (const [name, route, width, height, theme] of [
      ['desktop-home', '/', 1440, 1000, 'light'],
      ['desktop-library', '/library', 1440, 1000, 'light'],
      ['desktop-series-dark', '/series/1', 1440, 1000, 'dark'],
      ['desktop-preferences', '/settings/preferences', 1440, 1000, 'light'],
      ['mobile-home', '/', 390, 844, 'light'],
      ['mobile-series', '/series/1', 390, 844, 'light'],
      ['mobile-drawer', '/', 390, 844, 'light'],
    ]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      await send('Emulation.setTouchEmulationEnabled', { enabled: width < 600 });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      await send('Page.navigate', { url: `http://127.0.0.1:8197/#${route}` });
      await pause(1600);
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.classList.add('no-motion');document.fonts.ready`);
      if (name === 'mobile-drawer') { await evaluate("document.querySelector('.menu-toggle').click()"); await pause(350); }
      const summary = await evaluate(`({title:document.querySelector('h1')?.textContent,overflow:document.documentElement.scrollWidth>innerWidth,text:document.querySelector('#view')?.textContent.slice(0,100)})`);
      if (summary.overflow || !summary.text) throw new Error(`${name}: invalid layout ${JSON.stringify(summary)}`);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.resolve(__dirname, '../docs/screenshots', `${name}.png`), Buffer.from(shot.data, 'base64'));
      console.log(name, JSON.stringify(summary));
    }
    if (errors.length) throw new Error(errors.join('\n'));
  } finally { await send('Page.close'); ws.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
