// Bit layout grid (SavvyCAN / CANdb++ style): one row per byte, 8 bit columns (7..0),
// each signal a colored block; handles multi-byte Motorola signals, '-n' payloads,
// mux, unused bits, and collapses long uniform regions of big (can-tp/VAN) payloads.

import { html, raw } from './dom.js';
import { resolveRange, absToByteBit, getBit, msbLsb } from '../core/bits.js';
import { activeSignals } from '../core/normalize.js';
import { hexByte } from '../core/util.js';
import { t, valuesList, physText } from './widgets.js';

export function sigHue(i) { return Math.round((i * 137.508) % 360); }

/** Assign stable hues to signals of a frame (by index in the frame). */
export function hueMap(signals) {
  const m = new Map();
  signals.forEach((s, i) => m.set(s.name, sigHue(i)));
  return m;
}

/** Effective payload length used for the layout. */
export function layoutLength(frame, signals, bytes) {
  if (bytes) return bytes.length;
  let L = frame.length || 0;
  let maxEnd = -1;
  for (const s of signals) if (s.pos && !s.pos.toEnd) maxEnd = Math.max(maxEnd, s.pos.end);
  for (const s of signals) if (s.pos && s.pos.toEnd) maxEnd = Math.max(maxEnd, s.pos.start + 7);
  if (maxEnd >= 0) L = Math.max(L, Math.floor(maxEnd / 8) + 1);
  return Math.max(L, 1);
}

/**
 * Render the grid.
 * opts: { bytes, muxState, hues, flags: {name: [flags]}, idPrefix }
 */
export function renderGrid(frame, signals, opts = {}) {
  const bytes = opts.bytes || null;
  const hues = opts.hues || hueMap(signals);
  const act = activeSignals(signals, opts.muxState).filter((s) => s.pos);
  const L = layoutLength(frame, act, bytes);
  const nbits = L * 8;
  const owner = new Int32Array(nbits).fill(-1);
  const conflicts = new Set();
  const ranges = act.map((s) => resolveRange(s.pos, L));
  act.forEach((s, i) => {
    const r = ranges[i];
    for (let b = r.start; b <= Math.min(r.end, nbits - 1); b++) {
      if (owner[b] >= 0 && owner[b] !== i) conflicts.add(`${act[owner[b]].name} / ${s.name}`);
      else owner[b] = i;
    }
  });
  const outside = act.filter((s, i) => ranges[i].end >= nbits && !s.pos.toEnd);

  // row classification for compression
  const rowKind = (r) => {
    const o = owner[r * 8];
    for (let k = 1; k < 8; k++) if (owner[r * 8 + k] !== o) return null;
    if (o < 0) return 'free';
    const rg = ranges[o];
    if (rg.start < r * 8 && rg.end > r * 8 + 7) return `in${o}`;
    return null;
  };
  const rows = [];
  for (let r = 0; r < L;) {
    const k = rowKind(r);
    if (k) {
      let e = r;
      while (e + 1 < L && rowKind(e + 1) === k) e++;
      const minRun = k === 'free' ? 4 : 3;
      if (e - r + 1 >= minRun) {
        // keep the first row visible, collapse the rest except the last
        rows.push({ r });
        rows.push({ collapsed: true, from: r + 1, to: e - 1, kind: k });
        rows.push({ r: e });
        r = e + 1;
        continue;
      }
    }
    rows.push({ r });
    r++;
  }

  const cellFor = (r) => {
    const cells = [];
    let k = 0;
    while (k < 8) {
      const abs = r * 8 + k;
      const o = owner[abs];
      let e = k;
      while (e + 1 < 8 && owner[r * 8 + e + 1] === o) e++;
      const span = e - k + 1;
      const bitVals = bytes ? Array.from({ length: span }, (_, j) => getBit(bytes, abs + j)).join('') : '';
      if (o < 0) {
        cells.push(html`<td colspan="${span}" class="seg free" title="byte ${r + 1}, bits ${7 - k}${span > 1 ? '-' + (7 - e) : ''}: not documented">${bytes ? html`<span class="bitv">${bitVals}</span>` : ''}</td>`);
      } else {
        const s = act[o];
        const rg = ranges[o];
        const ml2 = msbLsb(rg.start, rg.end, !!s.littleEndian && !s.pos.toEnd);
        const hasMsb = ml2.msb >= abs && ml2.msb <= r * 8 + e;
        const hasLsb = ml2.lsb >= abs && ml2.lsb <= r * 8 + e;
        const isFirst = rg.start >= abs && rg.start <= r * 8 + e;
        const flags = opts.flags && opts.flags[s.name] ? opts.flags[s.name] : [];
        const bad = flags.some((f) => ['invalid', 'below-min', 'above-max', 'unknown-value', 'truncated'].includes(f));
        const cls = `seg sig${s.unused ? ' unused' : ''}${isFirst ? ' msb' : ' cont'}${hasLsb ? ' lsb' : ''}${bad ? ' flagged' : ''}${opts.selected === s.name ? ' hl' : ''}`;
        const p = absToByteBit(rg.start);
        const q = absToByteBit(Math.min(rg.end, nbits - 1));
        const title = `${s.name} (${s.pos.toEnd ? s.bits : `${p.byte}.${p.bit}-${q.byte}.${q.bit}`}, ${rg.width} bit${rg.width > 1 ? 's' : ''})${s.comment ? ' — ' + t(s.comment) : ''}`;
        cells.push(html`<td colspan="${span}" class="${cls}" style="--h:${hues.get(s.name) ?? 200}" data-sig="${s.name}" title="${title}">
          <div class="seg-in">${hasMsb && span >= 1 ? html`<span class="mark m-msb" title="MSB">MSB</span>` : ''}<span class="seg-name">${isFirst ? s.name : html`<span class="muted">${s.name}</span>`}${isFirst && s.littleEndian ? html` <span class="muted" title="little endian: least significant byte first">LE</span>` : ''}</span>${hasLsb && rg.width > 1 ? html`<span class="mark m-lsb" title="LSB">LSB</span>` : ''}</div>
          ${bytes ? html`<span class="bitv">${bitVals}</span>` : ''}
        </td>`);
      }
      k = e + 1;
    }
    return cells;
  };

  const body = rows.map((row) => {
    if (row.collapsed) {
      if (row.to < row.from) return '';
      const label = row.kind === 'free' ? 'not documented' : `${act[+row.kind.slice(2)].name} (continued)`;
      const hexPreview = bytes ? Array.from(bytes.slice(row.from, Math.min(row.to + 1, row.from + 16)), hexByte).join(' ') + (row.to - row.from + 1 > 16 ? ' …' : '') : '';
      const o = row.kind === 'free' ? -1 : +row.kind.slice(2);
      return html`<tr class="collapsed"><th class="byte">${row.from + 1}–${row.to + 1}</th><td colspan="8" class="seg ${o < 0 ? 'free' : 'sig cont'}" ${o >= 0 ? html`style="--h:${hues.get(act[o].name) ?? 200}" data-sig="${act[o].name}"` : ''}>⋯ ${row.to - row.from + 1} bytes: ${label} ${hexPreview ? html`<span class="mono muted">${hexPreview}</span>` : ''}</td>${bytes ? html`<td class="hexcol"></td>` : ''}</tr>`;
    }
    const r = row.r;
    return html`<tr><th class="byte" title="byte ${r + 1} (d[${r}])">${r + 1}</th>${cellFor(r)}${bytes ? html`<td class="hexcol mono">${hexByte(bytes[r] ?? 0)}</td>` : ''}</tr>`;
  });

  return html`<div class="bitgrid-wrap">
    <table class="bitgrid${bytes ? ' with-values' : ''}">
      <thead><tr><th class="byte">Byte</th>${[7, 6, 5, 4, 3, 2, 1, 0].map((b) => html`<th>${b}</th>`)}${bytes ? html`<th class="hexcol">hex</th>` : ''}</tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${conflicts.size ? html`<div class="notice warn">Overlapping signals: ${[...conflicts].join(', ')} (only the first one is drawn)</div>` : ''}
    ${outside.length ? html`<div class="notice warn">Outside of the ${L} bytes payload: ${outside.map((s) => `${s.name} (${s.bits})`).join(', ')}</div>` : ''}
  </div>`;
}

