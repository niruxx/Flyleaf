// Run after starting ebook-browser-server.cjs and an isolated browser with
// --headless=new --remote-debugging-port=9227 --user-data-dir=<temporary profile>.
const assert = require('node:assert/strict');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const endpoint = process.env.EBOOK_TEST_CDP || 'http://127.0.0.1:9227';

async function check(route, width = 390) {
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
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 700 });
    await send('Emulation.setTouchEmulationEnabled', { enabled: width < 700 });
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
  if (process.argv.includes('--selection')) {
    const response = await check('/reader-selection', 1000);
    const { result } = response;
    assert.deepEqual(response.errors, []);
    assert.equal(result.intercepted, true);
    assert.equal(result.keyboard, true);
    assert.equal(result.copied, 'This is para');
    assert.equal(result.highlight, result.copied);
    assert.match(result.locator, /^epubcfi\(/);
    for (const action of ['Copy', 'Highlight', 'Underline', 'Add note', 'Look up', 'Translate', 'Wikipedia', 'Reader settings']) assert.ok(result.options.includes(action));
    assert.equal(result.note, 'A reader note');
    assert.equal(result.bookmark, 'bookmark');
    assert.equal(result.definition, 'The thing here.');
    assert.equal(result.settingsOpened, true);
    assert.deepEqual(result.translation, { text: 'Texto traducido', provider: 'DeepL' });
    assert.equal(result.translatedSelection, result.copied);
    assert.deepEqual(result.wikiQueries, [result.copied, 'Flyleaf']);
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  if (process.argv.includes('--parallel')) {
    const results = [];
    for (const [route, width] of [['/reader-parallel', 390], ['/reader-parallel-pages', 390], ['/reader-parallel-pdf', 1000]]) {
      const result = await check(route, width);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.result, { primaryUnchanged: true, secondaryUnchanged: true, stacked: width < 700, restored: true }, route);
      results.push(result);
    }
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (process.argv.includes('--speech')) {
    const response = await check('/speech');
    assert.ok(!response.errors.length, JSON.stringify(response));
    assert.equal(response.result.chapter, 2);
    console.log(JSON.stringify(response, null, 2));
    return;
  }
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
