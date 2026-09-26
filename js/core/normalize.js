// Tolerant normalization of DBMUXEv documents (frames, signals, nodes, cars...).
// Legacy quirks are converted to the v0.2 format and reported as warnings,
// nothing here ever throws on unexpected input.

import { parseBits, checkBits, normalizeBitsString, absToByteBit } from './bits.js';
import { toMl, isObj, asArray, parseIntLoose, uniq } from './util.js';

export const FRAME_KEYS = new Set(['id', 'name', 'alt_names', 'type', 'extended', 'length', 'length_min', 'comment',
  'observations', 'periodicity', 'senders', 'receivers', 'isotp', 'van', 'lin', 'signals', 'alternatives']);
export const SIGNAL_KEYS = new Set(['bits', 'unused', 'alt_names', 'comment', 'type', 'signed', 'factor', 'resolution',
  'offset', 'min', 'max', 'units', 'invalid', 'default', 'values', 'mux_selector', 'mux', 'alternatives', 'receivers', 'byte_order']);

const W = (level, msg, where) => ({ level, msg, where: where || '' });

/** Parse a value-table key (object keys are strings after YAML -> JS). */
export function parseRawKey(k) {
  if (typeof k === 'number') return Number.isInteger(k) ? k : null;
  const s = String(k).trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^0b[01]+$/i.test(s)) return parseInt(s.slice(2), 2);
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  return null;
}

/**
 * Periodicity: returns { list: ['100ms','trigger'], periods: [100], trigger, request, legacy }
 * Accepts v0.2 lists, legacy numbers (100 -> '100ms'), and free strings
 * ('200ms + event based', 'event based', '500 ms').
 */
export function normalizePeriodicity(p) {
  const out = { list: [], periods: [], trigger: false, request: false, legacy: false, unknown: [] };
  if (p === null || p === undefined || p === '') return out;
  const items = Array.isArray(p) ? p : [p];
  if (!Array.isArray(p)) out.legacy = true;
  for (const it of items) {
    if (typeof it === 'number') {
      if (Number.isFinite(it) && it > 0) out.periods.push(Math.round(it));
      out.legacy = true;
      continue;
    }
    if (typeof it !== 'string') { out.unknown.push(String(it)); continue; }
    const s = it.trim().toLowerCase();
    if (/^[0-9]+ms$/.test(s)) { out.periods.push(parseInt(s, 10)); continue; }
    if (s === 'trigger') { out.trigger = true; continue; }
    if (s === 'request') { out.request = true; continue; }
    out.legacy = true;
    let matched = false;
    for (const tok of s.split(/\+|,|;|\/|\band\b|\bor\b|\bet\b/)) {
      const t = tok.trim();
      if (!t) continue;
      const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|millis\w*)?$/.exec(t);
      if (m) {
        const n = parseFloat(m[1]);
        const ms = m[2] && /^s/.test(m[2]) ? n * 1000 : n;
        out.periods.push(Math.round(ms));
        matched = true;
      } else if (/event|trigger|change|spontan|evenement|événement|on\s*demand?e?/.test(t)) {
        out.trigger = true; matched = true;
      } else if (/request|reply|requete|requête|answer|response/.test(t)) {
        out.request = true; matched = true;
      } else {
        out.unknown.push(t);
      }
    }
    if (!matched && !out.unknown.length) out.unknown.push(s);
  }
  out.periods = uniq(out.periods).sort((a, b) => a - b);
  out.list = [...out.periods.map((x) => `${x}ms`)];
  if (out.trigger) out.list.push('trigger');
  if (out.request) out.list.push('request');
  return out;
}

