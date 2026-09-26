import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDb, loadRepo, PSA_RE, exists } from './helpers.mjs';
import {
  buildDatabase, search, framesForCarVersion, diffVariants, sameFrameElsewhere, dtcToRaw, rawToDtc, frameRoute,
} from '../js/core/repo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MINI = path.join(here, 'fixtures', 'minirepo');
const SECOND = path.join(here, 'fixtures', 'second');

test('fixture repository: architectures, nodes, cars, frames', () => {
  const db = loadDb([MINI]);
  assert.ok(db.variants.has('AEE2004.full'));
  assert.ok(db.variants.has('AEE2004.ev'));
  assert.equal(db.variants.get('AEE2004.ev').parent, 'full');
  const buses = db.variantBuses('AEE2004.ev');
  assert.ok(buses.has('HS.IS'), 'ev inherits buses of full');
  const f = db.framesByKey.get('AEE2004.full/HS.IS/0B6')[0];
  assert.equal(f.name, 'VEHICLE_SPEED');
  assert.equal(frameRoute(f), '#/frames/AEE2004.full/HS.IS/0B6');
  const link = db.framesByKey.get('AEE2004.ev/HS.IS/0B6')[0];
  assert.equal(link.symlinkOf, 'buses/AEE2004.full/HS.IS/0B6.yml');
  assert.equal(link.signals.length, f.signals.length);
  // inherited frames: ev gets 6A8 from full, keeps its own 1A8
  const ev = db.variantFrames.get('AEE2004.ev').map((x) => x.key);
  assert.ok(ev.includes('AEE2004.full/HS.IS/6A8'));
  assert.ok(ev.includes('AEE2004.ev/HS.IS/1A8'));
  assert.ok(!ev.includes('AEE2004.full/HS.IS/1A8'));
  // broken yaml is reported, not fatal
  assert.ok(db.issues.some((i) => i.path.endsWith('664.yml') && i.level === 'error'));
  // legacy frame normalized
  const legacy = db.framesByKey.get('AEE2001.full/VAN.CONF/4D4')[0];
  assert.equal(legacy.type, 'van');
  assert.deepEqual(legacy.periodicity, ['100ms']);
  assert.equal(legacy.signals[0].bits, '1.7-1.0');
  assert.ok(legacy.issues.some((i) => /end before/.test(i.msg)));
  // phantom nodes
  const nodes = db.variantNodes.get('AEE2004.full');
  assert.ok(nodes.get('UNKNOWN_ECU').phantom);
  assert.ok(!nodes.get('BSI').phantom);
  // node usage
  const u = db.nodeUsage.get('AEE2004.full').get('BSI');
  assert.ok(u.sends.some((x) => x.id === 0x0B6));
  assert.ok(u.receives.some((x) => x.id === 0x1A8));
  // cars
  const car = db.cars.find((c) => c.project === 'A7');
  const fr = framesForCarVersion(db, car.versions[0]);
  assert.equal(fr.filtered, true);
  assert.ok(fr.frames.every((x) => x.senders.some((s) => ['BSI', 'CMM', 'CMB'].includes(s))));
  assert.ok(db.carsByNode.get('AEE2004.full|CMB')[0].optional);
  // diag
  const e = db.diag.ecus.get('AEE2004.full/BSI');
  assert.equal(e.ecu.addressing[0].request_id, 0x752);
  assert.equal(e.dids[0].ident, 0xF190);
  assert.equal(e.dtcs.length, 2);
  assert.equal(db.diag.protocols.get('UDS').services.length, 2);
});

test('variant diff and cross-architecture comparison', () => {
  const db = loadDb([MINI]);
  const d = diffVariants(db, 'AEE2004.ev');
  assert.equal(d.parent, 'AEE2004.full');
  assert.deepEqual(d.added.map((f) => f.id), [0x2A8]);
  assert.deepEqual(d.changed.map((c) => c.frame.id), [0x1A8]);
  assert.deepEqual(d.same.map((f) => f.id), [0x0B6]);
  const f = db.framesByKey.get('AEE2004.full/HS.IS/1A8')[0];
  const other = sameFrameElsewhere(db, f);
  assert.equal(other.length, 1);
  const sig = other[0].diff.signals;
  assert.equal(sig.find((s) => s.name === 'B').status, 'removed');
  assert.deepEqual(sig.find((s) => s.name === 'A').what, ['scaling']);
  const f0 = db.framesByKey.get('AEE2004.full/HS.IS/0B6')[0];
  assert.equal(sameFrameElsewhere(db, f0)[0].identicalFile, true);
});

