import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePeriodicity, normalizeType, normalizeSignal, normalizeFrame, applyFrameAlternative, applySignalAlternative,
  normalizeArchitectures, normalizeCar, parseRawKey, activeSignals,
} from '../js/core/normalize.js';
import { ml, toMl, parseHexBytes, esc } from '../js/core/util.js';

test('periodicity normalization', () => {
  assert.deepEqual(normalizePeriodicity(['100ms']).list, ['100ms']);
  assert.deepEqual(normalizePeriodicity(10).list, ['10ms']);
  assert.ok(normalizePeriodicity(10).legacy);
  assert.deepEqual(normalizePeriodicity('trigger').list, ['trigger']);
  assert.deepEqual(normalizePeriodicity('200ms + event based').list, ['200ms', 'trigger']);
  assert.deepEqual(normalizePeriodicity('500 ms + event based').list, ['500ms', 'trigger']);
  assert.deepEqual(normalizePeriodicity('event based').list, ['trigger']);
  assert.deepEqual(normalizePeriodicity(['1000ms', 'trigger']).list, ['1000ms', 'trigger']);
  assert.deepEqual(normalizePeriodicity('request').list, ['request']);
  assert.deepEqual(normalizePeriodicity(undefined).list, []);
  assert.deepEqual(normalizePeriodicity('1s').periods, [1000]);
});

test('type normalization', () => {
  assert.equal(normalizeType('uint8', {}, 8).type, 'uint');
  assert.equal(normalizeType('uint16_t', {}, 16).type, 'uint');
  assert.equal(normalizeType('int16', {}, 16).type, 'sint');
  assert.equal(normalizeType('UINT', {}, 8).type, 'uint');
  assert.equal(normalizeType('float', { factor: 0.01 }, 16).type, 'uint');
  assert.equal(normalizeType('float', { factor: 0.05, signed: true }, 8).type, 'sint');
  assert.equal(normalizeType('float', {}, 32).type, 'float');
  assert.equal(normalizeType('int', { min: -32, factor: 0.25 }, 8).type, 'sint');
  assert.equal(normalizeType('int', { min: -40, offset: -40 }, 8).type, 'uint');
  assert.equal(normalizeType('ASCII', {}, 64).type, 'str');
  assert.equal(normalizeType('SNM16', {}, 16).type, 'uint');
  assert.equal(normalizeType(undefined, { signed: true }, 8).type, 'sint');
  assert.equal(normalizeType('bool', {}, 3).type, 'uint');
});

test('raw keys', () => {
  assert.equal(parseRawKey('10'), 10);
  assert.equal(parseRawKey('0x0A'), 10);
  assert.equal(parseRawKey('0b11'), 3);
  assert.equal(parseRawKey('abc'), null);
});

test('legacy signal fields', () => {
  const s = normalizeSignal('SPEED', { bits: '1.7-2.0', resolution: 0.01, unit: 'km/h', type: 'uint16', signed: false, invalid: 0xFFFF }, 8);
  assert.equal(s.factor, 0.01);
  assert.equal(s.units, 'km/h');
  assert.equal(s.type, 'uint');
  assert.deepEqual(s.invalid, [0xFFFF]);
  assert.ok(s.issues.some((i) => /resolution/.test(i.msg)));
  const e = normalizeSignal('X', { bits: '1.5', values: { 0: { en: 'off', fr: 'arret' }, 1: 'on', 2: { unused: true } } });
  assert.equal(e.type, 'enum');
  assert.equal(e.values.length, 3);
  assert.equal(e.values[1].text.en, 'on');
  assert.equal(e.values[2].unused, true);
  const n = normalizeSignal('Y', { bits: 1.5, resolution: null, units: null });
  assert.equal(n.bits, '1.5');
  assert.equal(n.factor, 1);
  assert.equal(n.units, '');
  const bad = normalizeSignal('Z', 'nope');
  assert.equal(bad.pos, null);
  assert.ok(bad.issues.length);
});

