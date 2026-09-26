// Decoding / encoding of frame payloads according to normalized signals.

import { resolveRange, extractBits, insertBits, extractRange, insertRange } from './bits.js';
import { ml, fmtNum, hexByte } from './util.js';

function toSigned(raw, width) {
  if (typeof raw === 'bigint') {
    const top = 1n << BigInt(width - 1);
    return raw & top ? raw - (1n << BigInt(width)) : raw;
  }
  if (width >= 53) return raw;
  const top = 2 ** (width - 1);
  return raw >= top ? raw - 2 ** width : raw;
}

function fromSigned(v, width) {
  if (typeof v === 'bigint') return v < 0n ? v + (1n << BigInt(width)) : v;
  return v < 0 ? v + 2 ** width : v;
}

function rawBytes(bytes, start, end) {
  // bytes covering the range (MSB first); non aligned ranges are re-packed
  const width = end - start + 1;
  const n = Math.ceil(width / 8);
  const out = new Uint8Array(n);
  if (start % 8 === 0 && width % 8 === 0) {
    for (let i = 0; i < n; i++) out[i] = bytes[(start >> 3) + i] ?? 0;
    return out;
  }
  // left-aligned repack
  for (let i = 0; i < n; i++) {
    const s = start + i * 8;
    const e = Math.min(end, s + 7);
    const v = Number(extractBits(bytes, s, e));
    out[i] = (v << (7 - (e - s))) & 0xFF;
  }
  return out;
}

export function latin1(bytes) {
  let s = '';
  for (const b of bytes) s += b >= 0x20 && b !== 0x7F ? String.fromCharCode(b) : (b === 0 ? '' : '·');
  return s;
}

export function valueLabel(sig, raw, lang) {
  if (!sig.values || !sig.values.length) return null;
  const n = typeof raw === 'bigint' ? (raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : null) : raw;
  if (n === null) return null;
  const v = sig.values.find((x) => x.raw === n);
  if (!v) return null;
  return { text: v.text ? ml(v.text, lang) : (v.unused ? 'unused' : ''), unused: v.unused };
}

/**
 * Decode one signal from a payload.
 * Returns { name, present, raw, rawHex, value, phys, text, label, flags[], start, end }
 */
export function decodeSignal(sig, bytes, lang = 'en') {
  const res = { name: sig.name, sig, present: false, raw: null, rawHex: '', value: null, phys: null, text: '', label: null, flags: [] };
  if (!sig.pos) { res.flags.push('bad-bits'); return res; }
  const r = resolveRange(sig.pos, bytes.length);
  res.start = r.start; res.end = r.end;
  const avail = bytes.length * 8;
  if (r.start >= avail) { res.flags.push('absent'); return res; }
  let end = r.end;
  if (end >= avail) { res.flags.push('truncated'); end = avail - 1; }
  const width = end - r.start + 1;
  res.present = true;
  const le = !!sig.littleEndian && end === r.end;
  const t = sig.type;
  if (t === 'str' || t === 'bytes' || (width > 64 && t !== 'bcd')) {
    const b = rawBytes(bytes, r.start, end);
    res.bytes = b;
    res.raw = width <= 64 ? extractRange(bytes, r.start, end, le) : null;
    res.rawHex = b.length <= 16 ? '0x' + Array.from(b, hexByte).join('') : `${b.length} bytes`;
    if (t === 'str') { res.value = latin1(b); res.text = JSON.stringify(res.value); }
    else { res.value = Array.from(b, hexByte).join(' '); res.text = res.value; }
    return res;
  }
  const raw = extractRange(bytes, r.start, end, le);
  res.raw = raw;
  res.rawHex = '0x' + raw.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0');
  if (t === 'bcd') {
    const digits = raw.toString(16).padStart(Math.ceil(width / 4), '0');
    res.value = digits;
    if (/[a-f]/i.test(digits)) res.flags.push('bad-bcd');
    const n = parseInt(digits, 10);
    res.phys = Number.isFinite(n) ? n * sig.factor + sig.offset : null;
    res.text = res.phys !== null ? fmtNum(res.phys) : digits.toUpperCase();
  } else if (t === 'float' && (width === 32 || width === 64)) {
    const dv = new DataView(new ArrayBuffer(8));
    let f;
    if (width === 32) { dv.setUint32(0, Number(raw)); f = dv.getFloat32(0); }
    else { dv.setBigUint64(0, BigInt(raw)); f = dv.getFloat64(0); }
    res.value = f;
    res.phys = f * sig.factor + sig.offset;
    res.text = fmtNum(res.phys);
  } else {
    let v = raw;
    if (t === 'sint') v = toSigned(raw, width);
    res.value = v;
    if (typeof v === 'bigint') {
      res.phys = sig.factor === 1 && sig.offset === 0 ? v : Number(v) * sig.factor + sig.offset;
    } else {
      res.phys = v * sig.factor + sig.offset;
    }
    res.text = fmtNum(res.phys) + (sig.units ? ' ' + sig.units : '');
  }
  const lab = valueLabel(sig, raw, lang);
  if (lab) { res.label = lab.text; if (lab.unused) res.flags.push('unused-value'); }
  else if (sig.values.length && (sig.type === 'enum' || !sig.hasFactor)) res.flags.push('unknown-value');
  const rawNum = typeof raw === 'bigint' ? null : raw;
  if (rawNum !== null && sig.invalid.includes(rawNum)) res.flags.push('invalid');
  if (rawNum !== null && sig.default !== null && sig.default === rawNum) res.flags.push('default');
  if (typeof res.phys === 'number' && !res.flags.includes('invalid')) {
    const eps = Math.abs(sig.factor) * 1e-6;
    if (sig.min !== null && res.phys < sig.min - eps) res.flags.push('below-min');
    if (sig.max !== null && res.phys > sig.max + eps) res.flags.push('above-max');
  }
  return res;
}

