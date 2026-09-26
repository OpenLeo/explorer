// Tools view: log decoder, bit position converter, DBC/JSON export, bus load estimator, data issues.

import { html, $, on, setHtml, download, copyText, toast } from '../dom.js';
import { app, lang } from '../state.js';
import {
  tabs, codeBlock, emptyState, sourceBadge, variantOptions, defaultVariant, busInfo, busLabel, periodText, typeBadge,
} from '../widgets.js';
import { hex, bytesToHex, fmtNum, naturalCompare, debounce } from '../../core/util.js';
import { frameRoute } from '../../core/repo.js';
import { renderGrid, hueMap } from '../bitgrid.js';
import { parseLog, logStats, periodVerdict } from '../../core/logparse.js';
import { decodeFrame } from '../../core/codec.js';
import { Reassembler } from '../../core/isotp.js';
import {
  parseBits, formatBits, dbcMotorolaStart, motorolaLsbStart, intelStart, fromDbcMotorola, fromMotorolaLsb, fromIntel,
  describePos, dbcIntelStart,
} from '../../core/bits.js';
import { normalizeSignal } from '../../core/normalize.js';
import { exportDbc, exportJson } from '../../core/dbc.js';
import { estimateLoad, DEFAULT_BITRATES } from '../../core/busload.js';

const SUBS = [
  { id: 'log', label: 'Log decoder' },
  { id: 'bits', label: 'Bit converter' },
  { id: 'export', label: 'DBC / JSON export' },
  { id: 'busload', label: 'Bus load' },
  { id: 'issues', label: 'Data issues' },
];

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function variantOk(key) { return !!(key && app.db && app.db.variants.has(key)); }

function busesOf(archvar) {
  if (!app.db || !archvar) return [];
  const set = new Set(app.db.variantBuses(archvar).keys());
  for (const f of app.db.variantFrames.get(archvar) || []) set.add(f.netbus);
  return [...set].sort(naturalCompare);
}

// ===========================================================================
// Log decoder
// ===========================================================================

const LOG = {
  text: '', fileText: null, fileName: '', fileSize: 0, format: 'auto', archvar: '', bus: '',
  result: null, page: 0, expanded: null, idFilter: '', detailCache: new Map(),
};

function matchFrames(archvar, bus) {
  const m = new Map();
  const frames = (app.db && app.db.variantFrames.get(archvar)) || [];
  for (const f of frames) {
    if (f.type !== 'can' && f.type !== 'can-tp') continue;
    if (bus && f.netbus !== bus) continue;
    if (!m.has(f.id)) m.set(f.id, f);
  }
  return m;
}

function buildRows(res) {
  // rows: {k: 'f', i} for raw frames, {k: 'tp', i, id, payload} for reassembled ISO-TP payloads
  const rows = [];
  const reasm = new Map();
  res.frames.forEach((fr, i) => {
    rows.push({ k: 'f', i });
    const f = res.match.get(fr.id);
    if (f && f.type === 'can-tp') {
      let r = reasm.get(fr.id);
      if (!r) { r = new Reassembler({ addressing: f.isotp && f.isotp.addressing }); reasm.set(fr.id, r); }
      const p = r.push(fr.data);
      if (p) rows.push({ k: 'tp', i, id: fr.id, payload: p });
    }
  });
  return rows;
}

function runDecode() {
  const text = LOG.fileText !== null ? LOG.fileText : LOG.text;
  const t0 = Date.now();
  const parsed = parseLog(text || '', LOG.format);
  const stats = [...logStats(parsed.frames).values()].sort((a, b) => a.id - b.id || (a.ext ? 1 : 0) - (b.ext ? 1 : 0));
  let first = null;
  let last = null;
  for (const f of parsed.frames) if (f.ts !== null && f.ts !== undefined) { if (first === null) first = f.ts; last = f.ts; }
  LOG.result = { ...parsed, stats, first, last, ms: 0 };
  rematch();
  LOG.result.ms = Date.now() - t0;
  LOG.page = 0;
  LOG.expanded = null;
}

function rematch() {
  const res = LOG.result;
  if (!res) return;
  res.match = matchFrames(LOG.archvar, LOG.bus);
  res.rows = buildRows(res);
  LOG.detailCache = new Map();
  applyIdFilter();
}

function applyIdFilter() {
  const res = LOG.result;
  if (!res) return;
  const q = LOG.idFilter.trim().replace(/^0x/i, '');
  if (!q || !/^[0-9a-f]{1,8}$/i.test(q)) { res.view = res.rows; return; }
  const id = parseInt(q, 16);
  res.view = res.rows.filter((r) => (r.k === 'tp' ? r.id : res.frames[r.i].id) === id);
}

function heatColor(ratio) {
  if (!ratio) return '';
  const r = Math.min(1, ratio);
  return `background:hsl(${Math.round(45 - 45 * r)} 90% ${Math.round(72 - 30 * r)}%)`;
}

function miniHeat(st) {
  const denom = Math.max(1, st.count - 1);
  const cells = [];
  for (let b = 0; b < 64; b++) {
    const c = st.bitChanges[b];
    cells.push(html`<i style="${b >= st.maxLen * 8 ? 'opacity:.25' : heatColor(c / denom)}" title="byte ${Math.floor(b / 8) + 1} bit ${7 - (b % 8)}: ${c} changes"></i>`);
  }
  return html`<span class="heat">${cells}</span>`;
}

function bigHeat(st) {
  const denom = Math.max(1, st.count - 1);
  const n = Math.min(64, Math.max(1, st.maxLen));
  const cells = [html`<span></span>`, ...[7, 6, 5, 4, 3, 2, 1, 0].map((b) => html`<span class="muted">${b}</span>`)];
  for (let byte = 0; byte < n; byte++) {
    cells.push(html`<span class="muted">${byte + 1}</span>`);
    for (let k = 0; k < 8; k++) {
      const c = st.bitChanges[byte * 8 + k];
      cells.push(html`<span style="${heatColor(c / denom)}" title="${c} changes">${c || ''}</span>`);
    }
  }
  return html`<div class="heatbig">${cells}</div>`;
}

