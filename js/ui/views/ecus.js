// ECUs view: ECU list per architecture variant, ECU page with frames, custom ECU checklist, cars, DBC export.

import { html, $, on, setHtml, download } from '../dom.js';
import { app, lang } from '../state.js';
import { store } from '../../core/cache.js';
import {
  t, emptyState, variantOptions, defaultVariant, frameLink, periodText, nodeList, protocolBadge, busInfo, unreleasedBadge, sourceBadge, busLabel,
} from '../widgets.js';
import { exportDbc } from '../../core/dbc.js';
import { hex, naturalCompare, fmtNum, ident } from '../../core/util.js';

let listFilter = '';

function renderList(root, archvar) {
  const db = app.db;
  const key = archvar && db.variants.has(archvar) ? archvar : defaultVariant();
  const nodes = [...(db.variantNodes.get(key) || new Map()).values()];
  const usage = db.nodeUsage.get(key) || new Map();
  const rows = () => nodes.filter((n) => !n.phantom || usage.has(n.name))
    .filter((n) => { const q = listFilter.trim().toLowerCase(); return !q || `${n.name} ${n.alt.join(' ')} ${n.title ? Object.values(n.title).join(' ') : ''}`.toLowerCase().includes(q); })
    .sort((a, b) => naturalCompare(a.name, b.name)).map((n) => {
      const u = usage.get(n.name);
      const buses = n.buses.length ? n.buses : u ? [...u.buses] : [];
      return html`<tr><td><a href="#/ecus/${key}/${encodeURIComponent(n.name)}" class="mono"><b>${n.name}</b></a> ${n.released === false ? unreleasedBadge() : ''}${n.phantom ? html`<span class="badge" title="used by frames but not defined in nodes/${key}.yml">undefined</span>` : ''}${n.aliasOf ? html`<span class="small muted"> = ${n.aliasOf}</span>` : ''}${n.pseudo ? html`<span class="badge" title="${n.pseudo}">pseudo node</span>` : ''}${!n.phantom && n.archvar && n.archvar !== key ? html`<span class="badge badge-inh" title="defined in nodes/${n.archvar}.yml">↑ ${n.archvar}</span>` : ''}</td>
        <td>${t(n.title)}${n.alt.length ? html`<div class="small muted">${n.alt.join(', ')}</div>` : ''}</td><td class="small mono">${buses.join(', ')}</td>
        <td class="small mono">${Object.entries(n.ids).map(([net, id]) => `${net}:0x${hex(id, 2)}`).join(' ')}</td>
        <td class="num">${u ? u.sends.length : 0}</td><td class="num">${u ? u.receives.length : 0}</td>
        <td>${n.diag ? html`<span class="badge">diag</span>` : ''}${db.diag.ecus.has(`${key}/${n.name}`) ? html`<a class="badge" href="#/diag/ecu/${key}/${encodeURIComponent(n.name)}">diag data</a>` : ''}${sourceBadge(n.source)}</td></tr>`;
    });
  setHtml(root, html`<div class="page">
    <h2>ECUs</h2>
    <div class="filterbar"><select id="ecu-arch">${variantOptions(key)}</select><input type="search" id="ecu-q" placeholder="Filter ECUs (BSI, CMM, radio…)" value="${listFilter}"></div>
    ${nodes.length ? html`<div class="tablewrap"><table class="tbl"><thead><tr><th>ECU</th><th>Name</th><th>Buses</th><th>Codes</th><th class="num">Sends</th><th class="num">Receives</th><th></th></tr></thead><tbody id="ecu-rows">${rows()}</tbody></table></div>` : emptyState('No ECU known for this architecture', 'No nodes/ file and no frame referencing an ECU.')}
  </div>`);
  if (root._unbind) root._unbind();
  const offs = [
    on(root, 'change', '#ecu-arch', (ev, el) => { location.hash = `#/ecus/${el.value}`; }),
    on(root, 'input', '#ecu-q', (ev, el) => { listFilter = el.value; const tb = $('#ecu-rows', root); if (tb) setHtml(tb, rows()); }),
  ];
  root._unbind = () => offs.forEach((o) => o());
}

const ID_BASES = [
  [0x400, 'wake-up / event'], [0x480, 'error event'], [0x500, 'supervision'], [0x5C0, 'version'], [0x600, 'diagnostic / per-ECU'],
];

function identityFrames(db, key, node) {
  const out = [];
  const frames = db.variantFrames.get(key) || [];
  const nets = Object.entries(node.ids || {});
  for (const [net, code] of nets) {
    for (const f of frames) {
      if (f.net !== net && net !== '*') continue;
      for (const [base, what] of ID_BASES) {
        if (f.id === base + code) out.push({ f, what, base, code });
      }
    }
  }
  return out;
}

