const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('reader sheets open inside the active fullscreen element and otherwise in the body', () => {
  const source = fs.readFileSync('public/js/ui.js', 'utf8');
  const sheetSource = source.slice(source.indexOf('export function sheet('), source.indexOf('export function segmented('))
    .replace('export function', 'function');
  for (const fullscreen of [false, true]) {
    const body = { append: (dialog) => { dialog.parent = body; } };
    const root = { append: (dialog) => { dialog.parent = root; } };
    const document = { body, fullscreenElement: fullscreen ? root : null };
    let dialog;
    const context = { document, append() {}, leave() {}, h: (tag) => {
      if (tag !== 'dialog.sheet') return {};
      dialog = { addEventListener() {}, showModal() {
        assert.equal(this.parent, fullscreen ? root : body);
        this.open = true;
      } };
      return dialog;
    } };
    vm.runInNewContext(`${sheetSource}\nsheet(() => null);`, context);
    assert.equal(dialog.open, true);
  }
});

test('reflection dialogs stay visible inside an active fullscreen reader', () => {
  const source = fs.readFileSync('public/js/ui.js', 'utf8');
  const dialogSource = source.slice(source.indexOf('export function dialog('), source.indexOf('export function confirmDialog(')).replace('export function', 'function');
  for (const fullscreen of [false, true]) {
    const body = { append(node) { node.parent = body; } }, root = { append(node) { node.parent = root; } };
    let node;
    const context = { document: { body, fullscreenElement: fullscreen ? root : null }, append() {}, leave() {}, h(tag) {
      if (tag !== 'dialog.dialog') return {};
      node = { addEventListener() {}, showModal() { assert.equal(this.parent, fullscreen ? root : body); this.open = true; } };
      return node;
    } };
    vm.runInNewContext(`${dialogSource}\ndialog({ content: null });`, context);
    assert.equal(node.open, true);
  }
});
