// Builds the in-memory database from one or several parsed sources.
//
// A parsed source is { meta: {id, label, color, ...}, files: [{path, data, issues, link}] }
// where `link` is the resolved target path when the file is a symlink (data is then the target's data).

import { classify, basename } from './paths.js';
import {
  normalizeFrame, normalizeArchitectures, normalizeNode, normalizeCar, normalizeSignals, normalizeValues, parseRawKey,
} from './normalize.js';
import { isObj, toMl, asArray, parseIntLoose, naturalCompare, ml, hex } from './util.js';

/** Pseudo nodes used in senders/receivers that are not real ECUs. */
export const PSEUDO_NODES = {
  DIAG_TOOL: 'External diagnostic tester (plugged on the diagnostic socket)',
  IMMO_CLIENT: 'Any immobilised ECU (engine ECU, gearbox…) taking part in the immobiliser exchange',
};

export function frameRoute(f) { return `#/frames/${f.archvar}/${f.netbus}/${f.fileBase}`; }
export function idHex(f) {
  if (f.id < 0) return '???';
  const w = f.type === 'lin' ? 2 : f.extended ? 8 : 3;
  return hex(f.id, w);
}

function issue(db, source, path, level, msg, where) {
  db.issues.push({ source, path, level, msg, where: where || '' });
}

function newVariant(arch, variant, pseudo) {
  return {
    arch, variant, key: `${arch}.${variant}`, comment: null, displayName: null, parent: null, years: null,
    status: null, todo: false, networks: {}, protocols: [], pseudo: !!pseudo, sources: [],
  };
}

/** Parse "DTC" strings: B1003 <-> 0x9003 */
export function dtcToRaw(code) {
  const m = /^([PCBU])([0-3])([0-9A-F]{3})(?:-([0-9A-F]{2}))?$/i.exec(String(code).trim());
  if (!m) return null;
  const letter = 'PCBU'.indexOf(m[1].toUpperCase());
  const v = (letter << 14) | (parseInt(m[2], 10) << 12) | parseInt(m[3], 16);
  return { raw: v, failureType: m[4] ? parseInt(m[4], 16) : null };
}

export function rawToDtc(raw, failureType = null) {
  const v = raw & 0xFFFF;
  const letter = 'PCBU'[(v >> 14) & 3];
  const d1 = (v >> 12) & 3;
  const rest = (v & 0xFFF).toString(16).toUpperCase().padStart(3, '0');
  return `${letter}${d1}${rest}` + (failureType !== null && failureType !== undefined ? '-' + (failureType & 0xFF).toString(16).toUpperCase().padStart(2, '0') : '');
}

function normalizeProtocol(name, d) {
  const services = [];
  if (isObj(d.services)) {
    for (const [k, s] of Object.entries(d.services)) {
      const sid = parseRawKey(k);
      if (sid === null) continue;
      const sd = isObj(s) ? s : {};
      services.push({
        sid, name: sd.name ? String(sd.name) : `SERVICE_${hex(sid, 2)}`,
        displayName: toMl(sd.display_name), comment: toMl(sd.comment),
        request: sd.request ? String(sd.request) : '', response: sd.response ? String(sd.response) : '',
        subfunctions: normalizeValues(sd.subfunctions, [], ''),
      });
    }
  }
  services.sort((a, b) => a.sid - b.sid);
  const algorithms = [];
  if (isObj(d.algorithms)) {
    for (const [an, a] of Object.entries(d.algorithms)) algorithms.push({ name: an, comment: toMl(isObj(a) ? a.comment : null), pseudocode: isObj(a) && a.pseudocode ? String(a.pseudocode) : '' });
  }
  return {
    name, protocol: d.protocol ? String(d.protocol) : name, standard: d.standard ? String(d.standard) : '',
    comment: toMl(d.comment), transport: asArray(d.transport).map(String),
    services, nrcs: normalizeValues(d.negative_responses, [], ''), algorithms,
  };
}

