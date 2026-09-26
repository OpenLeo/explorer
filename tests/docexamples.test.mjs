// The commented examples of every document type shipped with PSA-RE (dbmuxev/doc/*.yml)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { yaml, PSA_RE, exists } from './helpers.mjs';
import { parseYaml } from '../js/core/yamlparse.js';
import { normalizeFrame, normalizeArchitectures, normalizeNode, normalizeCar } from '../js/core/normalize.js';
import { buildDatabase } from '../js/core/repo.js';
import { decodeFrame, encodeFrame } from '../js/core/codec.js';
import { exportDbc } from '../js/core/dbc.js';
import { genC, genPython } from '../js/core/codegen.js';

const DOC = path.join(PSA_RE, 'dbmuxev', 'doc');
const read = (n) => parseYaml(new Uint8Array(fs.readFileSync(path.join(DOC, n))), yaml);

test('dbmuxev/doc examples normalize cleanly', { skip: !exists(DOC) && 'dbmuxev/doc not found' }, () => {
  for (const fn of fs.readdirSync(DOC).filter((f) => f.startsWith('message_'))) {
    const { data, issues } = read(fn);
    assert.equal(issues.filter((i) => i.level === 'error').length, 0, fn);
    const f = normalizeFrame(data, { protocol: fn.includes('van') ? 'VAN' : fn.includes('lin') ? 'LIN' : 'CAN' });
    const errors = f.issues.filter((i) => i.level === 'error');
    assert.deepEqual(errors, [], fn);
    assert.ok(f.signals.length > 0, fn);
    Object.assign(f, { archvar: 'X.full', netbus: 'A.B', idHex: f.id.toString(16), key: 'k', uid: 'u' });
    const bytes = encodeFrame(f, {}, f.type === 'can-tp' ? 32 : f.length);
    decodeFrame(f, bytes);
    genC(f);
    genPython(f);
    exportDbc([f]);
  }
  const can = normalizeFrame(read('message_can.yml').data);
  const le = can.signals.find((s) => s.name === 'SPEED_LE');
  assert.equal(le.littleEndian, true);
  const arch = normalizeArchitectures(read('architectures.yml').data);
  assert.ok(Object.keys(arch).length > 0);
  const nodes = read('nodes.yml').data;
  for (const [n, d] of Object.entries(nodes)) normalizeNode(n, d);
  normalizeCar('X', read('car.yml').data);
});

test('dbmuxev/doc diag examples load into the database', { skip: !exists(DOC) && 'dbmuxev/doc not found' }, () => {
  const files = [
    ['diag/protocols/UDS.yml', 'diag_protocol.yml'],
    ['diag/AEE2010.full/BSI/ecu.yml', 'diag_ecu.yml'],
    ['diag/AEE2010.full/BSI/dids/F190.yml', 'diag_did.yml'],
    ['diag/AEE2010.full/BSI/lids/80.yml', 'diag_lid.yml'],
    ['diag/AEE2010.full/BSI/dtcs.yml', 'diag_dtc.yml'],
    ['diag/AEE2010.full/BSI/routines/0203.yml', 'diag_routine.yml'],
    ['diag/AEE2010.full/BSI/ioctls/D001.yml', 'diag_ioctl.yml'],
  ].map(([p, fn]) => ({ path: p, ...read(fn) }));
  const db = buildDatabase([{ meta: { id: 'doc', label: 'doc' }, files }]);
  const e = db.diag.ecus.get('AEE2010.full/BSI');
  assert.ok(e && e.ecu, 'ecu.yml');
  assert.ok(e.dids.length === 1 && e.dids[0].params.length > 0);
  assert.ok(e.lids.length === 1);
  assert.ok(e.dtcs.length > 0);
  assert.ok(e.routines.length === 1);
  assert.ok(e.ioctls.length === 1);
  assert.ok(db.diag.protocols.size === 1);
  assert.ok([...db.diag.protocols.values()][0].services.length > 0);
});
