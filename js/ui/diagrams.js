// SVG diagrams: architecture topology and frame emitters/receivers.

import { html } from './dom.js';
import { fmtNum } from '../core/util.js';
import { t } from './widgets.js';

const BW = 92;   // node box width
const BH = 30;   // node box height
const GAP = 14;  // horizontal gap
const VG = 12;   // vertical gap

function nodeBox(x, y, n, archvar, extraCls = '') {
  const cls = `nbox${n.phantom ? ' phantom' : ''}${n.released === false ? ' unreleased' : ''}${extraCls}`;
  const label = n.name.length > 11 ? n.name.slice(0, 10) + '…' : n.name;
  return html`<a href="#/ecus/${archvar}/${encodeURIComponent(n.name)}" class="svglink"><g class="${cls}">
    <title>${n.name}${n.title ? ' — ' + t(n.title) : ''}${n.phantom ? ' (not defined in nodes/)' : ''}${n.released === false ? ' (never released)' : ''}</title>
    <rect x="${x}" y="${y}" width="${BW}" height="${BH}" rx="5"></rect>
    <text x="${x + BW / 2}" y="${y + BH / 2 + 4}" text-anchor="middle">${label}</text></g></a>`;
}

/**
 * Topology of an architecture variant.
 * buses: [{netbus, protocol, bitrate, displayName}], nodes: [{name, buses:[netbus], phantom, released, title}]
 */
export function topologySvg(archvar, buses, nodes) {
  const busKeys = buses.map((b) => b.netbus);
  const nodesOn = nodes.filter((n) => !n.pseudo).map((n) => ({ ...n, on: n.buses.filter((b) => busKeys.includes(b)) })).filter((n) => n.on.length);
  const gateways = nodesOn.filter((n) => n.on.length > 1);
  const singles = nodesOn.filter((n) => n.on.length === 1);
  const G = gateways.length;
  const colW = BW + 18;
  const labelW = 170;
  const x0 = 16 + G * colW + labelW; // first node slot
  const slot = BW + GAP;
  const perBus = new Map(busKeys.map((b) => [b, singles.filter((n) => n.on[0] === b)]));
  const maxN = Math.max(1, ...[...perBus.values()].map((l) => l.length));
  const perRow = Math.max(4, Math.min(14, Math.ceil(maxN / 4)));
  const topH = G ? BH + 30 : 10;
  let y = topH;
  const parts = [];
  const busY = new Map();
  const bands = [];
  for (const b of buses) {
    const list = perBus.get(b.netbus) || [];
    // rows: 0 above, 1 below, 2 above (outer, half-slot offset), 3 below (outer)
    const rows = [[], [], [], []];
    list.forEach((n, i) => { const r = Math.floor(i / perRow); rows[Math.min(3, r)].push(n); });
    // overflow (more than 4 rows): put the rest on the outer rows
    const aboveRows = rows[2].length ? 2 : rows[0].length ? 1 : 0;
    const belowRows = rows[3].length ? 2 : rows[1].length ? 1 : 0;
    const top = y;
    const lineY = top + Math.max(aboveRows, 0.6) * (BH + VG) + 22;
    const bottom = lineY + belowRows * (BH + VG) + 26;
    busY.set(b.netbus, lineY);
    bands.push({ b, rows, top, lineY, bottom });
    y = bottom;
  }
  const maxRowLen = Math.max(0, ...bands.flatMap((bd) => bd.rows.map((r) => r.length)));
  const width = Math.max(x0 + maxRowLen * slot + slot / 2 + 20, 600);
  const height = y + 10;
  for (const bd of bands) {
    const { b, rows, lineY } = bd;
    const proto = (b.protocol || '').toLowerCase();
    parts.push(html`<line class="busline proto-${proto}" x1="${16}" y1="${lineY}" x2="${width - 10}" y2="${lineY}"></line>`);
    const lx = 16 + G * colW + 6;
    parts.push(html`<a href="#/frames/${archvar}?bus=${encodeURIComponent(b.netbus)}" class="svglink"><text class="buslabel" x="${lx}" y="${lineY - 20}">${b.netbus}</text></a>`);
    parts.push(html`<text class="bussub" x="${lx}" y="${lineY - 6}">${b.protocol || '?'}${b.bitrate ? ` ${fmtNum(b.bitrate)} kbit/s` : ''}${b.displayName ? ' · ' + t(b.displayName) : ''}</text>`);
    rows.forEach((row, r) => {
      const above = r % 2 === 0;
      const outer = r >= 2;
      row.forEach((n, i) => {
        const x = x0 + i * slot + (outer ? slot / 2 : 0);
        const yy = above ? lineY - 14 - BH - (outer ? BH + VG : 0) : lineY + 14 + (outer ? BH + VG : 0);
        const cx = x + BW / 2;
        parts.push(html`<line class="stub" x1="${cx}" y1="${above ? yy + BH : yy}" x2="${cx}" y2="${lineY}"></line><circle class="dot" cx="${cx}" cy="${lineY}" r="3"></circle>`);
        parts.push(nodeBox(x, yy, n, archvar));
      });
    });
  }
  gateways.forEach((n, i) => {
    const x = 16 + i * colW;
    const cx = x + BW / 2;
    const ys = n.on.map((b) => busY.get(b));
    const maxY = Math.max(...ys);
    parts.push(html`<line class="stub gw" x1="${cx}" y1="${10 + BH}" x2="${cx}" y2="${maxY}"></line>`);
    for (const yy of ys) parts.push(html`<circle class="dot gw" cx="${cx}" cy="${yy}" r="4.5"></circle>`);
    parts.push(nodeBox(x, 10, n, archvar, ' gateway'));
  });
  if (!nodesOn.length) parts.push(html`<text class="bussub" x="${x0}" y="${height / 2}">No node known on these buses</text>`);
  return html`<div class="svgwrap"><svg class="topology" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Topology of ${archvar}">${parts}</svg></div>`;
}

