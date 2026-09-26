// PSA UDS/KWP SecurityAccess seed -> key algorithm.
// Port of PSA-RE/sandbox/uds_auth_algorithm.py (reference implementation, same results).
// The seed is 4 bytes (sent by the ECU), the application key is 2 bytes (ECU specific constant).

const SEC_1 = [0xB2, 0x3F, 0xAA];
const SEC_2 = [0xB1, 0x02, 0xAB];

function pymod(a, b) { return ((a % b) + b) % b; }

/** 16 bit transform (Python semantics of the reference implementation). */
export function transform(data, sec) {
  let d = data & 0xFFFF;
  if (d > 32767) d -= 65536;
  const q = d > 0 ? pymod(d, sec[0]) : pymod(d, sec[0]) - sec[0];
  const a = (q * sec[2]) >>> 0;
  const t = Math.trunc(d / sec[0]) >>> 0;
  const b = (t * sec[1]) % 4294967296;
  let sub = (a - b) >>> 0;
  if (sub > 0x7FFFFFFF) sub = sub + sec[0] * sec[2] + sec[1];
  return sub & 0xFFFF;
}

function toBytes(v, n) {
  if (typeof v === 'string') {
    const h = v.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
    if (h.length !== n * 2) return null;
    const out = [];
    for (let i = 0; i < n; i++) out.push(parseInt(h.substr(i * 2, 2), 16));
    return out;
  }
  if (Array.isArray(v) || v instanceof Uint8Array) return v.length === n ? Array.from(v) : null;
  return null;
}

/**
 * Compute the key.
 * @param seed 4 bytes (hex string "11223344" or byte array)
 * @param appKey 2 bytes (hex string "B2B2" or byte array)
 * @returns Uint8Array(4) or null on bad input
 */
export function computeKey(seed, appKey) {
  const s = toBytes(seed, 4);
  const k = toBytes(appKey, 2);
  if (!s || !k) return null;
  const msb = transform((k[0] << 8) | k[1], SEC_1) | transform((s[0] << 8) | s[3], SEC_2);
  const lsb = transform((s[1] << 8) | s[2], SEC_1) | transform(msb, SEC_2);
  return Uint8Array.from([(msb >> 8) & 0xFF, msb & 0xFF, (lsb >> 8) & 0xFF, lsb & 0xFF]);
}

export const ALGORITHM_DESCRIPTION = `transform(data16, sec):            # data16 read as signed 16 bit
    result = (data % sec[0]) * sec[2] - (data / sec[0]) * sec[1]   # C truncating division
    if result < 0: result += sec[0] * sec[2] + sec[1]
    return result & 0xFFFF

sec_1 = [0xB2, 0x3F, 0xAA];  sec_2 = [0xB1, 0x02, 0xAB]
msb = transform(appkey[0..1], sec_1) | transform(seed[0], seed[3], sec_2)
lsb = transform(seed[1], seed[2], sec_1) | transform(msb, sec_2)
key = msb (2 bytes) + lsb (2 bytes)`;
