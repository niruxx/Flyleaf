'use strict';

// Canonical numeric CFI path in the original document, including text chunks
// split by comments. Offsets are UTF-16, as required by EPUB CFI.
function cfiPath(node, root, offset = 0) {
  const steps = [];
  while (node && node !== root) {
    const parent = node.parentNode;
    if (!parent) return null;
    const siblings = parent.childNodes;
    if (node.nodeType === 3) {
      const before = siblings.slice(0, siblings.indexOf(node));
      const lastElement = before.findLastIndex(n => n.nodeType === 1);
      const precedingText = before.slice(lastElement + 1).filter(n => n.nodeType === 3).reduce((n, child) => n + (child.text ?? child.textContent).length, 0);
      steps.unshift(`/${2 * before.filter(n => n.nodeType === 1).length + 1}:${precedingText + offset}`);
    } else {
      steps.unshift(`/${2 * (siblings.filter(n => n.nodeType === 1).indexOf(node) + 1)}`);
    }
    node = parent;
  }
  return node === root ? steps.join('') : null;
}
module.exports = { cfiPath };