function decodedSummary(f, data) {
  try {
    const d = decodeFrame(f, data, lang());
    const parts = [];
    for (const s of d.signals) {
      if (s.sig.unused || !s.present || s.active === false) continue;
      parts.push(`${s.name}=${s.label ? s.label : s.text}`);
    }
    const txt = parts.join(', ');
    return txt.length > 220 ? txt.slice(0, 217) + '…' : txt;
  } catch (e) { return ''; }
}

function signalStats(st) {
  const key = st.id + (st.ext ? 0x100000000 : 0);
  if (LOG.detailCache.has(key)) return LOG.detailCache.get(key);
  const res = LOG.result;
  const f = res.match.get(st.id);
  if (!f) return null;
  const payloads = [];
  if (f.type === 'can-tp') { for (const r of res.rows) if (r.k === 'tp' && r.id === st.id) payloads.push(r.payload); }
  else for (const fr of res.frames) if (fr.id === st.id && !!fr.ext === !!st.ext) payloads.push(fr.data);
  const MAX = 20000;
  const capped = payloads.length > MAX;
  const acc = new Map();
  let lastBytes = null;
  const step = capped ? payloads.length / MAX : 1;
  for (let x = 0; x < payloads.length; x += step) {
    const data = payloads[Math.floor(x)];
    lastBytes = data;
    let dec;
    try { dec = decodeFrame(f, data, lang()); } catch (e) { continue; }
    for (const d of dec.signals) {
      if (!d.present || d.active === false) continue;
      let a = acc.get(d.name);
      if (!a) { a = { sig: d.sig, first: null, last: null, min: null, max: null, distinct: new Set(), n: 0 }; acc.set(d.name, a); }
      const v = typeof d.phys === 'number' ? d.phys : null;
      const shown = d.label ? `${d.text} (${d.label})` : d.text;
      if (a.first === null) a.first = shown;
      a.last = shown;
      if (v !== null) { a.min = a.min === null ? v : Math.min(a.min, v); a.max = a.max === null ? v : Math.max(a.max, v); }
      if (a.distinct.size < 1000) a.distinct.add(shown);
      a.n++;
    }
  }
  if (payloads.length) lastBytes = payloads[payloads.length - 1];
  const out = { f, acc, lastBytes, count: payloads.length, capped };
  LOG.detailCache.set(key, out);
  return out;
}

function detailPanel(st) {
  const res = LOG.result;
  const f = res.match.get(st.id);
  if (!f) {
    return html`<div class="card"><h4>0x${hex(st.id, st.ext ? 8 : 3)} — unknown in ${LOG.archvar}${LOG.bus ? ' ' + LOG.bus : ''}</h4>
      <p class="muted">No documented frame with this ID. Last payload: <code>${bytesToHex(st.lastData)}</code></p>
      <div class="row"><div><div class="small muted">Changing bits (count)</div>${bigHeat(st)}</div></div></div>`;
  }
  const ss = signalStats(st);
  const bytes = ss && ss.lastBytes ? ss.lastBytes : st.lastData;
  let dec = null;
  try { dec = decodeFrame(f, bytes, lang()); } catch (e) { dec = null; }
  const flags = {};
  if (dec) for (const d of dec.signals) flags[d.name] = d.flags;
  const hues = hueMap(f.signals);
  const rows = ss ? [...ss.acc.values()].filter((a) => !a.sig.unused).map((a) => html`<tr>
      <td class="mono">${a.sig.name}</td><td class="mono">${a.sig.bits}</td><td>${a.first}</td><td>${a.last}</td>
      <td class="num">${a.min !== null ? fmtNum(a.min) : ''}</td><td class="num">${a.max !== null ? fmtNum(a.max) : ''}</td>
      <td class="num">${a.distinct.size >= 1000 ? '1000+' : a.distinct.size}</td></tr>`) : [];
  return html`<div class="card">
    <h4><a href="${frameRoute(f)}"><span class="mono">0x${f.idHex}</span> ${f.name}</a> ${typeBadge(f.type)} <span class="muted small">${f.netbus} · documented ${periodText(f)}</span></h4>
    <div class="small muted">Last ${f.type === 'can-tp' ? 'reassembled payload' : 'payload'}: <code>${bytesToHex(bytes || [])}</code></div>
    ${bytes && bytes.length ? renderGrid(f, f.signals, { bytes, muxState: dec ? dec.muxState : null, hues, flags }) : ''}
    <div class="two-col">
      <div><div class="small muted">Changing bits over the log (number of changes per bit)</div>${bigHeat(st)}</div>
      <div>${ss && ss.capped ? html`<p class="notice warn small">Values sampled on 20000 of ${ss.count} payloads.</p>` : ''}</div>
    </div>
    ${rows.length ? html`<div class="tablewrap"><table class="tbl compact small"><thead><tr><th>Signal</th><th>Bits</th><th>First</th><th>Last</th><th>Min</th><th>Max</th><th>Distinct</th></tr></thead><tbody>${rows}</tbody></table></div>` : html`<p class="muted small">No decoded values.</p>`}
  </div>`;
}

