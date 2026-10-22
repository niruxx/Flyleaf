'use strict';

// Just enough of the APK format to identify a Mihon/Tachiyomi extension: find
// AndroidManifest.xml in the zip and read Android's binary XML for the package name,
// version and extension markers.

const zlib = require('node:zlib');

/** The bytes of one file inside a zip, or null. */
function zipEntry(buf, wanted) {
  // End of central directory: in the last 64 KB (it may be followed by a comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (name !== wanted) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) return data;
    if (method === 8) return zlib.inflateRawSync(data);
    return null;
  }
  return null;
}

function stringPool(buf, at) {
  const count = buf.readUInt32LE(at + 8);
  const utf8 = (buf.readUInt32LE(at + 16) & 0x100) !== 0;
  const data = at + buf.readUInt32LE(at + 20);
  const offsets = at + buf.readUInt16LE(at + 2);
  const out = [];
  for (let i = 0; i < count; i++) {
    let o = data + buf.readUInt32LE(offsets + i * 4);
    if (utf8) {
      // Character count, then byte count; each is 1 byte, or 2 when the high bit is set.
      o += buf[o] & 0x80 ? 2 : 1;
      let len = buf[o];
      if (len & 0x80) len = ((len & 0x7f) << 8) | buf[o + 1], o += 2;
      else o += 1;
      out.push(buf.toString('utf8', o, o + len));
    } else {
      let len = buf.readUInt16LE(o);
      o += 2;
      if (len & 0x8000) len = ((len & 0x7fff) << 16) | buf.readUInt16LE(o), o += 2;
      out.push(buf.toString('utf16le', o, o + len * 2));
    }
  }
  return out;
}

/** Elements of a binary XML file as [{ name, attrs }], in document order. */
function binaryXml(buf) {
  let strings = [];
  const elements = [];
  let p = buf.readUInt16LE(2); // skip the file header
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (!size) break;
    if (type === 0x0001) strings = stringPool(buf, p);
    else if (type === 0x0102) {
      const ext = p + buf.readUInt16LE(p + 2);
      const attrStart = buf.readUInt16LE(ext + 8);
      const attrSize = buf.readUInt16LE(ext + 10);
      const attrCount = buf.readUInt16LE(ext + 12);
      const attrs = {};
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const raw = buf.readUInt32LE(a + 8);
        const dataType = buf[a + 15];
        const value = buf.readUInt32LE(a + 16);
        attrs[strings[buf.readUInt32LE(a + 4)]] = raw !== 0xffffffff ? strings[raw] : dataType === 0x03 ? strings[value] : dataType === 0x12 ? value !== 0 : value;
      }
      elements.push({ name: strings[buf.readUInt32LE(ext + 4)], attrs });
    }
    p += size;
  }
  return elements;
}

/**
 * What an APK is: { pkgName, versionName, versionCode, lib, kind, nsfw }, where kind is
 * 'manga' (a Mihon/Tachiyomi extension), 'anime' (Aniyomi) or null. Throws if unreadable.
 */
function readApk(buffer) {
  const manifest = zipEntry(buffer, 'AndroidManifest.xml');
  if (!manifest) throw new Error('no AndroidManifest.xml');
  const els = binaryXml(manifest);
  const root = els.find((e) => e.name === 'manifest');
  if (!root?.attrs.package) throw new Error('no package name');
  const features = els.filter((e) => e.name === 'uses-feature').map((e) => e.attrs.name);
  const meta = Object.fromEntries(els.filter((e) => e.name === 'meta-data').map((e) => [e.attrs.name, e.attrs.value]));
  const has = (prefix) => features.includes(prefix) || Object.keys(meta).some((k) => k.startsWith(`${prefix}.`));
  const versionName = root.attrs.versionName != null ? String(root.attrs.versionName) : null;
  // Extension versions are "<lib>.<build>", e.g. 1.4.29 → extension API 1.4.
  const lib = versionName ? Number(versionName.slice(0, versionName.lastIndexOf('.'))) || null : null;
  return {
    pkgName: String(root.attrs.package),
    versionName,
    versionCode: Number(root.attrs.versionCode) || 0,
    lib,
    kind: has('tachiyomi.extension') ? 'manga' : has('tachiyomi.animeextension') ? 'anime' : null,
    nsfw: Number(meta['tachiyomi.extension.nsfw']) === 1,
  };
}

module.exports = { readApk };
