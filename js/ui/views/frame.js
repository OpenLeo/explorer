// Frame detail: header + sub-tabs (grid, simple, signals, flow, decode, encode, code, alternatives, compare).

import { html, raw, $, $$, on, setHtml } from '../dom.js';
import { app, lang, sourceMetaById } from '../state.js';
import {
  t, frameBadges, periodText, typeBadge, nodeList, nodeLink, codeBlock, kv, valuesList, physText, busLabel, busInfo,
  protocolBadge, sourceBadge, unreleasedBadge, emptyState, tabs,
} from '../widgets.js';
import { renderGrid, renderLegend, signalDetails, hueMap } from '../bitgrid.js';
import { renderSimpleView } from '../simpleview.js';
import { flowSvg } from '../diagrams.js';
import { applyFrameAlternative, applySignalAlternative, activeSignals } from '../../core/normalize.js';
import { dbcMotorolaStart, motorolaLsbStart, describePos } from '../../core/bits.js';
import { decodeFrame, encodeFrame, physToRaw, rawToPhys, defaultRaw, FLAG_TEXT, maxRaw } from '../../core/codec.js';
import { genC, genPython, genDbcSnippet, txSnippets } from '../../core/codegen.js';
import { sameFrameElsewhere, frameRoute } from '../../core/repo.js';
import { hex, fmtNum, parseHexBytes, bytesToHex, ml, ident } from '../../core/util.js';
import { parseLog } from '../../core/logparse.js';

const TABS = [
  { id: 'grid', label: 'Grid' },
  { id: 'simple', label: 'Simple view' },
  { id: 'signals', label: 'Signals' },
  { id: 'flow', label: 'Emitters / receivers' },
  { id: 'decode', label: 'Decode' },
  { id: 'encode', label: 'Encode' },
  { id: 'code', label: 'Code' },
  { id: 'alternatives', label: 'Alternatives' },
  { id: 'compare', label: 'Other architectures' },
];

const frameState = new Map();
function stateFor(f) {
  if (!frameState.has(f.uid)) frameState.set(f.uid, { frameAlt: null, sigAlts: {}, mux: null, decodeHex: '', enc: null, encUnused: false });
  if (frameState.size > 200) frameState.delete(frameState.keys().next().value);
  return frameState.get(f.uid);
}

function effective(frame, st) {
  let f = frame;
  if (st.frameAlt !== null && frame.alternatives[st.frameAlt]) f = applyFrameAlternative(frame, st.frameAlt);
  const signals = f.signals.map((s) => (st.sigAlts[s.name] !== undefined && s.alternatives[st.sigAlts[s.name]] ? applySignalAlternative(s, st.sigAlts[s.name], f.length) : s));
  return { f, signals };
}

/** Mux selectors and their possible values */
function muxInfo(signals) {
  const sels = signals.filter((s) => s.muxSelector);
  return sels.map((sel) => {
    const vals = new Set();
    for (const s of signals) if (s.mux && s.mux.selector === sel.name) s.mux.values.forEach((v) => vals.add(v));
    for (const v of sel.values) vals.add(v.raw);
    return { sel, values: [...vals].sort((a, b) => a - b) };
  });
}

function defaultMux(signals) {
  const m = {};
  for (const { sel, values } of muxInfo(signals)) if (values.length) m[sel.name] = values[0];
  return m;
}

function muxControls(signals, muxState, allowAll = true) {
  const mi = muxInfo(signals);
  if (!mi.length) return '';
  return html`<div class="muxbar">${mi.map(({ sel, values }) => html`<label>Mux <b>${sel.name}</b> =
    <select data-mux="${sel.name}">
      ${allowAll ? html`<option value="" ${muxState[sel.name] === undefined || muxState[sel.name] === null ? 'selected' : ''}>all (overlapping)</option>` : ''}
      ${values.map((v) => { const lab = sel.values.find((x) => x.raw === v); return html`<option value="${v}" ${muxState[sel.name] === v ? 'selected' : ''}>0x${hex(v)}${lab && lab.text ? ' — ' + t(lab.text) : ''}</option>`; })}
    </select></label>`)}</div>`;
}

function tabHref(frame, tab, route) {
  const q = new URLSearchParams();
  if (tab) q.set('tab', tab);
  if (route && route.query.src) q.set('src', route.query.src);
  return `${frameRoute(frame)}?${q.toString()}`;
}

// ---------------------------------------------------------------------------

