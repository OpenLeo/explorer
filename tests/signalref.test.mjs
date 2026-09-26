import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSignalCatalog } from '../js/core/signalref.js';

const sig = (name, extra = {}) => ({ name, unused: false, altNames: [], ...extra });
const frame = (archvar, id, signals, extra = {}) => ({
  uid: `${archvar}/${id}`, archvar, id, idHex: id.toString(16).toUpperCase(), netbus: 'LS.CONF',
  fileBase: id.toString(16).toUpperCase(), signals, ...extra,
});

test('signals are grouped by exact name across different frame IDs and variants', () => {
  const a = frame('AEE2001.full', 0x824, [sig('RPM'), sig('SPEED')]);
  const b = frame('AEE2004.full', 0x0B6, [sig('RPM', { altNames: ['ENGINE_RPM'] }), sig('UNUSED_1', { unused: true })]);
  const db = { variantFrames: new Map([
    ['AEE2001.full', [a]],
    ['AEE2004.full', [b]],
    ['AEE2004.ev', [b]], // inherited effective frame
  ]) };
  const groups = buildSignalCatalog(db);
  const rpm = groups.find((g) => g.name === 'RPM');
  assert.deepEqual(rpm.architectures, ['AEE2001.full', 'AEE2004.ev', 'AEE2004.full']);
  assert.deepEqual(rpm.frameIds, [0x0B6, 0x824]);
  assert.deepEqual(rpm.aliases, ['ENGINE_RPM']);
  assert.equal(rpm.occurrences.length, 3);
  assert.equal(rpm.occurrences.find((o) => o.archvar === 'AEE2004.ev').inherited, true);
  assert.equal(groups.some((g) => g.name === 'UNUSED_1'), false);
});

test('same-name matching is exact and unused fields can be requested', () => {
  const db = { variantFrames: new Map([['A.full', [frame('A.full', 1, [sig('SPEED'), sig('VEHICLE_SPEED'), sig('UNUSED', { unused: true })])]]]) };
  assert.equal(buildSignalCatalog(db).length, 2);
  assert.equal(buildSignalCatalog(db, { includeUnused: true }).length, 3);
});

