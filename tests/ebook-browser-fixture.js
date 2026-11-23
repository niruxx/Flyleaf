const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = (promise, ms = 2500) => Promise.race([promise.then(() => 'settled', () => 'rejected'), wait(ms).then(() => 'hung')]);
const section = i => URL.createObjectURL(new Blob([`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${i}</title></head><body><h1>Chapter ${i}</h1><p>Readable fixture text.</p></body></html>`], { type: 'application/xhtml+xml' }));
export async function run(mode) {
  if (!mode.startsWith('reader')) {
    await import(mode === 'raw' ? '/vendor/raw/paginator.js' : '/vendor/foliate/paginator.js');
    const p = document.createElement('foliate-paginator');p.id='race';document.body.append(p);
    const urls=[0,1,2].map(section);
    const sections=urls.map(url=>({load:()=>url,unload(){}}));
    p.open({dir:'ltr',sections});await p.goTo({index:0,anchor:()=>1});await wait(50);
    let release, loads=0;
    const gate=new Promise(resolve=>{release=resolve});
    sections[1].load=()=>{loads++;return gate.then(()=>urls[1])};
    const turning=p.next();
    setTimeout(()=>p.snap(0,0),20);setTimeout(()=>release(),100);
    const result=await timeout(turning,1200);
    const after=await timeout(p.goTo({index:2,anchor:()=>0}),1200);
    const text=p.getContents()[0]?.doc?.body?.textContent;
    let failure, retry;
    if (mode !== 'raw') {
      await p.goTo({index:0,anchor:()=>1});
      sections[1].load=async()=>{throw new Error('Injected chapter load failure')};
      failure=await timeout(p.next());
      sections[1].load=()=>urls[1];
      retry=await timeout(p.next());
    }
    return {mode,result,loads,after,text,failure,retry};
  }
  const {readerView}=await import('/js/reader/reader.js');
  const id = { 'reader-slide': '2', 'reader-parallel-pages': '3', 'reader-parallel-pdf': '4' }[mode] || '1';
  await readerView(document.querySelector('#view'),{id,query:new URLSearchParams()},()=>false);
  if (mode.startsWith('reader-parallel')) return checkParallel(mode);
  if (mode === 'reader-selection') return checkSelectionMenu();
  if (mode === 'reader-layout') return { ready: Boolean(document.querySelector('foliate-view')) };
  const view=document.querySelector('foliate-view'), root=document.querySelector('.reader');
  let calls=0;const originalNext=view.next.bind(view);view.next=(...args)=>{calls++;return originalNext(...args)};
  const chapters=new Set();view.addEventListener('relocate',e=>chapters.add(e.detail.tocItem?.label));
  const tap=(fraction)=>{
    const doc=view.renderer.getContents()[0]?.doc;if(!doc)throw new Error('Missing ebook document');
    const rect=doc.defaultView.frameElement.getBoundingClientRect();
    const options={bubbles:true,clientX:innerWidth*fraction-rect.left,clientY:innerHeight*.4-rect.top};
    doc.body.dispatchEvent(new PointerEvent('pointerdown',options));doc.body.dispatchEvent(new MouseEvent('click',options));
  };
  let centerWorks=true,visible=true;
  for(let i=0;i<12&&!view.renderer.atEnd;i++){
    tap(.9);await wait(330);view.renderer.snap(0,0);await wait(420);
    const before=root.classList.contains('chrome-hidden');tap(.5);
    centerWorks &&= root.classList.contains('chrome-hidden')!==before;
    visible &&= getComputedStyle(view).transform==='none';
  }
  // Finish concurrent taps before checking the restored page and menu.
  await wait(700);if(root.classList.contains('chrome-hidden'))tap(.5);
  return {mode,calls,chapters:[...chapters],centerWorks,visible,menuVisible:!root.classList.contains('chrome-hidden'),text:view.renderer.getContents()[0]?.doc?.body?.textContent.slice(0,100)};
}

