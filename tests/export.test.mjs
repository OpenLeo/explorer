import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDb, PSA_RE, exists } from './helpers.mjs';
import { exportDbc, exportJson } from '../js/core/dbc.js';
import { genCMeta, genPython, txSnippets, linPid, linChecksum, chunks } from '../js/core/codegen.js';
import { decodeFrame, encodeFrame } from '../js/core/codec.js';
import { resolveRange, extractBits } from '../js/core/bits.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MINI = path.join(here, 'fixtures', 'minirepo');

function hasBin(b) { try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch (e) { return false; } }

test('DBC export structure', () => {
  const db = loadDb([MINI]);
  const frames = db.variantFrames.get('AEE2004.full');
  const { text, skipped } = exportDbc(frames, { lang: 'en', busLabel: 'AEE2004.full HS.IS' });
  assert.match(text, /^VERSION ""/);
  assert.match(text, /BU_: .*BSI/);
  assert.match(text, /BO_ 182 VEHICLE_SPEED: 8 BSI/);
  // ENGINE_RPM 1.7-2.3 -> Motorola start bit 7, 13 bits, factor 0.125
  assert.match(text, / SG_ ENGINE_RPM : 7\|13@0\+ \(0\.125,0\) \[0\|1023\.875\] "rpm" CMM,CMB/);
  assert.match(text, / SG_ TEMP : 39\|8@0- \(1,0\) \[-128\|127\]/);
  assert.match(text, /SG_ PAGE M :/);
  assert.match(text, /SG_ A m0 :/);
  assert.match(text, /VAL_ 182 STATE 0 "off" 1 "on" ;/);
  assert.match(text, /BA_ "GenMsgCycleTime" BO_ 182 50;/);
  assert.match(text, /CM_ SG_ 182 ENGINE_RPM "Engine speed";/);
  assert.ok(!/UNUSED_1/.test(text), 'unused signals skipped by default');
  assert.equal(skipped.length, 0);
  const fr = exportDbc(frames, { lang: 'fr' }).text;
  assert.match(fr, /CM_ SG_ 182 ENGINE_RPM "Regime moteur";/);
  const j = JSON.parse(exportJson(frames));
  assert.equal(j.frames.length, frames.length);
});

test('DBC export of the whole PSA-RE repository', { skip: !exists(PSA_RE) && 'PSA-RE missing' }, () => {
  const db = loadDb([PSA_RE]);
  for (const [key, frames] of db.variantFrames) {
    if (!frames.length) continue;
    const { text } = exportDbc(frames, { busLabel: key });
    // every BO_ line well formed, every SG_ line well formed
    for (const line of text.split('\n')) {
      if (line.startsWith('BO_ ')) assert.match(line, /^BO_ \d+ [A-Za-z_][A-Za-z0-9_]*: \d+ [A-Za-z_][A-Za-z0-9_]*$/, line);
      if (line.startsWith(' SG_ ')) assert.match(line, /^ SG_ [A-Za-z_][A-Za-z0-9_]*( M| m\d+)? : \d+\|\d+@[01][+-] \([-0-9.]+,[-0-9.]+\) \[[-0-9.]+\|[-0-9.]+\] "[^"]*" [A-Za-z_][A-Za-z0-9_,]*$/, line);
    }
  }
});

