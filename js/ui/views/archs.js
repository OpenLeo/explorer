// Architectures view: list of architectures/variants, variant page (buses, topology, nodes, diff vs parent).

import { html, setHtml } from '../dom.js';
import { app } from '../state.js';
import { t, emptyState, protocolBadge, sourceBadge, nodeLink, frameLink, unreleasedBadge } from '../widgets.js';
import { topologySvg } from '../diagrams.js';
import { diffVariants, frameRoute } from '../../core/repo.js';
import { hex, fmtNum, naturalCompare } from '../../core/util.js';

const ARCH_NOTES = {
  AEE2001: 'VAN + CAN architecture (≈1998-2008: 206, 307, C5, Xsara Picasso...). Comfort and body on VAN buses, powertrain on a CAN inter-systems bus.',
  AEE2004: 'First "full CAN" architecture (2004+). The "ev" variant is the 2007 evolution (AEE2004-2007), not an electric vehicle.',
  AEE2010: 'Second generation full CAN architecture (2010+), with eco/ev ("evolution") variants and many more buses.',
};

function variantStats(key) {
  const db = app.db;
  const frames = db.variantFrames.get(key) || [];
  const own = (db.ownFrames.get(key) || []).length;
  const nodes = [...(db.variantNodes.get(key) || new Map()).values()];
  const buses = [...db.variantBuses(key).keys()];
  return { frames: frames.length, own, nodes: nodes.filter((n) => !n.phantom).length, buses: buses.length };
}

function renderList(root) {
  const db = app.db;
  const archs = Object.keys(db.archs).sort(naturalCompare);
  setHtml(root, html`<div class="page">
    <h2>Architectures</h2>
    <p class="muted">PSA electrical/electronic architectures ("AEE"). Each one has variants; a variant may derive from a parent variant (frames not redefined are the same). "ev" means <i>évolution</i> (a later revision), not electric.</p>
    ${archs.map((a) => html`<div class="card">
      <h3>${a}</h3>
      ${ARCH_NOTES[a] ? html`<p class="muted">${ARCH_NOTES[a]}</p>` : ''}
      <div class="cards">${Object.values(db.archs[a]).map((v) => {
        const st = variantStats(v.key);
        return html`<a class="card" href="#/arch/${v.key}" style="display:block;color:inherit">
          <b class="mono">${v.key}</b> ${v.status ? html`<span class="badge">${v.status}</span>` : ''}${v.pseudo ? html`<span class="badge badge-warn" title="Not defined in architectures.yml">undeclared</span>` : ''}
          <div>${t(v.displayName) || t(v.comment) || html`<span class="muted">no description</span>`}</div>
          <div class="small muted">${v.years ? `${v.years} · ` : ''}${v.parent ? `parent: ${v.parent} · ` : ''}${st.buses} bus${st.buses > 1 ? 'es' : ''} · ${st.nodes} ECUs · ${st.frames} frames${st.own !== st.frames ? ` (${st.own} own)` : ''}</div>
        </a>`;
      })}</div>
    </div>`)}
  </div>`);
}