async function checkParallel(mode) {
  const pages = mode !== 'reader-parallel';
  const root = document.querySelector('.reader');
  const main = root.querySelector(':scope > .stage');
  const reference = () => root.querySelector('.parallel-pane');
  const view = () => reference()?.querySelector('foliate-view');
  const switchMode = async (on) => {
    root.querySelector('[aria-label="Reader settings (S)"]').click();
    await until(() => document.querySelector('dialog[open] input[aria-label="Parallel reading"]')).then(input => input.click());
    await until(() => Boolean(reference()) === on && !document.querySelector('dialog[open]'));
  };
  await switchMode(true);
  const mainBefore = () => pages ? main.querySelector('.strip').scrollTop : main.querySelector('foliate-view').renderer.start;
  const readingPosition = () => pages ? reference().querySelector('.strip').scrollTop : view().renderer.start;
  await until(() => pages ? reference().querySelector('form') : view()?.lastLocation?.section?.current === 1);
  if (pages) {
    const form = reference().querySelector('form');
    form.elements.page.value = '4';
    form.requestSubmit();
    await until(() => reference().querySelector('.parallel-position').textContent === 'Page 4 of 6');
  } else {
    const jump = reference().querySelector('select');
    jump.value = [...jump.options].find(option => option.textContent === 'Chapter 4').value;
    jump.dispatchEvent(new Event('change'));
    await until(() => view().lastLocation?.section?.current === 3);
  }
  await wait(300);
  const primaryBefore = mainBefore();
  const secondBefore = readingPosition();
  if (pages) reference().querySelector('.strip').scrollTop += 70;
  else await view().next();
  await until(() => readingPosition() !== secondBefore);
  const primaryUnchanged = mainBefore() === primaryBefore;
  const secondAfter = readingPosition();
  if (pages) main.querySelector('.strip').scrollTop += 80;
  else await main.querySelector('foliate-view').next();
  await until(() => mainBefore() !== primaryBefore);
  const secondaryUnchanged = readingPosition() === secondAfter;
  const stacked = reference().getBoundingClientRect().top >= main.getBoundingClientRect().bottom - 1;
  await wait(200);
  const savedSection = pages ? reference().querySelector('.parallel-position').textContent : view().lastLocation?.section?.current;
  await switchMode(false);
  const restored = pages ? Boolean(main.querySelector('.paged')) : main.querySelector('foliate-view').renderer.getAttribute('flow') === 'paginated';
  await switchMode(true);
  const section = () => pages ? reference().querySelector('.parallel-position').textContent : view()?.lastLocation?.section?.current;
  try {
    await until(() => section() === savedSection);
  } catch {
    throw new Error(`Parallel reader reopened at ${section()}, expected ${savedSection}`);
  }
  return { primaryUnchanged, secondaryUnchanged, stacked, restored };
}

async function until(get) {
  for (let i = 0; i < 80; i++) {
    const value = get();
    if (value) return value;
    await wait(50);
  }
  throw new Error(`Reader condition timed out: ${get}`);
}

