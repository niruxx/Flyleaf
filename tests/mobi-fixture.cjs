// Minimal standards-shaped PalmDB/MOBI6 fixture, with uncompressed or PalmDOC
// literal records. No third-party book content or tool binaries are required.
module.exports = function mobiFixture(html, { compression = 1, version = 6, ncxOffset = null } = {}) {
  const text = Buffer.from(html);
  const packed = compression === 2 ? Buffer.concat(Array.from({ length: Math.ceil(text.length / 8) }, (_, i) => {
    const part = text.subarray(i * 8, i * 8 + 8);
    return Buffer.concat([Buffer.from([part.length]), part]);
  })) : text;
  const ncx = ncxOffset == null ? [] : require('./kf8-fixture.cjs').index([[1, 1], [3, 1], [4, 1]], 'chapter', [[ncxOffset], [0], [0]]);
  const pdb = Buffer.alloc(78 + 8 * (2 + ncx.length));
  pdb.write('Fixture', 0);
  pdb.write('BOOKMOBI', 60);
  pdb.writeUInt16BE(2 + ncx.length, 76);
  const record = Buffer.alloc(272);
  record.writeUInt16BE(compression, 0);
  record.writeUInt32BE(text.length, 4);
  record.writeUInt16BE(1, 8);
  record.writeUInt16BE(4096, 10);
  record.write('MOBI', 16);
  record.writeUInt32BE(232, 20);
  record.writeUInt32BE(2, 24);
  record.writeUInt32BE(65001, 28);
  record.writeUInt32BE(1, 32);
  record.writeUInt32BE(version, 36);
  record.writeUInt32BE(248, 84);
  record.writeUInt32BE(4, 88);
  record.writeUInt32BE(2 + ncx.length, 108);
  record.writeUInt32BE(ncx.length ? 2 : 0xffffffff, 244);
  record.write('Test', 248);
  const records = [record, packed, ...ncx];
  let offset = pdb.length;
  records.forEach((data, i) => { pdb.writeUInt32BE(offset, 78 + 8 * i); offset += data.length; });
  return Buffer.concat([pdb, ...records]);
};
