'use strict';

// "Send to device": email books to Kindle / Kobo / PocketBook addresses via SMTP.

const path = require('node:path');
const fsp = require('node:fs/promises');
const settings = require('./settings');
const { bookParts, zipParts } = require('./book-package');

const KINDLE_OK = new Set(['epub', 'pdf', 'txt', 'docx', 'rtf']);
const MAX_BYTES = 45 * 1024 * 1024;

function configured() {
  const s = settings.get('smtp');
  return Boolean(s?.host && s?.from);
}

function transport() {
  const s = settings.get('smtp');
  if (!s?.host || !s?.from) throw new Error('Email isn’t set up yet. The admin can add SMTP details in Settings → Server.');
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: s.host,
    port: Number(s.port) || 587,
    secure: Boolean(s.secure),
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
  });
}

async function sendBooks(device, books) {
  const t = transport();
  const from = settings.get('smtp').from;
  const messages = [];
  for (const book of books) {
    if (device.platform === 'kindle' && !KINDLE_OK.has(book.format)) {
      throw new Error(`Kindle only accepts EPUB, PDF, DOCX, RTF and TXT – "${book.title}" is ${book.format.toUpperCase()}.`);
    }
    const stat = await fsp.stat(book.path);
    const parts = stat.isDirectory() ? await bookParts(book) : null;
    if (parts && !parts.length) throw new Error(`"${book.title}" has no files to email.`);
    const size = parts ? parts.reduce((sum, file) => sum + file.size + 120 + 2 * Buffer.byteLength(file.name), 22) : stat.size;
    if (size > MAX_BYTES) throw new Error(`"${book.title}" is too large to email (${Math.round(size / 1048576)} MB). Share a reading link instead.`);
    messages.push({ book, parts });
  }
  let sent = 0;
  for (const { book, parts } of messages) {
    const zip = parts ? zipParts(parts) : null;
    const filename = path.basename(book.path);
    const attachment = zip
      ? { filename: `${filename}.${book.format === 'audio' ? 'zip' : 'cbz'}`, content: zip }
      : { filename, path: book.path };
    const delivery = t.sendMail({
      from,
      to: { address: device.email },
      subject: book.title,
      text: `Sent from Flyleaf: ${book.title}`,
      attachments: [attachment],
    });
    if (zip) {
      try {
        await Promise.all([delivery, zip.finalize()]);
      } finally {
        if (!zip.readableEnded) zip.destroy();
      }
    } else await delivery;
    sent++;
  }
  return sent;
}

async function sendTest(to) {
  await transport().sendMail({ from: settings.get('smtp').from, to, subject: 'Flyleaf test email', text: 'Email from Flyleaf is working.' });
}

module.exports = { configured, sendBooks, sendTest };