test('multiple sources are merged and tagged', () => {
  const db = buildDatabase([loadRepo(MINI, { id: 'main' }), loadRepo(SECOND, { id: 'second' })]);
  const list = db.framesByKey.get('AEE2004.full/LS.CONF/036');
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].sources, ['main', 'second']);
  assert.equal(list[0].source, 'main');
  assert.equal(list[1].source, 'second');
  const only = db.framesByKey.get('AEE2004.full/LS.CONF/0C5')[0];
  assert.deepEqual(only.sources, ['second']);
  assert.equal(db.primaryFrames.filter((f) => f.key === 'AEE2004.full/LS.CONF/036').length, 1);
  const cov = db.variantNodes.get('AEE2004.full').get('COV_P');
  assert.equal(cov.source, 'second');
});

test('search', () => {
  const db = loadDb([MINI]);
  assert.equal(search(db, '0x0B6')[0].frame.id, 0x0B6);
  assert.equal(search(db, '0b6')[0].frame.id, 0x0B6);
  assert.equal(search(db, 'B6')[0].frame.id, 0x0B6);
  assert.equal(search(db, 'BSI')[0].kind, 'ecu');
  assert.ok(search(db, 'engine_rpm').some((r) => r.kind === 'signal'));
  assert.ok(search(db, 'A70').some((r) => r.kind === 'car'));
  assert.ok(search(db, 'B1003').some((r) => r.kind === 'dtc'));
  assert.deepEqual(search(db, ''), []);
});

test('DTC codes', () => {
  assert.equal(dtcToRaw('B1003').raw, 0x9003);
  assert.equal(rawToDtc(0x9003), 'B1003');
  assert.equal(rawToDtc(0xD50A), 'U150A');
  assert.equal(dtcToRaw('P0300-1A').failureType, 0x1A);
  assert.equal(rawToDtc(0x0300, 0x1A), 'P0300-1A');
  assert.equal(dtcToRaw('X1234'), null);
});

test('real PSA-RE repository loads without crashing', { skip: !exists(PSA_RE) && 'PSA-RE not found' }, () => {
  const t = Date.now();
  const db = loadDb([PSA_RE]);
  const ms = Date.now() - t;
  assert.ok(db.frames.length > 50, `frames: ${db.frames.length}`);
  assert.ok(db.cars.length > 50);
  assert.ok(db.variants.has('AEE2004.full'));
  assert.ok(db.variantFrames.get('AEE2004.full').length > 50);
  // every frame normalized with a valid id and type
  for (const f of db.frames) {
    assert.ok(Number.isInteger(f.id), f.path);
    assert.ok(['can', 'can-tp', 'van', 'lin'].includes(f.type), f.path);
    assert.ok(Array.isArray(f.periodicity));
    for (const s of f.signals) assert.equal(typeof s.name, 'string');
  }
  // legacy AEE2001 bus directory mapped to the declared VAN bus
  const van = db.frames.filter((f) => f.arch === 'AEE2001');
  assert.ok(van.length > 0);
  assert.ok(van.every((f) => f.type === 'van'), 'AEE2001 CONF frames are VAN');
  assert.ok(van.every((f) => f.archvar === 'AEE2001.full'));
  assert.ok(van.every((f) => !f.netbus.startsWith('?')), van.map((f) => f.netbus).join(','));
  // well-known frame
  const f036 = db.frames.find((f) => f.archvar === 'AEE2004.full' && f.id === 0x036);
  assert.ok(f036 && f036.signals.length > 10);
  assert.ok(search(db, '036').some((r) => r.frame === f036));
  assert.ok(ms < 3000, `db build took ${ms} ms`);
});


test('identical files without symlink information are detected', () => {
  const src = loadRepo(MINI, { id: 'm' });
  // simulate an HTTP server following symlinks: the link becomes a plain copy
  src.files = src.files.map((f) => (f.link ? { ...f, link: null, data: JSON.parse(JSON.stringify(f.data)) } : f));
  const db = buildDatabase([src]);
  const f = db.framesByKey.get('AEE2004.ev/HS.IS/0B6')[0];
  assert.equal(f.symlinkOf, null);
  assert.equal(f.identicalTo.key, 'AEE2004.full/HS.IS/0B6');
});