/** Normalize a signal type. Returns {type, warning} */
export function normalizeType(rawType, sig, width) {
  const hasFactor = sig && ((typeof sig.factor === 'number' && sig.factor !== 1) || (typeof sig.resolution === 'number' && sig.resolution !== 1));
  const signedFlag = sig && sig.signed === true;
  if (rawType === null || rawType === undefined || rawType === '') {
    if (signedFlag) return { type: 'sint', warning: null };
    return { type: null, warning: null };
  }
  const t = String(rawType).trim().toLowerCase();
  const canon = ['uint', 'sint', 'bool', 'enum', 'bcd', 'str', 'bytes', 'float'];
  if (canon.includes(t)) {
    if (t === 'float' && !(width === 32 || width === 64)) {
      return { type: signedFlag ? 'sint' : 'uint', warning: `type 'float' on a ${width} bit signal: read as a scaled ${signedFlag ? 'signed' : 'unsigned'} integer` };
    }
    if (t === 'float' && hasFactor) {
      return { type: signedFlag ? 'sint' : 'uint', warning: "type 'float' with a factor: read as a scaled integer" };
    }
    if (t === 'uint' && signedFlag) return { type: 'sint', warning: null };
    if (t === 'bool' && width !== 1) return { type: 'uint', warning: `bool signal is ${width} bits wide, read as uint` };
    return { type: t, warning: String(rawType) !== t ? `type '${rawType}' should be lowercase` : null };
  }
  if (/^(uint|unsigned|u)\d*(_t)?$/.test(t)) return { type: signedFlag ? 'sint' : 'uint', warning: `legacy type '${rawType}', use uint` };
  if (/^(sint|int|signed|s)\d+(_t)?$/.test(t) || t === 'sint' || t === 'signed') return { type: 'sint', warning: `legacy type '${rawType}', use sint` };
  if (t === 'int' || t === 'integer') {
    // ambiguous legacy type: signed only if it can obviously be negative without offset
    const neg = sig && typeof sig.min === 'number' && sig.min < 0 && !(typeof sig.offset === 'number' && sig.offset < 0);
    return { type: signedFlag || neg ? 'sint' : 'uint', warning: `ambiguous legacy type 'int', read as ${signedFlag || neg ? 'sint' : 'uint'}` };
  }
  if (t === 'boolean' || t === 'flag') return { type: width === 1 ? 'bool' : 'uint', warning: `legacy type '${rawType}', use bool` };
  if (['string', 'ascii', 'text', 'char', 'chars', 'iso-8859-1', 'latin1'].includes(t)) return { type: 'str', warning: `legacy type '${rawType}', use str` };
  if (['raw', 'hex', 'byte', 'bytearray', 'data', 'blob'].includes(t)) return { type: 'bytes', warning: `legacy type '${rawType}', use bytes` };
  if (['double', 'real', 'float32', 'float64', 'ieee754'].includes(t)) return { type: (width === 32 || width === 64) ? 'float' : 'uint', warning: `legacy type '${rawType}', use float` };
  return { type: signedFlag ? 'sint' : 'uint', warning: `unknown type '${rawType}', read as ${signedFlag ? 'sint' : 'uint'}` };
}

function numOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function intList(v) {
  const out = [];
  for (const x of asArray(v)) {
    const n = parseIntLoose(x);
    if (n !== null && n !== undefined) out.push(n);
  }
  return out;
}

/** Normalize a value table: returns [{raw, text(ml), unused}] sorted by raw. */
export function normalizeValues(values, issues, where) {
  const out = [];
  if (!isObj(values)) {
    if (values !== undefined && values !== null) issues.push(W('warning', 'values must be a mapping raw value -> meaning', where));
    return out;
  }
  for (const [k, entry] of Object.entries(values)) {
    const raw = parseRawKey(k);
    if (raw === null) { issues.push(W('warning', `value key '${k}' is not an integer`, where)); continue; }
    let text = null;
    let unused = false;
    if (typeof entry === 'string' || typeof entry === 'number') text = toMl(String(entry));
    else if (isObj(entry)) { text = toMl(entry); unused = entry.unused === true; }
    out.push({ raw, text, unused });
  }
  out.sort((a, b) => a.raw - b.raw);
  return out;
}

/**
 * Normalize one signal.
 * @returns normalized signal (never null) with .issues
 */
