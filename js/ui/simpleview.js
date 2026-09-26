// Simple view: the payload written as a
// bit string where each signal is a group of letters, with staggered callouts, followed by
// a prose description of every field ("Byte 3, bits 7-6: Driver door: 0 = closed, 1 = open").

import { html } from './dom.js';
import { resolveRange, describePos } from '../core/bits.js';
import { activeSignals } from '../core/normalize.js';
import { hex, fmtNum } from '../core/util.js';
import { t, nodeList, busLabel } from './widgets.js';
import { layoutLength } from './bitgrid.js';
import { lang } from './state.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzαβγδεζηθικλμνξπρστυφχψω';

function letterFor(i) { return i < LETTERS.length ? LETTERS[i] : `[${i}]`; }

function valueText(s) {
  if (!s.values.length) return '';
  const w = s.width;
  return s.values.slice(0, 40).map((v) => `${w <= 4 ? v.raw.toString(2).padStart(w, '0') : '0x' + hex(v.raw, Math.ceil(w / 4))} = ${v.text ? t(v.text) : ''}${v.unused ? (v.text ? ' (unused)' : 'unused') : ''}`).join(', ') + (s.values.length > 40 ? ', …' : '');
}

export function renderSimpleView(frame, signals, opts = {}) {
  const act = activeSignals(signals, opts.muxState).filter((s) => s.pos).sort((a, b) => a.pos.start - b.pos.start);
  const L = Math.min(layoutLength(frame, act, null), opts.maxBytes || 64);
  const nbits = L * 8;
  const owner = new Int32Array(nbits).fill(-1);
  const ranges = act.map((s) => resolveRange(s.pos, L));
  act.forEach((s, i) => {
    for (let b = ranges[i].start; b <= Math.min(ranges[i].end, nbits - 1); b++) if (owner[b] < 0) owner[b] = i;
  });
  const letters = new Map(act.map((s, i) => [s.name, letterFor(i)]));
  const lines = [];
  for (let line = 0; line * 64 < nbits; line++) {
    const lo = line * 64;
    const hi = Math.min(nbits, lo + 64) - 1;
    const groups = [];
    let i = lo;
    while (i <= hi) {
      const o = owner[i];
      let e = i;
      while (e + 1 <= hi && owner[e + 1] === o) e++;
      let txt = '';
      for (let b = i; b <= e; b++) {
        if (b !== lo && b % 8 === 0) txt += ' ';
        if (o < 0) txt += '·';
        else txt += act[o].unused ? '-' : letters.get(act[o].name);
      }
      groups.push({ o, txt, start: i, first: o >= 0 && ranges[o].start === i });
      i = e + 1;
    }
    const callouts = groups.filter((g) => g.first && !act[g.o].unused);
    const n = callouts.length;
    let k = 0;
    const html1 = groups.map((g) => {
      if (g.o < 0 || !g.first || act[g.o].unused) return html`<span class="awp-bits${g.o >= 0 ? ' awp-unused' : ' awp-free'}">${g.txt}</span>`;
      const s = act[g.o];
      const off = n - 1 - k++;
      return html`<span class="awp-bits awp-sig" data-sig="${s.name}"><span class="awp-letters" style="--h:${opts.hues ? opts.hues.get(s.name) : 200}">${g.txt}</span><span class="awp-info" style="padding-top:${off * 22 + 6}px">${letters.get(s.name)}: ${s.name}${s.comment ? html` <span class="muted">— ${t(s.comment)}</span>` : ''}</span></span>`;
    });
    lines.push(html`<div class="awp-line"><div class="awp-off mono">${line * 8 + 1}</div><div class="awp-structure" style="padding-bottom:${n * 22 + 34}px">${html1}</div></div>`);
  }
  const truncated = layoutLength(frame, act, null) > L;
  const fr = lang() === 'fr';
  const prose = act.map((s) => {
    const r = ranges[act.indexOf(s)];
    const parts = [];
    if (s.comment) parts.push(t(s.comment));
    if (s.hasFactor || s.offset) parts.push(`${fr ? 'valeur' : 'value'} = raw × ${fmtNum(s.factor, 8)}${s.offset ? ` ${s.offset < 0 ? '−' : '+'} ${Math.abs(s.offset)}` : ''}${s.units ? ' ' + s.units : ''}`);
    else if (s.units) parts.push(`${fr ? 'unité' : 'unit'}: ${s.units}`);
    if (s.type === 'sint') parts.push(fr ? 'signé' : 'signed');
    if (s.min !== null || s.max !== null) parts.push(`${fr ? 'plage' : 'range'} ${s.min ?? '?'} … ${s.max ?? '?'}`);
    if (s.invalid.length) parts.push(`${fr ? 'invalide' : 'invalid'}: ${s.invalid.map((x) => '0x' + hex(x)).join(', ')}`);
    if (s.mux) parts.push(`${fr ? 'présent si' : 'present when'} ${s.mux.selector} = ${s.mux.values.join(' / ')}`);
    const vt = valueText(s);
    return html`<li class="${s.unused ? 'muted' : ''}" data-sig="${s.name}"><span class="awp-letter" style="--h:${opts.hues ? opts.hues.get(s.name) : 200}">${s.unused ? '-' : letters.get(s.name)}</span>
      <b>${describePos(s.pos.toEnd ? s.pos : { ...s.pos, ...r, endByte: Math.floor(r.end / 8) + 1, endBit: 7 - (r.end % 8) }, lang())}</b>: ${s.unused ? html`<i>${fr ? 'inutilisé' : 'unused'}</i>` : html`<span class="mono">${s.name}</span>`}${parts.length ? html` — ${parts.join('; ')}` : ''}${vt ? html`<div class="awp-values">${vt}</div>` : ''}</li>`;
  });
  const bus = busLabel(frame.archvar, frame.netbus);
  return html`<div class="simpleview">
    <div class="awp-head">
      <div class="awp-id mono">${frame.idHex}</div>
      <div>
        <div>Network: <b>${bus}</b></div>
        <div>Source: ${nodeList(frame.archvar, frame.senders, 20)}</div>
        <div>Dest: ${nodeList(frame.archvar, frame.receivers, 20)}</div>
        ${frame.comment ? html`<p>${t(frame.comment)}</p>` : ''}
        ${frame.type === 'can-tp' ? html`<span class="badge badge-danger">ISO 15765-2</span>` : ''}
      </div>
    </div>
    ${lines}
    ${truncated ? html`<p class="muted">Only the first ${L} bytes are drawn, see the list below.</p>` : ''}
    <p class="muted small">Letters = documented fields (MSB first), <code>·</code> = undocumented bit, <code>-</code> = unused/reserved.</p>
    <ol class="awp-prose">${prose}</ol>
  </div>`;
}
