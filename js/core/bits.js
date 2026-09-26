// PSA bit notation helpers and raw bit extraction / insertion.
//
// PSA notation: '<byte>.<bit>' with bytes numbered from 1 (first transmitted)
// and bits from 7 (MSB, first transmitted) to 0. A range '<start>-<end>' is
// given in transmission order (big endian / Motorola): '1.7-2.0' is a 16 bit
// value whose MSB is byte 1 bit 7. '3.7-n' extends to the end of the payload.
//
// Internally we use an "absolute" index in transmission order (MSB0):
//   abs = (byte - 1) * 8 + (7 - bit)
// so a signal is simply the contiguous abs range [start..end], MSB first.

const BITS_RE = /^\s*(\d+)\.([0-7])\s*(?:-\s*(?:(\d+)\.([0-7])|([nN]))\s*)?$/;

export function absIndex(byte, bit) { return (byte - 1) * 8 + (7 - bit); }
export function absToByteBit(abs) { return { byte: Math.floor(abs / 8) + 1, bit: 7 - (abs % 8) }; }

/** Normalize the bits field: YAML may have turned '1.5' into the number 1.5 (or '1.0' into 1). */
export function normalizeBitsString(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (Number.isInteger(v)) return `${v}.0`;
    return String(v);
  }
  return String(v).trim();
}

/**
 * Parse PSA bit notation. Returns null when invalid.
 * { startByte, startBit, endByte, endBit, toEnd, start, end, width, text }
 * For '-n' ranges, end is computed from `length` (bytes) if given, else start + 7
 * (at least one byte, like tools/validate.py).
 */
/**
 * Legacy notations found in old files: '3' (whole byte 3), '1-2' (bytes 1 to 2),
 * '14.1-14-0' (typo). Returns the v0.2 equivalent or null.
 */
export function legacyBits(text) {
  if (text === null || text === undefined) return null;
  const t = String(text).trim();
  let m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(t);
  if (m && +m[1] >= 1) {
    const e = m[2] ? +m[2] : +m[1];
    if (e < +m[1]) return null;
    return `${m[1]}.7-${e}.0`;
  }
  m = /^(\d+)\.([0-7])-(\d+)[-,]([0-7])$/.exec(t);
  if (m) return `${m[1]}.${m[2]}-${m[3]}.${m[4]}`;
  m = /^(\d+),([0-7])(?:-(\d+),([0-7]))?$/.exec(t);
  if (m) return m[3] ? `${m[1]}.${m[2]}-${m[3]}.${m[4]}` : `${m[1]}.${m[2]}`;
  return null;
}

export function parseBits(bits, length) {
  let text = normalizeBitsString(bits);
  if (text === null) return null;
  let m = BITS_RE.exec(text);
  let legacy = false;
  if (!m && typeof bits === 'string') {
    const l = legacyBits(text);
    if (l) { m = BITS_RE.exec(l); legacy = text; text = l; }
  }
  if (!m) return null;
  const startByte = +m[1];
  const startBit = +m[2];
  if (startByte < 1) return null;
  const start = absIndex(startByte, startBit);
  let end;
  let toEnd = false;
  if (m[5]) {
    toEnd = true;
    end = length ? length * 8 - 1 : start + 7;
    if (end < start) end = start + 7 - (start % 8); // at least until the end of the start byte
  } else if (m[3]) {
    end = absIndex(+m[3], +m[4]);
  } else {
    end = start;
  }
  if (end < start) return null;
  const e = absToByteBit(end);
  return {
    startByte, startBit, endByte: e.byte, endBit: e.bit, toEnd,
    start, end, width: end - start + 1, text, legacy,
  };
}

/** Same as parseBits but tells why it failed. */
export function checkBits(bits) {
  const text = normalizeBitsString(bits);
  if (text === null || text === '') return 'missing bits';
  const m = BITS_RE.exec(text);
  if (!m && typeof bits === 'string' && legacyBits(text)) return null;
  if (!m) return `invalid bit notation '${text}' (expected <byte>.<bit>[-<byte>.<bit>|-n])`;
  if (+m[1] < 1) return `byte numbers start at 1 ('${text}')`;
  if (m[3] && absIndex(+m[3], +m[4]) < absIndex(+m[1], +m[2])) {
    return `bits '${text}' end before they start (ranges are <start>-<end> in transmission order, eg. 1.7-2.0)`;
  }
  return null;
}

/** Format an abs range back to PSA notation. */
export function formatBits(start, end, toEnd = false) {
  const s = absToByteBit(start);
  if (toEnd) return `${s.byte}.${s.bit}-n`;
  if (end === undefined || end === start) return `${s.byte}.${s.bit}`;
  const e = absToByteBit(end);
  return `${s.byte}.${s.bit}-${e.byte}.${e.bit}`;
}