export function normalizeSignal(name, raw, frameLength) {
  const issues = [];
  const where = `signals/${name}`;
  const s = isObj(raw) ? raw : {};
  if (!isObj(raw)) issues.push(W('error', 'signal definition must be a mapping', where));
  for (const k of Object.keys(s)) {
    if (!SIGNAL_KEYS.has(k)) {
      if (k === 'unit') issues.push(W('warning', "'unit' is deprecated, use units", where));
      else if (k === 'description') issues.push(W('warning', "'description' is not a v0.2 field, use comment", where));
      else issues.push(W('warning', `unknown signal field '${k}'`, where));
    }
  }
  const bitsText = normalizeBitsString(s.bits);
  const bitsErr = checkBits(s.bits);
  if (bitsErr) issues.push(W('error', bitsErr, where));
  if (typeof s.bits === 'number') issues.push(W('warning', `bits written as a number (${s.bits}), quote it: '${bitsText}'`, where));
  const pos = parseBits(s.bits, frameLength);
  if (pos && pos.legacy) issues.push(W('warning', `legacy bit notation '${pos.legacy}', should be '${pos.text}'`, where));
  const width = pos ? pos.width : 0;
  const tn = normalizeType(s.type, s, width);
  if (tn.warning) issues.push(W('warning', tn.warning, where));
  if (s.signed !== undefined) issues.push(W('warning', "'signed' is deprecated, use type: sint", where));
  let factor = numOrNull(s.factor);
  if (factor === null && s.resolution !== undefined && s.resolution !== null) {
    factor = numOrNull(s.resolution);
  }
  if (s.resolution !== undefined) issues.push(W('warning', "'resolution' is deprecated, use factor", where));
  if (factor === 0) { issues.push(W('error', 'factor cannot be 0', where)); factor = null; }
  const values = normalizeValues(s.values, issues, where);
  let type = tn.type;
  if (!type) type = values.length && factor === null ? 'enum' : (width === 1 && !values.length ? 'bool' : 'uint');
  const unitsRaw = s.units !== undefined ? s.units : s.unit;
  const comment = toMl(s.comment) || toMl(s.description);
  let mux = null;
  if (s.mux !== undefined) {
    if (isObj(s.mux) && s.mux.selector) {
      mux = { selector: String(s.mux.selector), values: intList(s.mux.values) };
      if (!mux.values.length) issues.push(W('warning', 'mux without values', where));
    } else issues.push(W('warning', 'mux must be {selector, values}', where));
  }
  let littleEndian = false;
  if (s.byte_order !== undefined && s.byte_order !== null) {
    const bo = String(s.byte_order).toLowerCase().replace(/[-\s]/g, '_');
    if (['little_endian', 'little', 'le', 'intel'].includes(bo)) littleEndian = true;
    else if (!['big_endian', 'big', 'be', 'motorola'].includes(bo)) issues.push(W('warning', `unknown byte_order '${s.byte_order}' (big_endian assumed)`, where));
    if (bo !== 'little_endian' && bo !== 'big_endian') issues.push(W('warning', `byte_order should be 'big_endian' or 'little_endian'`, where));
  }
  const sig = {
    name: String(name),
    littleEndian: littleEndian && !!pos && (pos.start >> 3) !== (pos.end >> 3),
    byteOrder: littleEndian ? 'little_endian' : 'big_endian',
    bits: pos ? pos.text : (bitsText || ''),
    pos,
    width,
    type,
    typeExplicit: !!tn.type,
    factor: factor === null ? 1 : factor,
    hasFactor: factor !== null && factor !== 1,
    offset: numOrNull(s.offset) ?? 0,
    min: numOrNull(s.min),
    max: numOrNull(s.max),
    units: unitsRaw === null || unitsRaw === undefined ? '' : String(unitsRaw),
    invalid: intList(s.invalid),
    default: parseIntLoose(s.default),
    values,
    unused: s.unused === true,
    muxSelector: s.mux_selector === true,
    mux,
    comment,
    altNames: asArray(s.alt_names).map(String).map((x) => x.trim()).filter(Boolean),
    receivers: asArray(s.receivers).map(String),
    legacyReceivers: asArray(s.receivers).map(String),
    alternatives: [],
    raw: s,
    issues,
  };
  if (sig.default === undefined) sig.default = null;
  if (s.alternatives !== undefined) {
    if (!Array.isArray(s.alternatives)) issues.push(W('warning', 'alternatives must be a list', where));
    else {
      s.alternatives.forEach((a, i) => {
        if (!isObj(a)) return;
        sig.alternatives.push({ index: i, note: toMl(a.note), raw: a });
      });
    }
  }
  if (pos && values.length && width < 53) {
    for (const v of values) if (v.raw >= 2 ** width) issues.push(W('error', `value 0x${v.raw.toString(16).toUpperCase()} does not fit in ${width} bit(s)`, where));
  }
  if (sig.min !== null && sig.max !== null && sig.min > sig.max) issues.push(W('warning', 'min > max', where));
  return sig;
}

