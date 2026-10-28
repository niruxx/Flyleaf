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
  await readerView(document.querySelector('#view'),{id:mode==='reader-slide'?'2':'1',query:new URLSearchParams()},()=>false);
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