function statsTable() {
  const res = LOG.result;
  const rows = res.stats.map((st) => {
    const key = st.id + (st.ext ? 0x100000000 : 0);
    const f = res.match.get(st.id);
    const doc = f ? f.periodMs : null;
    const verdict = st.period ? periodVerdict(st.period.mean, doc) : null;
    const expanded = LOG.expanded === key;
    return html`<tr class="${f ? '' : 'unknown'}" data-stat="${key}" style="cursor:pointer" title="Click for details">
      <td class="mono"><b>${hex(st.id, st.ext ? 8 : 3)}</b></td>
      <td>${f ? html`<a href="${frameRoute(f)}">${f.name}</a> ${f.type === 'can-tp' ? typeBadge('can-tp') : ''}` : html`<b>UNKNOWN</b>`}</td>
      <td class="num">${st.count}</td>
      <td class="num">${[...st.dlcs].sort((a, b) => a - b).join(', ')}${f && f.type === 'can' && ![...st.dlcs].includes(f.length) ? html` <span class="badge badge-warn" title="documented length ${f.length}">≠${f.length}</span>` : ''}</td>
      <td class="num">${st.period ? html`${fmtNum(st.period.mean, 1)} <span class="muted small">(${fmtNum(st.period.min, 1)}–${fmtNum(st.period.max, 1)})</span>` : html`<span class="muted">—</span>`}</td>
      <td>${f ? periodText(f) : ''} ${verdict ? html`<span class="badge ${verdict === 'ok' ? 'badge-ok' : 'badge-warn'}">${verdict}</span>` : ''}</td>
      <td class="num">${st.distinctCount >= 1000 ? '1000+' : st.distinctCount}</td>
      <td>${miniHeat(st)}</td>
    </tr>${expanded ? html`<tr class="detailrow"><td colspan="8">${detailPanel(st)}</td></tr>` : ''}`;
  });
  return html`<div class="tablewrap"><table class="tbl compact">
    <thead><tr><th>ID</th><th>Frame</th><th>Count</th><th>DLC</th><th>Measured period ms (min–max)</th><th>Documented</th><th>Distinct</th><th>Changing bits</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

const PAGE = 200;

function framesTable() {
  const res = LOG.result;
  const view = res.view || res.rows;
  const pages = Math.max(1, Math.ceil(view.length / PAGE));
  if (LOG.page >= pages) LOG.page = pages - 1;
  const slice = view.slice(LOG.page * PAGE, LOG.page * PAGE + PAGE);
  const rows = slice.map((r) => {
    const fr = res.frames[r.i];
    if (r.k === 'tp') {
      const f = res.match.get(r.id);
      return html`<tr class="tprow"><td class="mono small">${fr.ts !== null && fr.ts !== undefined ? fmtNum(fr.ts, 6) : ''}</td><td class="mono">${hex(r.id, 3)}</td>
        <td>${f ? html`<a href="${frameRoute(f)}">${f.name}</a>` : ''} <span class="badge type-can-tp">ISO-TP payload</span></td>
        <td class="mono small">${bytesToHex(r.payload.slice(0, 32))}${r.payload.length > 32 ? ` … (${r.payload.length} bytes)` : ''}</td>
        <td class="small">${f ? decodedSummary(f, r.payload) : ''}</td></tr>`;
    }
    const f = res.match.get(fr.id);
    return html`<tr class="${f ? '' : 'unknown'}"><td class="mono small">${fr.ts !== null && fr.ts !== undefined ? fmtNum(fr.ts, 6) : ''}</td><td class="mono">${hex(fr.id, fr.ext ? 8 : 3)}</td>
      <td>${f ? html`<a href="${frameRoute(f)}">${f.name}</a>` : html`<span class="muted">unknown</span>`}</td>
      <td class="mono small">${fr.rtr ? 'RTR' : bytesToHex(fr.data)}</td>
      <td class="small">${f && f.type === 'can' ? decodedSummary(f, fr.data) : ''}</td></tr>`;
  });
  return html`<div class="row"><b>Frames</b><span class="muted small">${view.length} rows${view !== res.rows ? ` (filtered from ${res.rows.length})` : ''}</span>
      <span class="spacer"></span>
      <label class="small muted">ID filter <input id="log-idfilter" class="mono" style="width:90px" value="${LOG.idFilter}" placeholder="eg. 036"></label>
      <button class="btn btn-sm" data-act="log-page" data-d="-1" ${LOG.page === 0 ? 'disabled' : ''}>◀ Prev</button>
      <span class="small">page ${LOG.page + 1} / ${pages}</span>
      <button class="btn btn-sm" data-act="log-page" data-d="1" ${LOG.page >= pages - 1 ? 'disabled' : ''}>Next ▶</button></div>
    <div class="tablewrap"><table class="tbl compact"><thead><tr><th>Time (s)</th><th>ID</th><th>Frame</th><th>Data</th><th>Decoded</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function logOutput() {
  const res = LOG.result;
  if (!res) return html`<p class="muted">Paste a log or open a file, then press Decode.</p>`;
  if (!res.frames.length) {
    return html`<div class="notice warn">No frame found (format: ${res.format}). ${res.errors.length} line(s) could not be parsed.</div>
      ${res.errors.slice(0, 5).map((e) => html`<div class="mono small muted">line ${e.line}: ${String(e.text).slice(0, 140)}</div>`)}`;
  }
  const unknown = res.stats.filter((s) => !res.match.has(s.id)).length;
  const span = res.first !== null && res.last !== null ? res.last - res.first : null;
  return html`<div class="card">
      <div class="row"><span>Format <b>${res.format}</b></span><span><b>${res.frames.length}</b> frames</span><span><b>${res.stats.length}</b> IDs (<span class="${unknown ? 'err' : ''}">${unknown} unknown</span>)</span>
        ${span !== null ? html`<span>span <b>${fmtNum(span, 3)}</b> s</span>` : ''}<span class="muted small">matched against ${LOG.archvar}${LOG.bus ? ' · ' + LOG.bus : ' (all buses)'} · ${res.ms} ms</span></div>
      ${res.errors.length ? html`<details><summary class="small">${res.errors.length} line(s) not parsed</summary>${res.errors.slice(0, 8).map((e) => html`<div class="mono small muted">line ${e.line}: ${String(e.text).slice(0, 140)}</div>`)}</details>` : ''}
    </div>
    <h3>Per ID statistics</h3>
    ${statsTable()}
    <h3>Decoded frames</h3>
    <div id="log-frames">${framesTable()}</div>`;
}

function busSelect(archvar, selected, allLabel) {
  return html`<option value="">${allLabel}</option>${busesOf(archvar).map((b) => html`<option value="${b}" ${b === selected ? 'selected' : ''}>${busLabel(archvar, b)}</option>`)}`;
}

function renderLog(root) {
  if (!variantOk(LOG.archvar)) LOG.archvar = defaultVariant();
  const formats = ['auto', 'candump-l', 'candump', 'savvycan', 'asc', 'plain'];
  return html`<div class="card">
      <p class="muted small">Supported: <code>candump -L</code> <code>(ts) can0 036#0E00…</code>, <code>candump</code> <code>can0 036 [8] 0E 00 …</code>, SavvyCAN / GVRET CSV, Vector ASC, plain <code>ID#DATA</code> or <code>ID DATA</code> lines. Everything stays in your browser.</p>
      <textarea id="log-text" rows="8" placeholder="(1600000000.100000) can0 036#0E00000000000000" spellcheck="false">${LOG.fileText !== null ? '' : LOG.text}</textarea>
      <div id="log-file-info" class="small muted">${LOG.fileText !== null ? `File ${LOG.fileName} (${fmtSize(LOG.fileSize)}) loaded — not shown in the text area.` : ''}</div>
      <div class="row">
        <label class="btn btn-sm">Open file…<input type="file" id="log-file" accept=".log,.txt,.csv,.asc,.trc" hidden></label>
        <label class="small">Format <select id="log-format">${formats.map((f) => html`<option value="${f}" ${LOG.format === f ? 'selected' : ''}>${f}</option>`)}</select></label>
        <label class="small">Architecture <select id="log-arch">${variantOptions(LOG.archvar)}</select></label>
        <label class="small">Bus <select id="log-bus">${busSelect(LOG.archvar, LOG.bus, 'all buses of the variant')}</select></label>
        <span class="spacer"></span>
        <button class="btn btn-sm" data-act="log-clear">Clear</button>
        <button class="btn primary" data-act="log-decode">Decode</button>
      </div>
    </div>
    <div id="log-out">${logOutput()}</div>`;
}

function bindLog(root) {
  const offs = [];
  const out = () => setHtml($('#log-out', root), logOutput());
  offs.push(on(root, 'input', '#log-text', (ev, el) => { LOG.text = el.value; if (LOG.fileText !== null && el.value) { LOG.fileText = null; setHtml($('#log-file-info', root), ''); } }));
  offs.push(on(root, 'change', '#log-file', async (ev, el) => {
    const file = el.files && el.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      LOG.fileName = file.name;
      LOG.fileSize = file.size;
      if (file.size < 1.5 * 1024 * 1024) {
        LOG.fileText = null;
        LOG.text = text;
        const ta = $('#log-text', root);
        if (ta) ta.value = text;
        setHtml($('#log-file-info', root), html`File ${file.name} (${fmtSize(file.size)})`);
      } else {
        LOG.fileText = text;
        const ta = $('#log-text', root);
        if (ta) ta.value = '';
        setHtml($('#log-file-info', root), html`File ${file.name} (${fmtSize(file.size)}) loaded — not shown in the text area.`);
      }
      runDecode();
      out();
    } catch (e) { toast(`Could not read the file: ${e.message}`, 'error'); }
  }));
  offs.push(on(root, 'change', '#log-format', (ev, el) => { LOG.format = el.value; }));
  offs.push(on(root, 'change', '#log-arch', (ev, el) => {
    LOG.archvar = el.value;
    LOG.bus = '';
    setHtml($('#log-bus', root), busSelect(LOG.archvar, '', 'all buses of the variant'));
    if (LOG.result) { rematch(); out(); }
  }));
  offs.push(on(root, 'change', '#log-bus', (ev, el) => { LOG.bus = el.value; if (LOG.result) { rematch(); out(); } }));
  offs.push(on(root, 'click', '[data-act=log-decode]', () => {
    const ta = $('#log-text', root);
    if (ta && LOG.fileText === null) LOG.text = ta.value;
    setHtml($('#log-out', root), html`<p class="muted">Decoding…</p>`);
    setTimeout(() => { try { runDecode(); } catch (e) { toast(e.message, 'error'); } out(); }, 10);
  }));
  offs.push(on(root, 'click', '[data-act=log-clear]', () => {
    LOG.text = ''; LOG.fileText = null; LOG.result = null; LOG.idFilter = '';
    const ta = $('#log-text', root);
    if (ta) ta.value = '';
    setHtml($('#log-file-info', root), '');
    out();
  }));
  offs.push(on(root, 'click', 'tr[data-stat]', (ev, el) => {
    if (ev.target.closest('a')) return;
    const key = Number(el.dataset.stat);
    LOG.expanded = LOG.expanded === key ? null : key;
    const res = LOG.result;
    if (res) {
      const scrollY = window.scrollY;
      out();
      window.scrollTo(0, scrollY);
    }
  }));
  offs.push(on(root, 'click', '[data-act=log-page]', (ev, el) => {
    LOG.page = Math.max(0, LOG.page + Number(el.dataset.d));
    setHtml($('#log-frames', root), framesTable());
  }));
  const idf = debounce((v) => {
    LOG.idFilter = v;
    LOG.page = 0;
    applyIdFilter();
    const box = $('#log-frames', root);
    if (!box) return;
    setHtml(box, framesTable());
    const inp = $('#log-idfilter', root);
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }, 250);
  offs.push(on(root, 'input', '#log-idfilter', (ev, el) => idf(el.value)));
  return offs;
}

