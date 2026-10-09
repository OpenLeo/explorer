// Frame relations: diagnostic / ISO-TP ID pairs (request <-> response, data <-> flow control)
// and "common" frames (generic layouts sent by many ECUs: version, supervision, fault log...).

/** Common frame families, first match wins. */
export const FAMILIES = [
  { id: 'diag', label: 'diag', title: 'Diagnostic transport frame (tester ⇄ ECU, ISO-TP / UDS / KWP / OBD)' },
  { id: 'flow-control', label: 'flow control', title: 'ISO-TP flow control frame of a segmented transfer', re: /(^|_)FLOW_CONTROL(_|$)/ },
  { id: 'version', label: 'version', title: 'ECU identification (software version, date, edition): generic layout sent by every ECU', re: /(^|_)VERSION(_\d+)?$/, sig: /^(SOFTWARE_)?VERSION_(DATE_)?DAY$/ },
  { id: 'supervision', label: 'supervision', title: 'ECU supervision (network management, absent ECUs, diagnostic memory state): generic layout', re: /(^|_)SUPERVISION(_|$)/ },
  { id: 'fault-log', label: 'fault log', title: 'Fault log transfer: generic layout sent by every ECU', re: /(^|_)FAULT_LOG(_|$)/ },
  { id: 'fault-event', label: 'fault event', title: 'Fault event: generic layout sent by many ECUs', re: /(^|_)FAULT_EVENT(_|$)/ },
  { id: 'wakeup', label: 'wake-up', title: 'Network wake-up frame: generic layout sent by every ECU able to wake the bus', re: /^WAKEUP_/ },
  { id: 'vin', label: 'VIN', title: 'Vehicle identification number (WMI / VDS / VIS parts)', re: /^VIN_(WMI|VDS|VIS)(_|$)/ },
];
export const FAMILY_BY_ID = new Map(FAMILIES.map((f) => [f.id, f]));

const DIAG_WORD = /(^|_)(DIAG|DIAGNOSTIC|DIAGNOSTICS|EOBD|OBD|UDS|KWP)(_|$)/;

/** 'request' | 'functional' | 'response' | null, from the frame name only. */
export function diagRoleFromName(name) {
  const n = String(name || '').toUpperCase();
  if (!DIAG_WORD.test(n)) return null;
  if (/(^|_)RESPONSE(_|$)/.test(n)) return 'response';
  if (/(^|_)REQUEST(_|$)/.test(n)) return /(^|_)FUNCTIONAL(_|$)/.test(n) ? 'functional' : 'request';
  return null;
}

/** Name without the "_<ID>" suffix used to tell homonyms apart (ON_CAN_DIAG_REQUEST_6B2). */
function baseName(name) { return String(name || '').toUpperCase().replace(/_[0-9A-F]{2,3}$/, ''); }

function counterpartName(name) {
  const b = baseName(name);
  if (/(^|_)RESPONSE(_|$)/.test(b)) return b.replace(/(^|_)RESPONSE(_|$)/, '$1REQUEST$2');
  return b.replace(/(^|_)(FUNCTIONAL_)?REQUEST(_|$)/, '$1RESPONSE$3');
}

// usual request/response ID offsets: 0x752/0x652 (PSA), 0x6B2/0x692 (on-CAN gateway), 0x7E4/0x7EC (OBD)
const PAIR_DELTAS = [0x100, 0x20, 0x8, 0x80, 0x40, 0x10];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Addressing rows of every ECU: diag/<archvar>/<node>/ecu.yml first, then the nodes' diag blocks. */
export function addressingIndex(db) {
  const rows = [];
  for (const e of (db.diag && db.diag.ecus.values()) || []) {
    if (!e || !e.ecu) continue;
    for (const a of e.ecu.addressing || []) {
      if (!a) continue;
      rows.push({ archvar: e.archvar, node: e.node, bus: a.bus || '', protocol: a.protocol || (e.ecu.protocols || [])[0] || '', req: a.request_id, res: a.response_id, func: a.functional_id, from: 'diag' });
    }
  }
  for (const [key, m] of db.nodes || []) {
    for (const nd of m.values()) {
      const d = nd && nd.diag;
      if (!d) continue;
      const protocols = Array.isArray(d.protocols) ? d.protocols : d.protocols ? [d.protocols] : [];
      if (isNum(d.request_id) || isNum(d.response_id)) rows.push({ archvar: key, node: nd.name, bus: d.bus || '', protocol: protocols[0] || '', req: d.request_id, res: d.response_id, func: null, from: 'nodes' });
      if (isNum(d.obd_request_id) || isNum(d.obd_response_id)) rows.push({ archvar: key, node: nd.name, bus: d.bus || '', protocol: 'EOBD', req: d.obd_request_id, res: d.obd_response_id, func: null, from: 'nodes' });
    }
  }
  const byId = new Map();
  const add = (id, row, role) => {
    if (!isNum(id)) return;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ row, role });
  };
  for (const r of rows) { add(r.req, r, 'request'); add(r.res, r, 'response'); add(r.func, r, 'functional'); }
  return byId;
}

