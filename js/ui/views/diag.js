// Diagnostics view: protocol reference, ECU addressing, DIDs/LIDs with decoder,
// DTC lookup, ISO-TP request builder, PSA seed/key calculator.

import { html, $, $$, on, setHtml } from '../dom.js';
import { app, lang } from '../state.js';
import { t, tabs, codeBlock, kv, emptyState, sourceBadge, nodeLink, valuesList } from '../widgets.js';
import { hex, bytesToHex, parseHexBytes, fmtNum, naturalCompare } from '../../core/util.js';
import { decodeFrame, FLAG_TEXT } from '../../core/codec.js';
import { renderGrid, renderLegend, hueMap } from '../bitgrid.js';
import { UDS_SERVICES, KWP_SERVICES, OBD_SERVICES, NRC, UDS_SESSIONS, COMMON_DIDS, describeMessage } from '../../core/diagref.js';
import { segment, flowControl, describeStMin } from '../../core/isotp.js';
import { computeKey, ALGORITHM_DESCRIPTION } from '../../core/seedkey.js';
import { dtcToRaw, rawToDtc, frameRoute, diagEcuKey, diagEcusOfNode } from '../../core/repo.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const bound = new WeakSet();
let cur = { route: null, root: null };

const arr = (v) => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function hx(v, w = 2) { return isNum(v) ? hex(v, w) : ''; }
function canIdHex(id) { return isNum(id) ? (id > 0x7FF ? hex(id, 8) : hex(id, 3)) : ''; }
/** CAN ID cell, linked to the frame documented with that ID in the variant (same bus first). */
function idCell(v, archvar, bus) {
  if (!isNum(v)) return html`<span class="muted">—</span>`;
  const frames = archvar && app.db ? (app.db.variantFrames.get(archvar) || []).filter((f) => f.id === v && (f.type === 'can' || f.type === 'can-tp')) : [];
  frames.sort((a, b) => (bus && (a.netbus === bus || a.bus === bus) ? 0 : 1) - (bus && (b.netbus === bus || b.bus === bus) ? 0 : 1));
  if (!frames.length) return html`<code>0x${canIdHex(v)}</code>`;
  const f = frames[0];
  return html`<a href="${frameRoute(f)}" title="${f.name} · ${f.netbus}${frames.length > 1 ? ` (+${frames.length - 1} other frame${frames.length > 2 ? 's' : ''} with this ID)` : ''}"><code>0x${canIdHex(v)}</code></a>`;
}
function parseCanId(s) {
  const m = /^\s*(?:0x)?([0-9a-f]{1,8})\s*$/i.exec(String(s ?? ''));
  return m ? parseInt(m[1], 16) : null;
}
function parseHexInt(s) {
  const m = /^\s*(?:0x)?([0-9a-f]{1,8})\s*$/i.exec(String(s ?? ''));
  return m ? parseInt(m[1], 16) : null;
}
function diagOf(db) { return (db && db.diag) || { protocols: new Map(), ecus: new Map(), dtcIndex: [] }; }
function replaceHash(h) { try { history.replaceState(null, '', h); if (app.route) app.route.hash = h; } catch (e) { /* ignore */ } }

const LETTERS = { P: 'Powertrain (engine, gearbox)', C: 'Chassis (brakes, steering, suspension)', B: 'Body (comfort, lighting, airbags)', U: 'Network / communication' };
const FIRST_DIGIT = { 0: 'generic (SAE/ISO defined)', 1: 'manufacturer specific', 2: 'generic (SAE/ISO defined)', 3: 'manufacturer specific / reserved' };

/** Service table for a protocol name (built-in) */
function builtinTable(protocol) {
  if (protocol === 'KWP2000' || protocol === 'KWP-PSA2000') return KWP_SERVICES;
  if (protocol === 'EOBD') return OBD_SERVICES;
  return UDS_SERVICES;
}

function repoProtocolFor(db, protocols) {
  const ps = diagOf(db).protocols;
  for (const p of arr(protocols)) {
    for (const rp of ps.values()) if (rp.protocol === p || rp.name === p) return rp;
  }
  return null;
}

function serviceName(db, sid, protocols) {
  const rp = repoProtocolFor(db, protocols);
  if (rp) { const s = (rp.services || []).find((x) => x.sid === sid); if (s) return s.name; }
  for (const p of arr(protocols).concat(['UDS'])) { const tb = builtinTable(p); if (tb[sid]) return tb[sid][0]; }
  return '';
}

/** All addressing rows (nodes' diag blocks + diag/<arch>/<node>/ecu.yml files) */
function addressingRows(db) {
  const rows = [];
  const seen = new Set();
  const dg = diagOf(db);
  for (const e of dg.ecus.values()) {
    if (!e || !e.ecu) continue;
    for (const a of arr(e.ecu.addressing)) {
      if (!a) continue;
      const k = `${e.archvar}|${e.node}|${e.model || ''}|${a.request_id}|${a.response_id}|${a.kline_address}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({
        archvar: e.archvar, node: e.node, model: e.model || null, protocols: a.protocol ? [a.protocol] : arr(e.ecu.protocols), bus: a.bus || '',
        transport: a.transport || 'can-tp', req: a.request_id, res: a.response_id, func: a.functional_id, kline: a.kline_address,
        source: e.source, from: 'diag',
      });
    }
  }
  for (const [key, m] of (db && db.variantNodes) || new Map()) {
    for (const nd of m.values()) {
      if (!nd || nd.phantom || !nd.diag) continue;
      if (nd.archvar && nd.archvar !== key) continue; // inherited from a parent variant
      const d = nd.diag;
      const k = `${key}|${nd.name}|${d.request_id}|${d.response_id}|${d.kline_address}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({
        archvar: key, node: nd.name, protocols: arr(d.protocols), bus: d.bus || '',
        transport: isNum(d.request_id) ? 'can-tp' : isNum(d.kline_address) ? 'k-line' : '', req: d.request_id, res: d.response_id,
        func: null, kline: d.kline_address, obdReq: d.obd_request_id, obdRes: d.obd_response_id, source: nd.source, from: 'nodes',
      });
    }
  }
  rows.sort((a, b) => naturalCompare(a.archvar, b.archvar) || naturalCompare(a.node, b.node));
  return rows;
}

