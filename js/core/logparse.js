// Bus log parsing (candump, SavvyCAN/GVRET CSV, Vector ASC, plain ID#DATA) and statistics.

import { parseHexBytes } from './util.js';

/** A parsed frame: { ts (seconds|null), iface, id, ext, rtr, data: Uint8Array, dir, line } */

const RE_CANDUMP_L = /^\s*\((\d+(?:\.\d+)?)\)\s+(\S+)\s+([0-9A-Fa-f]{1,8})#(R\d?|#[0-9A-Fa-f]?[0-9A-Fa-f.]*|[0-9A-Fa-f.]*)\s*(?:[RT])?\s*$/;
const RE_CANDUMP = /^\s*(?:\((\d+(?:\.\d+)?)\)\s+)?([A-Za-z]\w*)\s+([0-9A-Fa-f]{1,8})\s+\[(\d{1,2})\]\s*((?:[0-9A-Fa-f]{2}\s*)*|remote request)\s*(?:'.*')?\s*$/;
const RE_PLAIN = /^\s*(?:(\d+(?:\.\d+)?)[\s,;]+)?(?:0x)?([0-9A-Fa-f]{1,8})\s*(?:#|:|\s)\s*((?:[0-9A-Fa-f]{2}[\s.]*)*)\s*$/;
const RE_ASC = /^\s*(\d+\.\d+)\s+(\d+|CANFD\s+\d+)\s+([0-9A-Fa-f]{1,8})(x?)\s+(Rx|Tx)\s+([dr])\s+(\d+)\s*((?:[0-9A-Fa-f]{2}\s*)*)/i;
const RE_ASC_FD = /^\s*(\d+\.\d+)\s+CANFD\s+(\d+)\s+(Rx|Tx)\s+([0-9A-Fa-f]{1,8})(x?)\s+(?:\S+\s+)?(\d)\s+(\d)\s+([0-9a-fA-F]+)\s+(\d+)\s+((?:[0-9A-Fa-f]{2}\s*)*)/i;

function hexData(s) {
  const b = parseHexBytes((s || '').replace(/\./g, ''));
  return b || new Uint8Array(0);
}

/** Detect the log format from the first lines. */
export function detectFormat(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim()).slice(0, 40);
  if (!lines.length) return 'empty';
  if (lines.some((l) => /^\s*Time Stamp\s*,\s*ID/i.test(l))) return 'savvycan';
  if (lines.some((l) => /^\s*(date|base\s+hex|internal events|begin triggerblock)/i.test(l)) || lines.some((l) => RE_ASC.test(l))) return 'asc';
  if (lines.some((l) => RE_CANDUMP_L.test(l))) return 'candump-l';
  if (lines.some((l) => RE_CANDUMP.test(l))) return 'candump';
  if (lines.some((l) => RE_PLAIN.test(l))) return 'plain';
  return 'unknown';
}

function parseSavvy(lines, out, errors) {
  let cols = null;
  let tsDiv = 1e6;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const parts = line.split(',').map((x) => x.trim());
    if (/^time stamp$/i.test(parts[0])) {
      cols = {};
      parts.forEach((p, j) => { cols[p.toLowerCase()] = j; });
      continue;
    }
    if (!cols) { errors.push({ line: i + 1, text: line }); continue; }
    const id = parseInt(parts[cols.id], 16);
    const len = parseInt(parts[cols.len ?? cols.dlc], 10);
    const d1 = cols.d1 ?? (cols.len ?? cols.dlc) + 1;
    if (!Number.isFinite(id) || !Number.isFinite(len)) { errors.push({ line: i + 1, text: line }); continue; }
    const data = new Uint8Array(Math.max(0, Math.min(64, len)));
    for (let k = 0; k < data.length; k++) data[k] = parseInt(parts[d1 + k], 16) || 0;
    const tsRaw = Number(parts[cols['time stamp']]);
    out.push({
      ts: Number.isFinite(tsRaw) ? tsRaw / tsDiv : null,
      iface: cols.bus !== undefined ? `bus${parts[cols.bus]}` : '',
      id, ext: /true|1/i.test(parts[cols.extended] || '') || id > 0x7FF, rtr: false, data,
      dir: cols.dir !== undefined ? parts[cols.dir] : '', line: i + 1,
    });
  }
}

/**
 * Parse a log. Returns { format, frames: [...], errors: [{line, text}] }
 * format can be forced ('candump-l', 'candump', 'savvycan', 'asc', 'plain').
 */