function busMatches(rowBus, f) { return !rowBus || rowBus === f.netbus || rowBus === f.bus; }

/** Diagnostic pairs documented in the addressing data for a frame (same variant first, then same architecture). */
function addressingPairs(index, f) {
  const hits = index.get(f.id) || [];
  const scope = (pred) => hits.filter(({ row }) => pred(row) && busMatches(row.bus, f));
  let list = scope((r) => r.archvar === f.archvar);
  if (!list.length) list = scope((r) => r.archvar.split('.')[0] === f.arch);
  const out = new Map();
  for (const { row, role } of list) {
    const partner = role === 'response' ? row.req : row.res;
    const k = `${role}|${partner}`;
    if (!out.has(k)) out.set(k, { kind: 'diag', role, partnerId: isNum(partner) ? partner : null, functionalId: role === 'functional' ? null : (isNum(row.func) ? row.func : null), nodes: [], protocols: [], from: row.from, explicitBus: !!row.bus && row.archvar === f.archvar });
    const p = out.get(k);
    if (!p.nodes.includes(row.node)) p.nodes.push(row.node);
    if (row.protocol && !p.protocols.includes(row.protocol)) p.protocols.push(row.protocol);
    if (row.from === 'diag') p.from = 'diag';
    if (row.bus && row.archvar === f.archvar) p.explicitBus = true;
  }
  return [...out.values()];
}

/** OBD on CAN (ISO 15765-4): 0x7DF functional, 0x7E0-0x7E7 physical requests answered on ID + 8. */
function obdPair(f) {
  if (f.extended) {
    if (f.id === 0x18DB33F1) return { kind: 'diag', role: 'functional', partnerId: null, functionalId: null, nodes: [], protocols: ['EOBD'], from: 'standard' };
    return null;
  }
  if (!/(^|_)(EOBD|OBD)(_|$)/.test(String(f.name || '').toUpperCase())) return null;
  const base = { kind: 'diag', functionalId: 0x7DF, nodes: [], protocols: ['EOBD'], from: 'standard' };
  if (f.id === 0x7DF) return { ...base, role: 'functional', partnerId: null, functionalId: null };
  if (f.id >= 0x7E0 && f.id <= 0x7E7) return { ...base, role: 'request', partnerId: f.id + 8 };
  if (f.id >= 0x7E8 && f.id <= 0x7EF) return { ...base, role: 'response', partnerId: f.id - 8 };
  return null;
}

/** Guess the counterpart of a diag request/response from the frame names on the same bus. */
function namePair(f, role, busFrames) {
  const want = counterpartName(f.name);
  const wantRole = role === 'response' ? ['request', 'functional'] : ['response'];
  const cands = busFrames.filter((o) => o !== f && o.id !== f.id && baseName(o.name) === want && wantRole.includes(diagRoleFromName(o.name)));
  let pick = null;
  if (cands.length === 1) pick = cands[0];
  else if (cands.length > 1) {
    for (const d of PAIR_DELTAS) {
      pick = cands.find((o) => Math.abs(o.id - f.id) === d);
      if (pick) break;
    }
  }
  if (!pick && role !== 'functional') {
    // no homonym: try the usual offsets with any diag frame of the opposite role
    for (const d of PAIR_DELTAS) {
      const c = busFrames.filter((o) => Math.abs(o.id - f.id) === d && wantRole.includes(diagRoleFromName(o.name)));
      if (c.length === 1) { pick = c[0]; break; }
    }
  }
  if (!pick) return null;
  return { kind: 'diag', role, partnerId: pick.id, functionalId: null, nodes: [], protocols: [], from: 'name' };
}

