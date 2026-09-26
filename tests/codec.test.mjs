import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFrame } from '../js/core/normalize.js';
import { decodeFrame, decodeSignal, encodeFrame, physToRaw, rawToPhys } from '../js/core/codec.js';

const frame = normalizeFrame({
  id: 0x0B6, name: 'SPEED', type: 'can', length: 8, periodicity: ['50ms'], senders: ['BSI'],
  signals: {
    RPM: { bits: '1.7-2.0', type: 'uint', factor: 1, units: 'rpm', max: 8000 },
    SPEED: { bits: '3.7-4.0', type: 'uint', factor: 0.01, units: 'km/h', invalid: 0xFFFF },
    TEMP: { bits: '5.7-5.0', type: 'sint', min: -40, max: 100 },
    GEAR: { bits: '6.7-6.4', values: { 0: { en: 'neutral' }, 1: { en: 'first' } } },
    FLAG: { bits: '6.3', type: 'bool' },
    BCDV: { bits: '7.7-8.0', type: 'bcd' },
  },
});

test('decode a payload', () => {
  const bytes = Uint8Array.from([0x03, 0xE8, 0x1F, 0x40, 0xF6, 0x1A, 0x12, 0x34]);
  const d = decodeFrame(frame, bytes);
  const get = (n) => d.signals.find((s) => s.name === n);
  assert.equal(get('RPM').raw, 0x3E8); // 1000
  assert.equal(get('RPM').phys, 1000);
  assert.equal(get('SPEED').phys, 80);
  assert.equal(get('TEMP').phys, -10);
  assert.equal(get('GEAR').label, 'first');
  assert.equal(get('FLAG').raw, 1);
  assert.equal(get('BCDV').phys, 1234);
  assert.deepEqual(d.flags, []);
});

test('flags: invalid, out of range, unknown value, short payload', () => {
  const bytes = Uint8Array.from([0xFF, 0xF0, 0xFF, 0xFF, 0x7F, 0x50]);
  const d = decodeFrame(frame, bytes);
  const get = (n) => d.signals.find((s) => s.name === n);
  assert.ok(get('SPEED').flags.includes('invalid'));
  assert.ok(get('RPM').flags.includes('above-max'));
  assert.ok(get('TEMP').flags.includes('above-max'));
  assert.ok(get('GEAR').flags.includes('unknown-value'));
  assert.ok(get('BCDV').flags.includes('absent'));
  assert.deepEqual(d.flags, ['short']);
});

test('encode / decode round trip', () => {
  const raw = {
    RPM: physToRaw(frame.signals[0], 2500), SPEED: physToRaw(frame.signals[1], 123.45), TEMP: physToRaw(frame.signals[2], -40),
    GEAR: 1, FLAG: 1, BCDV: physToRaw(frame.signals[5], 4321),
  };
  const bytes = encodeFrame(frame, raw);
  assert.equal(bytes.length, 8);
  const d = decodeFrame(frame, bytes);
  const get = (n) => d.signals.find((s) => s.name === n);
  assert.equal(get('RPM').phys, 2500);
  assert.ok(Math.abs(get('SPEED').phys - 123.45) < 1e-9);
  assert.equal(get('TEMP').phys, -40);
  assert.equal(get('GEAR').label, 'first');
  assert.equal(get('BCDV').phys, 4321);
  assert.equal(rawToPhys(frame.signals[2], 0xD8), -40);
});

test('mux decode', () => {
  const f = normalizeFrame({
    id: 1, name: 'M', type: 'can', length: 2, signals: {
      SEL: { bits: '1.7-1.0', mux_selector: true },
      A: { bits: '2.7-2.0', mux: { selector: 'SEL', values: [0] } },
      B: { bits: '2.7-2.0', mux: { selector: 'SEL', values: [1] } },
    },
  });
  const d = decodeFrame(f, Uint8Array.from([1, 0x55]));
  assert.equal(d.signals.find((s) => s.name === 'A').active, false);
  assert.equal(d.signals.find((s) => s.name === 'B').active, true);
});

