'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

/** Only files that belong to the reader's image book or audiobook. */
async function bookParts(book) {
  let names;
  if (book.format === 'folder') names = await require('./archive').listPages(book);
  else if (book.format === 'audio') names = (await require('./audio').tracksOf(book.path)).map((track) => track.name);
  else return [];
  const parts = [];
  for (const name of names) {
    if (name !== path.basename(name)) continue;
    const file = path.join(book.path, name);
    const stat = await fsp.lstat(file);
    if (stat.isFile()) parts.push({ file, name, size: stat.size });
  }
  return parts;
}

function zipParts(parts) {
  const { ZipArchive } = require('archiver');
  const zip = new ZipArchive({ store: true });
  for (const { file, name } of parts) zip.file(file, { name });
  return zip;
}

module.exports = { bookParts, zipParts };