/**
 * Annotate every frame with:
 *   f.family: family id (FAMILIES) or null
 *   f.pairs:  [{kind: 'diag', role, partnerId, functionalId, nodes, protocols, from}
 *              | {kind: 'isotp', role: 'data' | 'flow-control', partnerId, from}]
 * and build db.familyFrames: Map('<archvar>|<family>' -> frames of the variant's effective set).
 */
export function annotateRelations(db) {
  const index = addressingIndex(db);
  const busFramesCache = new Map();
  const busFrames = (f) => {
    const k = `${f.archvar}|${f.netbus}`;
    if (!busFramesCache.has(k)) busFramesCache.set(k, (db.variantFrames.get(f.archvar) || []).filter((o) => o.netbus === f.netbus));
    return busFramesCache.get(k);
  };
  // ISO-TP flow control IDs declared by data frames: '<archvar>|<netbus>|<fc id>' -> data frames
  const fcOf = new Map();
  for (const f of db.frames) {
    const fc = f.isotp && f.isotp.flow_control_id;
    if (!isNum(fc)) continue;
    const k = `${f.archvar}|${f.netbus}|${fc}`;
    if (!fcOf.has(k)) fcOf.set(k, []);
    if (!fcOf.get(k).some((o) => o.id === f.id)) fcOf.get(k).push(f);
  }
  for (const f of db.frames) {
    const onCan = f.type === 'can' || f.type === 'can-tp';
    const obd = onCan ? obdPair(f) : null;
    const nameRole = obd ? obd.role : diagRoleFromName(f.name);
    // an ID listed in the addressing data is only taken as a diag frame when its name says so, or when the
    // addressing entry names this very bus (other frames may reuse the ID on another bus)
    const pairs = onCan ? addressingPairs(index, f).filter((p) => nameRole || p.explicitBus) : [];
    const fc = f.isotp && f.isotp.flow_control_id;
    if (!pairs.length && obd) pairs.push(obd);
    if (!pairs.length && nameRole) {
      if (isNum(fc)) pairs.push({ kind: 'diag', role: nameRole, partnerId: fc, functionalId: null, nodes: [], protocols: [], from: 'isotp' });
      else { const p = namePair(f, nameRole, busFrames(f)); if (p) pairs.push(p); }
      if (!pairs.length) pairs.push({ kind: 'diag', role: nameRole, partnerId: null, functionalId: null, nodes: [], protocols: [], from: 'name' });
    }
    if (isNum(fc) && !pairs.some((p) => p.partnerId === fc)) pairs.push({ kind: 'isotp', role: 'data', partnerId: fc, from: 'isotp' });
    for (const o of fcOf.get(`${f.archvar}|${f.netbus}|${f.id}`) || []) {
      if (o.id !== f.id && !pairs.some((p) => p.partnerId === o.id)) pairs.push({ kind: 'isotp', role: 'flow-control', partnerId: o.id, from: 'isotp' });
    }
    f.pairs = pairs;
    f.family = frameFamily(f);
  }
  db.familyFrames = new Map();
  for (const [key, frames] of db.variantFrames) {
    for (const f of frames) {
      if (!f.family) continue;
      const k = `${key}|${f.family}`;
      if (!db.familyFrames.has(k)) db.familyFrames.set(k, []);
      db.familyFrames.get(k).push(f);
    }
  }
}

/** Family id of a frame (call after f.pairs is set). */
export function frameFamily(f) {
  const name = String(f.name || '').toUpperCase();
  if (diagRoleFromName(name) || (f.pairs || []).some((p) => p.kind === 'diag')) return 'diag';
  for (const fam of FAMILIES) {
    if (fam.re && fam.re.test(name)) return fam.id;
    if (fam.sig && (f.signals || []).some((s) => fam.sig.test(String(s.name).toUpperCase()))) return fam.id;
  }
  return null;
}

/** Frames with a given ID in a variant's effective set (only those of the same bus when there are some). */
export function partnerFrames(db, f, id, archvar) {
  if (!isNum(id)) return [];
  const list = (db.variantFrames.get(archvar || f.archvar) || []).filter((o) => o.id === id && o !== f);
  const sameBus = list.filter((o) => o.netbus === f.netbus);
  return sameBus.length ? sameBus : list;
}