test('Python snippet and transmit snippets', () => {
  const db = loadDb([MINI]);
  const f = db.framesByKey.get('AEE2004.full/HS.IS/0B6')[0];
  const py = genPython(f);
  assert.match(py, /"ENGINE_RPM": dict\(start=0, length=13/);
  const bytes = Uint8Array.from([0x12, 0x34, 0, 0, 0, 0, 0, 0]);
  const tx = txSnippets(f, bytes, { bitrate: 500 });
  assert.equal(tx[0].code.split('\n')[0], 'cansend can0 0B6#1234000000000000');
  assert.ok(tx.some((t) => /twai_transmit/.test(t.code)));
  assert.ok(tx.some((t) => /CAN_500KBPS/.test(t.code)));
  const lin = db.framesByKey.get('AEE2004.full/LIN.LIN/21')[0];
  assert.ok(/PID\(0x/.test(txSnippets(lin, Uint8Array.from([1, 2]))[0].code));
});

test('LIN protected id and checksum', () => {
  assert.equal(linPid(0x00), 0x80);
  assert.equal(linPid(0x3C), 0x3C);
  assert.equal(linPid(0x3D), 0x7D);
  assert.equal(linPid(0x21), 0x61);
  assert.equal(linChecksum([0x01, 0x02], null), 0xFC);
  assert.equal(linChecksum([0xFF, 0xFF], null), (~(0xFF + 0xFF - 0xFF)) & 0xFF);
});

test('chunks of a Motorola field', () => {
  assert.deepEqual(chunks(3, 12), [{ byte: 0, hi: 4, lo: 0, n: 5, rshift: 5 }, { byte: 1, hi: 7, lo: 3, n: 5, rshift: 0 }]);
});

test('generated C compiles and matches the JS codec', { skip: !hasBin('gcc') && 'gcc not available', timeout: 300000 }, () => {
  const roots = [MINI];
  if (exists(PSA_RE)) roots.push(PSA_RE);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'psa-c-'));
  let rng = 12345;
  const rand = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return (rng >>> 8) & 0xFF; };
  let tested = 0;
  for (const root of roots) {
    const db = loadDb([root]);
    const frames = db.primaryFrames.filter((f) => f.type !== 'can-tp' && f.length > 0 && f.length <= 64 && f.signals.some((s) => s.pos));
    const headers = [];
    const body = [];
    const expected = [];
    frames.forEach((f, fi) => {
      const meta = genCMeta(f, { includeUnused: true, prefix: `F${fi}_${f.name.replace(/[^A-Za-z0-9_]/g, '_')}` });
      const hdr = meta.code;
      const hp = path.join(tmp, `f${fi}.h`);
      fs.writeFileSync(hp, hdr);
      headers.push(`#include "f${fi}.h"`);
      const N = meta.prefix;
      const fields = meta.fields.filter((x) => !x.array).map((x) => ({ name: x.fname, s: x.s, signed: !!x.signed }));
      const sigs = meta.fields.map((x) => x.s);
      for (let k = 0; k < 3; k++) {
        const payload = Uint8Array.from({ length: f.length }, rand);
        body.push(`{ const uint8_t d[] = {${Array.from(payload).join(',')}}; ${N}_t m; uint8_t o[${f.length}]; ${N}_unpack(&m, d); ${N}_pack(&m, o);`);
        for (const fl of fields) body.push(fl.signed ? `  printf("%lld\\n", (long long)m.${fl.name});` : `  printf("%llu\\n", (unsigned long long)m.${fl.name});`);
        body.push(`  for (int i = 0; i < ${f.length}; i++) { printf("%d ", o[i]); }
  printf("\\n"); }`);
        const dec = decodeFrame(f, payload);
        for (const fl of fields) {
          const s = fl.s;
          const d = dec.signals.find((x) => x.sig === s);
          let v = typeof d.raw === 'bigint' ? d.raw.toString() : d.raw;
          if (s.type === 'sint' && s.width < 64) v = Number(d.raw) >= 2 ** (s.width - 1) ? Number(d.raw) - 2 ** s.width : Number(d.raw);
          expected.push(String(v));
        }
        // repacked payload: covered bits kept, others cleared
        const mask = new Uint8Array(f.length);
        for (const s of sigs) {
          const r = resolveRange(s.pos, f.length);
          for (let b = r.start; b <= Math.min(r.end, f.length * 8 - 1); b++) mask[b >> 3] |= 0x80 >> (b & 7);
        }
        expected.push(Array.from(payload, (x, i) => x & mask[i]).join(' ') + ' ');
      }
      tested++;
    });
    const src = `#include <stdio.h>\n${headers.join('\n')}\nint main(void) {\n${body.join('\n')}\nreturn 0; }\n`;
    const cfile = path.join(tmp, 'main.c');
    fs.writeFileSync(cfile, src);
    const exe = path.join(tmp, 'main');
    execFileSync('gcc', ['-std=c99', '-O0', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-o', exe, cfile, `-I${tmp}`], { stdio: 'pipe' });
    const out = execFileSync(exe, { maxBuffer: 1 << 28 }).toString().replace(/\n$/, '').split('\n');
    assert.deepEqual(out, expected);
  }
  assert.ok(tested > 5);
  fs.rmSync(tmp, { recursive: true });
});

test('little endian in DBC (@1 Intel, LSB start bit) and signal receivers', () => {
  const db = loadDb([MINI]);
  const f = db.framesByKey.get('AEE2004.full/HS.IS/0B6')[0];
  const { text } = exportDbc([f]);
  // ODO_LE 7.7-8.0 little endian: LSB = byte 7 bit 0 -> sawtooth 48, @1
  assert.match(text, / SG_ ODO_LE : 48\|16@1\+ \(0\.1,0\) \[0\|6553\.5\] "km" CMB$/m);
});

test('generated Python runs and matches the JS codec', { skip: !hasBin('python3') && 'python3 missing' }, () => {
  const roots = [MINI];
  if (exists(PSA_RE)) roots.push(PSA_RE);
  let rng = 99;
  const rand = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return (rng >>> 8) & 0xFF; };
  for (const root of roots) {
    const db = loadDb([root]);
    const frames = db.primaryFrames.filter((f) => f.type !== 'can-tp' && f.length > 0 && f.signals.some((s) => s.pos && s.type !== 'str' && s.type !== 'bytes'));
    let script = 'import json\nres = []\n';
    const expected = [];
    frames.forEach((f, i) => {
      const payload = Uint8Array.from({ length: f.length }, rand);
      const py = genPython(f, { includeUnused: false }).replace(/def decode\(data: bytes, msg=\w+\)/, `def decode_${i}(data, msg=None)`).replace(/def encode\(values: dict, msg=\w+\)/, `def encode_${i}(values, msg=None)`);
      const name = py.match(/^(\w+) = \{/m)[1];
      script += py.replace(new RegExp(`^${name} = `, 'm'), `M${i} = `).replace(/msg=None\):/g, `msg=M${i}):`) + '\n';
      script += `res.append({k: v[0] for k, v in decode_${i}(bytes.fromhex('${Buffer.from(payload).toString('hex')}')).items()})\n`;
      const dec = decodeFrame(f, payload);
      const exp = {};
      for (const d of dec.signals) {
        if (d.sig.unused || d.raw === null || typeof d.raw === 'bigint' || d.sig.type === 'str' || d.sig.type === 'bytes') continue;
        exp[d.name] = d.raw;
      }
      expected.push(exp);
    });
    script += 'print(json.dumps(res))\n';
    const out = JSON.parse(execFileSync('python3', ['-'], { input: script, maxBuffer: 64 << 20 }).toString());
    out.forEach((o, i) => { for (const [k, v] of Object.entries(expected[i])) assert.equal(o[k], v, `${frames[i].key} ${k}`); });
  }
});
