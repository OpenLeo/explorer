// Signals view: exact-name cross-reference across effective architecture variants and frame IDs.

import { html, $, on, setHtml } from '../dom.js';
import { app } from '../state.js';
import { t, physText, sourceBadge, typeBadge, periodText, emptyState } from '../widgets.js';
import { frameRoute } from '../../core/repo.js';
import { buildSignalCatalog } from '../../core/signalref.js';
import { esc, hex, naturalCompare, debounce } from '../../core/util.js';
import { VList } from '../vlist.js';

let catalogDb = null;
let catalog = [];
let shown = [];
let vlist = null;
let mounted = null;
let query = '';
let sharedOnly = true;

function groups() {
  if (catalogDb !== app.db) {
    catalogDb = app.db;
    catalog = buildSignalCatalog(app.db);
  }
  return catalog;
}

function matches(g, q) {
  if (!q) return true;
  if (g.name.toLowerCase().includes(q) || g.aliases.some((a) => a.toLowerCase().includes(q))) return true;
  return g.occurrences.some(({ archvar, frame }) => archvar.toLowerCase().includes(q)
    || frame.name.toLowerCase().includes(q) || frame.idHex.toLowerCase().includes(q)
    || `0x${frame.idHex}`.toLowerCase().includes(q) || frame.netbus.toLowerCase().includes(q));
}

function rowHtml(g, selected) {
  return `<a class="sigref-row${g.name === selected ? ' selected' : ''}" href="#/signals/${encodeURIComponent(g.name)}">
    <span class="sigref-name mono" title="${esc(g.name)}">${esc(g.name)}</span>
    <span class="sigref-count" title="architectures">${g.architectures.length} arch</span>
    <span class="sigref-count" title="frame occurrences">${g.occurrences.length} frame${g.occurrences.length === 1 ? '' : 's'}</span>
  </a>`;
}

function refreshList(root, selected) {
  const q = query.trim().toLowerCase();
  shown = groups().filter((g) => (!sharedOnly || g.architectures.length > 1) && matches(g, q));
  setHtml($('#sigref-count', root), html`<b>${shown.length}</b> <span class="muted">/ ${catalog.length} signal names</span>`);
  const body = $('#sigref-list-body', root);
  if (!vlist || !body.contains(vlist.el)) {
    if (vlist) vlist.destroy();
    vlist = new VList(body, { rowHeight: 36, renderRow: (g) => rowHtml(g, selected) });
  } else {
    vlist.renderRow = (g) => rowHtml(g, selected);
  }
  vlist.setItems(shown);
  if (!shown.length) setHtml($('.vlist-inner', root), html`<div class="empty small">No signal matches the filters.</div>`);
}

function frameHref(o) {
  const q = new URLSearchParams({ tab: 'signals', sig: o.signal.name });
  if (o.inherited) q.set('via', o.archvar);
  return `${frameRoute(o.frame)}?${q}`;
}

function encodingText(s) {
  const parts = [s.type];
  const p = physText(s);
  if (p) parts.push(p);
  if (s.littleEndian) parts.push('little endian');
  if (s.muxSelector) parts.push('mux selector');
  if (s.mux) parts.push(`when ${s.mux.selector} = ${s.mux.values.join(' / ')}`);
  return parts.join(' · ');
}