function normalizeDiagData(d, kind) {
  const issues = [];
  const length = d.length === null ? null : parseIntLoose(d.length);
  const ident = kind === 'lid' ? parseIntLoose(d.lid) : kind === 'did' ? parseIntLoose(d.did) : kind === 'routine' ? parseIntLoose(d.routine) : parseIntLoose(d.ioctl);
  return {
    kind, ident: ident ?? -1, name: d.name ? String(d.name) : 'UNNAMED',
    displayName: toMl(d.display_name), comment: toMl(d.comment),
    dataKind: d.kind ? String(d.kind) : null, access: d.access ? String(d.access) : null,
    session: parseIntLoose(d.session), securityLevel: parseIntLoose(d.security_level),
    length: length ?? null, variants: asArray(d.variants).map(String),
    params: normalizeSignals(d.params, length || undefined, issues),
    results: normalizeSignals(d.results, undefined, issues),
    returnValues: normalizeValues(d.return_values, issues, ''),
    control: asArray(d.control).map(String),
    issues,
  };
}

function normalizeDiagEcu(d) {
  const addressing = asArray(d.addressing).filter(isObj).map((a) => ({
    transport: a.transport ? String(a.transport) : 'can-tp', bus: a.bus ? String(a.bus) : '',
    request_id: parseIntLoose(a.request_id), response_id: parseIntLoose(a.response_id),
    functional_id: parseIntLoose(a.functional_id), kline_address: parseIntLoose(a.kline_address),
    kline_init: a.kline_init || null, bitrate: a.bitrate ?? null, protocol: a.protocol || null, comment: toMl(a.comment),
  }));
  const tbl = (o) => {
    const out = [];
    if (isObj(o)) for (const [k, v] of Object.entries(o)) { const n = parseRawKey(k); if (n !== null) out.push({ raw: n, text: toMl(v) }); }
    return out.sort((a, b) => a.raw - b.raw);
  };
  return {
    node: d.node ? String(d.node) : null, comment: toMl(d.comment), protocols: asArray(d.protocols).map(String),
    addressing, sessions: tbl(d.sessions), resets: tbl(d.resets),
    services: asArray(d.services).map((x) => parseIntLoose(x)).filter((x) => x !== null),
    security: asArray(d.security_access).filter(isObj).map((s) => ({ level: parseIntLoose(s.level), algorithm: s.algorithm ? String(s.algorithm) : null, key: s.key ? String(s.key) : null, comment: toMl(s.comment) })),
    testerPresent: isObj(d.tester_present) ? { request: d.tester_present.request || '', period: d.tester_present.period_ms ?? null } : null,
  };
}

/**
 * Build the database.
 * @param {Array} sources parsed sources, the first one has priority
 */