/** Senders -> frame -> receivers diagram. */
export function flowSvg(frame, nodesMap) {
  const snd = frame.senders.length ? frame.senders : ['?'];
  const rcv = frame.receivers.length ? frame.receivers : ['?'];
  const rcvCols = rcv.length > 14 ? 3 : rcv.length > 7 ? 2 : 1;
  const rcvRows = Math.ceil(rcv.length / rcvCols);
  const rowH = BH + 10;
  const h = Math.max(snd.length, rcvRows, 2) * rowH + 30;
  const fx = 20 + BW + 90;
  const fw = 170;
  const rx0 = fx + fw + 90;
  const w = rx0 + rcvCols * (BW + 14) + 10;
  const fy = h / 2 - 32;
  const parts = [];
  const node = (name) => (nodesMap && nodesMap.get(name)) || { name, phantom: name !== '?' };
  snd.forEach((s, i) => {
    const y = (h - snd.length * rowH) / 2 + i * rowH + 5;
    parts.push(html`<path class="arrow" d="M ${20 + BW} ${y + BH / 2} C ${fx - 40} ${y + BH / 2}, ${fx - 50} ${h / 2}, ${fx} ${h / 2}" marker-end="url(#ah)"></path>`);
    parts.push(s === '?' ? html`<g class="nbox phantom"><rect x="20" y="${y}" width="${BW}" height="${BH}" rx="5"></rect><text x="${20 + BW / 2}" y="${y + BH / 2 + 4}" text-anchor="middle">unknown</text></g>` : nodeBox(20, y, node(s), frame.archvar, ' sender'));
  });
  rcv.forEach((r, i) => {
    const col = Math.floor(i / rcvRows);
    const row = i % rcvRows;
    const x = rx0 + col * (BW + 14);
    const y = (h - rcvRows * rowH) / 2 + row * rowH + 5;
    if (col === 0) parts.push(html`<path class="arrow" d="M ${fx + fw} ${h / 2} C ${rx0 - 50} ${h / 2}, ${rx0 - 40} ${y + BH / 2}, ${rx0} ${y + BH / 2}" marker-end="url(#ah)"></path>`);
    else parts.push(html`<path class="arrow faint" d="M ${fx + fw} ${h / 2} C ${rx0 - 50} ${h / 2}, ${x - 30} ${y - 6}, ${x} ${y + BH / 2}" marker-end="url(#ah)"></path>`);
    parts.push(r === '?' ? html`<g class="nbox phantom"><rect x="${x}" y="${y}" width="${BW}" height="${BH}" rx="5"></rect><text x="${x + BW / 2}" y="${y + BH / 2 + 4}" text-anchor="middle">unknown</text></g>` : nodeBox(x, y, node(r), frame.archvar, ' receiver'));
  });
  parts.push(html`<g class="fbox"><rect x="${fx}" y="${fy}" width="${fw}" height="64" rx="8"></rect>
    <text x="${fx + fw / 2}" y="${fy + 22}" text-anchor="middle" class="fid">0x${frame.idHex}</text>
    <text x="${fx + fw / 2}" y="${fy + 39}" text-anchor="middle" class="fname">${frame.name.length > 22 ? frame.name.slice(0, 21) + '…' : frame.name}</text>
    <text x="${fx + fw / 2}" y="${fy + 55}" text-anchor="middle" class="fsub">${frame.netbus} · ${frame.length} B${frame.periodMs ? ` · ${frame.periodMs} ms` : ''}${frame.trigger ? ' · event' : ''}</text></g>`);
  return html`<div class="svgwrap"><svg class="flow" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Senders and receivers of ${frame.name}">
    <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="ahead"></path></marker></defs>
    ${parts}</svg></div>`;
}