export function renderFrameDetail(container, frameVersions, route) {
  const db = app.db;
  const srcId = route.query.src;
  const base = frameVersions.find((f) => f.source === srcId) || frameVersions[0];
  const st = stateFor(base);
  if (!st.mux) st.mux = defaultMux(base.signals);
  const tab = TABS.some((x) => x.id === route.query.tab) ? route.query.tab : 'grid';
  const { f, signals } = effective(base, st);
  const hues = hueMap(base.signals.concat(f.signals.filter((s) => !base.signals.some((b) => b.name === s.name))));
  const bus = busInfo(f.archvar, f.netbus);
  const inherited = false;
  const altCount = base.alternatives.length + base.signals.filter((s) => s.alternatives.length).length;
  const others = sameFrameElsewhere(db, base);
  const issues = base.issues.filter((i) => i.level !== 'info');
  const infos = base.issues.filter((i) => i.level === 'info');

  const srcSwitch = frameVersions.length > 1 ? html`<div class="srcswitch" title="This frame is defined in several sources">
      <span class="muted">Sources:</span>${frameVersions.map((v) => { const m = sourceMetaById(v.source); return html`<a class="btn btn-sm${v === base ? ' active' : ''}" style="--c:${m.color}" href="${frameRoute(v)}?${new URLSearchParams({ tab, src: v.source }).toString()}">${m.label}</a>`; })}
    </div>` : '';

  const altBar = base.alternatives.length ? html`<div class="altbar"><span class="muted">Frame observations:</span>
      <button class="btn btn-sm${st.frameAlt === null ? ' active' : ''}" data-act="frame-alt" data-idx="">Base</button>
      ${base.alternatives.map((a, i) => html`<button class="btn btn-sm${st.frameAlt === i ? ' active' : ''}" data-act="frame-alt" data-idx="${i}" title="${t(a.note)}">Alt ${i + 1}: ${(t(a.note) || '').slice(0, 40)}</button>`)}
    </div>` : '';

  const specifics = [];
  if (f.type === 'can-tp' && f.isotp) specifics.push(html`<span>ISO-TP${f.isotp.flow_control_id !== undefined ? html`, flow control <code>0x${hex(f.isotp.flow_control_id, 3)}</code>` : ''}${f.isotp.addressing ? `, ${f.isotp.addressing} addressing` : ''}${f.isotp.padding !== undefined ? html`, padding ${f.isotp.padding === null ? 'none' : html`<code>0x${hex(f.isotp.padding, 2)}</code>`}` : ''}${f.isotp.functional ? ', functional' : ''}</span>`);
  if (f.type === 'van' && f.van) specifics.push(html`<span>VAN ${f.van.access || ''}${f.van.ack ? ', ack requested (RAK)' : ''}${f.van.rtr ? ', RTR' : ''}${f.van.reply ? `, ${f.van.reply} reply` : ''}${f.van.requested_by ? `, requested by ${[].concat(f.van.requested_by).join(', ')}` : ''}</span>`);
  if (f.type === 'lin') specifics.push(html`<span>LIN${f.lin && f.lin.protected_id !== undefined ? html`, PID <code>0x${hex(f.lin.protected_id, 2)}</code>` : ''}${f.lin && f.lin.checksum ? `, ${f.lin.checksum} checksum` : ''}${f.lin && f.lin.master ? `, master ${f.lin.master}` : ''}</span>`);
  if (f.legacyMethod) specifics.push(html`<span class="muted">method: ${f.legacyMethod}</span>`);
  if (f.lengthMin) specifics.push(html`<span>min length ${f.lengthMin}</span>`);
  if (f.altIds && f.altIds.length) specifics.push(html`<span>alt id ${f.altIds.map((x) => '0x' + hex(x, 3)).join(', ')}</span>`);

  const head = html`<div class="fd-head">
    <div class="fd-id mono" title="${f.id} decimal">0x${f.idHex}</div>
    <div class="fd-title">
      <h2>${f.name}</h2>
      ${f.altNames.length ? html`<div class="muted small">aka ${f.altNames.join(', ')}</div>` : ''}
      <div class="badges">${typeBadge(f.type)}${f.extended ? html`<span class="badge">29 bit</span>` : ''}
        <a class="badge badge-bus" href="#/frames/${f.archvar}?bus=${encodeURIComponent(f.netbus)}">${f.archvar} · ${busLabel(f.archvar, f.netbus)}</a>
        ${protocolBadge(bus)}
        <span class="badge">${f.length} byte${f.length > 1 ? 's' : ''}${f.type === 'can-tp' ? ' max' : ''}</span>
        <span class="badge badge-period">${periodText(f)}</span>
        ${frameBadges(base)}
      </div>
    </div>
    <button class="btn btn-sm close-detail" data-act="close-detail" title="Back to the list">✕</button>
  </div>
  ${srcSwitch}
  ${f.comment ? html`<p class="fd-comment">${t(f.comment)}</p>` : ''}
  ${f.observations ? html`<p class="fd-obs"><b>Observations:</b> ${t(f.observations)}</p>` : ''}
  <div class="fd-meta">
    <span><b>From</b> ${nodeList(f.archvar, f.senders, 8)}</span>
    <span><b>to</b> ${nodeList(f.archvar, f.receivers, 10)}</span>
    ${specifics}
  </div>
  ${base.symlinkOf ? symlinkNotice(base) : base.identicalTo ? html`<div class="notice">≡ Same content as <a href="${frameRoute(base.identicalTo)}">${base.identicalTo.archvar} ${base.identicalTo.netbus} ${base.identicalTo.fileBase}</a> (identical file, probably a symbolic link).</div>` : ''}
  ${inheritNotice(base, route)}
  ${base.overrides ? overrideNotice(base, route) : ''}
  ${altBar}
  ${issues.length || infos.length ? html`<details class="issues"><summary>${issues.length ? html`<span class="badge badge-warn">⚠ ${issues.length}</span> data warning${issues.length > 1 ? 's' : ''}` : ''}${infos.length ? html` <span class="muted">${infos.length} note${infos.length > 1 ? 's' : ''}</span>` : ''} <span class="muted small">(${f.path})</span></summary>
    <ul>${[...issues, ...infos].map((i) => html`<li class="lvl-${i.level}"><b>${i.level}</b> ${i.where ? html`<code>${i.where}</code> ` : ''}${i.msg}</li>`)}</ul></details>` : ''}`;

  const appliedAlts = [
    ...(st.frameAlt !== null && base.alternatives[st.frameAlt] ? [`frame alternative ${st.frameAlt + 1}`] : []),
    ...Object.entries(st.sigAlts).map(([n, i]) => `${n} alternative ${i + 1}`),
  ];
  const altApplied = appliedAlts.length ? html`<div class="notice warn">Showing alternative observations: ${appliedAlts.join(', ')}. <button class="btn btn-sm" data-act="alt-reset">Back to the base definition</button></div>` : '';
  const tabItems = TABS.map((x) => ({ ...x, count: x.id === 'alternatives' ? altCount : x.id === 'compare' ? others.length : x.id === 'signals' ? f.signals.length : undefined }));
  const body = renderTab(tab, { base, f, signals, st, hues, others, route });
  setHtml(container, html`<div class="fdetail-inner" data-uid="${base.uid}">${head}${tabs(tabItems, tab, (id) => tabHref(base, id, route))}${altApplied}<div class="tabbody" id="tabbody">${body}</div></div>`);
  bindDetail(container, { base, f, signals, st, hues, route, tab, frameVersions });
}

