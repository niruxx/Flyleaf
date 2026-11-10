'use strict';

const { TextDecoder } = require('node:util');
const { readZipFile } = require('./archive');

// EPUB content is usually UTF-8, but older books also declare UTF-16 or legacy
// XML encodings. Never build position maps from replacement-character text.
function decodeMarkup(buffer) {
  let encoding = 'utf-8';
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0x3c && buffer[1] === 0)) encoding = 'utf-16le';
  else if ((buffer[0] === 0xfe && buffer[1] === 0xff) || (buffer[0] === 0 && buffer[1] === 0x3c)) encoding = 'utf-16be';
  else {
    const declaration = buffer.subarray(0, 512).toString('ascii').match(/^\s*<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/i);
    if (declaration) encoding = declaration[1];
  }
  return new TextDecoder(encoding, { fatal: true }).decode(buffer);
}

async function readMarkup(file, member) {
  const buffer = await readZipFile(file, member);
  if (!buffer) throw new Error('Missing EPUB content');
  return decodeMarkup(buffer);
}

module.exports = { decodeMarkup, readMarkup };