/** Apply a signal alternative (partial override) and return a new normalized signal. */
export function applySignalAlternative(sig, altIndex, frameLength) {
  const alt = sig.alternatives[altIndex];
  if (!alt) return sig;
  const merged = { ...sig.raw };
  for (const [k, v] of Object.entries(alt.raw)) if (k !== 'note') merged[k] = v;
  delete merged.alternatives;
  const n = normalizeSignal(sig.name, merged, frameLength);
  n.appliedAlternative = alt;
  return n;
}

/** Signals map (or legacy list) -> ordered list of normalized signals */
export function normalizeSignals(signals, frameLength, issues) {
  const out = [];
  if (signals === null || signals === undefined) return out;
  if (Array.isArray(signals)) {
    issues.push(W('warning', 'signals should be a mapping NAME -> definition'));
    signals.forEach((s, i) => {
      const name = isObj(s) && s.name ? s.name : `SIGNAL_${i + 1}`;
      const copy = isObj(s) ? { ...s } : {};
      delete copy.name;
      out.push(normalizeSignal(name, copy, frameLength));
    });
    return out;
  }
  if (!isObj(signals)) { issues.push(W('error', 'signals must be a mapping')); return out; }
  for (const [name, s] of Object.entries(signals)) out.push(normalizeSignal(name, s, frameLength));
  return out;
}

/** Check overlaps / out of frame bits / mux consistency. Pushes to issues. */
export function checkSignalLayout(signals, length, type, issues, prefix = 'signals') {
  const variable = type === 'can-tp';
  const selectors = new Set(signals.filter((s) => s.muxSelector).map((s) => s.name));
  const occ = new Map();
  for (const s of signals) {
    if (!s.pos) continue;
    if (length && !variable && !s.pos.toEnd && s.pos.end >= length * 8) {
      issues.push(W('error', `bits '${s.bits}' outside of the ${length} bytes frame`, `${prefix}/${s.name}`));
    }
    if (s.mux && !selectors.has(s.mux.selector)) {
      issues.push(W('warning', `mux selector '${s.mux.selector}' is not a signal with mux_selector: true`, `${prefix}/${s.name}`));
    }
    const end = Math.min(s.pos.end, s.pos.start + 8 * 64); // bound work on huge payloads
    for (let b = s.pos.start; b <= end; b++) {
      if (!occ.has(b)) occ.set(b, []);
      occ.get(b).push(s);
    }
  }
  const reported = new Set();
  for (const [b, users] of occ) {
    if (users.length < 2) continue;
    for (let i = 0; i < users.length; i++) {
      for (let j = i + 1; j < users.length; j++) {
        const a = users[i];
        const c = users[j];
        if (a.mux && c.mux && a.mux.selector === c.mux.selector && !a.mux.values.some((v) => c.mux.values.includes(v))) continue;
        const key = [a.name, c.name].sort().join('|');
        if (reported.has(key)) continue;
        reported.add(key);
        const p = absToByteBit(b);
        issues.push(W('warning', `signals '${a.name}' and '${c.name}' overlap (byte ${p.byte} bit ${p.bit})`, prefix));
      }
    }
  }
}

const FRAME_TYPES = { can: 'can', 'can-tp': 'can-tp', cantp: 'can-tp', 'iso-tp': 'can-tp', isotp: 'can-tp', 'can_tp': 'can-tp', van: 'van', lin: 'lin', 'can-fd': 'can', canfd: 'can' };

/** VAN legacy 'method' strings -> van block */
function vanFromMethod(method) {
  const m = String(method || '').toLowerCase();
  if (!m) return null;
  const v = { access: 'write' };
  if (/read|reply|request/.test(m)) v.access = 'read';
  if (/ack/.test(m)) v.ack = true;
  if (/in-?frame/.test(m)) v.reply = 'in-frame';
  if (/deferred|differ/.test(m)) v.reply = 'deferred';
  return v;
}

/**
 * Normalize a frame document.
 * ctx: { protocol: 'CAN'|'VAN'|'LIN'..., fileId: number|null, fileBase, path }
 */
