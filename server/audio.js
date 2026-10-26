'use strict';

// Audiobooks: a single audio file (M4B, MP3…) or a folder of tracks is one book (format "audio").
// This reads what the player and the library need – title, author, narrator, cover, length and
// chapters – from ID3v2 tags (MP3) and MP4 atoms (M4B/M4A), without extra dependencies.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav']);
const AUDIO_MIME = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.wav': 'audio/wav',
};
const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

const isAudio = (name) => AUDIO_EXT.has(path.extname(name).toLowerCase());
const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** The tracks of an audiobook, in order: [{ file, name, size, mime }]. */
async function tracksOf(bookPath) {
  const st = await fsp.stat(bookPath);
  if (!st.isDirectory()) return [{ file: bookPath, name: path.basename(bookPath), size: st.size, mime: AUDIO_MIME[path.extname(bookPath).toLowerCase()] || 'application/octet-stream' }];
  const names = (await fsp.readdir(bookPath)).filter((n) => !n.startsWith('.') && isAudio(n)).sort(naturalSort);
  const out = [];
  for (const name of names) {
    const file = path.join(bookPath, name);
    const s = await fsp.stat(file).catch(() => null);
    if (s?.isFile()) out.push({ file, name, size: s.size, mime: AUDIO_MIME[path.extname(name).toLowerCase()] || 'application/octet-stream' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ID3v2 (MP3)

function decodeText(buf, enc) {
  if (enc === 0) return buf.toString('latin1');
  if (enc === 3) return buf.toString('utf8');
  if (enc === 1) {
    // UTF-16 with a byte-order mark.
    if (buf[0] === 0xfe && buf[1] === 0xff) return swap16(buf.subarray(2)).toString('utf16le');
    return buf.subarray(buf[0] === 0xff && buf[1] === 0xfe ? 2 : 0).toString('utf16le');
  }
  if (enc === 2) return swap16(buf).toString('utf16le');
  return buf.toString('latin1');
}
function swap16(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i + 1 < out.length; i += 2) [out[i], out[i + 1]] = [out[i + 1], out[i]];
  return out;
}
const clean = (s) => String(s || '').replace(/\0+$/g, '').replace(/\0/g, ' / ').trim() || null;
const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

async function id3(file) {
  const fd = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(10);
    await fd.read(head, 0, 10, 0);
    if (head.toString('latin1', 0, 3) !== 'ID3') return {};
    const major = head[3];
    if (major < 3) return {}; // ID3v2.2 is rare in audiobooks
    const size = Math.min(syncsafe(head, 6), 32 * 1024 * 1024);
    const body = Buffer.alloc(size);
    await fd.read(body, 0, size, 10);
    const tags = {};
    let p = 0;
    while (p + 10 <= body.length) {
      const id = body.toString('latin1', p, p + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const len = major === 4 ? syncsafe(body, p + 4) : body.readUInt32BE(p + 4);
      const data = body.subarray(p + 10, p + 10 + len);
      p += 10 + len;
      if (!len) continue;
      if (id[0] === 'T' && id !== 'TXXX') tags[id] ??= clean(decodeText(data.subarray(1), data[0]));
      else if (id === 'COMM' && !tags.COMM) {
        // encoding, language (3), short description (terminated), text
        const enc = data[0];
        const rest = data.subarray(4);
        const term = enc === 1 || enc === 2 ? findDoubleZero(rest) : rest.indexOf(0);
        tags.COMM = clean(decodeText(rest.subarray(term < 0 ? 0 : term + (enc === 1 || enc === 2 ? 2 : 1)), enc));
      } else if (id === 'APIC' && !tags.APIC) {
        const enc = data[0];
        const mimeEnd = data.indexOf(0, 1);
        let q = mimeEnd + 2; // past the mime type's terminator and the picture type
        const desc = data.subarray(q);
        const term = enc === 1 || enc === 2 ? findDoubleZero(desc) : desc.indexOf(0);
        q += term < 0 ? 0 : term + (enc === 1 || enc === 2 ? 2 : 1);
        tags.APIC = data.subarray(q);
      }
    }
    return {
      title: tags.TALB || tags.TIT2 || null,
      track: tags.TIT2 || null,
      author: tags.TPE2 || tags.TPE1 || null,
      narrator: tags.TCOM || (tags.TPE2 && tags.TPE1 !== tags.TPE2 ? tags.TPE1 : null),
      year: Number(String(tags.TDRC || tags.TYER || '').slice(0, 4)) || null,
      description: tags.COMM || null,
      genre: tags.TCON || null,
      cover: tags.APIC?.length > 100 ? Buffer.from(tags.APIC) : null,
    };
  } finally {
    await fd.close();
  }
}
function findDoubleZero(buf) {
  for (let i = 0; i + 1 < buf.length; i += 2) if (buf[i] === 0 && buf[i + 1] === 0) return i;
  return -1;
}

// ---------------------------------------------------------------------------
// MP4 atoms (M4B / M4A)

/** Top-level atoms of a file: [{ type, start, size }] (the data can be huge, so only headers are read). */
async function topAtoms(fd, fileSize) {
  const out = [];
  const head = Buffer.alloc(16);
  let pos = 0;
  while (pos + 8 <= fileSize && out.length < 64) {
    await fd.read(head, 0, 16, pos);
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let headerLen = 8;
    if (size === 1) {
      size = Number(head.readBigUInt64BE(8));
      headerLen = 16;
    } else if (size === 0) size = fileSize - pos;
    if (size < headerLen) break;
    out.push({ type, start: pos, size, headerLen });
    pos += size;
  }
  return out;
}

/** Child atoms inside a buffer. */
function children(buf, start = 0, end = buf.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size < 8 || p + size > end) break;
    out.push({ type, start: p + 8, end: p + size });
    p += size;
  }
  return out;
}
const child = (buf, parent, type) => children(buf, parent.start, parent.end).find((a) => a.type === type);

async function mp4(file) {
  const fd = await fsp.open(file, 'r');
  try {
    const { size } = await fd.stat();
    const moovAtom = (await topAtoms(fd, size)).find((a) => a.type === 'moov');
    if (!moovAtom || moovAtom.size > 96 * 1024 * 1024) return {};
    const buf = Buffer.alloc(moovAtom.size - moovAtom.headerLen);
    await fd.read(buf, 0, buf.length, moovAtom.start + moovAtom.headerLen);
    const moov = { start: 0, end: buf.length };
    const out = {};

    // Length from the movie header.
    const mvhd = child(buf, moov, 'mvhd');
    if (mvhd) {
      const v = buf[mvhd.start];
      const scale = v === 1 ? buf.readUInt32BE(mvhd.start + 20) : buf.readUInt32BE(mvhd.start + 12);
      const dur = v === 1 ? Number(buf.readBigUInt64BE(mvhd.start + 24)) : buf.readUInt32BE(mvhd.start + 16);
      if (scale) out.duration = dur / scale;
    }

    const udta = child(buf, moov, 'udta');
    // Tags: udta > meta (a full box: 4 bytes of version/flags) > ilst > ©nam, ©ART…
    const meta = udta && child(buf, udta, 'meta');
    const ilst = meta && children(buf, meta.start + 4, meta.end).find((a) => a.type === 'ilst');
    if (ilst) {
      for (const item of children(buf, ilst.start, ilst.end)) {
        const data = children(buf, item.start, item.end).find((a) => a.type === 'data');
        if (!data) continue;
        const value = buf.subarray(data.start + 8, data.end);
        const text = () => clean(value.toString('utf8'));
        switch (item.type) {
          case '©alb': out.album = text(); break;
          case '©nam': out.name = text(); break;
          case 'aART': out.albumArtist = text(); break;
          case '©ART': out.artist = text(); break;
          case '©wrt': out.composer = text(); break;
          case '©day': out.year = Number(String(text() || '').slice(0, 4)) || null; break;
          case 'desc': case 'ldes': out.description ??= text(); break;
          case '©cmt': out.comment = text(); break;
          case '©gen': out.genre = text(); break;
          case 'covr': out.cover ??= value.length > 100 ? Buffer.from(value) : null; break;
          default:
        }
      }
    }

    // Chapters: Nero "chpl" (most M4B tools write it): version, flags, (4 reserved bytes in
    // version 1), a count, then each start time in 100 ns units and a length-prefixed title.
    const chpl = udta && child(buf, udta, 'chpl');
    if (chpl) {
      let p = chpl.start + 4 + (buf[chpl.start] ? 4 : 0);
      const count = buf[p];
      p += 1;
      const chapters = [];
      for (let i = 0; i < count && p + 9 <= chpl.end; i++) {
        const start = Number(buf.readBigUInt64BE(p)) / 1e7;
        const len = buf[p + 8];
        const title = buf.toString('utf8', p + 9, p + 9 + len).trim();
        p += 9 + len;
        chapters.push({ title: title || `Chapter ${i + 1}`, start });
      }
      if (chapters.length > 1) out.chapters = chapters;
    }
    return {
      title: out.album || out.name || null,
      author: out.albumArtist || out.artist || null,
      narrator: out.composer || (out.albumArtist && out.artist !== out.albumArtist ? out.artist : null),
      year: out.year || null,
      description: out.description || out.comment || null,
      genre: out.genre || null,
      cover: out.cover || null,
      duration: out.duration || null,
      chapters: out.chapters || null,
    };
  } finally {
    await fd.close();
  }
}

/** Tags from one audio file (whatever its kind supports). */
async function fileTags(file) {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === '.mp3') return await id3(file);
    if (['.m4a', '.m4b', '.aac'].includes(ext)) return await mp4(file);
  } catch {}
  return {};
}

