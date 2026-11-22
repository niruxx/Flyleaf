// Firefox for iOS sends blob navigations to its download manager, even in chapter iframes.
// Fetch the chapter bytes directly and use a same-origin srcdoc frame in that browser.
const firefoxIOS = /\bFxiOS\//i.test(navigator.userAgent);
const emptyDocument = '<!doctype html><html><head></head><body></body></html>';

async function inlineChapter(src, signal) {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error('Ebook section failed to load');
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (type === 'text/html') return { markup: await response.text() };
  if (type === 'application/xhtml+xml' || type === 'image/svg+xml') {
    // The HTML parser would change some XHTML trees and drop namespaces used by
    // saved positions, footnotes and SVG. Keep the original document elements.
    const parsed = new DOMParser().parseFromString(await response.text(), type);
    if (parsed.documentElement.localName === 'parsererror' || parsed.querySelector('parsererror')) {
      throw new Error('Ebook section contains invalid XML');
    }
    return { markup: emptyDocument, root: parsed.documentElement };
  }
  if (type?.startsWith('image/')) return { markup: `<!doctype html><img src="${src}">` };
  throw new Error('Unsupported ebook section type');
}

async function installChapter(doc, root, signal) {
  const chapter = doc.importNode(root, true);
  const assets = chapter.querySelectorAll(
    'link[rel~="stylesheet" i][href]:not([href=""], [disabled], [rel~="alternate" i]), img[src]:not([src=""], [loading="lazy" i])',
  );
  const ready = Array.from(assets, (asset) =>
    new Promise((resolve) => {
      const loaded = () => {
        asset.removeEventListener('load', loaded);
        asset.removeEventListener('error', loaded);
        signal.removeEventListener('abort', loaded);
        resolve();
      };
      asset.addEventListener('load', loaded);
      asset.addEventListener('error', loaded);
      signal.addEventListener('abort', loaded);
    }));
  doc.replaceChild(chapter, doc.documentElement);
  await Promise.all(ready);
}

export function loadChapterFrame(frame, src, signal) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
      frame.removeEventListener('load', loaded);
      frame.removeEventListener('error', failed);
      controller.abort();
    };
    const fail = (error) => { cleanup(); reject(error); };
    const failed = () => fail(new Error('Ebook section failed to load'));
    const cancelled = () => fail(new Error('Ebook section load cancelled'));
    const inline = firefoxIOS && src.startsWith('blob:');
    let chapter;
    const loaded = async () => {
      const doc = frame.contentDocument;
      if (inline && doc?.URL !== 'about:srcdoc') return;
      if (!doc?.documentElement) return failed();
      frame.removeEventListener('load', loaded);
      try {
        if (chapter?.root) await installChapter(doc, chapter.root, controller.signal);
        cleanup();
        resolve(doc);
      } catch (error) {
        fail(error);
      }
    };
    const timer = setTimeout(() => {
      fail(new Error('Ebook section load timed out'));
      frame.removeAttribute('srcdoc');
      frame.src = 'about:blank';
    }, 20000);
    if (signal?.aborted) return cancelled();
    signal?.addEventListener('abort', cancelled);
    const navigate = () => {
      if (controller.signal.aborted) return;
      frame.addEventListener('load', loaded);
      frame.addEventListener('error', failed);
      if (chapter) frame.srcdoc = chapter.markup;
      else frame.src = src;
    };
    if (inline) inlineChapter(src, controller.signal).then((result) => { chapter = result; navigate(); }, fail);
    else navigate();
  });
}