export function normalizeFrame(raw, ctx = {}) {
  const issues = [];
  const d = isObj(raw) ? raw : {};
  if (!isObj(raw)) issues.push(W('error', 'frame file must be a mapping'));
  for (const k of Object.keys(d)) {
    if (!FRAME_KEYS.has(k)) {
      if (k === 'method') issues.push(W('warning', "'method' is legacy, use the van block (van: {access, ack, reply})"));
      else if (k === 'alt_id') issues.push(W('warning', "'alt_id' is not a v0.2 field"));
      else issues.push(W('warning', `unknown frame field '${k}'`));
    }
  }
  // id
  let id = parseIntLoose(d.id, typeof d.id === 'string');
  if (id === null || id === undefined) {
    if (ctx.fileId !== null && ctx.fileId !== undefined) {
      id = ctx.fileId;
      issues.push(W('error', 'missing id, taken from the file name'));
    } else { id = -1; issues.push(W('error', 'missing id')); }
  } else if (ctx.fileId !== null && ctx.fileId !== undefined && ctx.fileId !== id) {
    issues.push(W('error', `file name ID 0x${ctx.fileId.toString(16).toUpperCase()} does not match id 0x${id.toString(16).toUpperCase()}`));
  }
  // type
  let type = null;
  const protocol = (ctx.protocol || '').toUpperCase();
  if (d.type !== undefined && d.type !== null) {
    const t = String(d.type).trim().toLowerCase();
    type = FRAME_TYPES[t] || null;
    if (!type) issues.push(W('error', `unknown frame type '${d.type}'`));
    else if (String(d.type) !== type) issues.push(W('warning', `type '${d.type}' should be '${type}'`));
  }
  if (!type) {
    type = protocol === 'VAN' ? 'van' : protocol === 'LIN' ? 'lin' : (d.isotp ? 'can-tp' : 'can');
    if (d.type === undefined) issues.push(W('error', `missing type (assumed ${type})`));
  }
  if (protocol) {
    const expect = { CAN: ['can', 'can-tp'], 'CAN-FD': ['can', 'can-tp'], VAN: ['van'], LIN: ['lin'] }[protocol];
    if (expect && !expect.includes(type)) issues.push(W('warning', `frame type '${type}' does not match bus protocol ${protocol}`));
  }
  const name = d.name === undefined || d.name === null ? `FRAME_${(id >= 0 ? id : 0).toString(16).toUpperCase()}` : String(d.name);
  if (d.name === undefined) issues.push(W('error', 'missing name'));
  else if (!/^[A-Z][A-Z0-9_]*$/.test(name)) issues.push(W('warning', `name '${name}' is not an identifier (uppercase, digits, underscores)`));
  // length
  let length = parseIntLoose(d.length);
  const signalsTmp = [];
  if (length === null || length === undefined) length = null;
  const sigIssues = [];
  const signals = normalizeSignals(d.signals, length || undefined, sigIssues);
  signalsTmp.push(...signals);
  if (length === null) {
    let maxEnd = -1;
    for (const s of signals) if (s.pos && !s.pos.toEnd) maxEnd = Math.max(maxEnd, s.pos.end);
    length = maxEnd >= 0 ? Math.floor(maxEnd / 8) + 1 : (type === 'lin' || type === 'can' ? 8 : 0);
    if (type !== 'can-tp') issues.push(W('warning', `missing length (assumed ${length})`));
  }
  if (type === 'can' && length > 8) issues.push(W('warning', `can frame with ${length} bytes (max 8, is it can-tp?)`));
  if (type === 'van' && length > 28) issues.push(W('warning', `VAN frame with ${length} bytes (max 28)`));
  if (type === 'lin' && length > 8) issues.push(W('warning', `LIN frame with ${length} bytes (max 8)`));
  if (type === 'lin' && id > 63) issues.push(W('warning', `LIN id 0x${id.toString(16)} > 0x3F`));
  if (type === 'can' && id > 0x7FF && !d.extended) issues.push(W('warning', `id 0x${id.toString(16).toUpperCase()} needs 29 bits, set extended: true`));
  if (!d.signals) issues.push(W('warning', 'no signals'));
  const per = normalizePeriodicity(d.periodicity);
  if (per.legacy && d.periodicity !== undefined) {
    issues.push(W('warning', `legacy periodicity ${JSON.stringify(d.periodicity)}, should be ${JSON.stringify(per.list)}`));
  }
  if (per.unknown.length) issues.push(W('warning', `unknown periodicity item(s): ${per.unknown.join(', ')}`));
  const senders = asArray(d.senders).filter((x) => x !== null && x !== undefined).map((x) => String(x).trim());
  const receivers = asArray(d.receivers).filter((x) => x !== null && x !== undefined).map((x) => String(x).trim());
  if (d.senders !== undefined && !Array.isArray(d.senders)) issues.push(W('warning', 'senders must be a list'));
  if (d.receivers !== undefined && !Array.isArray(d.receivers)) issues.push(W('warning', 'receivers must be a list'));
  if (!senders.length) issues.push(W('info', 'no senders'));
  for (const s of signals) for (const r of s.legacyReceivers) if (!receivers.includes(r)) receivers.push(r);
  let van = isObj(d.van) ? { ...d.van } : null;
  if (!van && d.method && type === 'van') van = vanFromMethod(d.method);
  const frame = {
    id,
    name,
    ident: name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || `FRAME_${id}`,
    altNames: asArray(d.alt_names).map(String),
    altIds: intList(d.alt_id),
    type,
    extended: d.extended === true || (type === 'can' && id > 0x7FF),
    length,
    lengthMin: parseIntLoose(d.length_min),
    comment: toMl(d.comment),
    observations: toMl(d.observations),
    periodicity: per.list,
    periods: per.periods,
    periodMs: per.periods.length ? per.periods[0] : null,
    trigger: per.trigger,
    request: per.request,
    senders: uniq(senders),
    receivers: uniq(receivers),
    isotp: isObj(d.isotp) ? { ...d.isotp } : null,
    van,
    lin: isObj(d.lin) ? { ...d.lin } : null,
    legacyMethod: d.method ? String(d.method) : null,
    signals,
    alternatives: [],
    raw: d,
    issues,
  };
  if (frame.lengthMin === undefined) frame.lengthMin = null;
  if (d.alternatives !== undefined) {
    if (!Array.isArray(d.alternatives)) issues.push(W('warning', 'alternatives must be a list'));
    else d.alternatives.forEach((a, i) => { if (isObj(a)) frame.alternatives.push({ index: i, note: toMl(a.note), raw: a }); });
  }
  // gather signal issues
  for (const s of signals) for (const it of s.issues) issues.push(it);
  issues.push(...sigIssues);
  checkSignalLayout(signals, length, type, issues);
  frame.hasAlternatives = frame.alternatives.length > 0 || signals.some((s) => s.alternatives.length > 0);
  frame.hasMux = signals.some((s) => s.muxSelector || s.mux);
  frame.variable = type === 'can-tp' || signals.some((s) => s.pos && s.pos.toEnd);
  frame.warnCount = issues.filter((i) => i.level === 'warning' || i.level === 'error').length;
  frame.errCount = issues.filter((i) => i.level === 'error').length;
  return frame;
}