export function renderLegend(signals, hues, opts = {}) {
  const act = activeSignals(signals, opts.muxState);
  return html`<div class="legend">${act.map((s) => html`<div class="legend-item${s.unused ? ' unused' : ''}" data-sig="${s.name}" style="--h:${hues.get(s.name) ?? 200}">
    <span class="swatch"></span><code class="bits">${s.bits || '?'}</code> <b>${s.name}</b> <span class="muted">${t(s.comment)}</span>
  </div>`)}</div>`;
}

/** Details panel of a signal (shown on hover). */
export function signalDetails(s, archvar) {
  if (!s) return html`<p class="muted">Hover a signal to see its details.</p>`;
  const rows = [];
  rows.push(['Bits', html`<code>${s.bits}</code>${s.pos ? html` <span class="muted">(${s.pos.toEnd ? 'variable length' : s.width + ' bit' + (s.width > 1 ? 's' : '')})</span>` : ''}`]);
  rows.push(['Type', s.type + (s.typeExplicit ? '' : ' (inferred)')]);
  if (s.hasFactor || s.offset || s.units) rows.push(['Scaling', html`phys = raw × ${s.factor} + ${s.offset} ${s.units ? html`<b>${s.units}</b>` : ''}`]);
  if (s.min !== null || s.max !== null) rows.push(['Range', `${s.min ?? '?'} … ${s.max ?? '?'}`]);
  if (s.invalid.length) rows.push(['Invalid', s.invalid.map((x) => '0x' + x.toString(16).toUpperCase()).join(', ')]);
  if (s.default !== null) rows.push(['Default', '0x' + s.default.toString(16).toUpperCase()]);
  if (s.littleEndian) rows.push(['Byte order', 'little endian (least significant byte first)']);
  if (s.receivers && s.receivers.length) rows.push(['Used by', s.receivers.join(', ')]);
  if (s.muxSelector) rows.push(['Mux', 'selector']);
  if (s.mux) rows.push(['Mux', `when ${s.mux.selector} ∈ {${s.mux.values.join(', ')}}`]);
  if (s.altNames.length) rows.push(['Alt names', s.altNames.join(', ')]);
  if (s.unused) rows.push(['', html`<i>unused / reserved</i>`]);
  return html`<div class="sigdetails" style="--h:0">
    <h4>${s.name}</h4>
    ${s.comment ? html`<p>${t(s.comment)}</p>` : ''}
    <dl class="kv">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
    ${s.values.length ? html`<div class="valtable">${valuesList(s, 64)}</div>` : ''}
    ${s.alternatives.length ? html`<p class="notice">${s.alternatives.length} alternative observation(s), see the Alternatives tab.</p>` : ''}
  </div>`;
}

export { physText };