test('strings, bytes and variable length', () => {
  const f = normalizeFrame({
    id: 0x0A4, name: 'TEXT', type: 'can-tp', length: 20, isotp: {}, signals: {
      PAGE: { bits: '1.7-1.4' },
      TXT: { bits: '3.7-n', type: 'str' },
    },
  });
  const payload = Uint8Array.from([0x10, 0x00, ...Array.from('HELLO', (c) => c.charCodeAt(0))]);
  const d = decodeFrame(f, payload);
  assert.equal(d.signals[1].value, 'HELLO');
  const s = decodeSignal(normalizeFrame({ id: 2, name: 'B', type: 'can', length: 4, signals: { R: { bits: '1.7-4.0', type: 'bytes' } } }).signals[0], Uint8Array.from([1, 2, 3, 4]));
  assert.equal(s.value, '01 02 03 04');
  const big = normalizeFrame({ id: 3, name: 'BIG', type: 'can', length: 8, signals: { V: { bits: '1.7-8.0' } } });
  const r = decodeFrame(big, Uint8Array.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]));
  assert.equal(r.signals[0].raw, 0xFFFFFFFFFFFFFFFFn);
  const enc = encodeFrame(big, { V: 0x0102030405060708n });
  assert.deepEqual(Array.from(enc), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('float32 signal', () => {
  const f = normalizeFrame({ id: 4, name: 'F', type: 'can', length: 4, signals: { V: { bits: '1.7-4.0', type: 'float' } } });
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, 3.5, false);
  const d = decodeFrame(f, new Uint8Array(buf.buffer));
  assert.equal(d.signals[0].phys, 3.5);
});

test('little endian signals', async () => {
  const { rangeChunks, msbLsb, extractRange, insertRange, dbcIntelStart, parseBits } = await import('../js/core/bits.js');
  const f = normalizeFrame({
    id: 0x208, name: 'LE', type: 'can', length: 8, signals: {
      SPEED_LE: { bits: '4.7-5.0', byte_order: 'little_endian', factor: 0.01 },
      ODD_LE: { bits: '6.3-7.4', byte_order: 'little_endian' },
      ONE: { bits: '8.7-8.0', byte_order: 'little_endian' },
    },
  });
  assert.equal(f.signals[0].littleEndian, true);
  assert.equal(f.signals[2].littleEndian, false, 'single byte: byte order irrelevant');
  const bytes = Uint8Array.from([0, 0, 0, 0x34, 0x12, 0x0A, 0xB0, 0x55]);
  const d = decodeFrame(f, bytes);
  assert.equal(d.signals[0].raw, 0x1234);
  assert.ok(Math.abs(d.signals[0].phys - 46.6) < 1e-9);
  // ODD_LE: byte 6 bits 3..0 = 0xA (LSBs), byte 7 bits 7..4 = 0xB (MSBs) -> 0xBA
  assert.equal(d.signals[1].raw, 0xBA);
  assert.deepEqual(rangeChunks(40 + 4, 55 - 4, true).map((c) => c.shift), [0, 4]);
  const back = encodeFrame(f, { SPEED_LE: 0x1234, ODD_LE: 0xBA, ONE: 0x55 });
  assert.deepEqual(Array.from(back), [0, 0, 0, 0x34, 0x12, 0x0A, 0xB0, 0x55]);
  const p = parseBits('4.7-5.0');
  assert.deepEqual(msbLsb(p.start, p.end, true), { lsb: 31, msb: 32 });
  assert.equal(dbcIntelStart(p), 24);
  assert.equal(dbcIntelStart(parseBits('6.3-7.4')), null);
  const buf = new Uint8Array(3);
  insertRange(buf, 0, 23, 0x123456, true);
  assert.deepEqual(Array.from(buf), [0x56, 0x34, 0x12]);
  assert.equal(extractRange(buf, 0, 23, true), 0x123456);
});