// ===========================================================================
// Bit converter
// ===========================================================================

const BITS = { psa: '1.7-2.0', le: false };

function bitsModel() {
  const pos = parseBits(BITS.psa);
  if (!pos || pos.toEnd) return { pos: null };
  const le = BITS.le && (pos.start >> 3) !== (pos.end >> 3);
  return {
    pos, le,
    moto: dbcMotorolaStart(pos),
    lsb: motorolaLsbStart(pos),
    intel: le ? dbcIntelStart(pos) : intelStart(pos),
    len: pos.width,
  };
}

function bitsOutput() {
  const m = bitsModel();
  if (!m.pos) return html`<div class="notice warn">Invalid PSA notation. Expected <code>&lt;byte&gt;.&lt;bit&gt;</code> or a range <code>&lt;byte&gt;.&lt;bit&gt;-&lt;byte&gt;.&lt;bit&gt;</code> in transmission order, eg. <code>1.7-2.0</code>.</div>`;
  const length = Math.max(8, m.pos.endByte);
  const sig = normalizeSignal('FIELD', { bits: m.pos.text, byte_order: m.le ? 'little_endian' : undefined }, length);
  const frame = { length, type: 'can', archvar: '', idHex: '', signals: [sig] };
  const multi = (m.pos.start >> 3) !== (m.pos.end >> 3);
  return html`<div class="card">
      <p><b>${describePos(m.pos, lang())}</b> — ${m.len} bit${m.len > 1 ? 's' : ''}, ${m.le ? 'little endian (byte_order: little_endian)' : 'big endian (PSA default)'}</p>
      <ul class="small">
        <li>DBC Motorola (<code>@0</code>): <code>${m.moto}|${m.len}@0+</code>${m.le ? html` <span class="muted">(if the field were big endian)</span>` : ''}</li>
        <li>Motorola LSB start bit: <code>${m.lsb}</code></li>
        <li>DBC Intel (<code>@1</code>): ${m.intel !== null ? html`<code>${m.intel}|${m.len}@1+</code>` : html`<span class="muted">${m.le ? 'not byte aligned: not representable' : multi ? 'none (multi-byte big endian field)' : '—'}</span>`}</li>
      </ul>
      ${renderGrid(frame, [sig], { hues: hueMap([sig]) })}
    </div>`;
}

