// ISO 15765-2 (ISO-TP / CAN-TP) segmentation and reassembly.

/**
 * Segment a payload into CAN frames.
 * opts: { addressing: 'normal'|'extended'|'mixed', address, padding (byte|null), canDl (8) }
 * Returns { frames: [{kind:'SF'|'FF'|'CF', data:Uint8Array, sn?}], needsFlowControl }
 */
export function segment(payload, opts = {}) {
  const data = payload instanceof Uint8Array ? payload : Uint8Array.from(payload || []);
  const ext = opts.addressing === 'extended' || opts.addressing === 'mixed';
  const addr = ext ? [(opts.address ?? 0) & 0xFF] : [];
  const pad = opts.padding === undefined ? 0x00 : opts.padding;
  const dl = opts.canDl || 8;
  const room = dl - addr.length;
  const finish = (bytes) => {
    const arr = [...addr, ...bytes];
    if (pad !== null && arr.length < dl) while (arr.length < dl) arr.push(pad & 0xFF);
    return Uint8Array.from(arr);
  };
  const frames = [];
  const len = data.length;
  if (len <= room - 1 && len <= 7) {
    frames.push({ kind: 'SF', data: finish([len, ...data]) });
    return { frames, needsFlowControl: false };
  }
  let offset;
  if (len <= 4095) {
    const ffData = [0x10 | ((len >> 8) & 0x0F), len & 0xFF];
    const n = room - 2;
    ffData.push(...data.slice(0, n));
    frames.push({ kind: 'FF', data: finish(ffData) });
    offset = n;
  } else {
    // escape sequence (ISO 15765-2:2016) for > 4095 bytes
    const ffData = [0x10, 0x00, (len >>> 24) & 0xFF, (len >>> 16) & 0xFF, (len >>> 8) & 0xFF, len & 0xFF];
    const n = room - 6;
    ffData.push(...data.slice(0, n));
    frames.push({ kind: 'FF', data: finish(ffData) });
    offset = n;
  }
  let sn = 1;
  while (offset < len) {
    const n = room - 1;
    frames.push({ kind: 'CF', sn, data: finish([0x20 | sn, ...data.slice(offset, offset + n)]) });
    offset += n;
    sn = (sn + 1) & 0x0F;
  }
  return { frames, needsFlowControl: true };
}

/** Flow control frame sent by the receiver. fs: 0 = continue, 1 = wait, 2 = overflow */
export function flowControl(opts = {}) {
  const ext = opts.addressing === 'extended' || opts.addressing === 'mixed';
  const arr = [...(ext ? [(opts.address ?? 0) & 0xFF] : []), 0x30 | ((opts.fs || 0) & 0x0F), (opts.blockSize ?? 0) & 0xFF, (opts.stMin ?? 0) & 0xFF];
  const pad = opts.padding === undefined ? 0x00 : opts.padding;
  if (pad !== null) while (arr.length < 8) arr.push(pad & 0xFF);
  return Uint8Array.from(arr);
}

export function describeStMin(v) {
  if (v <= 0x7F) return `${v} ms`;
  if (v >= 0xF1 && v <= 0xF9) return `${(v - 0xF0) * 100} µs`;
  return 'reserved (use 127 ms)';
}

/** Decode the PCI of one frame. */
export function parsePci(bytes, opts = {}) {
  const o = opts.addressing === 'extended' || opts.addressing === 'mixed' ? 1 : 0;
  const b0 = bytes[o];
  if (b0 === undefined) return { kind: 'invalid' };
  const t = b0 >> 4;
  if (t === 0) {
    const len = b0 & 0x0F;
    if (len === 0 && bytes.length > o + 1) { const l2 = bytes[o + 1]; return { kind: 'SF', length: l2, data: bytes.slice(o + 2, o + 2 + l2) }; }
    return { kind: 'SF', length: len, data: bytes.slice(o + 1, o + 1 + len) };
  }
  if (t === 1) {
    let len = ((b0 & 0x0F) << 8) | (bytes[o + 1] ?? 0);
    let start = o + 2;
    if (len === 0) { len = ((bytes[o + 2] << 24) | (bytes[o + 3] << 16) | (bytes[o + 4] << 8) | bytes[o + 5]) >>> 0; start = o + 6; }
    return { kind: 'FF', length: len, data: bytes.slice(start) };
  }
  if (t === 2) return { kind: 'CF', sn: b0 & 0x0F, data: bytes.slice(o + 1) };
  if (t === 3) return { kind: 'FC', fs: b0 & 0x0F, blockSize: bytes[o + 1] ?? 0, stMin: bytes[o + 2] ?? 0 };
  return { kind: 'invalid' };
}

/**
 * Reassembler for a stream of frames of one CAN ID.
 * push(bytes) returns a completed payload (Uint8Array) or null.
 */
export class Reassembler {
  constructor(opts = {}) { this.opts = opts; this.reset(); }
  reset() { this.buf = null; this.expected = 0; this.nextSn = 1; this.errors = []; }
  push(bytes) {
    const p = parsePci(bytes, this.opts);
    if (p.kind === 'SF') { this.reset(); return p.data; }
    if (p.kind === 'FF') {
      this.buf = Array.from(p.data);
      this.expected = p.length;
      this.nextSn = 1;
      if (this.buf.length >= this.expected) { const r = Uint8Array.from(this.buf.slice(0, this.expected)); this.buf = null; return r; }
      return null;
    }
    if (p.kind === 'CF') {
      if (!this.buf) return null;
      if (p.sn !== this.nextSn) { this.errors.push(`sequence error: got ${p.sn}, expected ${this.nextSn}`); this.buf = null; return null; }
      this.nextSn = (this.nextSn + 1) & 0x0F;
      this.buf.push(...p.data);
      if (this.buf.length >= this.expected) { const r = Uint8Array.from(this.buf.slice(0, this.expected)); this.buf = null; return r; }
    }
    return null;
  }
}
