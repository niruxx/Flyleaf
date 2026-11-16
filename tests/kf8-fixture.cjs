// A minimal unencrypted KF8 with real skeleton/fragment INDX tables.
const vwi = value => {
  const bytes = [value & 127 | 128];
  while ((value >>>= 7)) bytes.unshift(value & 127);
  return Buffer.from(bytes);
};
function index(tags, name, values) {
  const meta = Buffer.alloc(56 + 12 + tags.length * 4);
  meta.write('INDX'); meta.writeUInt32BE(56, 4); meta.writeUInt32BE(1, 24); meta.writeUInt32BE(65001, 28);
  meta.write('TAGX', 56); meta.writeUInt32BE(12 + tags.length * 4, 60); meta.writeUInt32BE(1, 64);
  tags.forEach(([tag, count], i) => Buffer.from([tag, count, 1 << i, 0]).copy(meta, 68 + i * 4));
  const entry = Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from([(1 << tags.length) - 1]), ...values.flat().map(vwi)]);
  const data = Buffer.alloc(56 + entry.length + 6);
  data.write('INDX'); data.writeUInt32BE(56, 4); data.writeUInt32BE(56 + entry.length, 20); data.writeUInt32BE(1, 24);
  entry.copy(data, 56); data.write('IDXT', 56 + entry.length); data.writeUInt16BE(56, 60 + entry.length);
  return [meta, data];
}
module.exports = function kf8Fixture(text = 'Hello KF8 😀 text.', { resources = [], head = '' } = {}) {
  const skeleton = Buffer.from(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>KF8</title>${head}</head><body><p id="p"></p></body></html>`);
  const fragment = Buffer.from(text);
  const position = skeleton.indexOf('</p>');
  const record = Buffer.alloc(320);
  record.writeUInt16BE(1); record.writeUInt32BE(skeleton.length + fragment.length, 4); record.writeUInt16BE(1, 8); record.writeUInt16BE(4096, 10);
  record.write('MOBI', 16); record.writeUInt32BE(264, 20); record.writeUInt32BE(2, 24); record.writeUInt32BE(65001, 28); record.writeUInt32BE(1, 32); record.writeUInt32BE(8, 36);
  record.writeUInt32BE(300, 84); record.writeUInt32BE(4, 88); record.writeUInt32BE(7, 108); record.writeUInt32BE(64, 128);
  record.writeUInt32BE(6, 192); record.writeUInt32BE(1, 196); record.writeUInt32BE(0xffffffff, 244);
  record.writeUInt32BE(4, 248); record.writeUInt32BE(2, 252); record.writeUInt32BE(0xffffffff, 260);
  record.write('EXTH', 280); record.writeUInt32BE(12, 284); record.write('Test', 300);
  const fdst = Buffer.alloc(20); fdst.write('FDST'); fdst.writeUInt32BE(1, 8); fdst.writeUInt32BE(skeleton.length + fragment.length, 16);
  const records = [record, Buffer.concat([skeleton, fragment]), ...index([[1, 1], [6, 2]], 's', [[1], [0, skeleton.length]]),
    ...index([[2, 1], [4, 1], [6, 2]], String(position), [[0], [0], [0, fragment.length]]), fdst, ...resources];
  const pdb = Buffer.alloc(78 + 8 * records.length);
  pdb.write('Fixture'); pdb.write('BOOKMOBI', 60); pdb.writeUInt16BE(records.length, 76);
  let offset = pdb.length;
  records.forEach((data, i) => { pdb.writeUInt32BE(offset, 78 + 8 * i); offset += data.length; });
  return Buffer.concat([pdb, ...records]);
};
module.exports.index = index;