/** "The Hobbit (Unabridged)" → "The Hobbit", so the audiobook joins the ebook's series. */
const plainTitle = (t) => String(t || '').replace(/\s*[([]\s*(unabridged|abridged|dramati[sz]ed|audiobook|audio book|full cast)[^)\]]*[)\]]\s*$/i, '').replace(/\s*[-–:]\s*(unabridged|audiobook)\s*$/i, '').trim();

/**
 * Metadata for an audiobook (a file or a folder of tracks): title, author, narrator, year,
 * description, genres, cover, track count, and length/chapters when the file says.
 */
async function metadata(bookPath) {
  const tracks = await tracksOf(bookPath);
  if (!tracks.length) throw new Error('No audio files');
  const tags = await fileTags(tracks[0].file);
  let cover = null;
  const st = await fsp.stat(bookPath);
  const dir = st.isDirectory() ? bookPath : path.dirname(bookPath);
  // A cover image next to the audio wins (cover.jpg, folder.jpg…), then the embedded picture.
  try {
    const images = (await fsp.readdir(dir)).filter((n) => IMAGE_RE.test(n));
    const pick = images.find((n) => /^(cover|folder|front)\./i.test(n)) || (st.isDirectory() ? images[0] : null);
    if (pick) cover = await fsp.readFile(path.join(dir, pick));
  } catch {}
  cover ||= tags.cover || null;
  const fallback = path.basename(bookPath, st.isDirectory() ? '' : path.extname(bookPath));
  return {
    title: plainTitle(tags.title || fallback) || fallback,
    author: tags.author || null,
    narrator: tags.narrator || null,
    year: tags.year || null,
    description: tags.description || null,
    genres: tags.genre ? tags.genre.split(/[,;/]/).map((g) => g.trim()).filter(Boolean) : [],
    cover,
    tracks: tracks.length,
    duration: tracks.length === 1 ? tags.duration || null : null,
    chapters: tracks.length === 1 ? tags.chapters || null : null,
  };
}

const isDirSync = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

module.exports = { AUDIO_EXT, AUDIO_MIME, isAudio, tracksOf, metadata, fileTags, plainTitle, isDirSync };
