'use strict';

// Current CREngine attaches filepos/NCX targets to a following start tag when
// possible. That only changes attributes, so paths are stable on older DOMs too.
// Mid-text targets insert elements on newer DOM versions: retain native fallback.
function stableAnchorTargets(bytes, offsets) {
  const source = Buffer.from(bytes).toString('latin1'); // indices must remain byte offsets
  for (const offset of offsets) {
    if (!Number.isSafeInteger(offset) || offset <= 0 || offset > bytes.length) return false;
    let pos = offset;
    const lt = source.lastIndexOf('<', pos - 1), gt = source.lastIndexOf('>', pos - 1);
    if (lt > gt && source[lt + 1] !== '/') {
      const end = source.indexOf('>', pos);
      if (end < 0 || source.slice(pos, end).includes('<')) return false;
      if (!/\/\s*$/.test(source.slice(lt, end))) continue;
      pos = end + 1;
    }
    if (source[pos] === '>') pos++;
    let found = false;
    while (pos < source.length) {
      while (/[\t\n\r ]/.test(source[pos] || '') && pos < source.length) pos++;
      const start = source.slice(pos).match(/^<([a-z][\w:.-]*)\b[^<>]*>/i);
      if (!start) break;
      if (!/\/\s*>$/.test(start[0])) { found = true; break; }
      pos += start[0].length;
    }
    if (!found) return false;
  }
  return true;
}

// Only the modern DOM inserts standalone anchors into text. Keep both models:
// the sync protocol does not advertise the document's saved DOM version.
function modernAnchorSource(bytes, offsets, decode) {
  const unique = [...new Set(offsets)].sort((a, b) => a - b);
  const chunks = [];
  let start = 0;
  const raw = Buffer.from(bytes);
  const source = raw.toString('latin1');
  for (const offset of unique) {
    if (stableAnchorTargets(raw, [offset])) continue;
    if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= raw.length) return null;
    const prefix = source.slice(0, offset);
    // Reject targets inside tags, comments, entities or UTF-8 code points.
    if (prefix.lastIndexOf('<') > prefix.lastIndexOf('>') || prefix.lastIndexOf('&') > Math.max(prefix.lastIndexOf(';'), prefix.lastIndexOf('>'))) return null;
    const before = decode(raw.subarray(0, offset)), after = decode(raw.subarray(offset));
    if (before + after !== decode(raw)) return null;
    chunks.push(decode(raw.subarray(start, offset)), `<a id="filepos${offset}"></a>`);
    start = offset;
  }
  chunks.push(decode(raw.subarray(start)));
  return chunks.join('');
}

module.exports = { stableAnchorTargets, modernAnchorSource };
