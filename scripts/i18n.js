#!/usr/bin/env node
'use strict';

// Collects the UI text to translate and keeps the language files up to date.
//
//   npm run i18n
//
// Finds every t('…'), N_('…') and plural(n, '…', '…') in public/js, writes them to
// public/locales/template.json, and adds new keys (empty, so they show in English) to every
// language listed in public/locales/index.json. Keys no longer used are reported, and removed
// with --prune. See docs/translating.md.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'public', 'js');
const localeDir = path.join(root, 'public', 'locales');
const prune = process.argv.includes('--prune');

const LIT = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
const patterns = [
  new RegExp(String.raw`\b(?:t|N_)\(\s*${LIT}`, 'g'),
  new RegExp(String.raw`\bplural\([^,()]+(?:\([^()]*\))?,\s*${LIT},\s*${LIT}`, 'g'),
];
// Decode both JavaScript quote styles, including escaped line breaks and Unicode.
const unescape = (literal) => literal.slice(1, -1).replace(
  /\\(u\{[\da-f]+\}|u[\da-f]{4}|x[\da-f]{2}|\r?\n|.)/gis,
  (_, escape) => {
    if (escape.startsWith('u{')) return String.fromCodePoint(parseInt(escape.slice(2, -1), 16));
    if (/^[ux][\da-f]+$/i.test(escape)) return String.fromCodePoint(parseInt(escape.slice(1), 16));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '', '\r\n': '' })[escape] ?? escape;
  },
);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : e.name.endsWith('.js') ? [full] : [];
  });
}

const keys = new Map(); // key → files
for (const file of walk(srcDir)) {
  if (path.basename(file) === 'i18n.js') continue; // its comments show examples
  const src = fs.readFileSync(file, 'utf8');
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      for (const k of m.slice(1).filter(Boolean).map(unescape)) {
        if (!keys.has(k)) keys.set(k, new Set());
        keys.get(k).add(path.relative(root, file).split(path.sep).join('/'));
      }
    }
  }
}
const sorted = [...keys.keys()].sort((a, b) => a.localeCompare(b));
fs.mkdirSync(localeDir, { recursive: true });
fs.writeFileSync(path.join(localeDir, 'template.json'), `${JSON.stringify(Object.fromEntries(sorted.map((k) => [k, ''])), null, 2)}\n`);
console.log(`${sorted.length} strings → public/locales/template.json`);

const index = JSON.parse(fs.readFileSync(path.join(localeDir, 'index.json'), 'utf8'));
for (const { code, name } of index) {
  if (code === 'en') continue;
  const file = path.join(localeDir, `${code}.json`);
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const next = {};
  for (const k of sorted) next[k] = current[k] ?? '';
  const unused = Object.keys(current).filter((k) => !keys.has(k));
  if (!prune) for (const k of unused) next[k] = current[k];
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  const done = sorted.filter((k) => next[k]).length;
  console.log(`${name} (${code}): ${done}/${sorted.length} translated${unused.length ? `, ${unused.length} unused${prune ? ' removed' : ' (run with --prune to remove)'}` : ''}`);
}
