'use strict';

// "Send to device": email books to Kindle / Kobo / PocketBook addresses via SMTP.

const path = require('node:path');
const fsp = require('node:fs/promises');
const settings = require('./settings');

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
  let sent = 0;
  for (const book of books) {
    if (book.format === 'folder') throw new Error(`"${book.title}" is a folder of images and can’t be emailed.`);
    if (device.platform === 'kindle' && !KINDLE_OK.has(book.format)) {
      throw new Error(`Kindle only accepts EPUB, PDF, DOCX, RTF and TXT – "${book.title}" is ${book.format.toUpperCase()}.`);
    }
    const { size } = await fsp.stat(book.path);
    if (size > MAX_BYTES) throw new Error(`"${book.title}" is too large to email (${Math.round(size / 1048576)} MB).`);
    await t.sendMail({
      from,
      to: device.email,
      subject: book.title,
      text: `Sent from Flyleaf: ${book.title}`,
      attachments: [{ filename: path.basename(book.path), path: book.path }],
    });
    sent++;
  }
  return sent;
}

async function sendTest(to) {
  await transport().sendMail({ from: settings.get('smtp').from, to, subject: 'Flyleaf test email', text: 'Email from Flyleaf is working.' });
}

module.exports = { configured, sendBooks, sendTest };