test('frame normalization tolerant', () => {
  const f = normalizeFrame({
    id: 0x8C4, name: 'Radio keyboard events', type: 'VAN', method: 'write (require ack)', periodicity: 'event based', length: 3,
    senders: 'RAD', receivers: ['EMF'], signals: { A: { bits: '1.7' }, B: { bits: '1.7-1.6' } },
  }, { protocol: 'VAN', fileId: 0x8C4 });
  assert.equal(f.type, 'van');
  assert.deepEqual(f.periodicity, ['trigger']);
  assert.deepEqual(f.senders, ['RAD']);
  assert.equal(f.van.access, 'write');
  assert.equal(f.van.ack, true);
  assert.ok(f.issues.some((i) => /overlap/.test(i.msg)));
  assert.ok(f.issues.some((i) => /identifier/.test(i.msg)));
  const g = normalizeFrame(null, { fileId: 0x36 });
  assert.equal(g.id, 0x36);
  const h = normalizeFrame({ id: 0x36, name: 'X', type: 'can', length: 2, signals: { A: { bits: '3.7' } } });
  assert.ok(h.issues.some((i) => /outside/.test(i.msg)));
  const k = normalizeFrame({ id: 0x100, name: 'X', type: 'can', periodicity: 100, signals: { S: { bits: '1.7-1.0' } } }, { fileId: 0x101 });
  assert.equal(k.length, 1, 'length inferred from signals');
  assert.ok(k.issues.some((i) => /does not match/.test(i.msg)));
  assert.deepEqual(k.periodicity, ['100ms']);
});

test('mux signals do not overlap', () => {
  const f = normalizeFrame({
    id: 1, name: 'M', type: 'can', length: 2, periodicity: ['100ms'], senders: ['A'],
    signals: {
      SEL: { bits: '1.7-1.0', mux_selector: true },
      A: { bits: '2.7-2.0', mux: { selector: 'SEL', values: [0] } },
      B: { bits: '2.7-2.0', mux: { selector: 'SEL', values: [1, 2] } },
    },
  });
  assert.ok(!f.issues.some((i) => /overlap/.test(i.msg)));
  assert.equal(f.hasMux, true);
  assert.deepEqual(activeSignals(f.signals, { SEL: 1 }).map((s) => s.name), ['SEL', 'B']);
});

test('alternatives', () => {
  const f = normalizeFrame({
    id: 1, name: 'M', type: 'can', length: 2, periodicity: ['100ms'], senders: ['A'],
    signals: { S: { bits: '1.7-1.0', factor: 1, alternatives: [{ note: { en: 'maybe 0.5' }, factor: 0.5 }] } },
    alternatives: [{ note: { en: 'length 4 on some cars' }, length: 4, periodicity: ['200ms'] }],
  });
  assert.equal(f.hasAlternatives, true);
  const g = applyFrameAlternative(f, 0);
  assert.equal(g.length, 4);
  assert.deepEqual(g.periodicity, ['200ms']);
  const s = applySignalAlternative(f.signals[0], 0, 2);
  assert.equal(s.factor, 0.5);
  assert.equal(s.appliedAlternative.note.en, 'maybe 0.5');
});

test('architectures with TODO variants', () => {
  const a = normalizeArchitectures({ AEE2004: { full: { comment: { en: 'x' }, networks: { HS: { IS: { protocol: 'CAN', bitrate: 500 } } } }, eco: 'TODO' } });
  assert.equal(a.AEE2004.eco.todo, true);
  assert.equal(a.AEE2004.full.networks.HS.IS.bitrate, 500);
});

test('car normalization and brand guess', () => {
  const c = normalizeCar('A7', { codes: { A70: ['peugeot 207', 'peugeot 207+'], A71: 'peugeot 207' }, versions: { all: { architecture: 'AEE2004.full', nodes: { HS: ['BSI'] } } } });
  assert.deepEqual(c.brands, ['peugeot']);
  assert.equal(c.versions[0].nodes.HS[0], 'BSI');
});

test('util helpers', () => {
  assert.equal(ml({ fr: 'bonjour', en: 'hello' }, 'fr'), 'bonjour');
  assert.equal(ml({ fr: 'bonjour', en: 'hello' }, 'de'), 'hello');
  assert.equal(ml({ fr: 'bonjour' }, 'de'), 'bonjour');
  assert.equal(ml({ it: 'ciao' }, 'de'), 'ciao');
  assert.equal(ml({ en: '', fr: 'x' }, 'en'), 'x');
  assert.equal(ml(null), '');
  assert.deepEqual(toMl('x'), { en: 'x' });
  assert.deepEqual(Array.from(parseHexBytes('0E 00 1a')), [0x0E, 0, 0x1A]);
  assert.deepEqual(Array.from(parseHexBytes('0E001A')), [0x0E, 0, 0x1A]);
  assert.deepEqual(Array.from(parseHexBytes('E 0 1A')), [0x0E, 0, 0x1A]);
  assert.equal(parseHexBytes('0E0'), null);
  assert.equal(esc('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});