/** Resolve a parsed position against an actual payload length (for '-n'). */
export function resolveRange(pos, lengthBytes) {
  if (!pos) return null;
  if (pos.toEnd) {
    const end = Math.max(pos.start, (lengthBytes || 0) * 8 - 1);
    return { start: pos.start, end, width: end - pos.start + 1 };
  }
  return { start: pos.start, end: pos.end, width: pos.width };
}

// ---------------------------------------------------------------------------
// DBC conversions
// Sawtooth (DBC) bit numbering: bit n = byte0 * 8 + bitInByte (0 = LSB).
// ---------------------------------------------------------------------------

export function absToSawtooth(abs) { return Math.floor(abs / 8) * 8 + (7 - (abs % 8)); }
export function sawtoothToAbs(n) { return Math.floor(n / 8) * 8 + (7 - (n % 8)); }

/** DBC Motorola (@0, Vector convention) start bit = sawtooth index of the MSB. */
export function dbcMotorolaStart(pos) { return absToSawtooth(pos.start); }
/** Motorola "LSB" start bit (used by some tools) = sawtooth index of the LSB. */
export function motorolaLsbStart(pos) { return absToSawtooth(pos.end); }

/** Intel (@1) start bit, only meaningful when the field stays inside one byte. */
export function intelStart(pos) {
  if (Math.floor(pos.start / 8) !== Math.floor(pos.end / 8)) return null;
  return absToSawtooth(pos.end);
}

/** DBC Motorola start bit (MSB, sawtooth) + length -> PSA notation. */
export function fromDbcMotorola(startBit, length) {
  if (!(startBit >= 0) || !(length >= 1)) return null;
  const start = sawtoothToAbs(startBit);
  return formatBits(start, start + length - 1);
}

/** Motorola LSB start bit (sawtooth) + length -> PSA notation. */
export function fromMotorolaLsb(lsbBit, length) {
  if (!(lsbBit >= 0) || !(length >= 1)) return null;
  const end = sawtoothToAbs(lsbBit);
  const start = end - length + 1;
  if (start < 0) return null;
  return formatBits(start, end);
}

/**
 * Intel (@1) start bit + length -> PSA notation. Intel fields crossing a byte
 * boundary are little endian and cannot be expressed as one PSA range: we then
 * return {psa: null, parts:[...]} with the per-byte pieces (LSB first).
 */
export function fromIntel(startBit, length) {
  if (!(startBit >= 0) || !(length >= 1)) return { psa: null, parts: [] };
  const last = startBit + length - 1;
  const parts = [];
  for (let b = Math.floor(startBit / 8); b <= Math.floor(last / 8); b++) {
    const lo = b === Math.floor(startBit / 8) ? startBit % 8 : 0;
    const hi = b === Math.floor(last / 8) ? last % 8 : 7;
    parts.push(hi === lo ? `${b + 1}.${hi}` : `${b + 1}.${hi}-${b + 1}.${lo}`);
  }
  return { psa: parts.length === 1 ? parts[0] : null, parts };
}

// ---------------------------------------------------------------------------
// Raw bit access
// ---------------------------------------------------------------------------

export function getBit(bytes, abs) {
  const byte = abs >> 3;
  if (byte >= bytes.length) return 0;
  return (bytes[byte] >> (7 - (abs & 7))) & 1;
}

export function setBit(bytes, abs, v) {
  const byte = abs >> 3;
  if (byte >= bytes.length) return;
  const mask = 1 << (7 - (abs & 7));
  if (v) bytes[byte] |= mask; else bytes[byte] &= ~mask & 0xFF;
}

/**
 * Extract the unsigned raw value of abs range [start..end] (MSB first).
 * Returns a Number for widths <= 53 bits, a BigInt otherwise.
 */
export function extractBits(bytes, start, end) {
  const width = end - start + 1;
  if (width <= 0) return 0;
  if (width <= 32) {
    let v = 0;
    let i = start;
    // fast path per byte chunk
    while (i <= end) {
      const byte = i >> 3;
      const hi = 7 - (i & 7); // bit position inside byte (7..0)
      const lastInByte = Math.min(end, (byte << 3) + 7);
      const n = lastInByte - i + 1;
      const lo = hi - n + 1;
      const b = byte < bytes.length ? bytes[byte] : 0;
      const chunk = (b >> lo) & ((1 << n) - 1);
      v = v * (1 << n) + chunk;
      i = lastInByte + 1;
    }
    return v;
  }
  let v = 0n;
  for (let i = start; i <= end; i++) v = (v << 1n) | BigInt(getBit(bytes, i));
  return width <= 53 ? Number(v) : v;
}

