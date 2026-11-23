const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await wait(25); }
  throw new Error('Timed out waiting for speech playback');
}
export async function run() {
  localStorage.setItem('flyleaf.autoSaveNext', 'false');
  const host = document.createElement('div'); host.className = 'snackbar-host'; document.body.append(host);
  const spoken = [];
  let canceled = 0;
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    speak: utterance => spoken.push(utterance), cancel: () => canceled++, getVoices: () => [{ lang: 'en' }],
  } });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class { constructor(text) { this.text = text; } } });
  const { sentences } = await import('/js/reader/read-aloud.js');
  const doc = document.implementation.createHTMLDocument('Sentences');
  doc.body.innerHTML = '<p>Hello <em>world</em>. Next sentence!</p><p>Separate paragraph</p><p>One<br/>Two</p><p hidden>Skip me.</p>';
  const items = sentences(doc, 'en');
  assert(items.length === 5, 'sentence segmentation must respect inline markup, paragraph and line breaks');
  assert(items[0].range.toString() === 'Hello world. ', 'the highlighted range must span inline markup');
  const { readerView } = await import('/js/reader/reader.js');
  await readerView(document.querySelector('#view'), { id: '1', query: new URLSearchParams() }, () => false);
  const view = document.querySelector('foliate-view');
  const original = view.renderer.getContents()[0].doc.body.innerHTML;
  document.querySelector('.chrome-top [aria-label="Read aloud"]').click();
  const bar = document.querySelector('.read-aloud-bar');
  assert(bar, 'read-aloud panel must open');
  bar.querySelector('[aria-label="Read aloud"]').click();
  await until(() => spoken.length === 1);
  assert(view.renderer.getContents()[0].overlayer.element.querySelector('rect'), 'current sentence must be highlighted');
  assert(view.renderer.getContents()[0].doc.body.innerHTML === original, 'speech must not mutate the book DOM or CFIs');
  const speed = bar.querySelector('[aria-label="Speech speed"]');
  speed.value = '1.5'; speed.dispatchEvent(new Event('change'));
  await until(() => spoken.length === 2);
  assert(spoken[1].rate === 1.5, 'speed changes must restart at the selected rate');
  const count = spoken.length; spoken[0].onend(); await wait(30);
  assert(spoken.length === count, 'canceled callbacks must not queue more speech');
  for (let i = 0; i < 50 && view.renderer.getContents()[0].index === 0; i++) {
    const previous = spoken.length;
    spoken.at(-1).onend();
    await until(() => spoken.length > previous);
  }
  assert(view.renderer.getContents()[0].index === 1, 'speech must continue into the next chapter');
  const inChapterTwo = spoken.at(-1);
  bar.querySelector('[aria-label="Stop reading aloud"]').click();
  const stopped = spoken.length; inChapterTwo.onend(); await wait(30);
  assert(spoken.length === stopped, 'stop must cancel chapter playback');
  assert(!view.renderer.getContents()[0].overlayer.element.querySelector('rect'), 'stop must remove the speech highlight');
  bar.querySelector('[aria-label="Read aloud"]').click();
  await until(() => spoken.length > stopped);
  const manual = spoken.at(-1);
  document.querySelector('[aria-label="Next page"]').click();
  const afterNavigation = spoken.length;
  manual.onend(); await wait(50);
  assert(spoken.length === afterNavigation, 'manual navigation must cancel speech');
  const bounds = bar.getBoundingClientRect();
  assert(bounds.left >= 0 && bounds.right <= innerWidth, 'controls must fit the mobile viewport');
  bar.querySelector('[aria-label="Close read aloud"]').click();
  assert(!bar.isConnected && canceled > 0, 'closing controls must stop speech and remove the panel');
  return { sentences: items.length, utterances: spoken.length, chapter: 2, domPreserved: true, mobileControls: true };
}
