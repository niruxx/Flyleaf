'use strict';

const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generate() {
  const bits = [...randomBytes(20)].map((byte) => byte.toString(2).padStart(8, '0')).join('');
  return bits.match(/.{5}/g).map((group) => alphabet[parseInt(group, 2)]).join('');
}

function verify(secret, code, lastStep, now = Date.now()) {
  if (typeof secret !== 'string' || !/^[A-Z2-7]{32}$/.test(secret) || typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const bits = [...secret].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map((group) => parseInt(group, 2)));
  const current = Math.floor(now / 30_000);
  for (const step of [current, current - 1, current + 1]) {
    if (step < 0 || (lastStep != null && step <= lastStep)) continue;
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hash = createHmac('sha1', key).update(counter).digest();
    const expected = String((hash.readUInt32BE(hash.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
    if (timingSafeEqual(Buffer.from(code), Buffer.from(expected))) return step;
  }
  return null;
}

module.exports = { generate, verify };