function renderBits() {
  const m = bitsModel();
  const v = (x) => (x === null || x === undefined ? '' : String(x));
  return html`<div class="conv-grid">
      <div class="card"><h4>PSA / DBMUXEv</h4>
        <label class="lbl-block">bits</label><input id="bc-psa" class="mono" value="${BITS.psa}" spellcheck="false">
        <label class="chk small"><input type="checkbox" id="bc-le" ${BITS.le ? 'checked' : ''}> byte_order: little_endian</label>
        <p class="small muted">Bytes from 1, bit 7 = MSB (first sent); ranges in transmission order.</p></div>
      <div class="card"><h4>DBC Motorola (@0)</h4>
        <label class="lbl-block">start bit (MSB, Vector)</label><input id="bc-moto" type="number" min="0" value="${v(m.moto)}">
        <label class="lbl-block">length</label><input id="bc-moto-len" type="number" min="1" value="${v(m.len)}"></div>
      <div class="card"><h4>Motorola LSB</h4>
        <label class="lbl-block">start bit (LSB)</label><input id="bc-lsb" type="number" min="0" value="${v(m.lsb)}">
        <label class="lbl-block">length</label><input id="bc-lsb-len" type="number" min="1" value="${v(m.len)}">
        <p class="small muted">Used by some tools (Kvaser, older CANdb++ settings).</p></div>
      <div class="card"><h4>Intel (@1)</h4>
        <label class="lbl-block">start bit (LSB)</label><input id="bc-intel" type="number" min="0" value="${v(m.intel)}">
        <label class="lbl-block">length</label><input id="bc-intel-len" type="number" min="1" value="${v(m.len)}">
        <div id="bc-intel-note" class="small muted"></div></div>
    </div>
    <div id="bc-out">${bitsOutput()}</div>
    <div class="card small">
      <h4>Notations</h4>
      <ul>
        <li><b>PSA</b>: <code>&lt;byte&gt;.&lt;bit&gt;</code>, byte 1 is the first byte sent, bit 7 its MSB. <code>1.7-2.0</code> is a 16 bit big endian value (byte 1 = MSB). <code>3.7-n</code> runs until the end of a variable length payload.</li>
        <li><b>DBC sawtooth numbering</b>: bit n = byte index (from 0) × 8 + bit (0 = LSB). Motorola (<code>@0</code>) signals are given by their MSB, Intel (<code>@1</code>) signals by their LSB.</li>
        <li><b>Little endian</b> multi-byte fields (rare at PSA) are written in DBMUXEv as the covered range plus <code>byte_order: little_endian</code>: a byte aligned Intel field of N bytes whose LSB byte is k maps to <code>k.7-(k+N-1).0</code>.</li>
      </ul>
    </div>`;
}

function bindBits(root) {
  const offs = [];
  const setVals = (skip) => {
    const m = bitsModel();
    const set = (id, val) => { if (id === skip) return; const el = $(`#${id}`, root); if (el) el.value = val === null || val === undefined ? '' : String(val); };
    set('bc-psa', BITS.psa);
    set('bc-moto', m.moto); set('bc-moto-len', m.len);
    set('bc-lsb', m.lsb); set('bc-lsb-len', m.len);
    set('bc-intel', m.intel); set('bc-intel-len', m.len);
    const le = $('#bc-le', root);
    if (le) le.checked = BITS.le;
    setHtml($('#bc-out', root), bitsOutput());
  };
  const num = (id) => { const el = $(`#${id}`, root); const n = el ? parseInt(el.value, 10) : NaN; return Number.isFinite(n) ? n : null; };
  offs.push(on(root, 'input', '#bc-psa', (ev, el) => { BITS.psa = el.value.trim(); setVals('bc-psa'); }));
  offs.push(on(root, 'change', '#bc-le', (ev, el) => { BITS.le = el.checked; setVals(''); }));
  offs.push(on(root, 'input', '#bc-moto, #bc-moto-len', (ev, el) => {
    const r = fromDbcMotorola(num('bc-moto'), num('bc-moto-len'));
    if (r) { BITS.psa = r; BITS.le = false; setVals(el.id); }
  }));
  offs.push(on(root, 'input', '#bc-lsb, #bc-lsb-len', (ev, el) => {
    const r = fromMotorolaLsb(num('bc-lsb'), num('bc-lsb-len'));
    if (r) { BITS.psa = r; BITS.le = false; setVals(el.id); }
  }));
  offs.push(on(root, 'input', '#bc-intel, #bc-intel-len', (ev, el) => {
    const s = num('bc-intel');
    const n = num('bc-intel-len');
    const note = $('#bc-intel-note', root);
    if (s === null || n === null || n < 1) return;
    const r = fromIntel(s, n);
    if (r.psa) { BITS.psa = r.psa; BITS.le = false; setHtml(note, ''); setVals(el.id); return; }
    if (s % 8 === 0 && n % 8 === 0) {
      const k = s / 8 + 1;
      BITS.psa = formatBits((k - 1) * 8, (k - 1) * 8 + n - 1);
      BITS.le = true;
      setHtml(note, html`Little endian field: DBMUXEv <code>bits: '${BITS.psa}'</code> + <code>byte_order: little_endian</code>.`);
      setVals(el.id);
      return;
    }
    setHtml(note, html`Little endian field crossing bytes, not a single PSA range. Per byte (LSB first): ${r.parts.map((p, i) => html`${i ? ', ' : ''}<code>${p}</code>`)}.`);
  }));
  return offs;
}

// ===========================================================================
// Export
// ===========================================================================

const EXP = { archvar: '', buses: [], ecu: '', mode: 'both', unused: false, lang: '', inherited: true, last: null };

function exportFrames() {
  const db = app.db;
  let frames = EXP.inherited ? (db.variantFrames.get(EXP.archvar) || []) : (db.ownFrames.get(EXP.archvar) || []);
  if (EXP.buses.length) frames = frames.filter((f) => EXP.buses.includes(f.netbus));
  const ecu = EXP.ecu.trim().toUpperCase();
  if (ecu) {
    frames = frames.filter((f) => {
      const s = f.senders.some((n) => n.toUpperCase() === ecu);
      const r = f.receivers.some((n) => n.toUpperCase() === ecu);
      return EXP.mode === 'sender' ? s : EXP.mode === 'receiver' ? r : s || r;
    });
  }
  return frames;
}

