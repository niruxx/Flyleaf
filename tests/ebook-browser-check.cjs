// Run after starting ebook-browser-server.cjs and an isolated browser with
// --headless=new --remote-debugging-port=9227 --user-data-dir=<temporary profile>.
const assert = require('node:assert/strict');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const endpoint = process.env.EBOOK_TEST_CDP || 'http://127.0.0.1:9227';

async function check(route) {
  const target = await (await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error.message));
      else request?.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const sequence = ++id;
    pending.set(sequence, { resolve, reject });
    socket.send(JSON.stringify({ id: sequence, method, params }));
  });
  try {
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await send('Page.navigate', { url: `http://127.0.0.1:8198${route}` });
    for (let i = 0; i < 160; i++) {
      await wait(100);
      const response = await send('Runtime.evaluate', { expression: 'window.results', returnByValue: true });
      if (response.result?.value) return { route, result: response.result.value, errors };
      if (errors.length) break;
    }
    throw new Error(`Browser fixture did not finish: ${route}: ${errors.join('\n')}`);
  } finally {
    await send('Page.close');
    socket.close();
  }
}

(async () => {
  const results = [];
  for (const route of ['/race?raw', '/race', '/reader', '/reader-slide']) results.push(await check(route));
  const [raw, patched, book, slide] = results.map(response => response.result);
  assert.equal(raw.result, 'hung', 'the original renderer must reproduce the abandoned-load race');
  assert.equal(raw.loads, 2);
  assert.equal(patched.result, 'settled');
  assert.equal(patched.loads, 1);
  assert.match(patched.text, /Chapter 2/);
  assert.equal(patched.failure, 'rejected');
  assert.equal(patched.retry, 'settled');
  for (const reader of [book, slide]) {
    assert.equal(reader.chapters.length, 5);
    assert.equal(reader.centerWorks, true);
    assert.equal(reader.visible, true);
    assert.equal(reader.menuVisible, true);
  }
  assert.ok(results.every(response => !response.errors.length), JSON.stringify(results));
  console.log(JSON.stringify(results, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