/** Apply a frame-level alternative and return a new normalized frame (same identity). */
export function applyFrameAlternative(frame, altIndex) {
  const alt = frame.alternatives[altIndex];
  if (!alt) return frame;
  const merged = { ...frame.raw };
  for (const [k, v] of Object.entries(alt.raw)) if (k !== 'note') merged[k] = v;
  delete merged.alternatives;
  const n = normalizeFrame(merged, { protocol: null, fileId: null });
  // keep identity / placement
  for (const k of ['key', 'uid', 'source', 'path', 'archvar', 'arch', 'variant', 'net', 'bus', 'netbus', 'fileBase', 'symlinkOf']) n[k] = frame[k];
  n.appliedAlternative = alt;
  n.alternatives = frame.alternatives;
  return n;
}

/** Signals active for a given mux selector state: {SELECTOR: rawValue} (null = show all). */
export function activeSignals(signals, muxState) {
  if (!muxState) return signals;
  return signals.filter((s) => {
    if (!s.mux) return true;
    const cur = muxState[s.mux.selector];
    if (cur === undefined || cur === null) return true;
    return s.mux.values.includes(cur);
  });
}

// ---------------------------------------------------------------------------
// Architectures / nodes / cars
// ---------------------------------------------------------------------------

export function normalizeArchitectures(data, issues = []) {
  const out = {};
  if (!isObj(data)) { issues.push(W('error', 'architectures.yml must be a mapping')); return out; }
  for (const [arch, variants] of Object.entries(data)) {
    if (!isObj(variants)) { issues.push(W('warning', `architecture ${arch} has no variants`)); continue; }
    out[arch] = {};
    for (const [variant, v] of Object.entries(variants)) {
      const vd = isObj(v) ? v : {};
      const todo = !isObj(v);
      const networks = {};
      if (isObj(vd.networks)) {
        for (const [net, buses] of Object.entries(vd.networks)) {
          if (!isObj(buses)) continue;
          networks[net] = {};
          for (const [bus, b] of Object.entries(buses)) {
            const bd = isObj(b) ? b : {};
            const bitrate = numOrNull(bd.bitrate);
            if (bd.dispaly_name) issues.push(W('warning', `'dispaly_name' typo in ${arch}.${variant}/${net}.${bus}`));
            networks[net][bus] = {
              net, bus, netbus: `${net}.${bus}`,
              protocol: bd.protocol ? String(bd.protocol).toUpperCase() : 'CAN',
              bitrate,
              displayName: toMl(bd.display_name) || toMl(bd.dispaly_name),
              comment: toMl(bd.comment),
            };
          }
        }
      }
      out[arch][variant] = {
        arch, variant, key: `${arch}.${variant}`,
        comment: toMl(vd.comment) || (todo && typeof v === 'string' ? { en: v } : null),
        displayName: toMl(vd.display_name),
        parent: typeof vd.parent === 'string' ? vd.parent : null,
        years: vd.years !== undefined && vd.years !== null ? String(vd.years) : null,
        status: vd.status || (todo ? 'todo' : null),
        todo,
        networks,
        protocols: asArray(vd.protocols).map(String),
      };
    }
  }
  return out;
}