function exportName(ext) {
  const bus = EXP.buses.length === 1 ? EXP.buses[0] : EXP.buses.length ? 'selection' : 'all';
  return `${EXP.archvar}_${bus}${EXP.ecu ? '_' + EXP.ecu.toUpperCase() : ''}.${ext}`.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function exportOutput() {
  const frames = exportFrames();
  if (!frames.length) { EXP.last = null; return emptyState('Nothing to export', 'No frame matches this selection.'); }
  const label = `${EXP.archvar} ${EXP.buses.length ? EXP.buses.join(', ') : 'all buses'}${EXP.ecu ? ' ECU ' + EXP.ecu : ''}`;
  const r = exportDbc(frames, { lang: EXP.lang || lang(), includeUnused: EXP.unused, busLabel: label });
  EXP.last = { frames, text: r.text };
  const nonCan = frames.filter((f) => f.type === 'van' || f.type === 'lin').length;
  const lines = r.text.split('\n');
  const bu = Math.max(0, lines.findIndex((l) => l.startsWith('BU_')));
  const preview = lines.slice(bu, bu + 80).join('\n');
  return html`<div class="card">
      <div class="row"><span><b>${frames.length - r.skipped.length}</b> frames exported</span>
        ${r.skipped.length ? html`<span class="badge badge-warn">${r.skipped.length} skipped</span>` : ''}
        ${r.warnings.length ? html`<span class="badge badge-warn">${r.warnings.length} warnings</span>` : ''}
        <span class="spacer"></span>
        <button class="btn primary" data-act="exp-dbc">Download DBC</button>
        <button class="btn" data-act="exp-json">Download JSON</button>
        <button class="btn" data-act="exp-copy">Copy DBC</button></div>
      ${nonCan ? html`<p class="notice small">${nonCan} VAN/LIN frame(s) are exported with their raw identifiers: DBC is CAN oriented, use them for documentation only.</p>` : ''}
      ${r.skipped.length ? html`<details><summary class="small">Skipped frames</summary><ul class="small">${r.skipped.map((s) => html`<li><code>${s.frame.idHex}</code> ${s.frame.name} (${s.frame.netbus}): ${s.reason}</li>`)}</ul></details>` : ''}
      ${r.warnings.length ? html`<details><summary class="small">Warnings</summary><ul class="small">${r.warnings.slice(0, 200).map((w) => html`<li>${w}</li>`)}</ul></details>` : ''}
    </div>
    ${codeBlock(preview + '\n…', { title: 'Preview (first lines)', lang: 'dbc' })}`;
}

function exportControls() {
  const db = app.db;
  const buses = busesOf(EXP.archvar);
  const counts = new Map();
  for (const f of db.variantFrames.get(EXP.archvar) || []) counts.set(f.netbus, (counts.get(f.netbus) || 0) + 1);
  const nodes = [...(db.nodeUsage.get(EXP.archvar) || new Map()).keys()].sort(naturalCompare);
  const langs = ['en', 'fr', 'es', 'de', 'it', 'pl', 'ru', 'zh', 'hu', 'pt'];
  return html`<div class="card">
      <div class="row">
        <label class="small">Architecture <select id="exp-arch">${variantOptions(EXP.archvar)}</select></label>
        <label class="small">ECU <select id="exp-ecu"><option value="">all ECUs</option>${nodes.map((n) => html`<option value="${n}" ${EXP.ecu === n ? 'selected' : ''}>${n}</option>`)}</select></label>
        <select id="exp-mode" class="small">${['both', 'sender', 'receiver'].map((m) => html`<option value="${m}" ${EXP.mode === m ? 'selected' : ''}>${m}</option>`)}</select>
        <label class="small">Comments <select id="exp-lang">${langs.map((l) => html`<option value="${l}" ${(EXP.lang || lang()) === l ? 'selected' : ''}>${l}</option>`)}</select></label>
      </div>
      <div class="row small"><span class="muted">Buses:</span>${buses.map((b) => html`<label class="chk"><input type="checkbox" data-expbus="${b}" ${EXP.buses.includes(b) ? 'checked' : ''}> ${b} <span class="count">${counts.get(b) || 0}</span></label>`)}<span class="muted">(none checked = all)</span></div>
      <div class="row small">
        <label class="chk"><input type="checkbox" id="exp-unused" ${EXP.unused ? 'checked' : ''}> include unused signals</label>
        <label class="chk"><input type="checkbox" id="exp-inh" ${EXP.inherited ? 'checked' : ''}> include frames inherited from the parent variant</label>
      </div>
    </div>`;
}

function renderExport(route) {
  if (route.query.arch && variantOk(route.query.arch) && route.query.arch !== EXP.archvar) { EXP.archvar = route.query.arch; EXP.buses = []; EXP.ecu = ''; }
  if (!variantOk(EXP.archvar)) EXP.archvar = defaultVariant();
  return html`<div id="exp-ctl">${exportControls()}</div><div id="exp-out">${exportOutput()}</div>`;
}

function bindExport(root) {
  const offs = [];
  const out = () => setHtml($('#exp-out', root), exportOutput());
  offs.push(on(root, 'change', '#exp-arch', (ev, el) => {
    EXP.archvar = el.value; EXP.buses = []; EXP.ecu = '';
    setHtml($('#exp-ctl', root), exportControls());
    out();
  }));
  offs.push(on(root, 'change', '#exp-ecu', (ev, el) => { EXP.ecu = el.value; out(); }));
  offs.push(on(root, 'change', '#exp-mode', (ev, el) => { EXP.mode = el.value; out(); }));
  offs.push(on(root, 'change', '#exp-lang', (ev, el) => { EXP.lang = el.value; out(); }));
  offs.push(on(root, 'change', '#exp-unused', (ev, el) => { EXP.unused = el.checked; out(); }));
  offs.push(on(root, 'change', '#exp-inh', (ev, el) => { EXP.inherited = el.checked; out(); }));
  offs.push(on(root, 'change', '[data-expbus]', (ev, el) => {
    const b = el.dataset.expbus;
    EXP.buses = el.checked ? [...new Set([...EXP.buses, b])] : EXP.buses.filter((x) => x !== b);
    out();
  }));
  offs.push(on(root, 'click', '[data-act=exp-dbc]', () => { if (EXP.last) download(exportName('dbc'), EXP.last.text); }));
  offs.push(on(root, 'click', '[data-act=exp-copy]', () => { if (EXP.last) copyText(EXP.last.text); }));
  offs.push(on(root, 'click', '[data-act=exp-json]', () => {
    if (!EXP.last) return;
    try {
      download(exportName('json'), exportJson(EXP.last.frames, { architecture: EXP.archvar, buses: EXP.buses.length ? EXP.buses : 'all', ecu: EXP.ecu || undefined }), 'application/json');
    } catch (e) { toast(`JSON export failed: ${e.message}`, 'error'); }
  }));
  return offs;
}

// ===========================================================================
// Bus load
// ===========================================================================

const BL = { archvar: '', bus: '', bitrate: null, eventRate: 0 };

function blDefaults() {
  if (!variantOk(BL.archvar)) BL.archvar = defaultVariant();
  const buses = busesOf(BL.archvar);
  if (!buses.includes(BL.bus)) {
    const counts = new Map();
    for (const f of app.db.variantFrames.get(BL.archvar) || []) counts.set(f.netbus, (counts.get(f.netbus) || 0) + 1);
    BL.bus = buses.slice().sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0))[0] || '';
    BL.bitrate = null;
  }
}

