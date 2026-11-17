'use strict';

const TEXT = new Set(['epub', 'mobi', 'azw3', 'fb2', 'txt', 'docx', 'rtf']);
function readingKind(book) {
  return book.format === 'audio' ? 'audio' : TEXT.has(book.format) ? 'text' : book.format === 'pdf' ? 'pdf' : 'comic';
}
/** Estimates use indexed text or known pages/duration, never compressed file size. */
function estimateRemaining(book, pace = {}, speed = 1) {
  const kind = readingKind(book);
  if (book.p_finished) return null;
  const percent = Math.max(0, Math.min(1, Number(book.p_percent) || 0));
  if (percent >= .999) return null;
  let units, seconds, basis;
  if (kind === 'audio') {
    let embedded = {};
    try { embedded = JSON.parse(book.embedded || '{}'); } catch {}
    const duration = Number(embedded.duration);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    seconds = duration / speed;
    basis = 'duration';
  } else {
    units = kind === 'text' ? Number(book.text_chars) / 1800 : Number(book.page_count);
    if (!Number.isFinite(units) || units <= 0) return null;
    const learned = pace[kind];
    const defaultRate = kind === 'text' ? 1500 / 1800 : kind === 'comic' ? 2 : 1;
    const rate = learned?.seconds >= 300 && learned?.pages >= 5
      ? Math.max(.25, Math.min(kind === 'comic' ? 15 : 6, learned.pages / (learned.seconds / 60))) : defaultRate;
    seconds = units / rate * 60;
    basis = learned?.seconds >= 300 && learned?.pages >= 5 ? 'personal' : 'typical';
  }
  return { seconds: Math.max(1, Math.ceil(seconds * (1 - percent))), basis, kind };
}
function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) >= 1970 && Number(value.slice(0, 4)) <= 9998 &&
    Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}
module.exports = { readingKind, estimateRemaining, validDay };