export function buildDatabase(sources) {
  const db = {
    sources: sources.map((s) => s.meta),
    sourceById: new Map(sources.map((s) => [s.meta.id, s.meta])),
    archs: {},
    variants: new Map(),
    nodes: new Map(),
    cars: [],
    frames: [],
    framesByKey: new Map(),
    primaryFrames: [],
    variantFrames: new Map(),
    inherited: new Map(),
    nodeUsage: new Map(),
    busDocs: new Map(),
    diag: { protocols: new Map(), ecus: new Map(), dtcIndex: [] },
    issues: [],
    fileCount: 0,
  };

  // 1. architectures
  for (const src of sources) {
    for (const f of src.files) {
      if (f.path !== 'architectures.yml' && f.path !== 'architectures.yaml') continue;
      db.fileCount++;
      for (const it of f.issues || []) issue(db, src.meta.id, f.path, it.level, it.msg, it.line ? `line ${it.line}` : '');
      if (!f.data) continue;
      const iss = [];
      const archs = normalizeArchitectures(f.data, iss);
      for (const it of iss) issue(db, src.meta.id, f.path, it.level, it.msg, it.where);
      for (const [arch, variants] of Object.entries(archs)) {
        if (!db.archs[arch]) db.archs[arch] = {};
        for (const [vn, v] of Object.entries(variants)) {
          const cur = db.archs[arch][vn];
          if (!cur) { v.sources = [src.meta.id]; db.archs[arch][vn] = v; }
          else {
            cur.sources.push(src.meta.id);
            // merge networks/buses defined only in later sources
            for (const [net, buses] of Object.entries(v.networks)) {
              if (!cur.networks[net]) cur.networks[net] = {};
              for (const [b, bd] of Object.entries(buses)) if (!cur.networks[net][b]) cur.networks[net][b] = bd;
            }
            if (cur.todo && !v.todo) Object.assign(cur, { ...v, sources: cur.sources });
          }
        }
      }
    }
  }
  const ensureVariant = (key) => {
    if (db.variants.has(key)) return db.variants.get(key);
    const [arch, variant = 'full'] = key.split('.');
    if (!db.archs[arch]) db.archs[arch] = {};
    if (!db.archs[arch][variant]) db.archs[arch][variant] = newVariant(arch, variant, true);
    const v = db.archs[arch][variant];
    db.variants.set(`${arch}.${variant}`, v);
    return v;
  };
  for (const [arch, variants] of Object.entries(db.archs)) for (const [vn, v] of Object.entries(variants)) db.variants.set(`${arch}.${vn}`, v);

  const parentKey = (key) => {
    const v = db.variants.get(key);
    if (!v || !v.parent) return null;
    const pk = `${v.arch}.${v.parent}`;
    return db.variants.has(pk) ? pk : null;
  };
  db.parentKey = parentKey;

  /** buses of a variant, following parents: [{netbus, net, bus, protocol, bitrate, ...}] */
  const busCache = new Map();
  const variantBuses = (key) => {
    if (busCache.has(key)) return busCache.get(key);
    const out = new Map();
    const seen = new Set();
    let k = key;
    while (k && !seen.has(k)) {
      seen.add(k);
      const v = db.variants.get(k);
      if (!v) break;
      for (const [net, buses] of Object.entries(v.networks || {})) {
        for (const [b, bd] of Object.entries(buses)) if (!out.has(`${net}.${b}`)) out.set(`${net}.${b}`, { ...bd, inheritedFrom: k === key ? null : k });
      }
      k = parentKey(k);
    }
    busCache.set(key, out);
    return out;
  };
  db.variantBuses = variantBuses;

  const mapArchDir = (dir, src, path) => {
    if (dir.includes('.')) {
      if (!db.variants.has(dir)) issue(db, src, path, 'warning', `architecture variant '${dir}' not defined in architectures.yml`);
      ensureVariant(dir);
      return dir;
    }
    const arch = db.archs[dir];
    let variant = 'full';
    if (arch && !arch.full) variant = Object.keys(arch)[0] || 'full';
    const key = `${dir}.${variant}`;
    ensureVariant(key);
    return key;
  };
  const mapBusDir = (archvar, dir) => {
    if (dir.includes('.')) return dir;
    const buses = variantBuses(archvar);
    for (const nb of buses.keys()) if (nb.split('.')[1] === dir) return nb;
    for (const nb of buses.keys()) if (nb.split('.')[0] === dir) return nb;
    return `?.${dir}`;
  };

  // 2. nodes, cars, frames, diag
  const legacyWarned = new Set();
  for (const src of sources) {
    const sid = src.meta.id;
    for (const f of src.files) {
      const c = classify(f.path);
      if (!c || c.kind === 'architectures') continue;
      db.fileCount++;
      const fileIssues = f.issues || [];
      if (c.kind !== 'frame') for (const it of fileIssues) issue(db, sid, f.path, it.level, it.msg, it.line ? `line ${it.line}` : '');
      if (c.kind === 'busdoc') {
        const archvar = mapArchDir(c.archDir, sid, f.path);
        const nb = mapBusDir(archvar, c.busDir);
        const k = `${archvar}/${nb}`;
        if (!db.busDocs.has(k)) db.busDocs.set(k, []);
        if (typeof f.text === 'string') db.busDocs.get(k).push({ name: c.file, text: f.text, source: sid });
        continue;
      }
      if (c.kind === 'nodes') {
        if (!isObj(f.data)) { if (f.data !== null) issue(db, sid, f.path, 'error', 'nodes file must be a mapping'); continue; }
        if (!db.variants.has(c.archvar)) issue(db, sid, f.path, 'warning', `architecture variant '${c.archvar}' not defined in architectures.yml`);
        ensureVariant(c.archvar);
        if (!db.nodes.has(c.archvar)) db.nodes.set(c.archvar, new Map());
        const m = db.nodes.get(c.archvar);
        for (const [name, nd] of Object.entries(f.data)) {
          const n = normalizeNode(name, nd);
          n.archvar = c.archvar;
          if (m.has(name)) { m.get(name).sources.push(sid); continue; }
          n.source = sid; n.sources = [sid];
          m.set(name, n);
        }
        continue;
      }
      if (c.kind === 'car') {
        if (!isObj(f.data)) continue;
        if (db.cars.some((x) => x.project === c.project)) { db.cars.find((x) => x.project === c.project).sources.push(sid); continue; }
        const car = normalizeCar(c.project, f.data);
        car.source = sid; car.sources = [sid]; car.path = f.path;
        for (const it of car.issues) issue(db, sid, f.path, it.level, it.msg, it.where);
        db.cars.push(car);
        continue;
      }
      if (c.kind === 'frame') {
        const archvar = mapArchDir(c.archDir, sid, f.path);
        const netbus = mapBusDir(archvar, c.busDir);
        if (!c.archDir.includes('.') || !c.busDir.includes('.')) {
          const lk = `${sid}|${c.archDir}/${c.busDir}`;
          if (!legacyWarned.has(lk)) {
            legacyWarned.add(lk);
            issue(db, sid, `buses/${c.archDir}/${c.busDir}`, 'warning', `legacy directory name, expected buses/${archvar}/${netbus}/`);
          }
        }
        const busInfo = variantBuses(archvar).get(netbus);
        if (!busInfo) {
          // bus not declared: add a pseudo bus so it is displayed
          const v = ensureVariant(archvar);
          const [net, bus] = netbus.split('.');
          if (!v.networks[net]) v.networks[net] = {};
          if (!v.networks[net][bus]) {
            v.networks[net][bus] = { net, bus, netbus, protocol: '', bitrate: null, displayName: null, comment: null, undeclared: true };
            busCache.clear();
            issue(db, sid, f.path, 'warning', `bus '${netbus}' not defined in ${archvar}`);
          }
        }
        if (f.data === null || f.data === undefined) {
          for (const it of fileIssues) issue(db, sid, f.path, it.level, it.msg, it.line ? `line ${it.line}` : '');
          continue;
        }
        const protocol = (variantBuses(archvar).get(netbus) || {}).protocol || '';
        const fr = normalizeFrame(f.data, { protocol, fileId: c.fileId, path: f.path });
        if (c.badName) fr.issues.push({ level: 'warning', msg: 'file name must be <ID in uppercase hex>.yml or <ID>_<SUFFIX>.yml', where: '' });
        fr.issues.unshift(...fileIssues.map((it) => ({ level: it.level, msg: it.msg, where: it.line ? `line ${it.line}` : '' })));
        Object.assign(fr, {
          key: `${archvar}/${netbus}/${c.fileBase}`,
          source: sid,
          path: f.path,
          symlinkOf: f.link || null,
          archvar, arch: archvar.split('.')[0], variant: archvar.split('.')[1],
          netbus, net: netbus.split('.')[0], bus: netbus.split('.')[1],
          fileBase: c.fileBase, suffix: c.suffix,
        });
        fr.uid = `${fr.key}@${sid}`;
        fr.idHex = idHex(fr);
        fr.warnCount = fr.issues.filter((i) => i.level === 'warning' || i.level === 'error').length;
        fr.errCount = fr.issues.filter((i) => i.level === 'error').length;
        if (!f.link) for (const it of fr.issues) if (it.level !== 'info') issue(db, sid, f.path, it.level, it.msg, it.where);
        db.frames.push(fr);
        continue;
      }
      if (c.kind.startsWith('diag_')) {
        if (!isObj(f.data)) continue;
        if (c.kind === 'diag_protocol') {
          if (!db.diag.protocols.has(c.name)) db.diag.protocols.set(c.name, { ...normalizeProtocol(c.name, f.data), source: sid });
          continue;
        }
        const k = `${c.archvar}/${c.node}`;
        if (!db.diag.ecus.has(k)) db.diag.ecus.set(k, { archvar: c.archvar, node: c.node, ecu: null, dids: [], lids: [], dtcs: [], routines: [], ioctls: [], source: sid });
        const e = db.diag.ecus.get(k);
        if (c.kind === 'diag_ecu') { if (!e.ecu) e.ecu = normalizeDiagEcu(f.data); }
        else if (c.kind === 'diag_dtcs') {
          for (const [code, v] of Object.entries(f.data)) {
            const vd = isObj(v) ? v : { display_name: v };
            const r = dtcToRaw(code);
            const dtc = {
              code, raw: vd.raw ? parseInt(String(vd.raw), 16) : (r ? r.raw : null), displayName: toMl(vd.display_name),
              comment: toMl(vd.comment), clues: toMl(vd.clues), variants: asArray(vd.variants).map(String),
              archvar: c.archvar, node: c.node, source: sid,
            };
            e.dtcs.push(dtc);
            db.diag.dtcIndex.push(dtc);
          }
        } else {
          const kind = { diag_did: 'did', diag_lid: 'lid', diag_routine: 'routine', diag_ioctl: 'ioctl' }[c.kind];
          const item = normalizeDiagData(f.data, kind);
          item.path = f.path; item.source = sid; item.archvar = c.archvar; item.node = c.node;
          const list = { did: e.dids, lid: e.lids, routine: e.routines, ioctl: e.ioctls }[kind];
          if (!list.some((x) => x.ident === item.ident)) list.push(item);
        }
      }
    }
  }
  for (const e of db.diag.ecus.values()) for (const l of [e.dids, e.lids, e.routines, e.ioctls]) l.sort((a, b) => a.ident - b.ident);

  // 3. frames by key, primary frames, sources per key
  const order = new Map(sources.map((s, i) => [s.meta.id, i]));
  for (const f of db.frames) {
    if (!db.framesByKey.has(f.key)) db.framesByKey.set(f.key, []);
    db.framesByKey.get(f.key).push(f);
  }
  for (const list of db.framesByKey.values()) {
    list.sort((a, b) => order.get(a.source) - order.get(b.source));
    const srcs = list.map((x) => x.source);
    for (const f of list) f.sources = srcs;
    db.primaryFrames.push(list[0]);
  }
  db.primaryFrames.sort((a, b) => naturalCompare(a.archvar, b.archvar) || naturalCompare(a.netbus, b.netbus) || a.id - b.id || naturalCompare(a.fileBase, b.fileBase));
  db.framesByPath = new Map(db.frames.map((f) => [`${f.source}|${f.path}`, f]));
  // identical frame files in several places (symlinks followed by an HTTP server / local folder)
  const byContent = new Map();
  for (const f of db.primaryFrames) {
    if (f.symlinkOf) continue;
    let k;
    try { k = `${f.source}|${JSON.stringify(f.raw)}`; } catch (e) { continue; }
    if (!byContent.has(k)) byContent.set(k, []);
    byContent.get(k).push(f);
  }
  for (const group of byContent.values()) {
    if (group.length < 2) continue;
    const dep = (f) => { let d = 0; let p = parentKey(f.archvar); while (p && d < 20) { d++; p = parentKey(p); } return d; };
    group.sort((a, b) => dep(a) - dep(b) || (a.variant === 'full' ? 0 : 1) - (b.variant === 'full' ? 0 : 1) || naturalCompare(a.archvar, b.archvar) || naturalCompare(a.key, b.key));
    for (const f of group.slice(1)) f.identicalTo = group[0];
  }
  db.framesById = new Map();
  for (const f of db.primaryFrames) {
    if (!db.framesById.has(f.id)) db.framesById.set(f.id, []);
    db.framesById.get(f.id).push(f);
  }

  // 4. variant frames (own + inherited from parents)
  const own = new Map();
  for (const f of db.primaryFrames) {
    if (!own.has(f.archvar)) own.set(f.archvar, []);
    own.get(f.archvar).push(f);
  }
  db.ownFrames = own;
  const depth = (k) => { let d = 0; let p = parentKey(k); const seen = new Set([k]); while (p && !seen.has(p) && d < 20) { seen.add(p); d++; p = parentKey(p); } return d; };
  const orderedKeys = [...db.variants.keys()].sort((a, b) => depth(a) - depth(b));
  for (const key of orderedKeys) {
    const list = [...(own.get(key) || [])];
    const inh = new Set();
    const have = new Set(list.map((f) => `${f.netbus}/${f.fileBase}`));
    let pk = parentKey(key);
    const seen = new Set([key]);
    while (pk && !seen.has(pk)) {
      seen.add(pk);
      for (const f of own.get(pk) || []) {
        const k = `${f.netbus}/${f.fileBase}`;
        if (have.has(k)) continue;
        have.add(k);
        list.push(f);
        inh.add(f.uid);
      }
      pk = parentKey(pk);
    }
    list.sort((a, b) => naturalCompare(a.netbus, b.netbus) || a.id - b.id);
    db.variantFrames.set(key, list);
    // own frames overriding a frame of the parent's effective set
    const pk0 = parentKey(key);
    if (pk0 && db.variantFrames.has(pk0)) {
      const pm = new Map(db.variantFrames.get(pk0).map((f) => [`${f.netbus}/${f.fileBase}`, f]));
      for (const f of own.get(key) || []) {
        const p = pm.get(`${f.netbus}/${f.fileBase}`);
        if (p) { f.overrides = p; f.overrideDiff = diffFrames(p, f); }
      }
    }
    db.inherited.set(key, inh);
  }

  // 5. nodes: inherit from parents, add phantom nodes referenced by frames
  const variantNodes = new Map();
  for (const key of db.variants.keys()) {
    const m = new Map();
    let k = key;
    const seen = new Set();
    while (k && !seen.has(k)) {
      seen.add(k);
      for (const [n, nd] of db.nodes.get(k) || []) if (!m.has(n)) m.set(n, nd);
      k = parentKey(k);
    }
    variantNodes.set(key, m);
  }
  for (const [key, frames] of db.variantFrames) {
    const m = variantNodes.get(key);
    const usage = new Map();
    const use = (n) => {
      if (!usage.has(n)) usage.set(n, { sends: [], receives: [], buses: new Set() });
      return usage.get(n);
    };
    for (const f of frames) {
      for (const s of f.senders) { const u = use(s); u.sends.push(f); u.buses.add(f.netbus); }
      for (const r of f.receivers) { const u = use(r); u.receives.push(f); u.buses.add(f.netbus); }
    }
    for (const [n, u] of usage) {
      if (!m.has(n)) {
        // alias? (node defined with alt names)
        let alias = null;
        for (const nd of m.values()) if (nd.alt.includes(n)) { alias = nd.name; break; }
        m.set(n, {
          name: n, buses: [...u.buses], ids: {}, alt: [], title: null, comment: null, released: true, diag: null,
          phantom: true, aliasOf: alias, archvar: key, sources: [], issues: [],
        });
      }
    }
    db.nodeUsage.set(key, usage);
    for (const f of frames) {
      if (db.inherited.get(key).has(f.uid)) continue;
      for (const n of new Set([...f.senders, ...f.receivers])) {
        const nd = m.get(n);
        if (nd && nd.phantom && !nd.aliasOf && !PSEUDO_NODES[n] && db.nodes.has(key) && !f.symlinkOf) {
          f.issues.push({ level: 'info', msg: `node '${n}' not defined in nodes/${key}.yml`, where: '' });
        }
      }
    }
  }
  db.variantNodes = variantNodes;

  // unknown node summary (one issue per variant+node instead of per frame)
  for (const [key, m] of variantNodes) {
    if (!db.nodes.has(key) && !parentKey(key)) continue;
    for (const nd of m.values()) {
      if (PSEUDO_NODES[nd.name]) { nd.pseudo = PSEUDO_NODES[nd.name]; continue; }
      if (nd.phantom) issue(db, null, `nodes/${key}.yml`, 'info', `node '${nd.name}' is used by frames but not defined${nd.aliasOf ? ` (alternative name of ${nd.aliasOf})` : ''}`);
    }
  }

  // 6. cars per node
  db.carsByNode = new Map();
  for (const car of db.cars) {
    for (const v of car.versions) {
      const key = v.architecture;
      for (const [net, list] of Object.entries(v.nodes)) {
        for (const n of list) {
          const k = `${key}|${n}`;
          if (!db.carsByNode.has(k)) db.carsByNode.set(k, []);
          const arr = db.carsByNode.get(k);
          if (!arr.some((x) => x.car === car && x.version === v)) arr.push({ car, version: v, optional: v.optional.includes(n), net });
        }
      }
      if (key !== 'none' && !db.variants.has(key) && /^[A-Z]/.test(key)) {
        issue(db, car.source, car.path, 'info', `architecture '${key}' not defined`, `versions/${v.name}`);
      }
    }
  }
  db.cars.sort((a, b) => naturalCompare(a.project, b.project));

  db.variantList = [...db.variants.values()].sort((a, b) => naturalCompare(a.arch, b.arch) || (a.variant === 'full' ? -1 : b.variant === 'full' ? 1 : naturalCompare(a.variant, b.variant)));
  db.searchIndex = buildSearchIndex(db);
  return db;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** ECUs fitted on a car version (flat list) */
export function carVersionNodes(version) {
  const s = new Set();
  for (const list of Object.values(version.nodes || {})) for (const n of list) s.add(n);
  return s;
}

/** Frames of a car version: frames of its architecture whose senders are fitted */
export function framesForCarVersion(db, version) {
  const frames = db.variantFrames.get(version.architecture) || [];
  const fitted = carVersionNodes(version);
  if (!fitted.size) return { frames, filtered: false };
  const nodesMap = db.variantNodes.get(version.architecture) || new Map();
  // also accept alternative names
  const fittedAll = new Set(fitted);
  for (const n of fitted) { const nd = nodesMap.get(n); if (nd) for (const a of nd.alt) fittedAll.add(a); }
  return { frames: frames.filter((f) => f.senders.some((s) => fittedAll.has(s))), filtered: true };
}

/** Compare two normalized frames at signal level. */
export function diffFrames(a, b) {
  const out = { identical: true, fields: [], signals: [] };
  const fields = ['length', 'type', 'periodicity', 'senders', 'receivers', 'name'];
  for (const k of fields) {
    const va = JSON.stringify(a[k]);
    const vb = JSON.stringify(b[k]);
    if (va !== vb) { out.fields.push({ field: k, a: a[k], b: b[k] }); out.identical = false; }
  }
  const sa = new Map(a.signals.map((s) => [s.name, s]));
  const sb = new Map(b.signals.map((s) => [s.name, s]));
  const sigKey = (s) => JSON.stringify([s.bits, s.type, s.factor, s.offset, s.min, s.max, s.units, s.values.map((v) => [v.raw, v.text && v.text.en]), s.unused, s.invalid]);
  for (const [n, s] of sa) {
    if (!sb.has(n)) {
      // renamed? same bits
      const same = b.signals.find((x) => x.bits === s.bits && !sa.has(x.name));
      out.signals.push(same ? { name: n, status: 'renamed', to: same.name, a: s, b: same } : { name: n, status: 'removed', a: s });
      out.identical = false;
    } else {
      const t = sb.get(n);
      if (sigKey(s) !== sigKey(t)) {
        const what = [];
        if (s.bits !== t.bits) what.push('bits');
        if (s.type !== t.type) what.push('type');
        if (s.factor !== t.factor || s.offset !== t.offset) what.push('scaling');
        if (s.units !== t.units) what.push('units');
        if (s.min !== t.min || s.max !== t.max) what.push('range');
        if (JSON.stringify(s.values.map((v) => [v.raw, v.text && v.text.en])) !== JSON.stringify(t.values.map((v) => [v.raw, v.text && v.text.en]))) what.push('values');
        if (s.unused !== t.unused) what.push('unused');
        if (JSON.stringify(s.invalid) !== JSON.stringify(t.invalid)) what.push('invalid');
        out.signals.push({ name: n, status: 'changed', what, a: s, b: t });
        out.identical = false;
      } else out.signals.push({ name: n, status: 'same', a: s, b: t });
    }
  }
  for (const [n, t] of sb) {
    if (!sa.has(n) && !out.signals.some((x) => x.to === n)) { out.signals.push({ name: n, status: 'added', b: t }); out.identical = false; }
  }
  return out;
}

/** Diff between a variant and its parent (by bus + file name) */
export function diffVariants(db, key, parentKeyArg) {
  const pk = parentKeyArg || db.parentKey(key);
  if (!pk) return null;
  const mine = db.ownFrames.get(key) || [];
  const theirs = db.variantFrames.get(pk) || [];
  const tm = new Map(theirs.map((f) => [`${f.netbus}/${f.fileBase}`, f]));
  const mm = new Map(mine.map((f) => [`${f.netbus}/${f.fileBase}`, f]));
  const added = [];
  const changed = [];
  const same = [];
  for (const [k, f] of mm) {
    if (!tm.has(k)) added.push(f);
    else {
      const d = diffFrames(tm.get(k), f);
      if (d.identical) same.push(f); else changed.push({ frame: f, parent: tm.get(k), diff: d });
    }
  }
  // "removed" makes sense only when the child redefines the bus but lacks the frame; inherited frames are not removed
  return { parent: pk, added, changed, same, inheritedCount: (db.inherited.get(key) || new Set()).size };
}

/** Same frame id in other architectures/variants (by id and name). */
export function sameFrameElsewhere(db, frame) {
  const out = [];
  for (const f of db.primaryFrames) {
    if (f.uid === frame.uid) continue;
    if (f.id === frame.id && f.type === frame.type && (f.archvar !== frame.archvar || f.netbus !== frame.netbus || f.fileBase !== frame.fileBase)) {
      out.push({ frame: f, diff: diffFrames(frame, f), identicalFile: !!(f.symlinkOf && f.symlinkOf === frame.path) || !!(frame.symlinkOf && frame.symlinkOf === f.path) || (f.symlinkOf && f.symlinkOf === frame.symlinkOf) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function buildSearchIndex(db) {
  const idx = [];
  for (const f of db.primaryFrames) {
    idx.push({ kind: 'frame', key: f.uid, id: f.id, label: `${f.idHex} ${f.name}`, sub: `${f.archvar} · ${f.netbus}`, route: frameRoute(f), text: `${f.idHex} 0x${f.idHex} ${f.name} ${f.altNames.join(' ')}`.toLowerCase(), frame: f });
    for (const s of f.signals) {
      if (s.unused && /^UNUSED/i.test(s.name)) continue;
      idx.push({ kind: 'signal', label: s.name, sub: `${f.idHex} ${f.name} · ${f.archvar} ${f.netbus}`, route: frameRoute(f) + '?sig=' + encodeURIComponent(s.name), text: `${s.name} ${s.altNames.join(' ')}`.toLowerCase(), frame: f });
    }
  }
  for (const [key, m] of db.variantNodes) {
    for (const n of m.values()) {
      if (n.phantom && !(db.nodeUsage.get(key) || new Map()).has(n.name)) continue;
      idx.push({ kind: 'ecu', label: n.name, sub: `${key}${n.title ? ' · ' + ml(n.title) : ''}`, route: `#/ecus/${key}/${encodeURIComponent(n.name)}`, text: `${n.name} ${n.alt.join(' ')} ${n.title ? Object.values(n.title).join(' ') : ''}`.toLowerCase() });
    }
  }
  for (const c of db.cars) {
    idx.push({ kind: 'car', label: `${c.project} · ${c.codes.map((x) => x.code).join(', ')}`, sub: [...new Set(c.codes.flatMap((x) => x.names))].join(', '), route: `#/cars/${encodeURIComponent(c.project)}`, text: `${c.project} ${c.codes.map((x) => `${x.code} ${x.names.join(' ')}`).join(' ')}`.toLowerCase() });
  }
  for (const v of db.variantList) {
    idx.push({ kind: 'arch', label: v.key, sub: ml(v.comment), route: `#/arch/${v.key}`, text: `${v.key} ${v.arch}`.toLowerCase() });
  }
  for (const d of db.diag.dtcIndex) {
    idx.push({ kind: 'dtc', label: d.code, sub: `${d.node} · ${ml(d.displayName)}`, route: `#/diag/dtc?q=${encodeURIComponent(d.code)}`, text: `${d.code} ${d.raw !== null ? hex(d.raw, 4) : ''} ${d.displayName ? Object.values(d.displayName).join(' ') : ''}`.toLowerCase() });
  }
  for (const e of db.diag.ecus.values()) {
    for (const d of [...e.dids, ...e.lids]) {
      idx.push({ kind: d.kind, label: `${hex(d.ident, d.kind === 'did' ? 4 : 2)} ${d.name}`, sub: `${e.node} · ${e.archvar}`, route: `#/diag/ecu/${e.archvar}/${encodeURIComponent(e.node)}?${d.kind}=${hex(d.ident)}`, text: `${hex(d.ident, 4)} ${d.name}`.toLowerCase() });
    }
  }
  return idx;
}

/** Global search. Returns up to `limit` results, best first. */
export function search(db, query, limit = 60) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const results = [];
  const hexm = /^(?:0x)?([0-9a-f]{1,8})$/i.exec(q);
  const qid = hexm ? parseInt(hexm[1], 16) : null;
  const kindRank = { frame: 0, ecu: 1, car: 2, arch: 3, signal: 4, did: 5, lid: 5, dtc: 6 };
  for (const e of db.searchIndex) {
    let score = -1;
    if (qid !== null && e.kind === 'frame' && e.id === qid) score = 1000;
    const lbl = e.label.toLowerCase();
    if (score < 0) {
      if (lbl === q) score = 600;
      else if (e.text.split(' ').includes(q)) score = 400;
      else if (lbl.startsWith(q)) score = 300;
      else if (e.text.includes(q)) score = 100 - Math.min(90, e.text.indexOf(q));
    }
    if (score >= 0) results.push({ ...e, score: score - (kindRank[e.kind] ?? 9) });
  }
  results.sort((a, b) => b.score - a.score || naturalCompare(a.label, b.label));
  return results.slice(0, limit);
}

export { basename };
