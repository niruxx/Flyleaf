'use strict';

// What's new: CHANGELOG.md, parsed into versions for the "What's new" card and page.
//
//   ## [2.5.0] – 2026-10-26
//   One-line summary (optional).
//   ### Added
//   - **Feature** – what it does.
//
// The file is read again when it changes, so editing it on a running server just works.

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'CHANGELOG.md');
const CURRENT = require('../package.json').version;
let cache = { mtime: 0, entries: [] };

function parse(text) {
  const entries = [];
  let entry = null;
  let section = null;
  let item = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const version = line.match(/^##\s+\[?([0-9A-Za-z.+-]+)\]?\s*(?:[-–—]\s*(\d{4}-\d{2}-\d{2}))?\s*$/);
    if (version) {
      entry = { version: version[1], date: version[2] || null, summary: '', sections: [] };
      entries.push(entry);
      section = item = null;
      continue;
    }
    if (!entry) continue; // the file's own introduction
    const heading = line.match(/^###\s+(.+)$/);
    if (heading) {
      section = { title: heading[1].trim(), items: [] };
      entry.sections.push(section);
      item = null;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      if (!section) {
        section = { title: 'Changes', items: [] };
        entry.sections.push(section);
      }
      item = bullet[1];
      section.items.push(item);
      continue;
    }
    if (!line.trim()) {
      item = null;
      continue;
    }
    // A wrapped bullet, or the summary under the version heading.
    if (item != null && /^\s+/.test(raw)) section.items[section.items.length - 1] += ` ${line.trim()}`;
    else if (!section) entry.summary = `${entry.summary} ${line.trim()}`.trim();
  }
  return entries;
}

function entries() {
  try {
    const { mtimeMs } = fs.statSync(FILE);
    if (mtimeMs !== cache.mtime) cache = { mtime: mtimeMs, entries: parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    cache = { mtime: 0, entries: [] };
  }
  return cache.entries;
}

/** -1, 0 or 1, comparing dotted versions numerically ("2.10.0" > "2.9.1"). */
function compare(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0));
  const pb = String(b).split(/[.+-]/).map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The newest version in the changelog (falls back to package.json). */
const latest = () => entries()[0]?.version || CURRENT;

module.exports = { entries, compare, latest, CURRENT, parse };