/** node can be 'NODE' or 'NODE/MODEL' */
function ecuDiagHref(archvar, node) { return `#/diag/ecu/${archvar}/${String(node).split('/').map(encodeURIComponent).join('/')}`; }
const ecuRef = (e) => (e.model ? `${e.node}/${e.model}` : e.node);

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export function renderDiag(root, route) {
  cur = { route, root };
  const db = app.db;
  const dg = diagOf(db);
  const sub = route.parts[1] || 'overview';
  const activeTab = sub === 'ecu' ? 'addressing' : sub === 'protocol' ? 'protocols' : sub;
  const nav = tabs([
    { id: 'overview', label: 'Overview' },
    { id: 'protocols', label: 'Protocols', count: dg.protocols.size || undefined },
    { id: 'addressing', label: 'ECU addressing' },
    { id: 'dtc', label: 'DTC lookup', count: dg.dtcIndex.length || undefined },
    { id: 'request', label: 'Request builder (ISO-TP)' },
    { id: 'seedkey', label: 'Seed / key' },
  ], activeTab, (id) => (id === 'overview' ? '#/diag' : `#/diag/${id}`));
  let body;
  switch (sub) {
    case 'protocols': body = renderProtocols(db); break;
    case 'protocol': body = renderProtocol(db, route.parts[2]); break;
    case 'addressing': body = renderAddressing(db, route); break;
    case 'ecu': body = renderEcu(db, route.parts[2], route.parts[3], route, route.parts[4] || null); break;
    case 'dtc': body = renderDtcPage(db, route); break;
    case 'request': body = renderRequestPage(db, route); break;
    case 'seedkey': body = renderSeedKeyPage(db, route); break;
    default: body = renderOverview(db);
  }
  setHtml(root, html`<div class="page diag${sub === 'ecu' ? ' wide' : ''}"><h2>Diagnostics</h2>${nav}${body}</div>`);
  bind(root);
  if (sub === 'ecu') {
    const selRow = root.querySelector('#ecu-items .drow.selected');
    if (selRow) selRow.scrollIntoView({ block: 'nearest' });
    const det = root.querySelector('#ecu-detail');
    if (det) det.scrollTop = 0;
  }
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

function noDiagBanner(db) {
  const dg = diagOf(db);
  if (dg.ecus.size || dg.protocols.size) return '';
  return html`<div class="notice warn"><b>No diag/ data yet.</b> The loaded repositories have no <code>diag/</code> directory (protocol definitions, DIDs, DTCs...).
    The built-in references, the ISO-TP request builder, the DTC converter and the seed/key calculator still work, and the addressing table uses the <code>diag</code> blocks of <code>nodes/*.yml</code> when present.</div>`;
}

function renderOverview(db) {
  const dg = diagOf(db);
  let dids = 0; let lids = 0; let routines = 0; let ioctls = 0;
  for (const e of dg.ecus.values()) { dids += arr(e.dids).length; lids += arr(e.lids).length; routines += arr(e.routines).length; ioctls += arr(e.ioctls).length; }
  const rows = addressingRows(db);
  const ecus = [...dg.ecus.values()].sort((a, b) => naturalCompare(a.archvar, b.archvar) || naturalCompare(a.node, b.node) || naturalCompare(a.model || '', b.model || ''));
  return html`${noDiagBanner(db)}
    <div class="cards">
      <div class="card"><h3><a href="#/diag/protocols">Protocols</a></h3><p>${dg.protocols.size ? `${dg.protocols.size} protocol definition(s): ${[...dg.protocols.keys()].join(', ')}` : 'Built-in UDS / KWP2000 / OBD reference (services, NRCs).'}</p></div>
      <div class="card"><h3><a href="#/diag/addressing">ECU addressing</a></h3><p>${rows.length} addressing entr${rows.length === 1 ? 'y' : 'ies'} (request / response CAN IDs, K-line addresses).</p></div>
      <div class="card"><h3>ECU data</h3><p>${dg.ecus.size} ECU(s) with diag data · ${dids} DIDs · ${lids} LIDs · ${routines} routines · ${ioctls} I/O controls</p></div>
      <div class="card"><h3><a href="#/diag/dtc">DTC lookup</a></h3><p>${dg.dtcIndex.length} documented DTC(s). Converts codes like <code>B1003</code> ⇄ <code>0x9003</code>.</p></div>
      <div class="card"><h3><a href="#/diag/request">Request builder</a></h3><p>Turns a request like <code>22 F1 90</code> into the ISO-TP CAN frames (single / multi frame, flow control).</p></div>
      <div class="card"><h3><a href="#/diag/seedkey">Seed / key</a></h3><p>PSA SecurityAccess key computation from a 4-byte seed and a 2-byte application key.</p></div>
    </div>
    ${ecus.length ? html`<h3>ECUs with diagnostic data</h3>
      <div class="tablewrap"><table class="tbl"><thead><tr><th>Architecture</th><th>ECU</th><th>Model</th><th>Protocols</th><th>DIDs</th><th>LIDs</th><th>DTCs</th><th>Routines</th><th>I/O</th><th>Source</th></tr></thead><tbody>
      ${ecus.map((e) => html`<tr><td>${e.archvar}</td><td><a href="${ecuDiagHref(e.archvar, ecuRef(e))}"><b class="mono">${e.node}</b></a></td><td>${e.model ? html`<a class="mono" href="${ecuDiagHref(e.archvar, ecuRef(e))}">${e.model}</a>` : ''}</td><td>${arr(e.ecu && e.ecu.protocols).join(', ')}</td>
        <td class="num">${arr(e.dids).length}</td><td class="num">${arr(e.lids).length}</td><td class="num">${arr(e.dtcs).length}</td><td class="num">${arr(e.routines).length}</td><td class="num">${arr(e.ioctls).length}</td><td>${sourceBadge(e.source)}</td></tr>`)}
      </tbody></table></div>` : ''}
    <p class="muted small">Diagnostic access can change ECU configuration and, on the IS (high speed) bus, safety-relevant behavior. Use at your own risk.</p>`;
}

// ---------------------------------------------------------------------------
// protocols
// ---------------------------------------------------------------------------

function builtinReference(open = true) {
  const svcTable = (title, tb) => html`<h4>${title}</h4><div class="tablewrap"><table class="tbl compact"><thead><tr><th>SID</th><th>Service</th><th>Request layout</th><th>Positive response</th></tr></thead><tbody>
    ${Object.entries(tb).map(([k, v]) => html`<tr><td class="mono">0x${hex(+k, 2)}</td><td>${v[0]}</td><td class="mono small">${v[1]}</td><td class="mono small">0x${hex((+k + 0x40) & 0xFF, 2)}</td></tr>`)}</tbody></table></div>`;
  return html`<details class="card" ${open ? 'open' : ''}><summary><b>Built-in reference (ISO 14229 / ISO 14230 / SAE J1979)</b></summary>
    <div class="two-col">
      <div>${svcTable('UDS services (ISO 14229)', UDS_SERVICES)}</div>
      <div>${svcTable('KWP2000 services (ISO 14230)', KWP_SERVICES)}${svcTable('OBD / EOBD services (SAE J1979)', OBD_SERVICES)}</div>
    </div>
    <div class="two-col">
      <div><h4>Negative response codes (7F SID NRC)</h4><div class="tablewrap"><table class="tbl compact"><thead><tr><th>NRC</th><th>Meaning</th></tr></thead><tbody>
        ${Object.entries(NRC).map(([k, v]) => html`<tr><td class="mono">0x${hex(+k, 2)}</td><td>${v}</td></tr>`)}</tbody></table></div></div>
      <div><h4>UDS sessions (10 xx)</h4><div class="tablewrap"><table class="tbl compact"><tbody>${Object.entries(UDS_SESSIONS).map(([k, v]) => html`<tr><td class="mono">0x${hex(+k, 2)}</td><td>${v}</td></tr>`)}</tbody></table></div>
        <h4>Common DIDs (22 xx xx)</h4><div class="tablewrap"><table class="tbl compact"><tbody>${Object.entries(COMMON_DIDS).map(([k, v]) => html`<tr><td class="mono">0x${hex(+k, 4)}</td><td>${v}</td></tr>`)}</tbody></table></div></div>
    </div></details>`;
}

function renderProtocols(db) {
  const ps = [...diagOf(db).protocols.values()];
  return html`${noDiagBanner(db)}
    ${ps.length ? html`<div class="cards">${ps.map((p) => html`<div class="card"><h3><a href="#/diag/protocol/${encodeURIComponent(p.name)}">${p.name}</a> ${sourceBadge(p.source)}</h3>
      <p>${p.standard ? html`<b>${p.standard}</b> · ` : ''}${arr(p.services).length} services · ${arr(p.nrcs).length} NRCs${arr(p.algorithms).length ? ` · ${arr(p.algorithms).length} algorithm(s)` : ''}</p>${p.comment ? html`<p class="muted">${t(p.comment)}</p>` : ''}</div>`)}</div>` : ''}
    ${builtinReference(!ps.length)}`;
}

function renderProtocol(db, name) {
  const p = diagOf(db).protocols.get(name);
  if (!p) return html`${emptyState('Protocol not found', `No diag/protocols/${name || '?'}.yml in the loaded sources.`)}${builtinReference(true)}`;
  return html`<h3>${p.name} ${sourceBadge(p.source)}</h3>
    ${kv([['Protocol', p.protocol], ['Standard', p.standard], ['Transport', arr(p.transport).join(', ')], ['Comment', t(p.comment)]])}
    <h4>Services</h4>
    <div class="tablewrap"><table class="tbl"><thead><tr><th>SID</th><th>Name</th><th>Request</th><th>Response</th><th>Sub-functions</th><th>Comment</th></tr></thead><tbody>
      ${arr(p.services).map((s) => html`<tr><td class="mono">0x${hx(s.sid, 2)}</td><td><b class="mono">${s.name}</b>${s.displayName ? html`<div class="small muted">${t(s.displayName)}</div>` : ''}</td>
        <td class="mono small">${s.request}</td><td class="mono small">${s.response}</td>
        <td class="small">${arr(s.subfunctions).map((v) => html`<div><code>0x${hx(v.raw, 2)}</code> ${t(v.text)}${v.unused ? html` <i class="muted">unused</i>` : ''}</div>`)}</td>
        <td class="small">${t(s.comment)}</td></tr>`)}
    </tbody></table></div>
    ${arr(p.nrcs).length ? html`<h4>Negative response codes</h4><div class="tablewrap"><table class="tbl compact"><thead><tr><th>NRC</th><th>Meaning</th></tr></thead><tbody>
      ${arr(p.nrcs).map((v) => html`<tr><td class="mono">0x${hx(v.raw, 2)}</td><td>${t(v.text)}</td></tr>`)}</tbody></table></div>` : ''}
    ${arr(p.algorithms).length ? html`<h4>Algorithms</h4>${arr(p.algorithms).map((a) => html`<div class="card"><h4 class="mono">${a.name}</h4>${a.comment ? html`<p>${t(a.comment)}</p>` : ''}${a.pseudocode ? codeBlock(a.pseudocode, { title: 'pseudocode' }) : ''}
      ${/seed|key|auth|security/i.test(a.name + ' ' + t(a.comment)) ? html`<p><a href="#/diag/seedkey">Open the seed/key calculator</a></p>` : ''}</div>`)}` : ''}
    ${builtinReference(false)}`;
}

// ---------------------------------------------------------------------------
// addressing
// ---------------------------------------------------------------------------

function addressingTable(db, q, archvar) {
  const dg = diagOf(db);
  const qq = String(q || '').trim().toLowerCase();
  const rows = addressingRows(db).filter((r) => {
    if (archvar && r.archvar !== archvar) return false;
    if (!qq) return true;
    return `${r.node} ${r.archvar} ${r.bus} ${r.protocols.join(' ')} ${canIdHex(r.req)} ${canIdHex(r.res)} ${hx(r.kline)}`.toLowerCase().includes(qq);
  });
  if (!rows.length) return emptyState('No addressing information', 'No node has a diag block (nodes/*.yml) and no diag/*/*/ecu.yml defines addressing for this selection.');
  return html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Architecture</th><th>ECU</th><th>Request ID</th><th>Response ID</th><th>Functional</th><th>Protocols</th><th>Transport</th><th>Bus</th><th>K-line addr.</th><th>OBD req/resp</th><th>From</th><th></th></tr></thead><tbody>
    ${rows.map((r) => html`<tr>
      <td>${r.archvar}</td>
      <td>${nodeLink(r.archvar, r.node)}${r.model ? html` <span class="mono small">${r.model}</span>` : ''}${dg.ecus.has(diagEcuKey(r.archvar, r.node, r.model)) ? html` <a class="badge" href="${ecuDiagHref(r.archvar, r.model ? `${r.node}/${r.model}` : r.node)}">diag data</a>` : ''}</td>
      <td>${idCell(r.req, r.archvar, r.bus)}</td><td>${idCell(r.res, r.archvar, r.bus)}</td><td>${idCell(r.func, r.archvar, r.bus)}</td>
      <td>${r.protocols.join(', ')}</td><td>${r.transport}</td><td class="mono">${r.bus}</td>
      <td>${isNum(r.kline) ? html`<code>0x${hx(r.kline, 2)}</code>` : ''}</td>
      <td class="small">${isNum(r.obdReq) || isNum(r.obdRes) ? html`<code>${canIdHex(r.obdReq)}</code> / <code>${canIdHex(r.obdRes)}</code>` : ''}</td>
      <td class="small">${r.from === 'diag' ? 'diag/ecu.yml' : 'nodes/'} ${sourceBadge(r.source)}</td>
      <td>${isNum(r.req) ? html`<a class="btn btn-sm" href="#/diag/request?req=${canIdHex(r.req)}&res=${canIdHex(r.res)}&proto=${encodeURIComponent(r.protocols[0] || 'UDS')}">build a request</a>` : ''}</td>
    </tr>`)}
  </tbody></table></div>`;
}

function renderAddressing(db, route) {
  const q = route.query.q || '';
  const archvar = route.query.arch || '';
  const archs = [...new Set(addressingRows(db).map((r) => r.archvar))].sort(naturalCompare);
  return html`${noDiagBanner(db)}
    <div class="filterbar"><input type="search" data-live="addr" id="addr-q" placeholder="Filter: ECU, ID, bus…" value="${q}">
      <select data-live="addr" id="addr-arch"><option value="">all architectures</option>${archs.map((a) => html`<option value="${a}" ${a === archvar ? 'selected' : ''}>${a}</option>`)}</select></div>
    <div id="addr-out">${addressingTable(db, q, archvar)}</div>
    <p class="muted small">CAN diagnostic requests are sent by the tester on the request ID and answered on the response ID with ISO 15765-2 (ISO-TP) transport.</p>`;
}

// ---------------------------------------------------------------------------
// ECU diag page
// ---------------------------------------------------------------------------

const KIND_LABEL = { did: 'DID', lid: 'LID', routine: 'Routine', ioctl: 'I/O control' };
const KIND_WIDTH = { did: 4, lid: 2, routine: 4, ioctl: 4 };

function itemHref(archvar, node, it) { return `${ecuDiagHref(archvar, node)}?${it.kind}=${hex(it.ident, KIND_WIDTH[it.kind] || 4)}${it.fileBase ? `&f=${encodeURIComponent(it.fileBase)}` : ''}`; }

function sigsLength(sigs, declared) {
  if (isNum(declared) && declared > 0) return declared;
  let maxEnd = -1;
  for (const s of arr(sigs)) {
    if (!s || !s.pos) continue;
    maxEnd = Math.max(maxEnd, s.pos.toEnd ? s.pos.start + 7 : s.pos.end);
  }
  return maxEnd >= 0 ? Math.floor(maxEnd / 8) + 1 : 8;
}

function pseudoFrame(item, which, archvar) {
  const sigs = which === 'results' ? arr(item.results) : arr(item.params);
  return {
    id: isNum(item.ident) ? item.ident : 0, idHex: hex(isNum(item.ident) ? item.ident : 0, KIND_WIDTH[item.kind] || 4), name: item.name || '',
    type: 'can-tp', length: sigsLength(sigs, which === 'results' ? null : item.length), lengthMin: null,
    variable: which === 'results' || !isNum(item.length), archvar, netbus: 'DIAG', signals: sigs, alternatives: [], issues: [],
  };
}

/** Strip a positive response header (SID [+ identifier]) when present */
function stripResponse(item, bytes) {
  if (!bytes || !item) return { data: bytes, stripped: '' };
  const id = item.ident;
  const b = Array.from(bytes);
  if (item.kind === 'did' && b.length >= 3 && b[0] === 0x62 && ((b[1] << 8) | b[2]) === id) return { data: bytes.slice(3), stripped: '62 + DID' };
  if (item.kind === 'lid' && b.length >= 2 && b[0] === 0x61 && b[1] === id) return { data: bytes.slice(2), stripped: '61 + LID' };
  if (item.kind === 'routine' && b.length >= 4 && b[0] === 0x71 && ((b[2] << 8) | b[3]) === id) return { data: bytes.slice(4), stripped: '71 + sub-function + RID' };
  if (item.kind === 'routine' && b.length >= 2 && b[0] === 0x71 && b[1] === (id & 0xFF)) return { data: bytes.slice(2), stripped: '71 + RLID' };
  if (item.kind === 'ioctl' && b.length >= 4 && b[0] === 0x6F && ((b[1] << 8) | b[2]) === id) return { data: bytes.slice(4), stripped: '6F + DID + control' };
  if (item.kind === 'ioctl' && b.length >= 3 && b[0] === 0x70 && b[1] === (id & 0xFF)) return { data: bytes.slice(3), stripped: '70 + LID + control' };
  return { data: bytes, stripped: '' };
}

function sampleRequest(item) {
  const id = isNum(item.ident) ? item.ident : 0;
  if (item.kind === 'did') return `22 ${hex(id >> 8, 2)} ${hex(id & 0xFF, 2)}`;
  if (item.kind === 'lid') return `21 ${hex(id, 2)}`;
  if (item.kind === 'routine') return id > 0xFF ? `31 01 ${hex(id >> 8, 2)} ${hex(id & 0xFF, 2)}` : `31 ${hex(id, 2)}`;
  if (item.kind === 'ioctl') return id > 0xFF ? `2F ${hex(id >> 8, 2)} ${hex(id & 0xFF, 2)} 03` : `30 ${hex(id, 2)} 07`;
  return '';
}

function decodeTable(item, archvar, which, text) {
  const pf = pseudoFrame(item, which, archvar);
  const sigs = pf.signals;
  const s = String(text || '').trim();
  if (!sigs.length) return html`<p class="muted">No parameter documented.</p>`;
  if (!s) return html`<p class="muted">Paste the data bytes, or a full positive response (eg. <code>${item.kind === 'did' ? `62 ${hex(item.ident >> 8, 2)} ${hex(item.ident & 0xFF, 2)} …` : item.kind === 'lid' ? `61 ${hex(item.ident, 2)} …` : '…'}</code>).</p>`;
  const raw = parseHexBytes(s);
  if (!raw) return html`<div class="notice warn">Could not parse the payload: use hex bytes like <code>0E 00 A0</code>.</div>`;
  const { data, stripped } = stripResponse(item, raw);
  let dec;
  try { dec = decodeFrame(pf, data, lang(), sigs); } catch (e) { return html`<div class="notice danger">Decoding failed: ${String(e.message || e)}</div>`; }
  const hues = hueMap(sigs);
  const flags = {};
  for (const d of dec.signals) flags[d.name] = d.flags;
  return html`${stripped ? html`<p class="small muted">Response header stripped (${stripped}), ${data.length} data byte(s).</p>` : ''}
    ${dec.flags.length ? html`<div class="notice warn">${data.length} data bytes, ${isNum(item.length) ? `documented length ${item.length}` : 'variable length'}.</div>` : ''}
    <div class="diaggrid">${renderGrid(pf, sigs, { bytes: data, hues, flags, muxState: dec.muxState })}</div>
    <div class="tablewrap"><table class="tbl"><thead><tr><th>Parameter</th><th>Bits</th><th>Raw</th><th>Physical</th><th>Meaning</th><th>Flags</th></tr></thead><tbody>
      ${dec.signals.filter((d) => !d.sig.unused).map((d) => html`<tr class="${d.flags.some((f) => f !== 'default') ? 'flagged' : ''}${d.active === false ? ' inactive' : ''}" data-sig="${d.name}">
        <td><span class="swatch" style="--h:${hues.get(d.name) ?? 200}"></span><b class="mono">${d.name}</b></td><td class="mono">${d.sig.bits}</td>
        <td class="mono">${d.present ? d.rawHex : '—'}</td><td class="num"><b>${d.present ? d.text : ''}</b></td><td>${d.label || ''}</td>
        <td>${d.flags.map((f) => html`<span class="flag flag-${f}" title="${FLAG_TEXT[f] || f}">${f}</span>`)}</td></tr>`)}
    </tbody></table></div>`;
}

function sigTable(sigs) {
  if (!arr(sigs).length) return html`<p class="muted">None documented.</p>`;
  return html`<div class="tablewrap"><table class="tbl compact"><thead><tr><th>Name</th><th>Bits</th><th>Type</th><th>Scaling</th><th>Units</th><th>Range</th><th>Values</th><th>Comment</th></tr></thead><tbody>
    ${arr(sigs).map((s) => html`<tr class="${s.unused ? 'muted' : ''}" data-sig="${s.name}"><td class="mono"><b>${s.name}</b></td><td class="mono">${s.bits}</td><td>${s.type}${s.littleEndian ? ' (LE)' : ''}</td>
      <td class="small">${s.hasFactor || s.offset ? `×${fmtNum(s.factor, 8)}${s.offset ? ` + ${fmtNum(s.offset, 8)}` : ''}` : ''}</td><td>${s.units || ''}</td>
      <td class="small">${s.min !== null || s.max !== null ? `${s.min ?? '…'} – ${s.max ?? '…'}` : ''}</td><td>${valuesList(s, 8)}</td><td class="small">${t(s.comment)}</td></tr>`)}
  </tbody></table></div>`;
}

function itemDetail(item, archvar, node, route) {
  const which = item.kind === 'routine' ? (route.query.part === 'params' ? 'params' : (arr(item.results).length ? 'results' : 'params')) : 'params';
  const pf = pseudoFrame(item, which, archvar);
  const sigs = pf.signals;
  const hues = hueMap(sigs);
  const req = sampleRequest(item);
  return html`<div class="card" id="diag-item">
    <h3><span class="mono">${KIND_LABEL[item.kind] || item.kind} 0x${hex(item.ident, KIND_WIDTH[item.kind] || 4)}</span> ${item.name} ${sourceBadge(item.source)}</h3>
    ${item.displayName ? html`<p><b>${t(item.displayName)}</b></p>` : ''}${item.comment ? html`<p>${t(item.comment)}</p>` : ''}
    ${kv([['Kind', item.dataKind], ['Access', item.access], ['Session', isNum(item.session) ? `0x${hx(item.session, 2)}${UDS_SESSIONS[item.session] ? ` (${UDS_SESSIONS[item.session]})` : ''}` : null],
      ['Security level', isNum(item.securityLevel) ? `0x${hx(item.securityLevel, 2)}` : null], ['Length', isNum(item.length) ? `${item.length} byte(s)` : (item.kind === 'did' || item.kind === 'lid' ? 'variable' : null)],
      ['Variants', arr(item.variants).join(', ')], ['Control', arr(item.control).join(', ')], ['File', item.path]])}
    ${req ? html`<p>Request: <code>${req}</code> <a class="btn btn-sm" href="#/diag/request?data=${encodeURIComponent(req)}&arch=${encodeURIComponent(archvar)}&ecu=${encodeURIComponent(node)}">build the CAN frames</a></p>` : ''}
    ${arr(item.issues).length ? html`<details class="issues"><summary><span class="badge badge-warn">⚠ ${arr(item.issues).length}</span> data warnings</summary><ul>${arr(item.issues).map((i) => html`<li>${i.where ? html`<code>${i.where}</code> ` : ''}${i.msg}</li>`)}</ul></details>` : ''}
    ${item.kind === 'routine' ? html`<nav class="pills"><a href="${itemHref(archvar, node, item)}&part=params" class="${which === 'params' ? 'active' : ''}">Parameters (request)</a><a href="${itemHref(archvar, node, item)}&part=results" class="${which === 'results' ? 'active' : ''}">Results (response)</a></nav>` : ''}
    ${sigs.length ? html`<div class="diaggrid">${renderGrid(pf, sigs, { hues })}</div>${renderLegend(sigs, hues)}` : ''}
    <h4>${which === 'results' ? 'Results' : 'Parameters'}</h4>${sigTable(sigs)}
    ${arr(item.controls).length ? html`<h4>Control options</h4><table class="tbl compact"><tbody>${arr(item.controls).map((v) => html`<tr><td class="mono">0x${hx(v.raw, 2)}</td><td>${t(v.text)}</td></tr>`)}</tbody></table>` : ''}
    ${arr(item.mapped).length ? html`<h4>Mapped values <span class="count">${arr(item.mapped).length}</span></h4>${item.mappedComment ? html`<p class="small muted">${t(item.mappedComment)}</p>` : ''}
      <div class="tablewrap"><table class="tbl compact"><thead><tr><th>Index</th><th>Name</th><th>Bits</th><th>Type</th><th>Values</th><th>Comment</th></tr></thead><tbody>
      ${arr(item.mapped).map((m) => html`<tr><td class="num">${isNum(m.index) ? m.index : ''}</td><td class="mono"><b>${m.name}</b></td><td class="num">${isNum(m.length) ? m.length : ''}</td><td>${m.type}</td>
        <td class="small">${arr(m.values).slice(0, 8).map((v) => html`<div><code>0x${hx(v.raw, 2)}</code> ${t(v.text)}</div>`)}</td><td class="small">${t(m.comment)}</td></tr>`)}</tbody></table></div>` : ''}
    ${arr(item.tests).length ? html`<h4>Actuator tests</h4><ul>${arr(item.tests).map((x) => html`<li>${t(x.displayName)}${isNum(x.maxMs) ? html` <span class="small muted">(max ${x.maxMs} ms)</span>` : ''}</li>`)}</ul>` : ''}
    ${arr(item.alternatives).length ? html`<h4>Alternatives <span class="count">${arr(item.alternatives).length}</span></h4>${arr(item.alternatives).map((a) => html`<details class="card"><summary>${t(a.note)}${arr(a.variants).length ? html` <span class="small muted">${arr(a.variants).join(', ')}</span>` : ''}</summary>${sigTable(a.params)}</details>`)}` : ''}
    ${item.kind === 'routine' && arr(item.returnValues).length ? html`<h4>Return values</h4><div class="tablewrap"><table class="tbl compact"><tbody>${arr(item.returnValues).map((v) => html`<tr><td class="mono">0x${hx(v.raw, 2)}</td><td>${t(v.text)}</td></tr>`)}</tbody></table></div>` : ''}
    ${sigs.length ? html`<h4>Decode a payload</h4>
      <div class="row"><input id="dd-input" class="mono grow" data-live="didDecode" data-which="${which}" spellcheck="false" autocomplete="off" placeholder="data bytes or full positive response"></div>
      <div id="dd-out">${decodeTable(item, archvar, which, '')}</div>` : ''}
  </div>`;
}


function modelPicker(archvar, node, models) {
  return html`<h3>${node} <span class="muted">${archvar}</span></h3>
    <p>This node exists as ${models.length} ECU models, each with its own diagnostic data:</p>
    <div class="tablewrap"><table class="tbl"><thead><tr><th>Model</th><th>Description</th><th>Protocols</th><th>Cars</th><th>Variants</th><th>DIDs</th><th>LIDs</th><th>DTCs</th><th>Routines</th><th>I/O</th></tr></thead><tbody>
    ${models.map((e) => html`<tr><td><a class="mono" href="${ecuDiagHref(archvar, ecuRef(e))}"><b>${e.model}</b></a></td><td>${t(e.ecu && e.ecu.displayName)}</td><td>${arr(e.ecu && e.ecu.protocols).join(', ')}</td>
      <td class="small">${arr(e.ecu && e.ecu.cars).join(', ')}</td><td class="num">${arr(e.ecu && e.ecu.variants).length}</td>
      <td class="num">${arr(e.dids).length}</td><td class="num">${arr(e.lids).length}</td><td class="num">${arr(e.dtcs).length}</td><td class="num">${arr(e.routines).length}</td><td class="num">${arr(e.ioctls).length}</td></tr>`)}
    </tbody></table></div>`;
}

function ecuOverview(db, archvar, node, model, e, nd, addr, protos, ecu, nk) {
  const dtcs = e ? arr(e.dtcs) : [];
  return html`<div class="fdetail-inner">
    <h3>${nodeLink(archvar, node)}${model ? html` <span class="mono">/ ${model}</span>` : ''} <span class="muted">${archvar}</span> ${e ? sourceBadge(e.source) : ''}</h3>
    ${ecu.displayName ? html`<p><b>${t(ecu.displayName)}</b></p>` : nd ? html`<p class="muted">${t(nd.title)}</p>` : ''}
    ${ecu.comment ? html`<p>${t(ecu.comment)}</p>` : ''}
    ${!e ? html`<div class="notice">Only the addressing summary of <code>nodes/${archvar}.yml</code> is known for this ECU (no <code>diag/${archvar}/${node}/</code> directory).</div>` : ''}
    ${kv([['Protocols', protos.join(', ')], ['Cars', arr(ecu.cars).join(', ')],
      ['Tester present', ecu.testerPresent ? html`<code>${ecu.testerPresent.request || '3E 00'}</code>${isNum(ecu.testerPresent.period) ? ` every ${ecu.testerPresent.period} ms` : ''}` : null],
      ['Part number', ecu.identification ? html`<code>${ecu.identification.request}</code> → data bits <code>${ecu.identification.partNumber}</code>${ecu.identification.comment ? html` <span class="small muted">${t(ecu.identification.comment)}</span>` : ''}` : null]])}
    <div class="two-col">
      <div>
        <h4>Addressing</h4>
        ${addr.length ? html`<table class="tbl compact"><thead><tr><th>Transport</th><th>Bus</th><th>Request</th><th>Response</th><th>K-line</th><th></th></tr></thead><tbody>
          ${addr.map((r) => html`<tr><td>${r.transport}</td><td class="mono">${r.bus}</td><td>${idCell(r.req, r.archvar, r.bus)}</td><td>${idCell(r.res, r.archvar, r.bus)}</td><td>${isNum(r.kline) ? html`<code>0x${hx(r.kline, 2)}</code>` : ''}</td>
            <td>${isNum(r.req) ? html`<a class="btn btn-sm" href="#/diag/request?req=${canIdHex(r.req)}&res=${canIdHex(r.res)}&proto=${encodeURIComponent(protos[0] || 'UDS')}">request builder</a>` : ''}</td></tr>`)}</tbody></table>` : html`<p class="muted">No addressing documented.</p>`}
        ${arr(ecu.sessions).length ? html`<h4>Sessions</h4><table class="tbl compact"><tbody>${arr(ecu.sessions).map((x) => html`<tr><td class="mono">10 ${hx(x.raw, 2)}</td><td>${t(x.text) || UDS_SESSIONS[x.raw] || ''}</td></tr>`)}</tbody></table>` : ''}
        ${arr(ecu.resets).length ? html`<h4>Resets</h4><table class="tbl compact"><tbody>${arr(ecu.resets).map((x) => html`<tr><td class="mono">11 ${hx(x.raw, 2)}</td><td>${t(x.text)}</td></tr>`)}</tbody></table>` : ''}
      </div>
      <div>
        ${arr(ecu.services).length ? html`<h4>Supported services</h4><table class="tbl compact"><tbody>${arr(ecu.services).map((sid) => html`<tr><td class="mono">0x${hx(sid, 2)}</td><td>${serviceName(db, sid, protos) || html`<span class="muted">unknown</span>`}</td></tr>`)}</tbody></table>` : ''}
        ${arr(ecu.security).length ? html`<h4>Security access</h4><table class="tbl compact"><thead><tr><th>Level</th><th>Algorithm</th><th>Key</th><th></th></tr></thead><tbody>
          ${arr(ecu.security).map((x) => html`<tr><td class="mono">27 ${hx(x.level, 2)} / ${isNum(x.level) ? hx(x.level + 1, 2) : ''}</td><td>${x.algorithm || ''}</td><td class="mono">${x.key || ''}</td>
            <td>${x.key ? html`<a class="btn btn-sm" href="#/diag/seedkey?key=${encodeURIComponent(x.key)}${isNum(x.level) ? `&level=${hx(x.level, 2)}` : ''}">compute key</a>` : ''}</td></tr>`)}</tbody></table>` : ''}
      </div>
    </div>
    ${arr(ecu.variants).length ? html`<details class="card"><summary><b>Software variants</b> <span class="count">${arr(ecu.variants).length}</span></summary>
      <div class="tablewrap"><table class="tbl compact"><thead><tr><th>Variant</th><th>Part numbers</th><th>Cars</th></tr></thead><tbody>
      ${arr(ecu.variants).map((v) => html`<tr><td class="mono">${v.id}</td><td class="mono small">${v.parts.join(', ')}</td><td class="small">${v.cars.join(', ')}</td></tr>`)}</tbody></table></div></details>` : ''}
    ${dtcs.length ? html`<h4>Fault codes <span class="count">${dtcs.length}</span></h4>${dtcTable(dtcs)}` : ''}
  </div>`;
}

function itemRow(it, archvar, nk, selected) {
  const idh = hex(it.ident, KIND_WIDTH[it.kind] || 4);
  const disp = t(it.displayName);
  return html`<a class="drow${it === selected ? ' selected' : ''}" href="${itemHref(archvar, nk, it)}" data-kind="${it.kind}"
    data-text="${`${KIND_LABEL[it.kind]} ${idh} ${it.name} ${disp}`.toLowerCase()}"><span class="dk dk-${it.kind}">${KIND_LABEL[it.kind] || it.kind}</span><span class="mono">${idh}${it.fileBase && /_[A-Z]/.test(it.fileBase) ? html`<small class="muted">${it.fileBase.replace(/^[0-9A-F]+/, '')}</small>` : ''}</span><span class="mono dname" title="${disp}">${it.name}</span></a>`;
}

function renderEcu(db, archvar, node, route, model = null) {
  const dg = diagOf(db);
  if (!archvar || !node) return emptyState('No ECU selected', 'Pick an ECU in the addressing table.');
  const e = dg.ecus.get(diagEcuKey(archvar, node, model)) || null;
  if (!e && !model) {
    const models = diagEcusOfNode(db, archvar, node).filter((x) => x.model).sort((a, b) => naturalCompare(a.model, b.model));
    if (models.length === 1) return renderEcu(db, archvar, node, route, models[0].model);
    if (models.length) return html`<p><a href="#/diag/addressing">← addressing</a></p>${modelPicker(archvar, node, models)}`;
  }
  const nk = model ? `${node}/${model}` : node;
  const nd = db && db.variantNodes && db.variantNodes.get(archvar) ? db.variantNodes.get(archvar).get(node) : null;
  const addr = addressingRows(db).filter((r) => r.archvar === archvar && r.node === node && (r.from !== 'diag' || (r.model || null) === (model || null)));
  if (!e && !addr.length) return html`${emptyState(`No diagnostic data for ${node}`, `Nothing in diag/${archvar}/${node}/ nor a diag block in nodes/${archvar}.yml.`)}<p><a href="#/ecus/${archvar}/${encodeURIComponent(node)}">ECU page</a></p>`;
  const ecu = (e && e.ecu) || {};
  const protos = arr(ecu.protocols).length ? arr(ecu.protocols) : arr(nd && nd.diag && nd.diag.protocols);
  const groups = e ? [['did', arr(e.dids)], ['lid', arr(e.lids)], ['routine', arr(e.routines)], ['ioctl', arr(e.ioctls)]].filter((g) => g[1].length) : [];
  const all = groups.flatMap((g) => g[1]);
  const selected = findItem(all, route.query);
  const siblings = model ? diagEcusOfNode(db, archvar, node).filter((x) => x.model).sort((a, b) => naturalCompare(a.model, b.model)) : [];
  const detail = selected ? html`<div class="fdetail-inner"><p class="small"><a href="${ecuDiagHref(archvar, nk)}">← ${node}${model ? ` ${model}` : ''} overview</a></p>${itemDetail(selected, archvar, nk, route)}</div>`
    : ecuOverview(db, archvar, node, model, e, nd, addr, protos, ecu, nk);
  return html`<p class="small"><a href="#/diag/addressing">← addressing</a> · ${nodeLink(archvar, node)}${model ? html` · <b class="mono">${model}</b>` : ''} · ${archvar}</p>
    <div class="frames-layout has-detail diag-layout">
      <aside class="sidebar">
        <h4 class="mono">${node}${model ? html`<br><small>${model}</small>` : ''}</h4>
        ${ecu.displayName ? html`<p class="small">${t(ecu.displayName)}</p>` : ''}
        <p class="small"><a href="${ecuDiagHref(archvar, nk)}">Overview</a> (addressing, sessions, variants${arr(e && e.dtcs).length ? `, ${arr(e.dtcs).length} fault codes` : ''})</p>
        <label class="small">Search<input type="search" id="ecu-q" data-live="ecu-filter" placeholder="ID, name, description…"></label>
        <div class="small">${groups.map(([k, l]) => html`<label class="chk"><input type="checkbox" data-live="ecu-filter" data-kind="${k}" checked> ${KIND_LABEL[k]}s <span class="count">${l.length}</span></label>`)}</div>
        ${siblings.length > 1 ? html`<h4>Other models</h4><ul class="plain small">${siblings.filter((x) => x.model !== model).map((x) => html`<li><a class="mono" href="${ecuDiagHref(archvar, ecuRef(x))}">${x.model}</a></li>`)}</ul>` : ''}
      </aside>
      <section class="flist"><div class="flist-body" id="ecu-items">
        ${all.length ? groups.map(([k, l]) => html`<div class="dgroup" data-kind="${k}">${KIND_LABEL[k]}s <span class="count">${l.length}</span></div>${l.map((it) => itemRow(it, archvar, nk, selected))}`) : html`<p class="muted" style="padding:10px">No identifiers documented.</p>`}
      </div></section>
      <section class="fdetail" id="ecu-detail">${detail}</section>
    </div>`;
}

// ---------------------------------------------------------------------------
// DTC lookup
// ---------------------------------------------------------------------------

/** Parse a DTC query: returns {code, raw, failureType} or null */
export function parseDtcQuery(q) {
  const s = String(q || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^[PCBU][0-3][0-9A-F]{3}(-[0-9A-F]{2})?$/.test(s)) {
    const r = dtcToRaw(s);
    if (!r) return null;
    return { code: s, base: s.slice(0, 5), raw: r.raw, failureType: r.failureType };
  }
  const h = s.replace(/^0X/, '');
  if (/^[0-9A-F]{4}$/.test(h)) { const raw = parseInt(h, 16); const code = rawToDtc(raw); return { code, base: code, raw, failureType: null }; }
  if (/^[0-9A-F]{6}$/.test(h)) { const raw = parseInt(h.slice(0, 4), 16); const ft = parseInt(h.slice(4), 16); return { code: rawToDtc(raw, ft), base: rawToDtc(raw), raw, failureType: ft }; }
  return null;
}

function dtcTable(list) {
  return html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Code</th><th>Raw</th><th>ECU</th><th>Architecture</th><th>Description</th><th>Comment / clues</th></tr></thead><tbody>
    ${list.map((d) => html`<tr><td class="mono"><b>${d.code}</b></td><td class="mono">${isNum(d.raw) ? `0x${hex(d.raw, 4)}` : ''}</td>
      <td><a href="${ecuDiagHref(d.archvar, ecuRef(d))}">${d.node}${d.model ? ` ${d.model}` : ''}</a></td><td>${d.archvar}</td><td>${t(d.displayName)}${arr(d.variants).length ? html`<div class="small muted">${arr(d.variants).join(', ')}</div>` : ''}</td>
      <td class="small">${t(d.comment)}${d.clues ? html`<div class="muted">${t(d.clues)}</div>` : ''}</td></tr>`)}
  </tbody></table></div>`;
}

function dtcResults(db, q) {
  const idx = arr(diagOf(db).dtcIndex);
  const p = parseDtcQuery(q);
  const s = String(q || '').trim().toLowerCase();
  let head = '';
  let matches;
  if (p) {
    const letter = p.code[0];
    head = html`<div class="card"><h3 class="mono">${p.code}</h3>
      ${kv([['Raw (2 bytes)', html`<code>0x${hex(p.raw, 4)}</code> <span class="muted">(${bytesToHex([p.raw >> 8, p.raw & 0xFF])}${p.failureType !== null ? ` ${hex(p.failureType, 2)}` : ''} on the bus)</span>`],
        ['System', `${letter} — ${LETTERS[letter] || '?'}`], ['Type', `${p.code[1]} — ${FIRST_DIGIT[p.code[1]] || ''}`],
        ['Failure type', p.failureType !== null ? `0x${hex(p.failureType, 2)}` : null]])}
      <p class="small muted">Bits 15-14 of the raw value: system letter (00 P, 01 C, 10 B, 11 U), bits 13-12: first digit, bits 11-0: the 3 last hex digits.</p></div>`;
    matches = idx.filter((d) => {
      const base = String(d.code || '').toUpperCase().slice(0, 5);
      return base === p.base || (isNum(d.raw) && d.raw === p.raw);
    });
  } else if (s) {
    matches = idx.filter((d) => `${d.code} ${d.node} ${d.archvar} ${t(d.displayName)} ${t(d.comment)}`.toLowerCase().includes(s));
  } else matches = idx;
  const shown = matches.slice(0, 500);
  return html`${head}
    ${!idx.length ? html`<div class="notice">No DTC documented in the loaded sources (diag/*/*/dtcs.yml).</div>` : ''}
    ${idx.length ? (shown.length ? html`<p class="muted">${matches.length} matching DTC(s)${matches.length > shown.length ? `, first ${shown.length} shown` : ''}.</p>${dtcTable(shown)}` : html`<p class="muted">No documented DTC matches.</p>`) : ''}`;
}

function renderDtcPage(db, route) {
  const q = route.query.q || '';
  return html`${noDiagBanner(db)}
    <div class="filterbar"><input type="search" id="dtc-q" data-live="dtc" class="mono" placeholder="B1003, B1003-11, 0x9003, D50A or text" value="${q}" autocomplete="off" spellcheck="false"></div>
    <div id="dtc-out">${dtcResults(db, q)}</div>`;
}

// ---------------------------------------------------------------------------
// request builder
// ---------------------------------------------------------------------------

const ECHO = { 0x10: 1, 0x11: 1, 0x19: 1, 0x21: 1, 0x22: 2, 0x27: 1, 0x28: 1, 0x2E: 2, 0x2F: 2, 0x30: 1, 0x31: 3, 0x3B: 1, 0x3E: 1, 0x85: 1, 0x1A: 1, 0x01: 1, 0x02: 1, 0x09: 1, 0x14: 0, 0x04: 0, 0x03: 0 };
const SUPPRESSIBLE = new Set([0x10, 0x11, 0x28, 0x3E, 0x85, 0x31, 0x27]);

let rq = null;

function reqDefaults(db, route) {
  const q = route.query;
  const rows = addressingRows(db).filter((r) => isNum(r.req));
  let row = null;
  if (q.arch && q.ecu) row = rows.find((r) => r.archvar === q.arch && r.node === q.ecu) || null;
  if (!row && !q.req && rows.length) row = rows[0];
  return {
    req: q.req || (row ? canIdHex(row.req) : '7E0'),
    res: q.res || (row && isNum(row.res) ? canIdHex(row.res) : '7E8'),
    proto: q.proto || (row && row.protocols[0]) || 'UDS',
    mode: q.mode === 'extended' ? 'extended' : 'normal',
    addr: q.addr || '40', raddr: q.raddr || 'F1',
    pad: q.pad || '00', bs: q.bs || '0', st: q.st || '0',
    data: q.data || '22 F1 90',
    iface: q.iface || 'can0',
    guessed: !q.req && !row,
  };
}

function reqHash() {
  const p = new URLSearchParams();
  for (const k of ['req', 'res', 'proto', 'mode', 'addr', 'pad', 'bs', 'st', 'data']) if (rq[k] !== undefined && rq[k] !== '') p.set(k, rq[k]);
  return `#/diag/request?${p.toString()}`;
}

function reqOutput(db) {
  const reqId = parseCanId(rq.req);
  const resId = parseCanId(rq.res);
  const bytes = parseHexBytes(rq.data);
  if (reqId === null || resId === null) return html`<div class="notice warn">Enter valid request and response CAN IDs (hex).</div>`;
  if (!bytes) return html`<div class="notice warn">Could not parse the request: use hex bytes like <code>22 F1 90</code>.</div>`;
  if (!bytes.length) return html`<p class="muted">Type the request bytes (service ID first).</p>`;
  if (bytes.length > 4095) return html`<div class="notice warn">Requests longer than 4095 bytes need the ISO 15765-2:2016 escape sequence, rarely supported by ECUs.</div>`;
  const ext = rq.mode === 'extended';
  const address = ext ? (parseHexInt(rq.addr) ?? 0) & 0xFF : undefined;
  const raddress = ext ? (parseHexInt(rq.raddr) ?? 0xF1) & 0xFF : undefined;
  const padding = rq.pad === 'none' ? null : ((parseHexInt(rq.pad) ?? 0) & 0xFF);
  const bs = Math.max(0, Math.min(255, parseInt(rq.bs, 10) || 0));
  const st = Math.max(0, Math.min(255, parseHexInt(rq.st) ?? (parseInt(rq.st, 10) || 0)));
  const opts = { addressing: rq.mode, address, padding };
  let desc;
  try { desc = describeMessage(Array.from(bytes), rq.proto, diagOf(db).protocols); } catch (e) { desc = { text: '' }; }
  const seg = segment(bytes, opts);
  const idS = canIdHex(reqId);
  const idR = canIdHex(resId);
  const rows = [];
  const cansend = [];
  let cfInBlock = 0;
  for (const f of seg.frames) {
    if (f.kind === 'CF' && bs > 0 && cfInBlock === bs) {
      const fc2 = flowControl({ addressing: rq.mode, address: raddress, blockSize: bs, stMin: st, padding });
      rows.push({ dir: 'ECU → tester', id: idR, data: fc2, kind: 'FC', expl: `flow control again after ${bs} consecutive frames (block size)` });
      cansend.push(`# wait for the next flow control on ${idR}`);
      cfInBlock = 0;
    }
    let expl = '';
    if (f.kind === 'SF') expl = `single frame: PCI 0${hex(bytes.length, 1)} = ${bytes.length} data byte(s)`;
    else if (f.kind === 'FF') expl = `first frame: PCI 1${hex((bytes.length >> 8) & 0xF, 1)} ${hex(bytes.length & 0xFF, 2)} = ${bytes.length} bytes in total`;
    else expl = `consecutive frame, sequence number ${f.sn}${st ? ` (wait STmin ${describeStMin(st)} before it)` : ''}`;
    rows.push({ dir: 'tester → ECU', id: idS, data: f.data, kind: f.kind, expl });
    cansend.push(`cansend ${rq.iface} ${idS}#${bytesToHex(f.data, '')}`);
    if (f.kind === 'FF') {
      const fc = flowControl({ addressing: rq.mode, address: raddress, blockSize: bs, stMin: st, padding });
      rows.push({ dir: 'ECU → tester', id: idR, data: fc, kind: 'FC', expl: `flow control from the ECU: 30 = continue to send (CTS), BS ${bs} (${bs ? `${bs} frames per block` : 'no limit'}), STmin 0x${hex(st, 2)} (${describeStMin(st)})` });
      cansend.push(`# wait for the ECU flow control (30 ..) on ${idR} before sending the consecutive frames`);
    }
    if (f.kind === 'CF') cfInBlock++;
  }
  // expected response
  const sid = bytes[0];
  const echo = ECHO[sid];
  const posSid = (sid + 0x40) & 0xFF;
  const suppressed = SUPPRESSIBLE.has(sid) && bytes.length > 1 && (bytes[1] & 0x80) && sid !== 0x31 && sid !== 0x27;
  const sample = [posSid, ...Array.from(bytes.slice(1, 1 + (echo ?? 0)))];
  const sampleSeg = segment(Uint8Array.from(sample), { ...opts, address: raddress });
  const tpPad = padding === null ? '' : ` -p ${hex(padding, 2)}:${hex(padding, 2)}`;
  const tpExt = ext ? ` -x ${hex(address, 2)}:${hex(raddress, 2)}` : '';
  const hexSpaced = bytesToHex(bytes).toLowerCase();
  const pyMode = ext ? 'Extended_11bits' : (reqId > 0x7FF || resId > 0x7FF ? 'Normal_29bits' : 'Normal_11bits');
  const py = `import can, isotp  # pip install python-can can-isotp
bus = can.Bus(channel='${rq.iface}', interface='socketcan')
addr = isotp.Address(isotp.AddressingMode.${pyMode}, txid=0x${idS}, rxid=0x${idR}${ext ? `, target_address=0x${hex(address, 2)}, source_address=0x${hex(raddress, 2)}` : ''})
stack = isotp.CanStack(bus, address=addr, params={${padding === null ? "'tx_padding': None" : `'tx_padding': 0x${hex(padding, 2)}`}, 'stmin': ${st}, 'blocksize': ${bs}})
stack.send(bytes.fromhex('${bytesToHex(bytes, '')}'))
while stack.transmitting():
    stack.process()
import time
t0 = time.time()
while time.time() - t0 < 2:
    stack.process()
    if stack.available():
        print(stack.recv().hex(' '))
        break
    time.sleep(0.005)`;
  return html`<div class="notice"><b>${desc.text || 'Request'}</b>${desc.layout ? html` <span class="muted mono">(${desc.layout})</span>` : ''}</div>
    <div class="tablewrap"><table class="tbl"><thead><tr><th>#</th><th>Direction</th><th>CAN ID</th><th>Data</th><th>Frame</th><th>Explanation</th></tr></thead><tbody>
      ${rows.map((r, i) => html`<tr class="${r.dir.startsWith('ECU') ? 'muted' : ''}"><td class="num">${i + 1}</td><td>${r.dir}</td><td class="mono">${r.id}</td><td class="mono"><b>${bytesToHex(r.data)}</b></td><td>${r.kind}</td><td class="small">${r.expl}</td></tr>`)}
    </tbody></table></div>
    <p class="small muted">${seg.needsFlowControl
    ? 'Multi-frame request: the tester sends the first frame (FF), waits for the flow control (FC) of the ECU, then sends the consecutive frames (CF) respecting its block size and STmin. The FC shown is the typical answer (the ECU chooses BS/STmin).'
    : 'Single frame request: it fits in one CAN frame (up to 7 data bytes with normal addressing, 6 with extended addressing).'}
    ${padding === null ? ' Frames are not padded (DLC < 8 allowed).' : ` Unused bytes are padded with 0x${hex(padding, 2)}.`}</p>
    <h4>Expected answer</h4>
    ${suppressed ? html`<p>The "suppress positive response" bit (0x80) of the sub-function is set: the ECU does not answer when the request succeeds.</p>` : ''}
    <p>Positive response on <code>${idR}</code> starts with <code>${hex(posSid, 2)}</code> (SID + 0x40)${echo ? html`, followed by the echoed ${echo === 1 ? 'sub-function / identifier byte' : `${echo} identifier bytes`}` : ''}; a negative response is <code>7F ${hex(sid, 2)} NRC</code> (eg. <code>7F ${hex(sid, 2)} 78</code> = response pending, wait and keep listening).</p>
    <p class="small">Smallest positive response: ${sampleSeg.frames.map((f) => html`<code>${idR}#${bytesToHex(f.data, '')}</code> `)}${echo === undefined ? html`<span class="muted">(response layout unknown for this service)</span>` : ''}</p>
    <h4>Send it</h4>
    ${codeBlock(cansend.join('\n'), { title: 'can-utils (raw frames, the flow control is not handled)' })}
    ${codeBlock(`# terminal 1: receive the response (sends the flow control for multi-frame answers)\nisotprecv -s ${idS} -d ${idR}${tpPad}${tpExt} ${rq.iface}\n# terminal 2: send the request\necho "${hexSpaced}" | isotpsend -s ${idS} -d ${idR}${tpPad}${tpExt} ${rq.iface}`, { title: 'can-utils ISO-TP (kernel isotp module)' })}
    ${codeBlock(py, { title: 'Python (python-can + can-isotp)' })}`;
}

function renderRequestPage(db, route) {
  if (!rq || cur.route !== route || route.query.req || route.query.data) rq = reqDefaults(db, route);
  const rows = addressingRows(db).filter((r) => isNum(r.req));
  const inp = (k, label, attrs = '') => html`<label class="small">${label} <input data-live="req" data-k="${k}" value="${rq[k]}" class="mono" size="${k === 'data' ? 40 : 6}" ${attrs}></label>`;
  return html`<div class="card">
    <div class="row"><label class="small">ECU <select data-live="req-ecu"><option value="">— pick an ECU to fill the IDs —</option>${rows.map((r) => html`<option value="${r.archvar}|${r.node}|${canIdHex(r.req)}|${canIdHex(r.res)}|${r.protocols[0] || 'UDS'}">${r.archvar} · ${r.node} (${canIdHex(r.req)} → ${canIdHex(r.res)})</option>`)}</select></label></div>
    <div class="row">${inp('req', 'Request ID')} ${inp('res', 'Response ID')}
      <label class="small">Protocol <select data-live="req" data-k="proto">${['UDS', 'KWP2000', 'KWP-PSA2000', 'EOBD'].map((p) => html`<option value="${p}" ${rq.proto === p ? 'selected' : ''}>${p}</option>`)}</select></label>
      <label class="small">Addressing <select data-live="req" data-k="mode">${['normal', 'extended'].map((p) => html`<option value="${p}" ${rq.mode === p ? 'selected' : ''}>${p}</option>`)}</select></label>
      ${inp('addr', 'Target addr.')} ${inp('raddr', 'Tester addr.')}
      <label class="small">Padding <select data-live="req" data-k="pad">${['00', '55', 'AA', 'CC', 'FF', 'none'].map((p) => html`<option value="${p}" ${rq.pad === p ? 'selected' : ''}>${p}</option>`)}</select></label>
      ${inp('bs', 'FC block size')} ${inp('st', 'FC STmin')} ${inp('iface', 'Interface')}</div>
    <div class="row">${inp('data', 'Request bytes', 'spellcheck="false" autocomplete="off"')}
      <span class="small muted">eg. <code>10 03</code> (extended session), <code>22 F1 90</code> (read VIN), <code>3E 00</code> (tester present), <code>19 02 FF</code> (read DTCs)</span></div>
    ${rq.guessed ? html`<p class="small muted">No ECU addressing documented in the loaded data: 7E0/7E8 (OBD engine ECU) are used as an example.</p>` : ''}
  </div>
  <div id="req-out">${reqOutput(db)}</div>`;
}

// ---------------------------------------------------------------------------
// seed / key
// ---------------------------------------------------------------------------

function securityEntries(db) {
  const out = [];
  for (const e of diagOf(db).ecus.values()) {
    for (const s of arr(e && e.ecu && e.ecu.security)) if (s && s.key) out.push({ archvar: e.archvar, node: e.node, level: s.level, key: s.key, algorithm: s.algorithm });
  }
  return out.sort((a, b) => naturalCompare(a.node, b.node));
}

function seedKeyOutput(seedText, keyText, levelText) {
  const seed = parseHexBytes(seedText);
  const app2 = parseHexBytes(keyText);
  const level = parseHexInt(levelText);
  if (!seed || seed.length !== 4) return html`<p class="muted">Enter the 4 byte seed sent by the ECU (the 4 bytes after <code>67 xx</code>).</p>`;
  if (!app2 || app2.length !== 2) return html`<p class="muted">Enter the 2 byte ECU application key.</p>`;
  const key = computeKey(seed, app2);
  if (!key) return html`<div class="notice warn">Invalid input.</div>`;
  const lv = isNum(level) ? level & 0xFF : 0x03;
  return html`<div class="payload-out"><span class="muted">Key</span> <code class="mono big">${bytesToHex(key)}</code> <button class="btn btn-sm" data-copyval="${bytesToHex(key, '')}">Copy</button></div>
    <table class="tbl compact"><thead><tr><th>Step</th><th>Tester → ECU</th><th>ECU → tester</th></tr></thead><tbody>
      <tr><td>open a session that allows it (often extended)</td><td class="mono">10 03</td><td class="mono">50 03 …</td></tr>
      <tr><td>request the seed</td><td class="mono">27 ${hex(lv, 2)}</td><td class="mono">67 ${hex(lv, 2)} ${bytesToHex(seed)}</td></tr>
      <tr><td>send the key</td><td class="mono"><b>27 ${hex((lv + 1) & 0xFF, 2)} ${bytesToHex(key)}</b></td><td class="mono">67 ${hex((lv + 1) & 0xFF, 2)}</td></tr>
    </tbody></table>
    <p class="small muted">A wrong key is answered with <code>7F 27 35</code> (invalid key); too many attempts with <code>7F 27 36</code> and then <code>37</code> (wait before retrying).</p>`;
}

function renderSeedKeyPage(db, route) {
  const q = route.query;
  const entries = securityEntries(db);
  const algos = [];
  for (const p of diagOf(db).protocols.values()) for (const a of arr(p.algorithms)) algos.push({ proto: p.name, ...a });
  const seed = q.seed || '11 22 33 44';
  const key = q.key || (entries[0] ? entries[0].key : '');
  const level = q.level || (entries[0] && isNum(entries[0].level) ? hex(entries[0].level, 2) : '03');
  return html`<p class="muted">SecurityAccess (service 0x27) computation used by PSA ECUs (UDS and KWP): the ECU sends a 4 byte seed, the tester answers with a 4 byte key computed from the seed and a 2 byte constant specific to the ECU (application key). Ported from <code>PSA-RE/sandbox/uds_auth_algorithm.py</code>.</p>
    <div class="card">
      ${entries.length ? html`<div class="row"><label class="small">Key from the data <select data-live="sk-pick"><option value="">—</option>${entries.map((e) => html`<option value="${e.key}|${isNum(e.level) ? hex(e.level, 2) : ''}">${e.node} (${e.archvar}) level ${isNum(e.level) ? hex(e.level, 2) : '?'}${e.algorithm ? ` · ${e.algorithm}` : ''}</option>`)}</select></label></div>` : html`<p class="small muted">No application key documented in the loaded data (diag/…/ecu.yml security_access): type it.</p>`}
      <div class="row">
        <label class="small">Seed (4 bytes) <input id="sk-seed" data-live="seedkey" class="mono" value="${seed}" size="14" spellcheck="false" autocomplete="off"></label>
        <label class="small">Application key (2 bytes) <input id="sk-key" data-live="seedkey" class="mono" value="${key}" size="8" spellcheck="false" autocomplete="off"></label>
        <label class="small">Level <input id="sk-level" data-live="seedkey" class="mono" value="${level}" size="4" spellcheck="false" autocomplete="off"></label>
      </div>
      <div id="sk-out">${seedKeyOutput(seed, key, level)}</div>
    </div>
    ${codeBlock(ALGORITHM_DESCRIPTION, { title: 'Algorithm' })}
    ${algos.length ? html`<h4>Algorithms described in the data</h4>${algos.map((a) => html`<div class="card"><b class="mono">${a.name}</b> <span class="muted">(${a.proto})</span>${a.comment ? html`<p>${t(a.comment)}</p>` : ''}${a.pseudocode ? html`<pre class="code">${a.pseudocode}</pre>` : ''}</div>`)}` : ''}
    <p class="small muted">Only use it on vehicles you own or are allowed to work on.</p>`;
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

function findItem(all, query) {
  for (const k of ['did', 'lid', 'routine', 'ioctl']) {
    if (query[k] === undefined) continue;
    const id = parseHexInt(query[k]);
    const cands = all.filter((x) => x.kind === k && x.ident === id);
    return cands.find((x) => query.f && x.fileBase === query.f) || cands[0] || null;
  }
  return null;
}

function currentItem(db, route) {
  if (!route || route.parts[1] !== 'ecu') return null;
  const e = diagOf(db).ecus.get(diagEcuKey(route.parts[2], route.parts[3], route.parts[4] || null));
  if (!e) return null;
  const it = findItem([...arr(e.dids), ...arr(e.lids), ...arr(e.routines), ...arr(e.ioctls)], route.query);
  return it ? { item: it, archvar: route.parts[2] } : null;
}

function bind(root) {
  if (bound.has(root)) return;
  bound.add(root);
  const active = () => app.route && app.route.view === 'diag' && cur.root === root;
  const live = (ev, el) => {
    if (!active()) return;
    const db = app.db;
    const kind = el.dataset.live;
    if (kind === 'addr') {
      const q = ($('#addr-q', root) || {}).value || '';
      const a = ($('#addr-arch', root) || {}).value || '';
      setHtml($('#addr-out', root), addressingTable(db, q, a));
      const p = new URLSearchParams();
      if (q) p.set('q', q);
      if (a) p.set('arch', a);
      replaceHash(`#/diag/addressing${p.toString() ? '?' + p.toString() : ''}`);
    } else if (kind === 'dtc') {
      setHtml($('#dtc-out', root), dtcResults(db, el.value));
      replaceHash(`#/diag/dtc${el.value ? '?q=' + encodeURIComponent(el.value) : ''}`);
    } else if (kind === 'ecu-filter') {
      const q = (($('#ecu-q', root) || {}).value || '').trim().toLowerCase();
      const on = new Set($$('input[type=checkbox][data-live=ecu-filter]', root).filter((c) => c.checked).map((c) => c.dataset.kind));
      for (const r of $$('#ecu-items .drow', root)) r.style.display = on.has(r.dataset.kind) && (!q || r.dataset.text.includes(q)) ? '' : 'none';
      for (const g of $$('#ecu-items .dgroup', root)) g.style.display = on.has(g.dataset.kind) ? '' : 'none';
    } else if (kind === 'didDecode') {
      const c = currentItem(db, cur.route);
      if (c) setHtml($('#dd-out', root), decodeTable(c.item, c.archvar, el.dataset.which || 'params', el.value));
    } else if (kind === 'req') {
      if (!rq) return;
      rq[el.dataset.k] = el.value;
      setHtml($('#req-out', root), reqOutput(db));
      replaceHash(reqHash());
    } else if (kind === 'req-ecu') {
      if (!rq || !el.value) return;
      const [, , req, res, proto] = el.value.split('|');
      Object.assign(rq, { req, res, proto: proto || rq.proto, guessed: false });
      for (const k of ['req', 'res']) { const i = $(`[data-live=req][data-k=${k}]`, root); if (i) i.value = rq[k]; }
      const ps = $('select[data-live=req][data-k=proto]', root);
      if (ps) ps.value = rq.proto;
      setHtml($('#req-out', root), reqOutput(db));
      replaceHash(reqHash());
    } else if (kind === 'seedkey') {
      const sd = ($('#sk-seed', root) || {}).value;
      const k = ($('#sk-key', root) || {}).value;
      const lv = ($('#sk-level', root) || {}).value;
      setHtml($('#sk-out', root), seedKeyOutput(sd, k, lv));
    } else if (kind === 'sk-pick') {
      if (!el.value) return;
      const [k, lv] = el.value.split('|');
      const ki = $('#sk-key', root);
      const li = $('#sk-level', root);
      if (ki) ki.value = k;
      if (li && lv) li.value = lv;
      setHtml($('#sk-out', root), seedKeyOutput(($('#sk-seed', root) || {}).value, k, lv || (li && li.value)));
    }
  };
  on(root, 'input', 'input[data-live]', live);
  on(root, 'change', 'select[data-live]', live);
  let lastSig = null;
  on(root, 'mouseover', '#diag-item [data-sig]', (ev, el) => {
    if (!active()) return;
    const name = el.dataset.sig;
    if (name === lastSig) return;
    lastSig = name;
    $$('#diag-item .hl', root).forEach((x) => x.classList.remove('hl'));
    $$(`#diag-item [data-sig="${CSS.escape(name)}"]`, root).forEach((x) => x.classList.add('hl'));
  });
}