function checklist(db, key, node, u) {
  const sends = u ? u.sends : [];
  const recv = u ? u.receives : [];
  const periodic = sends.filter((f) => f.periodMs).sort((a, b) => a.periodMs - b.periodMs || a.id - b.id);
  const event = sends.filter((f) => !f.periodMs);
  const idf = identityFrames(db, key, node);
  const nm = [...new Set([...sends, ...recv].filter((f) => /WAKE|REVEIL|SUPERV|VERSION|ALIVE|\bNM\b|NETWORK|RESEAU|PRESENCE|POWER|ETAT_BSI|BSI_COMMANDS|COMMANDES_BSI/i.test(`${f.name} ${f.altNames.join(' ')}`)))];
  const buses = node.buses.length ? node.buses : u ? [...u.buses] : [];
  const ck = store.get(`check:${key}/${node.name}`, {}) || {};
  const item = (id, content) => html`<li><label><input type="checkbox" data-check="${id}" ${ck[id] ? 'checked' : ''}>${content}</label></li>`;
  const phys = (b) => {
    const bi = busInfo(key, b) || {};
    const p = (bi.protocol || '').toUpperCase();
    if (p === 'VAN') return 'VAN: needs a VAN controller (TSS463/TSS461) or a software implementation (eg. ESP32 RMT) with a CAN-like differential transceiver';
    if (p === 'LIN') return 'LIN: single wire, LIN transceiver (TJA1020/TJA1021), usually 19.2 kbit/s; the master sends the headers';
    if (p === 'K-LINE') return 'K-line: ISO 9141 transceiver (L9637D, MC33290)';
    return `CAN transceiver at ${bi.bitrate ? fmtNum(bi.bitrate) + ' kbit/s' : 'the bus bitrate (unknown, measure it)'}; check whether this bus uses a high-speed or fault-tolerant low-speed physical layer on your car`;
  };
  return html`<div class="card"><h3>Build a custom ECU / emulate ${node.name}</h3>
    <p class="muted small">Checklist generated from the documented frames (your ticks are kept in this browser). Emulating an ECU means sending everything it sends, at the right period, and reacting to what it receives.</p>
    <ol class="checklist">
      <li><b>1. Physical layer</b><ul class="checklist">${buses.map((b) => item(`phy:${b}`, html` <span class="mono">${b}</span> — ${phys(b)}`))}</ul></li>
      <li><b>2. Transmit periodically</b> (${periodic.length})<ul class="checklist">${periodic.length ? periodic.map((f) => item(`tx:${f.key}`, html` ${frameLink(f)} <span class="mono">${f.name}</span> every <b>${f.periodMs} ms</b>${f.trigger ? ' + on change' : ''} on <span class="mono">${f.netbus}</span>, ${f.length} bytes`)) : html`<li class="muted">none documented</li>`}</ul></li>
      <li><b>3. Transmit on event / on request</b> (${event.length})<ul class="checklist">${event.length ? event.map((f) => item(`ev:${f.key}`, html` ${frameLink(f)} <span class="mono">${f.name}</span> (${periodText(f)}) on <span class="mono">${f.netbus}</span>`)) : html`<li class="muted">none documented</li>`}</ul></li>
      <li><b>4. Consume</b> (${recv.length})<ul class="checklist">${recv.length ? recv.map((f) => item(`rx:${f.key}`, html` ${frameLink(f)} <span class="mono">${f.name}</span> from ${f.senders.join(', ') || '?'} (${periodText(f)})${f.periodMs ? html` <span class="muted small">— detect its loss after ~${Math.max(3 * f.periodMs, 100)} ms</span>` : ''}`)) : html`<li class="muted">none documented</li>`}</ul></li>
      <li><b>5. Wake-up, supervision and identity frames</b><ul class="checklist">
        ${idf.map(({ f, what, base, code }) => item(`id:${f.key}`, html` ${frameLink(f)} <span class="mono">${f.name}</span> — ${what} frame (ID 0x${hex(base, 3)} + ECU code 0x${hex(code, 2)}, heuristic)`))}
        ${nm.filter((f) => !idf.some((x) => x.f === f)).map((f) => item(`nm:${f.key}`, html` ${frameLink(f)} <span class="mono">${f.name}</span> — power / network management related (by name)`))}
        ${!idf.length && !nm.length ? html`<li class="muted">nothing identified; on AEE2004 low speed buses, the BSI power state frame (0x036) and the wake-up (0x4xx) / supervision (0x5xx) ranges are usually involved</li>` : ''}
        <li class="muted small">The gateway (BSI) usually supervises every ECU: an ECU that stops sending its frames is reported as missing (and faults are logged).</li>
      </ul></li>
      ${node.diag ? html`<li><b>6. Diagnostics</b><ul class="checklist">${item('diag', html` answer diagnostic requests on ${node.diag.request_id !== null && node.diag.request_id !== undefined ? html`<span class="mono">0x${hex(node.diag.request_id, 3)}</span> → respond on <span class="mono">0x${hex(node.diag.response_id, 3)}</span>` : 'its diagnostic address'} (${(node.diag.protocols || []).join(', ') || 'protocol?'}) — at least TesterPresent and the identification DIDs`)}</ul></li>` : ''}
    </ol>
  </div>`;
}