function renderVariant(root, key) {
  const db = app.db;
  const v = db.variants.get(key);
  if (!v) { setHtml(root, html`<div class="page">${emptyState('Unknown architecture', key)}</div>`); return; }
  const buses = [...db.variantBuses(key).values()];
  const frames = db.variantFrames.get(key) || [];
  const counts = new Map();
  for (const f of frames) counts.set(f.netbus, (counts.get(f.netbus) || 0) + 1);
  const nodesMap = db.variantNodes.get(key) || new Map();
  const usage = db.nodeUsage.get(key) || new Map();
  const nodes = [...nodesMap.values()].filter((n) => !n.phantom || usage.has(n.name)).map((n) => {
    let nb = n.buses && n.buses.length ? n.buses : [];
    const u = usage.get(n.name);
    if (!nb.length && u) nb = [...u.buses];
    return { ...n, buses: nb };
  }).sort((a, b) => naturalCompare(a.name, b.name));
  const diff = diffVariants(db, key);
  const children = db.variantList.filter((x) => x.arch === v.arch && x.parent === v.variant);
  const nets = [...new Set(buses.map((b) => b.net))];
  const docs = [...db.busDocs.entries()].filter(([k]) => k.startsWith(key + '/'));
  setHtml(root, html`<div class="page wide">
    <p><a href="#/arch">← Architectures</a></p>
    <h2 class="mono">${key} ${v.status ? html`<span class="badge">${v.status}</span>` : ''} ${(v.sources || []).map((s) => sourceBadge(s))}</h2>
    <p>${t(v.displayName) ? html`<b>${t(v.displayName)}</b> — ` : ''}${t(v.comment)}</p>
    <p class="muted">${v.years ? `Years: ${v.years}. ` : ''}${v.parent ? html`Derives from <a href="#/arch/${v.arch}.${v.parent}">${v.arch}.${v.parent}</a>. ` : ''}${children.length ? html`Derived variants: ${children.map((c, i) => html`${i ? ', ' : ''}<a href="#/arch/${c.key}">${c.key}</a>`)}. ` : ''}${v.protocols.length ? `Protocols: ${v.protocols.join(', ')}.` : ''}</p>
    ${ARCH_NOTES[v.arch] ? html`<p class="muted small">${ARCH_NOTES[v.arch]}</p>` : ''}
    <p><a class="btn" href="#/frames/${key}">Browse the ${frames.length} frames</a> <a class="btn" href="#/ecus/${key}">ECUs</a> <a class="btn" href="#/tools/export?arch=${encodeURIComponent(key)}">DBC export</a></p>

    <h3>Networks and buses</h3>
    ${buses.length ? html`<div class="tablewrap"><table class="tbl">
      <thead><tr><th>Network</th><th>Bus</th><th>Protocol</th><th>Bitrate</th><th>Name</th><th>Comment</th><th class="num">Frames</th><th class="num">ECUs</th></tr></thead>
      <tbody>${buses.sort((a, b) => naturalCompare(a.netbus, b.netbus)).map((b) => {
        const n = nodes.filter((x) => x.buses.includes(b.netbus)).length;
        return html`<tr><td class="mono">${b.net}</td><td class="mono"><a href="#/frames/${key}?bus=${encodeURIComponent(b.netbus)}">${b.netbus}</a>${b.inheritedFrom ? html` <span class="badge" title="defined in the parent variant">inherited</span>` : ''}${b.undeclared ? html` <span class="badge badge-warn" title="found in buses/ but not declared in architectures.yml">undeclared</span>` : ''}</td>
          <td>${protocolBadge({ protocol: b.protocol })}</td><td>${b.bitrate ? `${fmtNum(b.bitrate)} kbit/s` : html`<span class="muted">unknown</span>`}</td><td>${t(b.displayName)}</td><td class="small">${t(b.comment)}</td><td class="num">${counts.get(b.netbus) || 0}</td><td class="num">${n}</td></tr>`;
      })}</tbody></table></div>` : emptyState('No network defined', 'architectures.yml has no networks for this variant yet (or it is not multiplexed).')}

    ${buses.length ? html`<h3>Topology</h3><p class="muted small">Each line is a bus; boxes are ECUs (click to open). ECUs on several buses (gateways, like the BSI) are drawn on the left with a connection to each bus. Dashed boxes: ECUs used by frames but not defined in nodes/; red: never released.</p>${topologySvg(key, buses.sort((a, b) => naturalCompare(a.netbus, b.netbus)), nodes)}` : ''}

    <h3>ECUs <span class="count">${nodes.length}</span></h3>
    ${nodes.length ? html`<div class="tablewrap"><table class="tbl compact">
      <thead><tr><th>ECU</th><th>Name</th><th>Buses</th><th>Codes</th><th class="num">Sends</th><th class="num">Receives</th><th>Diag</th></tr></thead>
      <tbody>${nodes.map((n) => {
        const u = usage.get(n.name);
        return html`<tr><td>${nodeLink(key, n.name)} ${n.released === false ? unreleasedBadge() : ''}${n.phantom ? html`<span class="badge" title="not defined in nodes/${key}.yml">undefined</span>` : ''}${n.alt && n.alt.length ? html`<div class="small muted">${n.alt.join(', ')}</div>` : ''}</td>
          <td>${t(n.title)}</td><td class="small mono">${n.buses.join(', ')}</td>
          <td class="small mono">${Object.entries(n.ids || {}).map(([net, id]) => `${net}: 0x${hex(id, 2)}`).join(', ')}</td>
          <td class="num">${u ? u.sends.length : 0}</td><td class="num">${u ? u.receives.length : 0}</td>
          <td class="small mono">${n.diag && (n.diag.request_id !== undefined && n.diag.request_id !== null) ? `0x${hex(n.diag.request_id, 3)} → 0x${hex(n.diag.response_id, 3)}` : n.diag && n.diag.kline_address !== undefined && n.diag.kline_address !== null ? `K 0x${hex(n.diag.kline_address, 2)}` : ''}</td></tr>`;
      })}</tbody></table></div>` : emptyState('No ECU known', 'No nodes/ file for this variant and no frame references an ECU.')}

    ${diff ? html`<h3>Differences with the parent variant <a href="#/arch/${diff.parent}" class="mono">${diff.parent}</a></h3>
      <p class="muted small">${diff.inheritedCount} frame(s) inherited unchanged from the parent (not redefined), ${diff.same.length} redefined identically, ${diff.changed.length} changed, ${diff.added.length} added. Frames are compared by bus + file name.</p>
      ${diff.added.length ? html`<h4>Added (${diff.added.length})</h4><div class="tablewrap"><table class="tbl compact"><tbody>${diff.added.map((f) => html`<tr class="st-added"><td>${frameLink(f)}</td><td class="mono">${f.name}</td><td class="mono small">${f.netbus}</td></tr>`)}</tbody></table></div>` : ''}
      ${diff.changed.length ? html`<h4>Changed (${diff.changed.length})</h4><div class="tablewrap"><table class="tbl compact"><thead><tr><th>Frame</th><th>Bus</th><th>Frame fields</th><th>Signals</th></tr></thead><tbody>${diff.changed.map(({ frame: f, parent: p, diff: d }) => html`<tr class="st-changed"><td>${frameLink(f)} <span class="mono">${f.name}</span> <a class="small" href="${frameRoute(f)}?tab=compare">compare</a></td><td class="mono small">${f.netbus}</td>
        <td class="small">${d.fields.map((x) => x.field).join(', ')}</td>
        <td class="small">${d.signals.filter((s) => s.status !== 'same').map((s, i) => html`${i ? ', ' : ''}<span class="mono">${s.name}</span> <i>${s.status}${s.what && s.what.length ? ` (${s.what.join('/')})` : ''}</i>`)}</td></tr>`)}</tbody></table></div>` : ''}
    ` : ''}

    ${docs.length ? html`<h3>Bus notes</h3>${docs.map(([k, list]) => list.map((d) => html`<div class="card"><h4 class="mono">${k.split('/')[1]} / ${d.name}</h4><pre class="code" style="white-space:pre-wrap">${d.text}</pre></div>`))}` : ''}
    ${nets.includes('HS') || buses.some((b) => b.netbus === 'HS.IS') ? html`<div class="notice danger"><b>Safety:</b> the HS / IS bus carries safety critical traffic (engine, ABS/ESP, power steering, airbags). Do not transmit on it unless you know exactly what you are doing; wiring mistakes can damage ECUs.</div>` : ''}
  </div>`);
}

export function renderArchs(root, route) {
  const key = route.parts[1];
  if (key) renderVariant(root, key);
  else renderList(root);
}