function renderDetail(root, g) {
  if (!g) {
    setHtml(root, html`<div class="sigref-placeholder"><h3>Select a signal</h3>
      <p>Choose a signal name to see every architecture and frame in which it is available, even when the frame ID changes.</p>
      <p class="muted small">Signals are grouped by exact normalized name. Search also accepts aliases, architecture names, frame IDs, frame names and buses.</p></div>`);
    return;
  }
  const byArch = new Map();
  for (const o of g.occurrences) {
    if (!byArch.has(o.archvar)) byArch.set(o.archvar, []);
    byArch.get(o.archvar).push(o);
  }
  const ids = g.frameIds.map((id) => `0x${hex(id, id > 0xFFF ? 8 : 3)}`);
  const cards = [...byArch.entries()].sort(([a], [b]) => naturalCompare(a, b)).map(([archvar, occurrences]) => html`<section class="sigref-arch card">
    <h3><a href="#/arch/${archvar}" class="mono">${archvar}</a> <span class="count">${occurrences.length}</span></h3>
    <div class="tablewrap"><table class="tbl compact"><thead><tr><th>Frame</th><th>Bus</th><th>Bits</th><th>Definition</th><th>Timing</th></tr></thead>
      <tbody>${occurrences.map((o) => html`<tr>
        <td><a href="${frameHref(o)}"><code>0x${o.frame.idHex}</code> <span class="mono">${o.frame.name}</span></a>
          ${o.inherited ? html` <span class="badge badge-inh" title="Inherited from ${o.frame.archvar}">↑ ${o.frame.archvar}</span>` : ''}${sourceBadge(o.frame.source)}
          ${o.signal.comment ? html`<div class="small muted">${t(o.signal.comment)}</div>` : ''}</td>
        <td><a href="#/frames/${archvar}?bus=${encodeURIComponent(o.frame.netbus)}" class="mono small">${o.frame.netbus}</a> ${typeBadge(o.frame.type)}</td>
        <td><a href="${frameHref(o)}" class="mono">${o.signal.bits || '?'}</a></td>
        <td class="small">${encodingText(o.signal)}</td>
        <td class="small">${periodText(o.frame)}</td>
      </tr>`)}</tbody></table></div>
  </section>`);
  setHtml(root, html`<div class="sigref-detail-inner">
    <div class="sigref-title">
      <div><h2 class="mono">${g.name}</h2>${g.aliases.length ? html`<div class="muted small">aka ${g.aliases.join(', ')}</div>` : ''}</div>
      <a class="btn btn-sm sigref-close" href="#/signals" title="Back to signal list">✕</a>
    </div>
    <div class="badges"><span class="badge badge-ok">${g.architectures.length} architecture${g.architectures.length === 1 ? '' : 's'}</span>
      <span class="badge">${g.occurrences.length} frame occurrence${g.occurrences.length === 1 ? '' : 's'}</span>
      ${ids.map((id) => html`<span class="badge mono">${id}</span>`)}</div>
    <p class="muted">Every effective frame containing the exact signal name <code>${g.name}</code>. Different IDs are expected across architecture generations; compare the bits and definition columns before treating encodings as interchangeable.</p>
    <div class="sigref-arch-grid">${cards}</div>
  </div>`);
}

function bind(root) {
  if (root._unbind) root._unbind();
  const offs = [];
  const update = debounce(() => refreshList(root, app.route && app.route.parts[1]), 80);
  offs.push(on(root, 'input', '#sigref-q', (ev, el) => { query = el.value; update(); }));
  offs.push(on(root, 'change', '#sigref-shared', (ev, el) => { sharedOnly = el.checked; refreshList(root, app.route && app.route.parts[1]); }));
  root._unbind = () => offs.forEach((o) => o());
}

export function renderSignals(root, route) {
  const selected = route.parts[1] || '';
  const list = groups();
  const group = selected ? list.find((g) => g.name === selected) : null;
  const needFull = !mounted || mounted.root !== root || mounted.db !== app.db || !root.querySelector('.sigref-layout');
  if (needFull) {
    if (vlist) { vlist.destroy(); vlist = null; }
    setHtml(root, html`<div class="sigref-layout${selected ? ' has-detail' : ''}">
      <section class="sigref-list">
        <div class="sigref-list-head"><div><h2>Signals</h2><div id="sigref-count"></div></div>
          <p class="muted small">Cross-reference signal names across architectures and frame IDs.</p>
          <input id="sigref-q" type="search" value="${query}" placeholder="Signal, alias, architecture, frame ID or bus" autocomplete="off" spellcheck="false">
          <label class="chk small"><input id="sigref-shared" type="checkbox" ${sharedOnly ? 'checked' : ''}> present in 2+ architectures</label>
        </div>
        <div class="sigref-cols"><span>Signal</span><span>Architectures</span><span>Occurrences</span></div>
        <div class="sigref-list-body" id="sigref-list-body"></div>
      </section>
      <section class="sigref-detail" id="sigref-detail"></section>
    </div>`);
    mounted = { root, db: app.db };
    bind(root);
  } else {
    root.querySelector('.sigref-layout').classList.toggle('has-detail', !!selected);
  }
  refreshList(root, selected);
  renderDetail($('#sigref-detail', root), group || (selected ? null : undefined));
  if (selected && !group) setHtml($('#sigref-detail', root), emptyState('Signal not found', `No signal named ${selected} exists in the loaded sources.`));
  const i = shown.findIndex((g) => g.name === selected);
  if (i >= 0 && vlist) vlist.scrollToIndex(i);
}