function renderEcu(root, key, name) {
  const db = app.db;
  const nodes = db.variantNodes.get(key) || new Map();
  const node = nodes.get(name);
  if (root._unbind) { root._unbind(); root._unbind = null; }
  if (!node) { setHtml(root, html`<div class="page"><p><a href="#/ecus/${key}">← ECUs</a></p>${emptyState('Unknown ECU', `${name} is not known in ${key}`)}</div>`); return; }
  const u = (db.nodeUsage.get(key) || new Map()).get(name);
  const sends = u ? [...u.sends].sort((a, b) => a.id - b.id) : [];
  const recv = u ? [...u.receives].sort((a, b) => a.id - b.id) : [];
  const cars = db.carsByNode.get(`${key}|${name}`) || [];
  const buses = node.buses.length ? node.buses : u ? [...u.buses] : [];
  const diagData = db.diag.ecus.get(`${key}/${name}`);
  const inOther = db.variantList.filter((v) => v.key !== key && (db.variantNodes.get(v.key) || new Map()).has(name) && !(db.variantNodes.get(v.key).get(name).phantom && !(db.nodeUsage.get(v.key) || new Map()).has(name)));
  const ftable = (list, dir) => list.length ? html`<div class="tablewrap"><table class="tbl compact"><thead><tr><th>ID</th><th>Name</th><th>Bus</th><th class="num">Len</th><th>Period</th><th>${dir === 'tx' ? 'Receivers' : 'Senders'}</th></tr></thead>
    <tbody>${list.map((f) => html`<tr><td>${frameLink(f)}</td><td class="mono">${f.name}</td><td class="mono small">${f.netbus}</td><td class="num">${f.length}</td><td class="small">${periodText(f)}</td><td class="small">${nodeList(key, dir === 'tx' ? f.receivers : f.senders, 8)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">None documented.</p>`;
  setHtml(root, html`<div class="page">
    <p><a href="#/ecus/${key}">← ECUs of ${key}</a></p>
    <h2><span class="mono">${node.name}</span> ${node.released === false ? unreleasedBadge() : ''} ${(node.sources || []).map((s) => sourceBadge(s))}</h2>
    ${node.title ? html`<p><b>${t(node.title)}</b></p>` : ''}
    ${node.comment ? html`<p>${t(node.comment)}</p>` : ''}
    ${node.pseudo ? html`<div class="notice">Pseudo node: ${node.pseudo}. It is not a real ECU of the car.</div>` : ''}
    ${!node.phantom && node.archvar && node.archvar !== key ? html`<div class="notice">Inherited: defined in <code>nodes/${node.archvar}.yml</code> (${key} derives from it).</div>` : ''}
    ${node.phantom && !node.pseudo ? html`<div class="notice warn">This ECU is referenced by frames but not defined in <code>nodes/${key}.yml</code>${node.aliasOf ? html` (it is an alternative name of <a href="#/ecus/${key}/${encodeURIComponent(node.aliasOf)}">${node.aliasOf}</a>)` : ''}.</div>` : ''}
    <div class="two-col">
      <div class="card"><h3>Identity</h3>
        <dl class="kv">
          <dt>Architecture</dt><dd><a href="#/arch/${key}" class="mono">${key}</a>${inOther.length ? html` <span class="small muted">also in ${inOther.map((v, i) => html`${i ? ', ' : ''}<a href="#/ecus/${v.key}/${encodeURIComponent(name)}">${v.key}</a>`)}</span>` : ''}</dd>
          ${node.alt.length ? html`<dt>Other names</dt><dd>${node.alt.join(', ')}</dd>` : ''}
          <dt>Buses</dt><dd>${buses.length ? buses.map((b) => html`<div><a class="mono" href="#/frames/${key}?bus=${encodeURIComponent(b)}">${b}</a> ${protocolBadge(busInfo(key, b))}</div>`) : html`<span class="muted">unknown</span>`}</dd>
          ${Object.keys(node.ids).length ? html`<dt>ECU codes</dt><dd class="mono">${Object.entries(node.ids).map(([net, id]) => html`<div>${net}: 0x${hex(id, 2)} (${id})</div>`)}</dd>` : ''}
        </dl>
      </div>
      <div class="card"><h3>Diagnostics</h3>
        ${node.diag ? html`<dl class="kv">
          ${node.diag.protocols ? html`<dt>Protocols</dt><dd>${[].concat(node.diag.protocols).join(', ')}</dd>` : ''}
          ${node.diag.bus ? html`<dt>Bus</dt><dd class="mono">${node.diag.bus}</dd>` : ''}
          ${node.diag.request_id !== undefined && node.diag.request_id !== null ? html`<dt>Request ID</dt><dd class="mono">0x${hex(node.diag.request_id, 3)}</dd>` : ''}
          ${node.diag.response_id !== undefined && node.diag.response_id !== null ? html`<dt>Response ID</dt><dd class="mono">0x${hex(node.diag.response_id, 3)}</dd>` : ''}
          ${node.diag.kline_address !== undefined && node.diag.kline_address !== null ? html`<dt>K-line address</dt><dd class="mono">0x${hex(node.diag.kline_address, 2)}</dd>` : ''}
          ${node.diag.obd_request_id !== undefined && node.diag.obd_request_id !== null ? html`<dt>OBD IDs</dt><dd class="mono">0x${hex(node.diag.obd_request_id, 3)} → 0x${hex(node.diag.obd_response_id, 3)}</dd>` : ''}
        </dl>
        ${node.diag.request_id !== undefined && node.diag.request_id !== null ? html`<a class="btn btn-sm" href="#/diag/request?req=${hex(node.diag.request_id)}&res=${hex(node.diag.response_id)}">Build a diagnostic request</a>` : ''}` : html`<p class="muted">No diagnostic addressing documented.</p>`}
        ${diagData ? html`<p><a class="btn btn-sm" href="#/diag/ecu/${key}/${encodeURIComponent(name)}">Diagnostic data (DIDs, DTCs…)</a></p>` : ''}
      </div>
    </div>
    <h3>Sends <span class="count">${sends.length}</span></h3>${ftable(sends, 'tx')}
    <h3>Receives <span class="count">${recv.length}</span></h3>${ftable(recv, 'rx')}
    ${checklist(db, key, node, u)}
    <div class="card"><h3>Cars fitted with ${node.name} <span class="count">${cars.length}</span></h3>
      ${cars.length ? html`<div class="tablewrap"><table class="tbl compact"><tbody>${cars.map((c) => html`<tr><td><a href="#/cars/${encodeURIComponent(c.car.project)}" class="mono">${c.car.project}</a></td><td>${[...new Set(c.car.codes.flatMap((x) => x.names))].join(', ')}</td><td class="small">${c.version.name}${c.optional ? html` <span class="badge">optional</span>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No car file lists this ECU yet.</p>`}
    </div>
    <div class="card"><h3>DBC export</h3>
      <p class="muted small">DBC file with only the frames ${node.name} sends and/or receives (${sends.length + recv.length} frames), ready for SavvyCAN, CANdb++, cantools...</p>
      <button class="btn" data-act="ecu-dbc" data-mode="both">Download DBC (sent + received)</button>
      <button class="btn" data-act="ecu-dbc" data-mode="tx">Sent only</button>
      <button class="btn" data-act="ecu-dbc" data-mode="rx">Received only</button>
    </div>
  </div>`);
  const offs = [
    on(root, 'change', '[data-check]', (ev, el) => {
      const k = `check:${key}/${name}`;
      const ck = store.get(k, {}) || {};
      if (el.checked) ck[el.dataset.check] = 1; else delete ck[el.dataset.check];
      store.set(k, ck);
    }),
    on(root, 'click', '[data-act=ecu-dbc]', (ev, el) => {
      const mode = el.dataset.mode;
      const list = mode === 'tx' ? sends : mode === 'rx' ? recv : [...new Set([...sends, ...recv])];
      const { text } = exportDbc(list, { lang: lang(), busLabel: `${key} ${name} (${mode})` });
      download(`${key}_${ident(name)}_${mode}.dbc`, text);
    }),
  ];
  root._unbind = () => offs.forEach((o) => o());
}

export function renderEcus(root, route) {
  const [, key, name] = route.parts;
  if (key && name) renderEcu(root, key, name);
  else renderList(root, key);
}
