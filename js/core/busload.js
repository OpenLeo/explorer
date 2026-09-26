// Bus load estimation from documented periods, lengths and bitrate.

/** Worst-case bits on the wire for one CAN 2.0 frame (incl. bit stuffing, 3 bit interframe space). */
export function canFrameBits(dataBytes, extended = false, worstCase = true) {
  const n = Math.max(0, Math.min(8, dataBytes));
  const g = extended ? 54 : 34; // bits subject to stuffing besides data
  const fixed = extended ? 67 : 47; // total without stuffing, incl. EOF + IFS (= g + 13)
  const stuff = worstCase ? Math.floor((g + 8 * n - 1) / 4) : 0;
  return fixed + 8 * n + stuff;
}

/** VAN frame duration in time slots (E-Manchester: 4 bits -> 5 TS). Approximation. */
export function vanFrameTs(dataBytes) {
  const n = Math.max(0, Math.min(28, dataBytes));
  // SOF 10 TS, IDEN 12 bits, COM 4 bits, data, FCS 15 bits (E-Manchester), EOD 2, ACK 2, EOF 8, IFS 8
  const bits = 12 + 4 + 8 * n + 15;
  return 10 + Math.ceil(bits * 5 / 4) + 2 + 2 + 8 + 8;
}

/** LIN frame nominal bits (header + response), and max with 40% tolerance. */
export function linFrameBits(dataBytes) {
  const n = Math.max(1, Math.min(8, dataBytes));
  const nominal = 34 + 10 * (n + 1);
  return { nominal, max: Math.ceil(nominal * 1.4) };
}

export const DEFAULT_BITRATES = { CAN: 500, 'CAN-FD': 500, VAN: 125, LIN: 19.2, 'K-LINE': 10.4 };

/**
 * Estimate the load of a bus.
 * frames: normalized frames; opts: { bitrate (kbit/s), protocol, eventRate: frames/s assumed for trigger-only frames }
 * Returns { rows: [{frame, bits, perSec, bps, share}], totalBps, load (0..1), bitrate, ignored: [...] }
 */
export function estimateLoad(frames, opts = {}) {
  const protocol = (opts.protocol || 'CAN').toUpperCase();
  const bitrate = (opts.bitrate || DEFAULT_BITRATES[protocol] || 500) * 1000;
  const eventRate = opts.eventRate || 0;
  const rows = [];
  const ignored = [];
  let total = 0;
  for (const f of frames) {
    let perSec = 0;
    if (f.periodMs) perSec = 1000 / f.periodMs;
    else if (f.trigger && eventRate) perSec = eventRate;
    if (!perSec) { ignored.push(f); continue; }
    let bits;
    if (protocol === 'VAN' || f.type === 'van') bits = vanFrameTs(f.length || 0);
    else if (protocol === 'LIN' || f.type === 'lin') bits = linFrameBits(f.length || 8).max;
    else if (f.type === 'can-tp') {
      // a can-tp payload is several frames (only if periodic)
      const count = f.length <= 7 ? 1 : 1 + Math.ceil(Math.max(0, f.length - 6) / 7);
      bits = count * canFrameBits(8, f.extended);
    } else bits = canFrameBits(f.length || 0, f.extended);
    const bps = bits * perSec;
    total += bps;
    rows.push({ frame: f, bits, perSec, bps });
  }
  for (const r of rows) r.share = total ? r.bps / total : 0;
  rows.sort((a, b) => b.bps - a.bps);
  return { rows, totalBps: total, load: total / bitrate, bitrate: bitrate / 1000, ignored };
}
