import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDatabase } from '../js/core/repo.js';
import { diagRoleFromName, partnerFrames } from '../js/core/relations.js';

const frame = (id, name, extra = {}) => ({ id, name, type: 'can', length: 8, periodicity: ['trigger'], senders: ['X'], receivers: ['Y'], signals: {}, ...extra });
const file = (bus, idHex, data) => ({ path: `buses/AEE2004.full/${bus}/${idHex}.yml`, data, issues: [] });

function db() {
  const files = [
    { path: 'architectures.yml', data: { AEE2004: { full: { networks: { HS: { IS: { protocol: 'CAN', bitrate: 500 } }, LS: { CONF: { protocol: 'CAN', bitrate: 125 } } } } } }, issues: [] },
    { path: 'diag/AEE2004.full/BSI/ecu.yml', data: { node: 'BSI', protocols: ['UDS'], addressing: [{ transport: 'can-tp', bus: 'LS.CONF', request_id: 0x752, response_id: 0x652 }] }, issues: [] },
    file('LS.CONF', '752', frame(0x752, 'BSI_DIAG_REQUEST')),
    file('LS.CONF', '652', frame(0x652, 'BSI_DIAG_RESPONSE')),
    file('HS.IS', '652', frame(0x652, 'ADAPTIVE_CRUISE_SETPOINT')),
    file('HS.IS', '6B2', frame(0x6B2, 'ON_CAN_DIAG_REQUEST_6B2')),
    file('HS.IS', '692', frame(0x692, 'ON_CAN_DIAG_RESPONSE_692')),
    file('HS.IS', '6B4', frame(0x6B4, 'ON_CAN_DIAG_REQUEST_6B4')),
    file('HS.IS', '694', frame(0x694, 'ON_CAN_DIAG_RESPONSE_694')),
    file('HS.IS', '7DF', frame(0x7DF, 'EOBD_REQUEST_ON_CAN')),
    file('HS.IS', '7E4', frame(0x7E4, 'EOBD_REQUEST_ON_CAN_7E4')),
    file('LS.CONF', '0A4', frame(0x0A4, 'RADIO_TEXT', { type: 'can-tp', isotp: { flow_control_id: 0x09F } })),
    file('LS.CONF', '09F', frame(0x09F, 'RADIO_TEXT_REPLY_FLOW_CONTROL')),
    file('HS.IS', '112', frame(0x112, 'BSI_VERSION')),
    file('HS.IS', '10D', frame(0x10D, 'ABS_IDENT', { signals: { VERSION_DATE_DAY: { bits: '2.7-2.0' } } })),
    file('HS.IS', '036', frame(0x036, 'BSI_COMMANDS')),
  ];
  return buildDatabase([{ meta: { id: 'a', label: 'a', color: '#888' }, files }]);
}

const get = (d, key) => d.framesByKey.get(`AEE2004.full/${key}`)[0];

test('diag role from frame names', () => {
  assert.equal(diagRoleFromName('BSI_DIAG_REQUEST'), 'request');
  assert.equal(diagRoleFromName('ON_CAN_DIAG_RESPONSE_692'), 'response');
  assert.equal(diagRoleFromName('RADIO_RECEIVER_DIAG_FUNCTIONAL_REQUEST'), 'functional');
  assert.equal(diagRoleFromName('BSX_STATUS_REQUEST'), null);
  assert.equal(diagRoleFromName('VEHICLE_SPEED'), null);
});

test('diagnostic ID pairs: addressing data, names, OBD, ISO-TP flow control', () => {
  const d = db();
  const req = get(d, 'LS.CONF/752');
  assert.equal(req.family, 'diag');
  assert.deepEqual(req.pairs.map((p) => [p.role, p.partnerId, p.from]), [['request', 0x652, 'diag']]);
  assert.deepEqual(req.pairs[0].nodes, ['BSI']);
  assert.deepEqual(partnerFrames(d, req, 0x652).map((f) => f.name), ['BSI_DIAG_RESPONSE'], 'same bus partner only');
  assert.deepEqual(get(d, 'LS.CONF/652').pairs.map((p) => [p.role, p.partnerId]), [['response', 0x752]]);
  // same ID on another bus, not a diag frame
  const acc = get(d, 'HS.IS/652');
  assert.equal(acc.family, null);
  assert.deepEqual(acc.pairs, []);
  // homonyms told apart by the usual 0x20 offset
  assert.equal(get(d, 'HS.IS/6B2').pairs[0].partnerId, 0x692);
  assert.equal(get(d, 'HS.IS/6B4').pairs[0].partnerId, 0x694);
  assert.equal(get(d, 'HS.IS/694').pairs[0].partnerId, 0x6B4);
  // OBD (ISO 15765-4)
  assert.equal(get(d, 'HS.IS/7DF').pairs[0].role, 'functional');
  assert.deepEqual(get(d, 'HS.IS/7E4').pairs.map((p) => [p.role, p.partnerId, p.functionalId]), [['request', 0x7EC, 0x7DF]]);
  // ISO-TP data <-> flow control
  assert.deepEqual(get(d, 'LS.CONF/0A4').pairs.map((p) => [p.kind, p.role, p.partnerId]), [['isotp', 'data', 0x09F]]);
  assert.deepEqual(get(d, 'LS.CONF/09F').pairs.map((p) => [p.kind, p.role, p.partnerId]), [['isotp', 'flow-control', 0x0A4]]);
  assert.equal(get(d, 'LS.CONF/09F').family, 'flow-control');
});

test('common frame families', () => {
  const d = db();
  assert.equal(get(d, 'HS.IS/112').family, 'version');
  assert.equal(get(d, 'HS.IS/10D').family, 'version', 'detected from the signal layout');
  assert.equal(get(d, 'HS.IS/036').family, null);
  assert.deepEqual(d.familyFrames.get('AEE2004.full|version').map((f) => f.idHex).sort(), ['10D', '112']);
});