async function checkSelectionMenu() {
  const writes = [];
  const copied = [];
  const translations = [];
  const wikiQueries = [];
  const originalFetch = window.fetch;
  window.fetch = (url, options) => {
    if (/\/api\/books\/1\/annotations$/.test(url) && options?.method === 'POST') {
      const annotation = JSON.parse(options.body);
      writes.push(annotation);
      return Promise.resolve(Response.json({ ...annotation, id: writes.length }));
    }
    if (url === '/api/lookup/translate' && options?.method === 'POST') {
      translations.push(JSON.parse(options.body));
      return Promise.resolve(Response.json({ text: 'Texto traducido', provider: 'DeepL' }));
    }
    const lookup = new URL(url, location.href);
    if (lookup.pathname === '/api/lookup/define') {
      return Promise.resolve(Response.json({ word: lookup.searchParams.get('word'), entries: [{
        language: 'English', partOfSpeech: 'pronoun', definitions: [{ text: 'The thing here.', examples: [] }],
      }], url: 'https://en.wiktionary.org/wiki/this' }));
    }
    if (lookup.pathname === '/api/lookup/wiki') {
      const title = lookup.searchParams.get('q');
      wikiQueries.push(title);
      return Promise.resolve(Response.json({ result: { title, extract: 'Wikipedia preview', url: 'https://en.wikipedia.org/wiki/Flyleaf' } }));
    }
    return originalFetch(url, options);
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text) => copied.push(text),
  } });
  const view = document.querySelector('foliate-view');
  const doc = view.renderer.getContents()[0].doc;
  const paragraph = doc.querySelector('p');
  const text = paragraph.firstChild;
  const select = (start, end) => {
    const range = doc.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);
    doc.getSelection().removeAllRanges();
    doc.getSelection().addRange(range);
    doc.dispatchEvent(new Event('selectionchange'));
  };
  const rightClick = () => !paragraph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 110 }));
  const liveMenu = () => document.querySelector('[aria-label="Reader actions"]:not(.leaving)');
  const action = (label) => [...liveMenu().querySelectorAll('[role="menuitem"]')]
    .find((item) => item.querySelector('span:not(.icon)')?.textContent === label);
  select(0, 12);
  const toolbar = await until(() => document.querySelector('[aria-label="Text selection actions"]'));
  toolbar.querySelector('[aria-label="More actions"]').click();
  await until(liveMenu);
  action('Copy').click();
  await until(() => copied.length === 1);
  const intercepted = rightClick();
  await until(liveMenu);
  const options = [...liveMenu().querySelectorAll('[role="menuitem"]')].map(item => item.querySelector('span:not(.icon)').textContent);
  await wait(25);
  action('Copy').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  const keyboard = document.activeElement === action('Highlight');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await until(() => !liveMenu());
  rightClick();
  await until(liveMenu);
  action('Highlight').click();
  await until(() => writes.length === 1);
  await until(() => doc.getSelection().isCollapsed);
  select(13, 24);
  rightClick();
  await until(liveMenu);
  action('Add note').click();
  const dialog = await until(() => document.querySelector('dialog[open][aria-label="Add note"]'));
  dialog.querySelector('textarea').value = 'A reader note';
  dialog.querySelector('.dialog-actions button:last-child').click();
  await until(() => writes.length === 2 && doc.getSelection().isCollapsed);
  document.querySelector('[aria-label="Bookmark this page (B)"]').click();
  await until(() => writes.length === 3);
  const lookup = () => document.querySelector('.lk-pop:not(.leaving)');
  select(0, 4);
  rightClick();
  await until(liveMenu);
  action('Look up').click();
  const definition = (await until(() => lookup()?.querySelector('.lk-entry li'))).textContent;
  lookup().querySelector('[aria-label="Close"]').click();
  select(0, 12);
  rightClick();
  await until(liveMenu);
  action('Translate').click();
  const translated = await until(() => lookup()?.querySelector('.lk-extract'));
  const translation = { text: translated.textContent, provider: lookup().querySelector('.lk-pos').textContent };
  lookup().querySelector('[aria-label="Close"]').click();
  rightClick();
  await until(liveMenu);
  action('Wikipedia').click();
  await until(() => lookup()?.querySelector('.lk-extract'));
  lookup().querySelector('input').value = 'Flyleaf';
  lookup().querySelector('form').requestSubmit();
  await until(() => lookup()?.querySelector('.lk-word')?.textContent === 'Flyleaf');
  lookup().querySelector('[aria-label="Close"]').click();
  doc.getSelection().removeAllRanges();
  rightClick();
  await until(liveMenu);
  action('Reader settings').click();
  const settings = await until(() => document.querySelector('dialog[open][aria-label="Reader settings"]'));
  return { intercepted, keyboard, copied: copied[0], options, highlight: writes[0].text, locator: writes[0].locator,
    note: writes[1].note, bookmark: writes[2].kind, definition, settingsOpened: Boolean(settings),
    translation, translatedSelection: translations[0].q, wikiQueries };
}