function blProtocol() {
  const b = busInfo(BL.archvar, BL.bus);
  const frames = (app.db.variantFrames.get(BL.archvar) || []).filter((f) => f.netbus === BL.bus);
  let p = b && b.protocol ? b.protocol.toUpperCase() : '';
  if (!p) p = frames.some((f) => f.type === 'van') ? 'VAN' : frames.some((f) => f.type === 'lin') ? 'LIN' : 'CAN';
  return { protocol: p, bus: b, frames };
}

function blBitrate() {
  if (BL.bitrate) return BL.bitrate;
  const { protocol, bus } = blProtocol();
  return (bus && bus.bitrate) || DEFAULT_BITRATES[protocol] || 500;
}

function busloadOutput() {
  if (!BL.bus) return emptyState('No bus', 'This architecture variant has no bus.');
  const { protocol, frames } = blProtocol();
  if (!frames.length) return emptyState('No frame', `No frame documented on ${BL.bus}.`);
  const r = estimateLoad(frames, { bitrate: blBitrate(), protocol, eventRate: Number(BL.eventRate) || 0 });
  const pct = r.load * 100;
  const cls = pct > 70 ? 'high' : pct > 40 ? 'mid' : '';
  const unit = protocol === 'VAN' ? 'TS' : 'bits';
  return html`<div class="card">
      <div class="row"><span style="font-size:22px;font-weight:700">${fmtNum(pct, 1)} %</span><span class="muted">estimated load of ${BL.bus} (${protocol} ${fmtNum(r.bitrate)} k${protocol === 'VAN' ? 'TS' : 'bit'}/s)</span></div>
      <div class="loadbar"><div class="${cls}" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>
      <p class="small muted">${fmtNum(r.totalBps, 0)} ${unit}/s from ${r.rows.length} periodic frame(s); ${r.ignored.length} frame(s) without period ${Number(BL.eventRate) ? 'estimated at the assumed event rate or ' : ''}ignored.</p>
    </div>
    <div class="tablewrap"><table class="tbl compact">
      <thead><tr><th>ID</th><th>Name</th><th class="num">Len</th><th>Period</th><th class="num">${unit}/frame</th><th class="num">frames/s</th><th class="num">${unit}/s</th><th class="num">Share</th></tr></thead>
      <tbody>${r.rows.map((x) => html`<tr><td class="mono"><a href="${frameRoute(x.frame)}">${x.frame.idHex}</a></td><td>${x.frame.name}</td><td class="num">${x.frame.length}</td><td>${periodText(x.frame)}</td>
        <td class="num">${x.bits}</td><td class="num">${fmtNum(x.perSec, 2)}</td><td class="num">${fmtNum(x.bps, 0)}</td><td class="num">${fmtNum(x.share * 100, 1)} %</td></tr>`)}</tbody>
    </table></div>
    ${r.ignored.length ? html`<details><summary class="small">${r.ignored.length} frame(s) not counted (event / request only)</summary><p class="small">${r.ignored.map((f, i) => html`${i ? ', ' : ''}<a href="${frameRoute(f)}" class="mono">${f.idHex}</a> ${f.name}`)}</p></details>` : ''}`;
}

function busloadControls() {
  const buses = busesOf(BL.archvar);
  return html`<div class="card"><div class="row">
      <label class="small">Architecture <select id="bl-arch">${variantOptions(BL.archvar)}</select></label>
      <label class="small">Bus <select id="bl-bus">${buses.map((b) => html`<option value="${b}" ${b === BL.bus ? 'selected' : ''}>${busLabel(BL.archvar, b)}</option>`)}</select></label>
      <label class="small">Bitrate (kbit/s) <input id="bl-rate" type="number" min="1" step="any" style="width:100px" value="${blBitrate()}"></label>
      <label class="small">Assumed rate of event-only frames (frames/s) <input id="bl-ev" type="number" min="0" step="any" style="width:80px" value="${BL.eventRate}"></label>
    </div>
    <p class="small muted">Estimate from the documented periods and lengths only. CAN: worst case bit stuffing, 3 bit interframe space. VAN: E-Manchester time slots (4 bits → 5 TS), approximation. LIN: nominal frame time × 1.4. ISO-TP payloads count as their segmented frames. Measure the real bus with the log decoder.</p></div>`;
}

function renderBusload() {
  blDefaults();
  return html`<div id="bl-ctl">${busloadControls()}</div><div id="bl-out">${busloadOutput()}</div>`;
}