export function normalizeNode(name, raw) {
  const issues = [];
  const d = isObj(raw) ? raw : {};
  const ids = {};
  if (isObj(d.id)) for (const [net, v] of Object.entries(d.id)) { const n = parseIntLoose(v); if (n !== null) ids[net] = n; }
  else if (d.id !== undefined) { const n = parseIntLoose(d.id); if (n !== null) ids['*'] = n; }
  let diag = null;
  if (isObj(d.diag)) {
    diag = { ...d.diag };
    for (const k of ['request_id', 'response_id', 'kline_address', 'obd_request_id', 'obd_response_id']) {
      if (diag[k] !== undefined) diag[k] = parseIntLoose(diag[k]);
    }
  }
  return {
    name: String(name),
    buses: asArray(d.bus).map(String),
    ids,
    alt: asArray(d.alt).map(String),
    title: toMl(d.name),
    comment: toMl(d.comment),
    released: d.released !== false,
    diag,
    legacyDiag: { services: d.diag_services || null, sessions: d.diag_sessions || null, reset: d.diag_reset || null },
    issues,
    raw: d,
  };
}

export function normalizeCar(project, raw) {
  const issues = [];
  const d = isObj(raw) ? raw : {};
  const codes = [];
  if (isObj(d.codes)) {
    for (const [code, names] of Object.entries(d.codes)) {
      codes.push({ code: String(code), names: asArray(names).filter((x) => x !== null && x !== undefined).map(String) });
    }
  } else issues.push(W('warning', 'missing codes'));
  const versions = [];
  if (isObj(d.versions)) {
    for (const [vname, v] of Object.entries(d.versions)) {
      const vd = isObj(v) ? v : {};
      const nodes = {};
      if (isObj(vd.nodes)) for (const [net, list] of Object.entries(vd.nodes)) nodes[net] = asArray(list).map(String);
      versions.push({
        name: String(vname),
        architecture: vd.architecture ? String(vd.architecture) : 'none',
        years: vd.years !== undefined && vd.years !== null ? String(vd.years) : null,
        codes: asArray(vd.codes).map(String),
        comment: toMl(vd.comment),
        nodes,
        optional: asArray(vd.optional_nodes).map(String),
      });
    }
  } else issues.push(W('warning', 'missing versions'));
  // brand: explicit list, otherwise guessed from names
  let brands = asArray(d.brand).map((b) => String(b).toLowerCase());
  if (!brands.length) {
    const guess = new Set();
    for (const c of codes) for (const n of c.names) {
      const w = n.trim().split(/\s+/)[0].toLowerCase();
      if (['peugeot', 'citroen', 'citroën', 'ds', 'opel', 'vauxhall', 'toyota', 'fiat', 'mitsubishi', 'dongfeng'].includes(w)) guess.add(w.replace('ë', 'e'));
    }
    brands = [...guess];
  }
  return {
    project: String(project),
    codes,
    brands,
    names: asArray(d.names).map(String),
    platform: d.platform ? String(d.platform) : null,
    years: d.years !== undefined && d.years !== null ? String(d.years) : null,
    comment: toMl(d.comment),
    versions,
    issues,
  };
}