function renderTab(tab, ctx) {
  switch (tab) {
    case 'simple': return renderSimpleTab(ctx);
    case 'signals': return renderSignalsTab(ctx);
    case 'flow': return renderFlowTab(ctx);
    case 'decode': return renderDecodeTab(ctx);
    case 'encode': return renderEncodeTab(ctx);
    case 'code': return renderCodeTab(ctx);
    case 'alternatives': return renderAltTab(ctx);
    case 'compare': return renderCompareTab(ctx);
    default: return renderGridTab(ctx);
  }
}

// ---- Grid -----------------------------------------------------------------

function renderGridTab({ f, signals, st, hues, route }) {
  if (!signals.length) return emptyState('No signal documented', 'This frame has no signals yet (or only its ID is known).');
  const sel = route.query.sig || null;
  const selSig = sel ? signals.find((s) => s.name === sel) : null;
  return html`${muxControls(signals, st.mux)}
    <div class="gridpane">
      <div class="gridmain">${renderGrid(f, signals, { muxState: st.mux, hues, selected: sel })}</div>
      <aside class="gridside" id="sigdetails">${signalDetails(selSig, f.archvar)}</aside>
    </div>
    ${renderLegend(signals, hues, { muxState: st.mux })}`;
}

// ---- Simple view ---------------------------------------------------------------

function renderSimpleTab({ f, signals, st, hues }) {
  if (!signals.length) return emptyState('No signal documented');
  return html`${muxControls(signals, st.mux)}${renderSimpleView(f, signals, { muxState: st.mux, hues })}`;
}

// ---- Signals table --------------------------------------------------------

function renderSignalsTab({ f, signals, hues }) {
  if (!signals.length) return emptyState('No signal documented');
  const rows = signals.map((s) => {
    const p = s.pos;
    return html`<tr class="${s.unused ? 'muted' : ''}" data-sig="${s.name}">
      <td><span class="swatch" style="--h:${hues.get(s.name) ?? 200}"></span><a href="#/signals/${encodeURIComponent(s.name)}" class="mono" title="Find this signal across architectures"><b>${s.name}</b></a>${s.altNames.length ? html`<div class="small muted">${s.altNames.join(', ')}</div>` : ''}${s.alternatives.length ? html` <span class="badge badge-alt">alt</span>` : ''}${s.issues.some((i) => i.level === 'error') ? html` <span class="badge badge-warn" title="${s.issues.map((i) => i.msg).join('\n')}">⚠</span>` : ''}</td>
      <td class="mono">${s.bits}</td>
      <td class="mono">${p ? `${p.startByte}.${p.startBit}` : '?'}</td>
      <td class="num">${p ? (p.toEnd ? 'var' : p.width) : '?'}</td>
      <td class="num mono" title="DBC Motorola (big endian) start bit = MSB position; LSB start bit ${p ? motorolaLsbStart(p) : ''}">${p ? dbcMotorolaStart(p) : ''}</td>
      <td>${s.type}${s.littleEndian ? html` <span class="badge" title="little endian: least significant byte first">LE</span>` : ''}${s.muxSelector ? html` <span class="badge">mux sel</span>` : ''}${s.mux ? html` <span class="badge" title="when ${s.mux.selector} in ${s.mux.values.join(',')}">m${s.mux.values.join(',')}</span>` : ''}</td>
      <td class="num">${s.hasFactor ? fmtNum(s.factor, 10) : ''}</td>
      <td class="num">${s.offset ? fmtNum(s.offset, 10) : ''}</td>
      <td>${s.units}</td>
      <td class="num">${s.min ?? ''}</td>
      <td class="num">${s.max ?? ''}</td>
      <td class="mono small">${s.invalid.map((x) => '0x' + hex(x)).join(' ')}${s.default !== null ? html`<div title="default">def 0x${hex(s.default)}</div>` : ''}</td>
      <td>${valuesList(s, 6)}</td>
      <td class="small">${t(s.comment)}${s.unused ? html` <i>(unused)</i>` : ''}${s.receivers && s.receivers.length ? html`<div class="muted">used by ${s.receivers.join(', ')}</div>` : ''}</td>
    </tr>`;
  });
  return html`<div class="tablewrap"><table class="tbl signals-tbl">
    <thead><tr><th>Name</th><th>Bits</th><th title="start byte.bit (MSB)">Start</th><th title="length in bits">Len</th><th title="DBC Motorola start bit (@0)">DBC</th><th>Type</th><th>Factor</th><th>Offset</th><th>Units</th><th>Min</th><th>Max</th><th>Invalid / default</th><th>Values</th><th>Comment</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="muted small">Bits: PSA notation &lt;byte&gt;.&lt;bit&gt;, byte 1 first, bit 7 = MSB, ranges in transmission order (big endian). DBC: Motorola start bit (Vector convention, MSB). physical = raw × factor + offset.</p>`;
}