/**
 * Decode a frame. Mux handling: selectors are decoded first; multiplexed signals
 * whose selector value doesn't match are returned with active=false.
 */
export function decodeFrame(frame, bytes, lang = 'en', signals = null) {
  const sigs = signals || frame.signals;
  const out = [];
  const muxState = {};
  for (const s of sigs) {
    if (s.muxSelector) {
      const d = decodeSignal(s, bytes, lang);
      if (d.present && typeof d.raw === 'number') muxState[s.name] = d.raw;
    }
  }
  for (const s of sigs) {
    const d = decodeSignal(s, bytes, lang);
    d.active = true;
    if (s.mux && muxState[s.mux.selector] !== undefined && !s.mux.values.includes(muxState[s.mux.selector])) d.active = false;
    out.push(d);
  }
  const flags = [];
  if (frame.length && !frame.variable && bytes.length !== frame.length) {
    if (!(frame.lengthMin && bytes.length >= frame.lengthMin && bytes.length <= frame.length)) flags.push(bytes.length < frame.length ? 'short' : 'long');
  }
  return { signals: out, muxState, flags };
}

/** Maximum raw value of a signal width (Number, or BigInt when > 53 bits). */
export function maxRaw(width) { return width <= 53 ? 2 ** width - 1 : (1n << BigInt(width)) - 1n; }

/** Physical value -> raw (clamped, two's complement for sint). */
export function physToRaw(sig, phys, width = sig.width) {
  let v = Number(phys);
  if (!Number.isFinite(v)) v = 0;
  let raw = Math.round((v - sig.offset) / (sig.factor || 1));
  if (sig.type === 'sint') {
    const lo = -(2 ** (width - 1));
    const hi = 2 ** (width - 1) - 1;
    raw = Math.min(hi, Math.max(lo, raw));
    return fromSigned(raw, width);
  }
  if (sig.type === 'bcd') {
    const digits = Math.ceil(width / 4);
    const s = String(Math.max(0, raw)).padStart(digits, '0').slice(-digits);
    return parseInt(s, 16);
  }
  const hi = width <= 53 ? 2 ** width - 1 : Number.MAX_SAFE_INTEGER;
  return Math.min(hi, Math.max(0, raw));
}

export function rawToPhys(sig, raw, width = sig.width) {
  let v = typeof raw === 'bigint' ? Number(raw) : raw;
  if (sig.type === 'sint') v = toSigned(v, width);
  if (sig.type === 'bcd') v = parseInt(v.toString(16), 10);
  return v * sig.factor + sig.offset;
}

/** Initial raw value for a signal when building a payload. */
export function defaultRaw(sig) {
  if (sig.default !== null && sig.default !== undefined) return sig.default;
  if (sig.unused) return 0;
  return 0;
}

/**
 * Write a signal into a payload.
 * value: Number/BigInt raw value, or for str a string, for bytes a hex string / byte array.
 */
export function encodeSignal(bytes, sig, value) {
  if (!sig.pos) return;
  const r = resolveRange(sig.pos, bytes.length);
  const end = Math.min(r.end, bytes.length * 8 - 1);
  if (end < r.start) return;
  const width = end - r.start + 1;
  if (sig.type === 'str' || sig.type === 'bytes' || (width > 53 && typeof value !== 'bigint' && typeof value !== 'number')) {
    let arr;
    if (typeof value === 'string' && sig.type === 'str') arr = Array.from(value, (c) => c.charCodeAt(0) & 0xFF);
    else if (typeof value === 'string') arr = (value.replace(/[^0-9a-f]/gi, '').match(/../g) || []).map((x) => parseInt(x, 16));
    else arr = Array.from(value || []);
    const n = Math.ceil(width / 8);
    if (r.start % 8 === 0 && width % 8 === 0) {
      for (let i = 0; i < n; i++) bytes[(r.start >> 3) + i] = (arr[i] ?? 0) & 0xFF;
      return;
    }
    let big = 0n;
    for (let i = 0; i < n; i++) big = (big << 8n) | BigInt(arr[i] ?? 0);
    const extra = n * 8 - width;
    big >>= BigInt(extra);
    insertBits(bytes, r.start, end, big);
    return;
  }
  insertRange(bytes, r.start, end, value, !!sig.littleEndian && end === r.end);
}

/** Build a payload from {signalName: raw}. Missing signals get their default raw value. */
export function encodeFrame(frame, rawValues = {}, length = frame.length, signals = null) {
  const bytes = new Uint8Array(Math.max(0, length || 0));
  for (const s of signals || frame.signals) {
    const v = Object.prototype.hasOwnProperty.call(rawValues, s.name) ? rawValues[s.name] : defaultRaw(s);
    if (v === null || v === undefined) continue;
    encodeSignal(bytes, s, v);
  }
  return bytes;
}

export const FLAG_TEXT = {
  invalid: 'invalid / not available value',
  'below-min': 'below documented minimum',
  'above-max': 'above documented maximum',
  'unknown-value': 'value not in the value table',
  'unused-value': 'value documented as unused',
  default: 'default value (data not available yet)',
  truncated: 'payload shorter than the signal',
  absent: 'signal beyond the payload',
  'bad-bcd': 'not a valid BCD value',
  'bad-bits': 'invalid bit position',
};
