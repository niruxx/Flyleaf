'use strict';

// Match ordered text, not similar strings. Filepos markers can split one run
// into several; each intersection keeps offsets in both original DOMs.
function alignRuns(nativeRuns, webRuns, profile) {
  const mappings = [];
  let n = 0, w = 0, nativeStart = 0, webStart = 0;
  while (n < nativeRuns.length && w < webRuns.length) {
    const native = nativeRuns[n], web = webRuns[w];
    const length = Math.min(native.text.length - nativeStart, web.text.length - webStart);
    const text = native.text.slice(nativeStart, nativeStart + length);
    if (!length || text !== web.text.slice(webStart, webStart + length)) return [];
    if (mappings.length >= 100000) return [];
    // Share the source run object so structured cloning doesn't repeat a
    // chapter-sized string for every anchor splitting that run.
    mappings.push({ native: native.path, nativeRun: native, nativeStart, pre: native.pre,
      stripLeadingNewline: native.stripLeadingNewline, text, profile, path: web.path, chunkStart: web.chunkStart + webStart });
    nativeStart += length;
    webStart += length;
    if (nativeStart === native.text.length) { n++; nativeStart = 0; }
    if (webStart === web.text.length) { w++; webStart = 0; }
  }
  return n === nativeRuns.length && w === webRuns.length ? mappings : [];
}

module.exports = { alignRuns };