// ---- Flow -----------------------------------------------------------------

function renderFlowTab({ f }) {
  const db = app.db;
  const nodes = db.variantNodes.get(f.archvar) || new Map();
  const all = [...new Set([...f.senders, ...f.receivers])];
  const rows = all.map((n) => {
    const nd = nodes.get(n);
    const cars = db.carsByNode.get(`${f.archvar}|${n}`) || [];
    const role = [f.senders.includes(n) ? 'sender' : '', f.receivers.includes(n) ? 'receiver' : ''].filter(Boolean).join(' + ');
    return html`<tr><td>${nodeLink(f.archvar, n)}</td><td>${role}</td><td>${nd ? t(nd.title) : ''}${nd && nd.phantom ? html` <span class="badge" title="not defined in nodes/${f.archvar}.yml">undefined node</span>` : ''}${nd && nd.released === false ? unreleasedBadge() : ''}</td>
      <td>${cars.length ? cars.slice(0, 12).map((c, i) => html`${i ? ', ' : ''}<a href="#/cars/${encodeURIComponent(c.car.project)}" title="${c.car.codes.map((x) => x.names.join('/')).join(', ')}">${c.car.project}</a>${c.optional ? html`<sup title="optional">opt</sup>` : ''}`) : html`<span class="muted">no car lists this ECU yet</span>`}${cars.length > 12 ? ` +${cars.length - 12}` : ''}</td></tr>`;
  });
  return html`${flowSvg(f, nodes)}
    <div class="tablewrap"><table class="tbl"><thead><tr><th>ECU</th><th>Role</th><th>Name</th><th>Cars fitted with it</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---- Decode ---------------------------------------------------------------

function decodeInputBytes(text, f) {
  const s = String(text || '').trim();
  if (!s) return new Uint8Array(0);
  if (/#|\[\d+\]/.test(s) || /^\(/.test(s)) {
    const r = parseLog(s);
    const fr = r.frames.find((x) => x.id === f.id) || r.frames[0];
    if (fr) return fr.data;
  }
  return parseHexBytes(s);
}

function decodeResults(ctx, text) {
  const { f, signals, st, hues } = ctx;
  const bytes = decodeInputBytes(text, f);
  if (bytes === null) return html`<div class="notice warn">Could not parse the payload: use hex bytes (<code>0E 00 00 A0</code> or <code>0E0000A0</code>) or a candump line.</div>`;
  if (!bytes.length) return html`<p class="muted">Paste a payload above.</p>`;
  const dec = decodeFrame(f, bytes, lang(), signals);
  const flags = {};
  for (const d of dec.signals) flags[d.name] = d.flags;
  const rows = dec.signals.filter((d) => !d.sig.unused || d.raw).map((d) => {
    const s = d.sig;
    const bad = d.flags.filter((x) => x !== 'default');
    return html`<tr class="${d.active === false ? 'inactive' : ''} ${bad.length ? 'flagged' : ''}" data-sig="${s.name}">
      <td><span class="swatch" style="--h:${hues.get(s.name) ?? 200}"></span><b class="mono">${s.name}</b>${d.active === false ? html` <span class="muted small">(mux inactive)</span>` : ''}</td>
      <td class="mono">${s.bits}</td>
      <td class="mono">${d.present ? d.rawHex : '—'}${d.present && typeof d.raw === 'number' && d.raw > 9 ? html` <span class="muted">(${d.raw})</span>` : ''}</td>
      <td class="num"><b>${d.present ? d.text : ''}</b></td>
      <td>${d.label ? html`<span class="lbl">${d.label}</span>` : ''}</td>
      <td>${d.flags.map((x) => html`<span class="flag flag-${x}" title="${FLAG_TEXT[x] || x}">${x}</span>`)}</td>
    </tr>`;
  });
  return html`${dec.flags.length ? html`<div class="notice warn">Payload is ${bytes.length} bytes, the frame is documented with ${f.length}${f.lengthMin ? ` (min ${f.lengthMin})` : ''}.</div>` : ''}
    <div class="decode-grid">${renderGrid(f, signals, { bytes, muxState: dec.muxState, hues, flags })}</div>
    <div class="tablewrap"><table class="tbl decode-tbl"><thead><tr><th>Signal</th><th>Bits</th><th>Raw</th><th>Physical</th><th>Meaning</th><th>Flags</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderDecodeTab(ctx) {
  const { f, st } = ctx;
  if (!st.decodeHex) st.decodeHex = bytesToHex(encodeFrame(f, {}, f.type === 'can-tp' ? Math.min(f.length || 8, 64) : f.length, ctx.signals));
  return html`<div class="decode">
    <label class="lbl-block">Payload (hex bytes, or a candump / <code>ID#DATA</code> line)</label>
    <div class="row"><input id="dec-input" class="mono grow" value="${st.decodeHex}" spellcheck="false" autocomplete="off" placeholder="0E 00 00 00 00 00 00 A0">
      <button class="btn" data-act="dec-clear">Clear</button><button class="btn" data-act="dec-to-enc" title="Load this payload in the encoder">→ Encode</button></div>
    <div id="dec-out">${decodeResults(ctx, st.decodeHex)}</div>
  </div>`;
}

// ---- Encode ---------------------------------------------------------------

function encState(ctx) {
  const { f, signals, st } = ctx;
  if (!st.enc || st.enc.len !== f.length || st.enc.sigKey !== signals.map((s) => s.name + s.bits).join('|')) {
    const raw0 = {};
    for (const s of signals) raw0[s.name] = defaultRaw(s);
    const mux = defaultMux(signals);
    for (const [k, v] of Object.entries(mux)) raw0[k] = v;
    st.enc = { raw: raw0, len: f.length, sigKey: signals.map((s) => s.name + s.bits).join('|'), payloadLen: f.type === 'can-tp' ? Math.min(f.length || 8, 64) : f.length };
  }
  return st.enc;
}

function encMux(signals, enc) {
  const m = {};
  for (const s of signals) if (s.muxSelector) m[s.name] = typeof enc.raw[s.name] === 'number' ? enc.raw[s.name] : 0;
  return m;
}

function encodeOutput(ctx) {
  const { f, signals } = ctx;
  const enc = encState(ctx);
  const mux = encMux(signals, enc);
  const act = activeSignals(signals, mux);
  const bytes = encodeFrame(f, enc.raw, enc.payloadLen, act);
  const bus = busInfo(f.archvar, f.netbus);
  const snippets = txSnippets(f, bytes, { bitrate: bus && bus.bitrate });
  return html`<div class="payload-out"><span class="muted">Payload</span> <code class="mono big" id="enc-hex">${bytesToHex(bytes)}</code>
      <button class="btn btn-sm" data-copyval="${bytesToHex(bytes, '')}">Copy</button>
      <button class="btn btn-sm" data-act="enc-to-dec" data-hex="${bytesToHex(bytes)}">→ Decode</button></div>
    ${snippets.map((s) => codeBlock(s.code, { title: s.title, lang: s.lang }))}`;
}

function encodeForm(ctx) {
  const { signals, st } = ctx;
  const enc = encState(ctx);
  const mux = encMux(signals, enc);
  const act = activeSignals(signals, mux).filter((s) => s.pos && (st.encUnused || !s.unused));
  return act.map((s) => {
    const v = enc.raw[s.name];
    let input;
    if (s.type === 'str') input = html`<input data-enc="${s.name}" data-kind="str" value="${typeof v === 'string' ? v : ''}" class="grow" maxlength="${Math.ceil(s.width / 8) || 64}" placeholder="text">`;
    else if (s.type === 'bytes' || s.width > 53) input = html`<input data-enc="${s.name}" data-kind="bytes" class="mono grow" value="${typeof v === 'string' ? v : ''}" placeholder="hex bytes">`;
    else if (s.values.length && (!s.hasFactor || s.type === 'enum')) {
      const known = s.values.some((x) => x.raw === v);
      input = html`<select data-enc="${s.name}" data-kind="enum">${s.values.map((x) => html`<option value="${x.raw}" ${x.raw === v ? 'selected' : ''}>0x${hex(x.raw)} — ${t(x.text) || (x.unused ? 'unused' : '')}</option>`)}${!known ? html`<option value="${v}" selected>0x${hex(v)} (not in table)</option>` : ''}</select>
        <label class="small muted">raw <input data-enc="${s.name}" data-kind="raw" type="number" min="0" max="${maxRaw(s.width)}" value="${v}" class="rawin" title="raw value"></label>`;
    } else if (s.type === 'bool' || s.width === 1) input = html`<label class="chk"><input type="checkbox" data-enc="${s.name}" data-kind="bool" ${v ? 'checked' : ''}> ${v ? '1' : '0'}</label>`;
    else {
      const phys = rawToPhys(s, v || 0);
      input = html`<input data-enc="${s.name}" data-kind="phys" type="number" step="${s.factor}" value="${fmtNum(phys, 10)}" ${s.min !== null ? html`min="${s.min}"` : ''} ${s.max !== null ? html`max="${s.max}"` : ''} class="physin"> <span class="muted">${s.units}</span>
        <label class="small muted">raw <input data-enc="${s.name}" data-kind="raw" type="number" min="0" max="${maxRaw(s.width)}" value="${v}" class="rawin" title="raw value"></label>`;
    }
    return html`<div class="encrow${s.unused ? ' muted' : ''}${s.muxSelector ? ' muxsel' : ''}"><label title="${t(s.comment)}"><span class="mono">${s.name}</span> <span class="muted small">${s.bits}</span></label><div class="encinput">${input}</div>
      <div class="small muted">${s.min !== null || s.max !== null ? `${s.min ?? '…'} – ${s.max ?? '…'}` : ''}${s.invalid.length ? ` invalid 0x${hex(s.invalid[0])}` : ''}</div></div>`;
  });
}

function renderEncodeTab(ctx) {
  const { f, st } = ctx;
  if (!ctx.signals.length) return emptyState('No signal documented', 'Nothing to encode.');
  return html`<div class="encode">
    <div class="enc-form">
      <div class="row"><label class="chk"><input type="checkbox" data-act="enc-unused" ${st.encUnused ? 'checked' : ''}> show unused bits</label>
        <button class="btn btn-sm" data-act="enc-reset">Reset to defaults</button>${f.type === 'can-tp' ? html`<span class="muted small">payload length</span> <input type="number" min="1" max="4095" id="enc-len" value="${encState(ctx).payloadLen}" class="rawin">` : ''}</div>
      <div id="enc-fields">${encodeForm(ctx)}</div>
    </div>
    <div id="enc-out">${encodeOutput(ctx)}</div>
  </div>`;
}

// ---- Code -----------------------------------------------------------------

function renderCodeTab({ f, route }) {
  const which = ['c', 'py', 'dbc'].includes(route.query.code) ? route.query.code : 'c';
  const q = (c) => `${frameRoute(f)}?${new URLSearchParams({ ...(route.query.src ? { src: route.query.src } : {}), tab: 'code', code: c }).toString()}`;
  let code;
  let fn;
  if (which === 'py') { code = genPython(f, { lang: lang() }); fn = `${ident(f.name).toLowerCase()}_${f.idHex}.py`; }
  else if (which === 'dbc') { code = genDbcSnippet(f, { lang: lang() }); fn = `${ident(f.name)}_${f.idHex}.dbc`; }
  else { code = genC(f, { lang: lang() }); fn = `${ident(f.name).toLowerCase()}_${f.idHex}.h`; }
  return html`<nav class="pills"><a href="${q('c')}" class="${which === 'c' ? 'active' : ''}">C header</a><a href="${q('py')}" class="${which === 'py' ? 'active' : ''}">Python</a><a href="${q('dbc')}" class="${which === 'dbc' ? 'active' : ''}">DBC</a></nav>
    ${codeBlock(code, { filename: fn, lang: which })}
    <p class="muted small">Generated code handles the PSA (Motorola, MSB first) bit order and two's complement signed values. Unused bits are omitted. Check the data warnings before trusting it.</p>`;
}

// ---- Alternatives ---------------------------------------------------------

function fieldList(obj) {
  return html`<dl class="kv">${Object.entries(obj).filter(([k]) => k !== 'note').map(([k, v]) => html`<dt>${k}</dt><dd><code>${typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : String(v)}</code></dd>`)}</dl>`;
}

function renderAltTab({ base, st }) {
  const sigs = base.signals.filter((s) => s.alternatives.length);
  if (!base.alternatives.length && !sigs.length) return emptyState('No conflicting observations', 'Alternatives are kept in the data when contributors observed different things (another length, period, bit position, scaling...). None for this frame.');
  const frameAlts = base.alternatives.length ? html`<h3>Frame-level alternatives</h3>
    <div class="altgrid">
      <div class="altcard${st.frameAlt === null ? ' applied' : ''}"><h4>Base</h4>${fieldList({ length: base.raw.length, periodicity: base.raw.periodicity, senders: base.raw.senders, receivers: base.raw.receivers })}
        <button class="btn btn-sm" data-act="frame-alt" data-idx="">${st.frameAlt === null ? 'Applied' : 'Apply'}</button></div>
      ${base.alternatives.map((a, i) => html`<div class="altcard${st.frameAlt === i ? ' applied' : ''}"><h4>Alternative ${i + 1}</h4><p class="note">${t(a.note)}</p>${fieldList(a.raw)}
        <button class="btn btn-sm" data-act="frame-alt" data-idx="${i}">${st.frameAlt === i ? 'Applied' : 'Apply'}</button></div>`)}
    </div>` : '';
  const sigAlts = sigs.length ? html`<h3>Signal-level alternatives</h3>${sigs.map((s) => html`<div class="altgrid">
      <div class="altcard${st.sigAlts[s.name] === undefined ? ' applied' : ''}"><h4 class="mono">${s.name} (base)</h4>${fieldList(Object.fromEntries(Object.entries(s.raw).filter(([k]) => !['alternatives', 'comment', 'alt_names'].includes(k))))}
        <button class="btn btn-sm" data-act="sig-alt" data-sig="${s.name}" data-idx="">${st.sigAlts[s.name] === undefined ? 'Applied' : 'Apply'}</button></div>
      ${s.alternatives.map((a, i) => html`<div class="altcard${st.sigAlts[s.name] === i ? ' applied' : ''}"><h4 class="mono">${s.name} alt ${i + 1}</h4><p class="note">${t(a.note)}</p>${fieldList(a.raw)}
        <button class="btn btn-sm" data-act="sig-alt" data-sig="${s.name}" data-idx="${i}">${st.sigAlts[s.name] === i ? 'Applied' : 'Apply'}</button></div>`)}
    </div>`)}` : '';
  return html`<p class="muted">Applying an alternative changes the Grid, Simple view, Signals, Decode, Encode and Code tabs for this frame.</p>${frameAlts}${sigAlts}`;
}

// ---- Compare ----------------------------------------------------------------

function renderCompareTab({ base, others }) {
  if (!others.length) return emptyState('Not found elsewhere', `No other architecture/variant/bus has a ${base.type} frame with ID 0x${base.idHex}.`);
  return html`${others.map(({ frame: o, diff, identicalFile }) => {
    const changed = diff.signals.filter((s) => s.status !== 'same');
    return html`<div class="cmp">
      <h4>${frameLinkFull(o)} ${diff.identical ? html`<span class="badge badge-ok">identical</span>` : html`<span class="badge badge-warn">different</span>`} ${identicalFile ? html`<span class="badge badge-link">same file</span>` : ''} ${sourceBadge(o.source)}</h4>
      ${diff.fields.length ? html`<ul class="small">${diff.fields.map((d) => html`<li><b>${d.field}</b>: <code>${JSON.stringify(d.a)}</code> → <code>${JSON.stringify(d.b)}</code></li>`)}</ul>` : ''}
      ${changed.length ? html`<table class="tbl small"><thead><tr><th>Signal</th><th>Status</th><th>Here</th><th>There</th></tr></thead><tbody>${changed.map((s) => html`<tr class="st-${s.status}"><td class="mono">${s.name}${s.to ? ` → ${s.to}` : ''}</td><td>${s.status}${s.what ? ` (${s.what.join(', ')})` : ''}</td><td class="mono">${s.a ? s.a.bits : ''}${s.a && (s.a.hasFactor || s.a.units) ? ' ' + physText(s.a) : ''}</td><td class="mono">${s.b ? s.b.bits : ''}${s.b && (s.b.hasFactor || s.b.units) ? ' ' + physText(s.b) : ''}</td></tr>`)}</tbody></table>` : ''}
    </div>`;
  })}`;
}

function symlinkNotice(f) {
  const tgt = app.db.framesByPath.get(`${f.source}|${f.symlinkOf}`);
  return html`<div class="notice">≡ Same as ${tgt ? html`<a href="${frameRoute(tgt)}">${tgt.archvar} ${tgt.netbus} ${tgt.fileBase}</a>` : html`<code>${f.symlinkOf}</code>`}: this file is a symbolic link, the frame is identical in both places.</div>`;
}

function inheritNotice(f, route) {
  const via = route.query.via;
  if (!via || via === f.archvar) return '';
  const inh = app.db.inherited.get(via);
  if (!inh || !inh.has(f.uid)) return '';
  return html`<div class="notice">↑ Shown as part of <a href="#/frames/${via}" class="mono">${via}</a>: this frame is not redefined there, it is inherited from <a href="#/arch/${f.archvar}" class="mono">${f.archvar}</a>.</div>`;
}

function overrideNotice(f, route) {
  const p = f.overrides;
  const d = f.overrideDiff;
  if (d && d.identical) return html`<div class="notice">Redefined in <span class="mono">${f.archvar}</span> identically to <a href="${frameRoute(p)}">${p.archvar} ${p.netbus} ${p.fileBase}</a>.</div>`;
  const what = d ? [...d.fields.map((x) => x.field), ...d.signals.filter((x) => x.status !== 'same').map((x) => `${x.name} ${x.status}`)] : [];
  return html`<div class="notice warn"><b>Changed in this variant</b> compared to <a href="${frameRoute(p)}">${p.archvar} ${p.netbus} ${p.fileBase}</a>${what.length ? html`: ${what.slice(0, 8).join(', ')}${what.length > 8 ? ` +${what.length - 8}` : ''}` : ''}. <a href="${tabHref(f, 'compare', route)}">See the diff</a></div>`;
}

function frameLinkFull(o) {
  return html`<a href="${frameRoute(o)}"><span class="mono">0x${o.idHex}</span> ${o.name}</a> <span class="muted">${o.archvar} · ${o.netbus}</span>`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindDetail(container, ctx0) {
  const { base, route, tab } = ctx0;
  const st = ctx0.st;
  const rerender = () => renderFrameDetail(container, ctx0.frameVersions, app.route || route);
  const ctx = () => { const e = effective(base, st); return { ...ctx0, f: e.f, signals: e.signals }; };

  if (container._unbind) container._unbind();
  const offs = [];
  offs.push(on(container, 'click', '[data-act]', (ev, el) => {
    const act = el.dataset.act;
    if (act === 'frame-alt') { st.frameAlt = el.dataset.idx === '' ? null : +el.dataset.idx; st.enc = null; rerender(); }
    else if (act === 'sig-alt') { if (el.dataset.idx === '') delete st.sigAlts[el.dataset.sig]; else st.sigAlts[el.dataset.sig] = +el.dataset.idx; st.enc = null; rerender(); }
    else if (act === 'alt-reset') { st.frameAlt = null; st.sigAlts = {}; st.enc = null; rerender(); }
    else if (act === 'close-detail') { location.hash = `#/frames/${base.archvar}`; }
    else if (act === 'dec-clear') { st.decodeHex = ''; const i = $('#dec-input', container); if (i) { i.value = ''; i.focus(); } setHtml($('#dec-out', container), decodeResults(ctx(), '')); }
    else if (act === 'dec-to-enc') {
      const c = ctx();
      const bytes = decodeInputBytes(st.decodeHex, c.f);
      if (bytes) {
        const dec = decodeFrame(c.f, bytes, lang(), c.signals);
        encState(c);
        for (const d of dec.signals) if (d.present && d.raw !== null) st.enc.raw[d.name] = d.sig.type === 'str' ? d.value : d.sig.type === 'bytes' ? d.value : d.raw;
        st.enc.payloadLen = bytes.length;
      }
      location.hash = tabHref(base, 'encode', route);
    } else if (act === 'enc-to-dec') { st.decodeHex = el.dataset.hex; location.hash = tabHref(base, 'decode', route); }
    else if (act === 'enc-reset') { st.enc = null; rerender(); }
  }));
  offs.push(on(container, 'change', '[data-act=enc-unused]', (ev, el) => { st.encUnused = el.checked; setHtml($('#enc-fields', container), encodeForm(ctx())); }));
  offs.push(on(container, 'change', 'select[data-mux]', (ev, el) => {
    st.mux[el.dataset.mux] = el.value === '' ? null : +el.value;
    const tb = $('#tabbody', container);
    setHtml(tb, renderTab(tab, { ...ctx(), route: app.route || route, others: [] }));
  }));
  // hover highlight (grid, legend, tables)
  let lastSig = null;
  offs.push(on(container, 'mouseover', '[data-sig]', (ev, el) => {
    const name = el.dataset.sig;
    if (name === lastSig) return;
    lastSig = name;
    $$('.hl', container).forEach((x) => x.classList.remove('hl'));
    $$(`[data-sig="${CSS.escape(name)}"]`, container).forEach((x) => x.classList.add('hl'));
    const det = $('#sigdetails', container);
    if (det) { const c = ctx(); setHtml(det, signalDetails(c.signals.find((s) => s.name === name), c.f.archvar)); }
  }));
  offs.push(on(container, 'mouseleave', '.bitgrid, .legend, .awp-structure, .awp-prose', () => {
    lastSig = null;
    $$('.hl', container).forEach((x) => x.classList.remove('hl'));
  }, true));
  // decode input
  offs.push(on(container, 'input', '#dec-input', (ev, el) => {
    st.decodeHex = el.value;
    setHtml($('#dec-out', container), decodeResults(ctx(), el.value));
  }));
  // encode inputs
  const encUpdate = (el) => {
    const c = ctx();
    const enc = encState(c);
    const s = c.signals.find((x) => x.name === el.dataset.enc);
    if (!s) return;
    const kind = el.dataset.kind;
    let v;
    if (kind === 'bool') v = el.checked ? 1 : 0;
    else if (kind === 'enum' || kind === 'raw') { v = Math.max(0, Math.round(Number(el.value) || 0)); const mx = maxRaw(s.width); if (typeof mx === 'number') v = Math.min(v, mx); }
    else if (kind === 'phys') v = physToRaw(s, Number(el.value));
    else v = el.value;
    enc.raw[s.name] = v;
    if (s.muxSelector || kind === 'enum' || kind === 'bool' || kind === 'raw') {
      // keep companion inputs in sync (re-render the form, keep focus on raw inputs)
      const focusKind = kind;
      setHtml($('#enc-fields', container), encodeForm(c));
      if (focusKind === 'raw') { const r = $(`[data-enc="${CSS.escape(s.name)}"][data-kind=raw]`, container); if (r) { r.focus(); try { r.setSelectionRange(r.value.length, r.value.length); } catch (e) { /* number inputs */ } } }
    } else {
      const r = $(`[data-enc="${CSS.escape(s.name)}"][data-kind=raw]`, container);
      if (r) r.value = String(v);
    }
    setHtml($('#enc-out', container), encodeOutput(c));
  };
  offs.push(on(container, 'input', '[data-enc]', (ev, el) => { if (el.tagName !== 'SELECT' && el.type !== 'checkbox') encUpdate(el); }));
  offs.push(on(container, 'change', '[data-enc]', (ev, el) => { if (el.tagName === 'SELECT' || el.type === 'checkbox') encUpdate(el); }));
  offs.push(on(container, 'change', '#enc-len', (ev, el) => {
    const c = ctx();
    const enc = encState(c);
    enc.payloadLen = Math.max(1, Math.min(4095, Math.round(Number(el.value) || 1)));
    setHtml($('#enc-out', container), encodeOutput(c));
  }));
  container._unbind = () => offs.forEach((o) => o());
  if (route.query.sig && tab === 'grid') {
    const el = $(`.bitgrid [data-sig="${CSS.escape(route.query.sig)}"]`, container);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
}
