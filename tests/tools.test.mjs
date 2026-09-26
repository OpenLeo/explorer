import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, detectFormat, logStats, periodVerdict } from '../js/core/logparse.js';
import { segment, flowControl, parsePci, Reassembler, describeStMin } from '../js/core/isotp.js';
import { computeKey, transform } from '../js/core/seedkey.js';
import { canFrameBits, estimateLoad, vanFrameTs } from '../js/core/busload.js';
import { describeMessage } from '../js/core/diagref.js';
import { bytesToHex } from '../js/core/util.js';

test('candump -L format', () => {
  const t = '(1600000000.100000) can0 036#0E00000000000000\n(1600000000.200000) can0 036#0E00000000000001\n(1600000000.250000) can0 12345678#DEAD\n(1600000000.3) can0 123#R\n';
  assert.equal(detectFormat(t), 'candump-l');
  const { frames, errors } = parseLog(t);
  assert.equal(errors.length, 0);
  assert.equal(frames.length, 4);
  assert.equal(frames[0].id, 0x036);
  assert.equal(frames[0].data.length, 8);
  assert.equal(frames[2].ext, true);
  assert.equal(frames[3].rtr, true);
});

test('candump default and -ta formats', () => {
  const t = '  can0  036   [8]  0E 00 00 00 00 00 00 A0\n (1600000000.123456)  vcan0  0B6   [3]  01 02 03\n  can1  123   [0]  remote request\n';
  assert.equal(detectFormat(t), 'candump');
  const { frames, errors } = parseLog(t);
  assert.equal(errors.length, 0);
  assert.equal(frames.length, 3);
  assert.equal(bytesToHex(frames[0].data), '0E 00 00 00 00 00 00 A0');
  assert.equal(frames[1].ts, 1600000000.123456);
  assert.equal(frames[1].iface, 'vcan0');
  assert.equal(frames[2].rtr, true);
});

test('SavvyCAN CSV (GVRET)', () => {
  const t = 'Time Stamp,ID,Extended,Dir,Bus,LEN,D1,D2,D3,D4,D5,D6,D7,D8\n1000000,00000036,false,Rx,0,8,0E,00,00,00,00,00,00,A0\n1100000,000000B6,false,Rx,0,2,01,02,,,,,,\n';
  assert.equal(detectFormat(t), 'savvycan');
  const { frames } = parseLog(t);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].ts, 1);
  assert.equal(frames[1].id, 0xB6);
  assert.deepEqual(Array.from(frames[1].data), [1, 2]);
});

test('Vector ASC', () => {
  const t = 'date Mon Sep 25 10:00:00 am 2026\nbase hex  timestamps absolute\ninternal events logged\nBegin Triggerblock\n   0.001000 1  36              Rx   d 8 0E 00 00 00 00 00 00 A0  Length = 0 BitCount = 0\n   0.101000 1  18DAF110x       Rx   d 3 02 10 03\nEnd TriggerBlock\n';
  assert.equal(detectFormat(t), 'asc');
  const { frames, errors } = parseLog(t);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].id, 0x36);
  assert.equal(frames[1].ext, true);
  assert.equal(frames[1].id, 0x18DAF110);
});

test('plain ID#DATA and ID DATA lines', () => {
  const { frames, errors } = parseLog('036#0E00\n0x0B6 01 02 03\n# comment\ngarbage line here\n');
  assert.equal(frames.length, 2);
  assert.equal(errors.length, 1);
});

test('log statistics: period and changing bits', () => {
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(`(${(i * 0.1).toFixed(3)}) can0 036#${i % 2 ? '80' : '00'}00`);
  const { frames } = parseLog(lines.join('\n'));
  const st = logStats(frames).get(0x36);
  assert.equal(st.count, 10);
  assert.ok(Math.abs(st.period.mean - 100) < 0.01);
  assert.equal(st.bitChanges[0], 9);
  assert.equal(st.bitChanges[1], 0);
  assert.equal(periodVerdict(st.period.mean, 100), 'ok');
  assert.equal(periodVerdict(50, 100), 'fast');
});

