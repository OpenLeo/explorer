import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBits, checkBits, formatBits, extractBits, insertBits, dbcMotorolaStart, motorolaLsbStart, intelStart,
  fromDbcMotorola, fromMotorolaLsb, fromIntel, resolveRange, legacyBits, describePos, normalizeBitsString,
} from '../js/core/bits.js';

test('parseBits single bit and ranges', () => {
  const a = parseBits('1.7');
  assert.equal(a.start, 0); assert.equal(a.end, 0); assert.equal(a.width, 1);
  const b = parseBits('1.7-2.0');
  assert.deepEqual([b.start, b.end, b.width, b.startByte, b.endByte], [0, 15, 16, 1, 2]);
  const c = parseBits('3.3-3.0');
  assert.deepEqual([c.start, c.end, c.width], [20, 23, 4]);
  const d = parseBits('1.4-2.3');
  assert.equal(d.width, 10);
  assert.equal(parseBits('1.0-1.7'), null, 'reverse range is invalid');
  assert.equal(parseBits('0.7'), null);
  assert.equal(parseBits('foo'), null);
  assert.equal(parseBits(null), null);
});

test('parseBits variable length', () => {
  const p = parseBits('3.7-n', 10);
  assert.equal(p.toEnd, true);
  assert.equal(p.end, 79);
  assert.equal(p.width, 64);
  const q = parseBits('3.7-n');
  assert.equal(q.end, 23, 'without length: one byte');
  assert.deepEqual(resolveRange(q, 5), { start: 16, end: 39, width: 24 });
});

test('YAML numbers and legacy notations', () => {
  assert.equal(normalizeBitsString(1.5), '1.5');
  assert.equal(normalizeBitsString(2), '2.0');
  assert.equal(parseBits(1.5).start, 2);
  assert.equal(legacyBits('3'), '3.7-3.0');
  assert.equal(legacyBits('1-2'), '1.7-2.0');
  assert.equal(legacyBits('14.1-14-0'), '14.1-14.0');
  assert.equal(parseBits('1-2').width, 16);
  assert.ok(parseBits('3').legacy);
  assert.equal(checkBits('3'), null);
  assert.match(checkBits('2.0-1.7'), /end before/);
  assert.match(checkBits('x'), /invalid/);
});

test('formatBits round trip', () => {
  for (const s of ['1.7', '1.7-2.0', '3.5-3.2', '2.0-3.1', '8.0']) {
    const p = parseBits(s);
    assert.equal(formatBits(p.start, p.end), s);
  }
  assert.equal(formatBits(16, 0, true), '3.7-n');
});

test('extract / insert bits (Motorola)', () => {
  const bytes = Uint8Array.from([0x12, 0x34, 0xAB, 0xFF, 0, 0, 0, 0]);
  assert.equal(extractBits(bytes, 0, 15), 0x1234);
  assert.equal(extractBits(bytes, 0, 3), 0x1);
  assert.equal(extractBits(bytes, 4, 11), 0x23);
  assert.equal(extractBits(bytes, 16, 23), 0xAB);
  const p = parseBits('1.4-2.3'); // 10 bits: 1.4..1.0 = 10010, 2.7..2.3 = 00110
  assert.equal(extractBits(bytes, p.start, p.end), 0b1001000110);
  const out = new Uint8Array(8);
  insertBits(out, p.start, p.end, 0b1001000110);
  assert.equal(extractBits(out, p.start, p.end), 0b1001000110);
  assert.equal(out[0], 0x12 & 0x1F);
  assert.equal(out[1], 0x34 & 0xF8);
  // 40 bits and 64 bits (BigInt path)
  const big = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(extractBits(big, 0, 39), 0x0102030405);
  assert.equal(extractBits(big, 0, 63), 0x0102030405060708n);
  const w = new Uint8Array(8);
  insertBits(w, 0, 63, 0x0102030405060708n);
  assert.deepEqual(Array.from(w), [1, 2, 3, 4, 5, 6, 7, 8]);
  // out of payload bits read as 0
  assert.equal(extractBits(Uint8Array.from([0xFF]), 4, 11), 0xF0);
});

test('DBC start bits', () => {
  const p = parseBits('1.7-2.0');
  assert.equal(dbcMotorolaStart(p), 7);
  assert.equal(motorolaLsbStart(p), 8);
  assert.equal(intelStart(p), null);
  const q = parseBits('2.5-2.2');
  assert.equal(dbcMotorolaStart(q), 13);
  assert.equal(intelStart(q), 10);
  assert.equal(fromDbcMotorola(7, 16), '1.7-2.0');
  assert.equal(fromDbcMotorola(13, 4), '2.5-2.2');
  assert.equal(fromMotorolaLsb(8, 16), '1.7-2.0');
  assert.equal(fromIntel(10, 4).psa, '2.5-2.2');
  const x = fromIntel(4, 8);
  assert.equal(x.psa, null);
  assert.deepEqual(x.parts, ['1.7-1.4', '2.3-2.0']);
  // round trip for every position of a 12 bit field
  for (let s = 0; s < 64 - 12; s++) {
    const psa = formatBits(s, s + 11);
    const pp = parseBits(psa);
    assert.equal(fromDbcMotorola(dbcMotorolaStart(pp), 12), psa);
    assert.equal(fromMotorolaLsb(motorolaLsbStart(pp), 12), psa);
  }
});

test('describePos', () => {
  assert.equal(describePos(parseBits('3.7-3.6')), 'byte 3, bits 7-6');
  assert.equal(describePos(parseBits('3.7')), 'byte 3, bit 7');
  assert.equal(describePos(parseBits('3.7-3.0')), 'byte 3');
  assert.equal(describePos(parseBits('1.7-2.0')), 'bytes 1-2');
  assert.match(describePos(parseBits('1.4-2.3')), /1\.4 → 2\.3/);
});