export function parseLog(text, format = 'auto') {
  const fmt = format === 'auto' ? detectFormat(text) : format;
  const lines = String(text).split(/\r?\n/);
  const frames = [];
  const errors = [];
  if (fmt === 'savvycan') { parseSavvy(lines, frames, errors); return { format: fmt, frames, errors }; }
  let hexBase = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    let m;
    if (fmt === 'asc') {
      if (/^base\s+dec/i.test(t)) hexBase = false;
      if (/^base\s+hex/i.test(t)) hexBase = true;
      if ((m = RE_ASC_FD.exec(line))) {
        const id = hexBase ? parseInt(m[4], 16) : parseInt(m[4], 10);
        frames.push({ ts: parseFloat(m[1]), iface: `ch${m[2]}`, id, ext: !!m[5], rtr: false, data: hexData(m[10]).slice(0, parseInt(m[9], 10)), dir: m[3], line: i + 1 });
        continue;
      }
      if ((m = RE_ASC.exec(line))) {
        const id = hexBase ? parseInt(m[3], 16) : parseInt(m[3], 10);
        const dlc = parseInt(m[7], 10);
        const rtr = m[6].toLowerCase() === 'r';
        frames.push({ ts: parseFloat(m[1]), iface: `ch${String(m[2]).replace(/\D/g, '')}`, id, ext: !!m[4], rtr, data: rtr ? new Uint8Array(0) : hexData(m[8]).slice(0, dlc), dir: m[5], line: i + 1 });
        continue;
      }
      if (/^(date|base|internal|begin|end|\d+\.\d+\s+(start|statistic|error|sv:|\d+\s+statistic))/i.test(t) || /ErrorFrame|Statistic|J1939|log trigger/i.test(t)) continue;
      errors.push({ line: i + 1, text: line });
      continue;
    }
    if ((m = RE_CANDUMP_L.exec(line))) {
      const payload = m[4];
      const rtr = /^R/.test(payload);
      const fd = payload.startsWith('#');
      const dataHex = fd ? payload.slice(2) : rtr ? '' : payload;
      frames.push({ ts: parseFloat(m[1]), iface: m[2], id: parseInt(m[3], 16), ext: m[3].length > 3, rtr, data: hexData(dataHex), dir: '', line: i + 1 });
      continue;
    }
    if ((m = RE_CANDUMP.exec(line))) {
      const rtr = /remote/.test(m[5]);
      frames.push({ ts: m[1] ? parseFloat(m[1]) : null, iface: m[2], id: parseInt(m[3], 16), ext: m[3].length > 3, rtr, data: rtr ? new Uint8Array(0) : hexData(m[5]).slice(0, parseInt(m[4], 10)), dir: '', line: i + 1 });
      continue;
    }
    if ((m = RE_PLAIN.exec(line))) {
      frames.push({ ts: m[1] ? parseFloat(m[1]) : null, iface: '', id: parseInt(m[2], 16), ext: m[2].length > 3, rtr: false, data: hexData(m[3]), dir: '', line: i + 1 });
      continue;
    }
    errors.push({ line: i + 1, text: line });
  }
  return { format: fmt, frames, errors };
}

/**
 * Per-ID statistics.
 * Returns Map id -> { id, count, first, last, periods: {mean,min,max}, dlcs:Set, bitChanges: Int32Array(64*8), bytesSeen, lastData, changingBytes }
 */
export function logStats(frames) {
  const m = new Map();
  for (const f of frames) {
    const key = f.id + (f.ext ? 0x100000000 : 0);
    let s = m.get(key);
    if (!s) {
      s = { id: f.id, ext: f.ext, count: 0, first: f.ts, last: f.ts, lastTs: null, dts: [], dlcs: new Set(), maxLen: 0, bitChanges: new Uint32Array(64 * 8), prev: null, firstData: f.data, lastData: f.data, distinct: new Set() };
      m.set(key, s);
    }
    s.count++;
    s.dlcs.add(f.data.length);
    s.maxLen = Math.max(s.maxLen, f.data.length);
    if (f.ts !== null && f.ts !== undefined) {
      if (s.lastTs !== null && f.ts >= s.lastTs) s.dts.push(f.ts - s.lastTs);
      s.lastTs = f.ts;
      if (s.first === null) s.first = f.ts;
      s.last = f.ts;
    }
    if (s.prev) {
      const n = Math.min(64, Math.max(s.prev.length, f.data.length));
      for (let b = 0; b < n; b++) {
        const x = (s.prev[b] ?? 0) ^ (f.data[b] ?? 0);
        if (!x) continue;
        for (let k = 0; k < 8; k++) if (x & (0x80 >> k)) s.bitChanges[b * 8 + k]++;
      }
    }
    if (s.distinct.size < 1000) s.distinct.add(Array.from(f.data).join(','));
    s.prev = f.data;
    s.lastData = f.data;
  }
  for (const s of m.values()) {
    if (s.dts.length) {
      const sorted = [...s.dts].sort((a, b) => a - b);
      const sum = s.dts.reduce((a, b) => a + b, 0);
      s.period = {
        mean: (sum / s.dts.length) * 1000,
        median: sorted[Math.floor(sorted.length / 2)] * 1000,
        min: sorted[0] * 1000,
        max: sorted[sorted.length - 1] * 1000,
      };
    } else s.period = null;
    s.distinctCount = s.distinct.size;
    delete s.distinct;
    delete s.prev;
    delete s.dts;
  }
  return m;
}

/** Compare a measured period with the documented one: 'ok' | 'fast' | 'slow' | null */
export function periodVerdict(measuredMs, documentedMs) {
  if (!measuredMs || !documentedMs) return null;
  const r = measuredMs / documentedMs;
  if (r < 0.8) return 'fast';
  if (r > 1.25) return 'slow';
  return 'ok';
}