test('ISO-TP single and multi frame', () => {
  const sf = segment([0x22, 0xF1, 0x90]);
  assert.equal(sf.frames.length, 1);
  assert.equal(bytesToHex(sf.frames[0].data), '03 22 F1 90 00 00 00 00');
  const sfp = segment([0x22, 0xF1, 0x90], { padding: 0x55 });
  assert.equal(bytesToHex(sfp.frames[0].data), '03 22 F1 90 55 55 55 55');
  const nopad = segment([0x3E, 0x00], { padding: null });
  assert.equal(bytesToHex(nopad.frames[0].data), '02 3E 00');
  const payload = Array.from({ length: 20 }, (_, i) => i + 1);
  const mf = segment(payload);
  assert.equal(mf.needsFlowControl, true);
  assert.equal(bytesToHex(mf.frames[0].data), '10 14 01 02 03 04 05 06');
  assert.equal(bytesToHex(mf.frames[1].data), '21 07 08 09 0A 0B 0C 0D');
  assert.equal(bytesToHex(mf.frames[2].data), '22 0E 0F 10 11 12 13 14');
  assert.equal(bytesToHex(flowControl({ blockSize: 0, stMin: 10 })), '30 00 0A 00 00 00 00 00');
  const r = new Reassembler();
  let out = null;
  for (const f of mf.frames) out = r.push(f.data) || out;
  assert.deepEqual(Array.from(out), payload);
  // extended addressing
  const ext = segment([0x22, 0xF1, 0x90], { addressing: 'extended', address: 0x40 });
  assert.equal(bytesToHex(ext.frames[0].data), '40 03 22 F1 90 00 00 00');
  assert.equal(parsePci(ext.frames[0].data, { addressing: 'extended' }).length, 3);
  // sequence number wraps after 15
  const big = segment(Array.from({ length: 200 }, (_, i) => i & 0xFF));
  assert.equal(big.frames[16].data[0], 0x20);
  const r2 = new Reassembler();
  let o2 = null;
  for (const f of big.frames) o2 = r2.push(f.data) || o2;
  assert.equal(o2.length, 200);
  // > 4095 bytes escape sequence
  const huge = segment(new Uint8Array(5000));
  assert.equal(bytesToHex(huge.frames[0].data.slice(0, 6)), '10 00 00 00 13 88');
  assert.equal(describeStMin(0xF3), '300 µs');
});

test('PSA seed/key matches the Python reference implementation', () => {
  // vectors generated with PSA-RE/sandbox/uds_auth_algorithm.py (transform/get_key logic)
  const vectors = [
    ['11223344', 'B2B2', '76B559FB'], ['00000000', '0000', '003F2A3F'], ['FFFFFFFF', 'FFFF', '75DB75CF'],
    ['12345678', 'ABCD', '53FF3DEB'], ['DEADBEEF', 'C6E2', '17FF7FBB'], ['0000B200', '1234', '0EDA7EBD'],
    ['80000001', '8000', '6AFD567F'], ['00B20000', '00B2', '763677D0'], ['2265B1F5', '91B7', '55FF7BEF'],
    ['D8F16ADF', 'CD61', '39BF3FDF'], ['C386BBC4', '1027', '7DF573CB'], ['414C343C', '1E2F', '2DEF3BFB'],
    ['7ED4D57B', 'C2CE', '7CDF475D'], ['7311D8A3', '78E5', '3C5F6CBF'], ['A6CECC1B', '612E', '7D5B2FFD'],
    ['C9E9C616', '35BF', '54FF6FDF'], ['18072E8C', '7CE4', '3FFF656F'], ['0741C7A8', 'E4B0', '5ED93FEE'],
    ['D5F4B3B2', '63CA', '79EF7CB5'], ['6EC9D286', '9B81', '7BDF1D7E'], ['C324C985', 'C464', '3FCF7F5F'],
    ['008A05A6', 'B222', '7EE67FB7'], ['7204E52D', '442E', '6EFF3EFD'], ['B8B6D8FE', 'CD44', '35F705FF'],
  ];
  for (const [seed, app, key] of vectors) {
    assert.equal(bytesToHex(computeKey(seed, app), ''), key, `${seed}/${app}`);
  }
  assert.equal(computeKey('1122', 'B2B2'), null);
  assert.equal(computeKey('11 22 33 44', 'b2 b2') !== null, true);
  assert.equal(transform(0, [0xB2, 0x3F, 0xAA]), 0x3F);
});

test('bus load', () => {
  assert.equal(canFrameBits(8, false, false), 111);
  assert.equal(canFrameBits(8, false, true), 111 + 24);
  assert.equal(canFrameBits(0, false, true), 47 + 8);
  assert.ok(vanFrameTs(8) > 100);
  const frames = [{ periodMs: 10, length: 8, type: 'can' }, { periodMs: 100, length: 8, type: 'can' }, { periodMs: null, trigger: true, length: 8, type: 'can' }];
  const r = estimateLoad(frames, { bitrate: 500, protocol: 'CAN' });
  assert.equal(r.rows.length, 2);
  assert.equal(r.ignored.length, 1);
  assert.ok(Math.abs(r.totalBps - 135 * 110) < 1e-6);
  assert.ok(Math.abs(r.load - (135 * 110) / 500000) < 1e-9);
});

test('diag message description', () => {
  assert.match(describeMessage([0x22, 0xF1, 0x90]).text, /ReadDataByIdentifier DID 0xF190 \(VIN\)/);
  assert.match(describeMessage([0x7F, 0x22, 0x31]).text, /requestOutOfRange/);
  assert.match(describeMessage([0x62, 0xF1, 0x90]).text, /Positive response to ReadDataByIdentifier/);
  assert.match(describeMessage([0x27, 0x03]).text, /requestSeed/);
  assert.match(describeMessage([0x21, 0x80], 'KWP2000').text, /ReadDataByLocalIdentifier LID 0x80/);
});