function bindBusload(root) {
  const offs = [];
  const out = () => setHtml($('#bl-out', root), busloadOutput());
  offs.push(on(root, 'change', '#bl-arch', (ev, el) => { BL.archvar = el.value; BL.bus = ''; blDefaults(); setHtml($('#bl-ctl', root), busloadControls()); out(); }));
  offs.push(on(root, 'change', '#bl-bus', (ev, el) => {
    BL.bus = el.value; BL.bitrate = null;
    const r = $('#bl-rate', root);
    if (r) r.value = String(blBitrate());
    out();
  }));
  offs.push(on(root, 'input', '#bl-rate', (ev, el) => { const n = Number(el.value); BL.bitrate = n > 0 ? n : null; out(); }));
  offs.push(on(root, 'input', '#bl-ev', (ev, el) => { const n = Number(el.value); BL.eventRate = n >= 0 ? n : 0; out(); }));
  return offs;
}

// ===========================================================================
// Data issues
// ===========================================================================

const ISS = { level: '', source: '', q: '', limit: 500 };
let issueFrameMap = null;
let issueFrameDb = null;

function frameForIssue(it) {
  if (issueFrameDb !== app.db) {
    issueFrameDb = app.db;
    issueFrameMap = new Map();
    for (const f of app.db.frames) issueFrameMap.set(`${f.source}|${f.path}`, f);
  }
  return issueFrameMap.get(`${it.source}|${it.path}`) || null;
}

function filteredIssues() {
  const q = ISS.q.trim().toLowerCase();
  return app.db.issues.filter((i) => {
    if (ISS.level && i.level !== ISS.level) return false;
    if (ISS.source && i.source !== ISS.source) return false;
    if (q && !`${i.path} ${i.where} ${i.msg}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function issuesOutput() {
  const list = filteredIssues();
  const multi = app.db.sources.length > 1;
  const files = new Set(list.map((i) => `${i.source}|${i.path}`));
  const shown = list.slice(0, ISS.limit);
  return html`<p class="small muted">${list.length} issue(s) in ${files.size} file(s).</p>
    ${list.length ? html`<div class="tablewrap"><table class="tbl compact">
      <thead><tr><th>Level</th>${multi ? html`<th>Source</th>` : ''}<th>File</th><th>Where</th><th>Message</th></tr></thead>
      <tbody>${shown.map((i) => {
        const f = frameForIssue(i);
        return html`<tr class="lvl-${i.level}"><td><b>${i.level}</b></td>${multi ? html`<td>${i.source ? sourceBadge(i.source, { always: true }) : ''}</td>` : ''}
          <td class="mono small">${f ? html`<a href="${frameRoute(f)}">${i.path}</a>` : i.path}</td><td class="mono small">${i.where}</td><td>${i.msg}</td></tr>`;
      })}</tbody></table></div>` : emptyState('No issue', 'Nothing matches these filters.')}
    ${list.length > shown.length ? html`<p><button class="btn" data-act="iss-more">Show ${Math.min(500, list.length - shown.length)} more (${list.length - shown.length} hidden)</button></p>` : ''}`;
}

function renderIssues() {
  const db = app.db;
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of db.issues) counts[i.level] = (counts[i.level] || 0) + 1;
  return html`<div class="card">
      <p class="small muted">Lightweight checks done in your browser while loading: YAML syntax, encoding, legacy / unknown fields, bits outside of the frame, overlapping signals, unknown nodes, file naming. The reference validator is <code>python3 tools/validate.py</code> in the data repository.</p>
      <div class="filterbar">
        <span class="badge badge-danger">${counts.error || 0} errors</span><span class="badge badge-warn">${counts.warning || 0} warnings</span><span class="badge">${counts.info || 0} notes</span>
        <select id="iss-level"><option value="">all levels</option>${['error', 'warning', 'info'].map((l) => html`<option value="${l}" ${ISS.level === l ? 'selected' : ''}>${l}</option>`)}</select>
        ${db.sources.length > 1 ? html`<select id="iss-src"><option value="">all sources</option>${db.sources.map((s) => html`<option value="${s.id}" ${ISS.source === s.id ? 'selected' : ''}>${s.label}</option>`)}</select>` : ''}
        <input id="iss-q" type="search" placeholder="filter (file, message…)" value="${ISS.q}">
      </div>
    </div>
    <div id="iss-out">${issuesOutput()}</div>`;
}

function bindIssues(root) {
  const offs = [];
  const out = () => setHtml($('#iss-out', root), issuesOutput());
  offs.push(on(root, 'change', '#iss-level', (ev, el) => { ISS.level = el.value; ISS.limit = 500; out(); }));
  offs.push(on(root, 'change', '#iss-src', (ev, el) => { ISS.source = el.value; ISS.limit = 500; out(); }));
  const q = debounce(() => out(), 150);
  offs.push(on(root, 'input', '#iss-q', (ev, el) => { ISS.q = el.value; ISS.limit = 500; q(); }));
  offs.push(on(root, 'click', '[data-act=iss-more]', () => { ISS.limit += 500; out(); }));
  return offs;
}

// ===========================================================================
// Entry
// ===========================================================================

export function renderTools(root, route) {
  if (root._toolsUnbind) { root._toolsUnbind(); root._toolsUnbind = null; }
  if (!app.db) { setHtml(root, html`<div class="page">${emptyState('No data loaded')}</div>`); return; }
  const sub = SUBS.some((s) => s.id === route.parts[1]) ? route.parts[1] : 'log';
  let body;
  let bind;
  try {
    if (sub === 'bits') { body = renderBits(); bind = bindBits; }
    else if (sub === 'export') { body = renderExport(route); bind = bindExport; }
    else if (sub === 'busload') { body = renderBusload(); bind = bindBusload; }
    else if (sub === 'issues') { body = renderIssues(); bind = bindIssues; }
    else { body = renderLog(root); bind = bindLog; }
  } catch (e) {
    body = html`<div class="notice danger">This tool failed: ${String(e && e.message || e)}</div>`;
    bind = null;
  }
  const items = SUBS.map((s) => ({ ...s, count: s.id === 'issues' ? app.db.issues.filter((i) => i.level !== 'info').length : undefined }));
  setHtml(root, html`<div class="page wide tools-page">
      <h2>Tools</h2>
      ${tabs(items, sub, (id) => `#/tools/${id}`)}
      <div class="tools-body">${body}</div>
    </div>`);
  const offs = bind ? bind(root) : [];
  root._toolsUnbind = () => offs.forEach((o) => o());
}

/** Internal hooks for node smoke tests (no DOM needed). */
export const _internals = { LOG, runDecode, logOutput, BITS, bitsOutput, EXP, exportOutput };
