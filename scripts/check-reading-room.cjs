// Use screenshot-server.cjs and a disposable Chromium profile listening on port 9233.
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
  const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const series = await (await fetch('http://127.0.0.1:8197/api/series/1')).json();
  const book = { ...series.books[0], id: 1, engine: 'pages', title: 'The Midnight Garden', label: 'Volume 1', volume: 1, pageCount: 240, progress: { percent: .4, page: 95 }, language: 'en' };
  series.books = [book, { ...book, id: 21, title: 'FUTURE TITLE SHOULD STAY HIDDEN', label: 'Volume 2', volume: 2, progress: null }, { ...book, id: 22, title: 'ANOTHER FUTURE TITLE', label: 'Volume 3', volume: 3, progress: null }];
  series.count = 3; series.nextBookId = 1;
  const journal = { month: '2026-11', reading: [{ day: '2026-11-17', book, seconds: 1200, pages: 20 }], entries: [{ id: 1, day: '2026-11-17', body: 'A quiet story about finding your way home.', mood: 'moved', book }], highlights: [{ id: 1, createdAt: Date.parse('2026-11-17T18:00:00Z'), book, locator: '12', text: 'Every map begins with somewhere you have been.', note: 'A line worth keeping.' }] };
  ws.onmessage = async event => {
    const m = JSON.parse(event.data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params.exceptionDetails));
    if (m.method === 'Fetch.requestPaused') {
      const { requestId, request } = m.params, url = new URL(request.url);
      let data;
      if (url.pathname === '/api/series/1') data = series;
      else if (url.pathname === '/api/reading/tonight') data = { minutes: Number(url.searchParams.get('minutes')), unknown: 2, total: 2, items: [{ book, seconds: 720, basis: 'personal' }, { book: { ...book, id: 2, title: 'A Map of Small Things', coverUrl: '/preview/cover/1.svg' }, seconds: 1200, basis: 'typical' }] };
      else if (url.pathname.includes('/positions')) data = { updatedAt: 200, devices: [{ client: 'KOReader', at: Date.parse('2026-11-17T18:00:00Z') }], items: [{ id: 1, percent: .4, page: 95, at: Date.parse('2026-11-17T18:00:00Z'), compatible: true, current: true }, { id: 2, percent: .1, page: 23, at: Date.parse('2026-11-16T18:00:00Z'), compatible: true }, { id: 3, percent: .05, page: 11, at: 1, compatible: false }] };
      else if (request.method === 'POST') { const body = JSON.parse(request.postData); journal.entries.push({ ...body, id: 2, book: null }); data = { id: 2 }; }
      else if (request.method === 'DELETE') { journal.entries = journal.entries.filter(e => e.id !== Number(url.pathname.split('/').pop())); data = { ok: true }; }
      else data = journal;
      await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(data)).toString('base64') });
    }
  };
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const go = async route => { await evaluate(`(async()=> (await import('/js/router.js')).navigate(${JSON.stringify(route)}))()`); await pause(500); };
  const shot = async name => {
    const result = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync('data/ui-checks', { recursive: true }); fs.writeFileSync(`data/ui-checks/${name}.png`, Buffer.from(result.data, 'base64'));
  };
  const noOverflow = async () => assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
  try {
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setTimezoneOverride', { timezoneId: 'America/Chicago' });
    await send('Fetch.enable', { patterns: ['*/api/reading/tonight*', '*/api/journal*', '*/api/books/*/positions*', '*/api/series/1'].map(urlPattern => ({ urlPattern })) });
    await send('Page.navigate', { url: 'http://127.0.0.1:8197/#/' }); await pause(1000);
    for (const width of [1440, 390]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width === 390 });
      await go('/tonight');
      assert.equal(await evaluate("document.querySelectorAll('.tonight-card').length"), 2); await noOverflow(); await shot(`tonight-${width}`);
      await go('/journal?month=2026-11');
      assert.equal(await evaluate("document.querySelectorAll('.reflection-card').length"), 1); await noOverflow(); await shot(`journal-${width}`);
      await evaluate("(async()=>{const p=await import('/js/prefs.js');p.setPref('spoilerSafe',true)})()");
      await go('/series/1');
      assert.equal(await evaluate("document.querySelectorAll('.spoiler-guard').length"), 2);
      assert.equal(await evaluate("document.querySelector('#view').textContent.includes('FUTURE TITLE SHOULD STAY HIDDEN')"), false);
      assert.equal(await evaluate("document.querySelector('.spoiler-guard img') !== null"), false); await noOverflow();
      await evaluate("document.querySelector('.spoiler-guard').scrollIntoView({block:'center'})"); await pause(800); await shot(`spoiler-safe-${width}`);
      await evaluate("document.querySelector('.spoiler-guard button').click()");
      assert.equal(await evaluate("document.querySelector('[title=\"FUTURE TITLE SHOULD STAY HIDDEN\"]') !== null"), true);
      await evaluate("(async()=>{const p=await import('/js/prefs.js');p.setPref('einkMode',true)})()");
      await go('/journal?month=2026-11');
      assert.equal(await evaluate("document.documentElement.classList.contains('eink') && document.documentElement.classList.contains('no-motion')"), true);
      assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), 'rgb(255, 255, 255)'); await noOverflow(); await shot(`journal-eink-${width}`);
      await evaluate("(async()=>{const p=await import('/js/prefs.js');p.setPref('einkMode',false)})()");
      assert.equal(await evaluate("document.documentElement.classList.contains('eink')"), false);
      if (width === 390) {
        await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Add a reflection')).click()"); await pause(100);
        await evaluate("(()=>{const f=document.querySelector('dialog form');f.querySelector('input[type=date]').value='2026-11-17';f.querySelector('textarea').value='Private words <script>window.journalInjected=true</script>';f.requestSubmit();})()"); await pause(300);
        assert.equal(await evaluate("document.querySelectorAll('.reflection-card').length"), 2);
        assert.equal(await evaluate('window.journalInjected === true'), false);
        await evaluate("[...document.querySelectorAll('.reflection-card')].find(c=>c.textContent.includes('Private words')).querySelectorAll('button')[1].click()"); await pause(100);
        await evaluate("[...document.querySelector('dialog').querySelectorAll('button')].find(b=>b.textContent==='Confirm').click()"); await pause(300);
        assert.equal(await evaluate("document.querySelectorAll('.reflection-card').length"), 1);
        await evaluate("(async()=>{const h=await import('/js/components/position-history.js');h.positionHistory({id:1,engine:'pages'})})()"); await pause(250);
        assert.equal(await evaluate("document.querySelectorAll('.position-history-row').length"), 3);
        assert.equal(await evaluate("document.querySelectorAll('.position-history-row button:disabled').length"), 1); await noOverflow(); await shot('reading-positions-390');
        await evaluate("document.querySelector('dialog').close()");
      }
      console.log(`${width}px: session picker, journal, spoiler protection, e-ink passed`);
    }
    assert.deepEqual(errors, []);
  } finally { await send('Page.close'); ws.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