/** Insert an unsigned raw value (Number or BigInt) in abs range [start..end]. */
export function insertBits(bytes, start, end, value) {
  const width = end - start + 1;
  if (width <= 0) return;
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0));
  const mask = (1n << BigInt(width)) - 1n;
  v &= mask;
  for (let i = end; i >= start; i--) {
    setBit(bytes, i, Number(v & 1n));
    v >>= 1n;
  }
}

/**
 * Byte chunks of an abs range in transmission order: [{byte (0 based), hi, lo, n, shift}].
 * shift = position of the chunk inside the raw value:
 *  - big endian (PSA default): the first chunk holds the most significant bits
 *  - little endian: the first chunk holds the least significant bits (byte order reversed,
 *    bits inside each byte keep their order)
 */
export function rangeChunks(start, end, littleEndian = false) {
  const out = [];
  const width = end - start + 1;
  let consumed = 0;
  let i = start;
  while (i <= end) {
    const byte = i >> 3;
    const hi = 7 - (i & 7);
    const last = Math.min(end, (byte << 3) + 7);
    const n = last - i + 1;
    const lo = hi - n + 1;
    out.push({ byte, hi, lo, n, shift: littleEndian ? consumed : width - consumed - n });
    consumed += n;
    i = last + 1;
  }
  return out;
}

/** abs index of the MSB and LSB of a range (depends on the byte order). */
export function msbLsb(start, end, littleEndian = false) {
  if (!littleEndian || (start >> 3) === (end >> 3)) return { msb: start, lsb: end };
  const ch = rangeChunks(start, end, true);
  const first = ch[0];
  const lastc = ch[ch.length - 1];
  return { lsb: first.byte * 8 + (7 - first.lo), msb: lastc.byte * 8 + (7 - lastc.hi) };
}

/** Extract a range honoring the byte order. */
export function extractRange(bytes, start, end, littleEndian = false) {
  if (!littleEndian || (start >> 3) === (end >> 3)) return extractBits(bytes, start, end);
  const width = end - start + 1;
  const ch = rangeChunks(start, end, true);
  if (width <= 53) {
    let v = 0;
    for (const c of ch) {
      const b = c.byte < bytes.length ? bytes[c.byte] : 0;
      v += ((b >> c.lo) & ((1 << c.n) - 1)) * 2 ** c.shift;
    }
    return v;
  }
  let v = 0n;
  for (const c of ch) {
    const b = c.byte < bytes.length ? bytes[c.byte] : 0;
    v |= BigInt((b >> c.lo) & ((1 << c.n) - 1)) << BigInt(c.shift);
  }
  return v;
}

/** Insert a range honoring the byte order. */
export function insertRange(bytes, start, end, value, littleEndian = false) {
  if (!littleEndian || (start >> 3) === (end >> 3)) { insertBits(bytes, start, end, value); return; }
  const width = end - start + 1;
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0));
  v &= (1n << BigInt(width)) - 1n;
  for (const c of rangeChunks(start, end, true)) {
    if (c.byte >= bytes.length) continue;
    const part = Number((v >> BigInt(c.shift)) & ((1n << BigInt(c.n)) - 1n));
    const mask = ((1 << c.n) - 1) << c.lo;
    bytes[c.byte] = (bytes[c.byte] & ~mask & 0xFF) | ((part << c.lo) & mask);
  }
}

/** DBC Intel (@1) start bit of a little endian range, null when not representable. */
export function dbcIntelStart(pos) {
  const single = (pos.start >> 3) === (pos.end >> 3);
  if (!single && !(pos.startBit === 7 && pos.endBit === 0)) return null;
  const { lsb } = msbLsb(pos.start, pos.end, true);
  return absToSawtooth(lsb);
}

/** Human description of a position, eg. "byte 3, bits 7-6" or "bytes 1-2 (1.7 → 2.0)". */
export function describePos(pos, lang = 'en') {
  if (!pos) return '';
  const fr = lang === 'fr';
  const B = fr ? 'octet' : 'byte';
  const Bs = fr ? 'octets' : 'bytes';
  const b = fr ? 'bit' : 'bit';
  const bs = fr ? 'bits' : 'bits';
  if (pos.toEnd) return `${Bs} ${pos.startByte} → ${fr ? 'fin' : 'end'} (${fr ? 'depuis le bit' : 'from bit'} ${pos.startBit})`;
  if (pos.startByte === pos.endByte) {
    if (pos.width === 1) return `${B} ${pos.startByte}, ${b} ${pos.startBit}`;
    if (pos.width === 8) return `${B} ${pos.startByte}`;
    return `${B} ${pos.startByte}, ${bs} ${pos.startBit}-${pos.endBit}`;
  }
  if (pos.startBit === 7 && pos.endBit === 0) return `${Bs} ${pos.startByte}-${pos.endByte}`;
  return `${Bs} ${pos.startByte}-${pos.endByte} (${pos.startByte}.${pos.startBit} → ${pos.endByte}.${pos.endBit})`;
}
