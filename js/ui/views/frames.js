// Frames view: sidebar filters + virtualized frame list + frame detail.

import { html, raw, $, $$, on, setHtml } from '../dom.js';
import { app } from '../state.js';
import { store } from '../../core/cache.js';
import { frameRoute } from '../../core/repo.js';
import { esc, naturalCompare } from '../../core/util.js';
import { VList } from '../vlist.js';
import { frameBadges, periodText, variantOptions, defaultVariant, t, emptyState, busLabel } from '../widgets.js';
import { renderFrameDetail } from './frame.js';

const DEFAULT_FILTERS = { archvar: '', buses: [], ecu: '', ecuMode: 'both', q: '', inSignals: false, types: [], timing: 'all', conflicts: false, warnings: false, source: '', sort: 'id', dir: 1 };
let filt = { ...DEFAULT_FILTERS, ...(store.get('frameFilters', {}) || {}) };
let vlist = null;
let mounted = null; // {root, db}
let listItems = [];

function saveFilters() { store.set('frameFilters', filt); }

function variantBusList(archvar) {
  const db = app.db;
  const frames = db.variantFrames.get(archvar) || [];
  const counts = new Map();
  for (const f of frames) counts.set(f.netbus, (counts.get(f.netbus) || 0) + 1);
  const buses = [...db.variantBuses(archvar).keys()];
  for (const b of counts.keys()) if (!buses.includes(b)) buses.push(b);
  return buses.sort(naturalCompare).map((b) => ({ netbus: b, count: counts.get(b) || 0 }));
}

export function filterFrames(frames) {
  const q = filt.q.trim().toLowerCase();
  const hexq = /^(?:0x)?([0-9a-f]{1,8})$/i.exec(q);
  const qid = hexq ? parseInt(hexq[1], 16) : null;
  const ecu = filt.ecu.trim().toUpperCase();
  const db = app.db;
  const inh = db.inherited.get(filt.archvar) || new Set();
  let out = frames.filter((f) => {
    if (filt.buses.length && !filt.buses.includes(f.netbus)) return false;
    if (filt.types.length && !filt.types.includes(f.type)) return false;
    if (filt.timing === 'periodic' && !f.periodMs) return false;
    if (filt.timing === 'event' && (f.periodMs || !f.trigger)) return false;
    if (filt.timing === 'request' && !f.request) return false;
    if (filt.conflicts && !f.hasAlternatives) return false;
    if (filt.warnings && !f.warnCount) return false;
    if (filt.source && !(f.sources || [f.source]).includes(filt.source)) return false;
    if (ecu) {
      const s = f.senders.some((n) => n.toUpperCase() === ecu);
      const r = f.receivers.some((n) => n.toUpperCase() === ecu);
      if (filt.ecuMode === 'sender' && !s) return false;
      if (filt.ecuMode === 'receiver' && !r) return false;
      if (filt.ecuMode === 'both' && !s && !r) return false;
    }
    if (q) {
      if (qid !== null && f.id === qid) return true;
      if (f.idHex.toLowerCase().includes(q.replace(/^0x/, '')) && hexq) return true;
      if (f.name.toLowerCase().includes(q)) return true;
      if (f.altNames.some((a) => a.toLowerCase().includes(q))) return true;
      if (filt.inSignals && f.signals.some((s) => s.name.toLowerCase().includes(q) || s.altNames.some((a) => a.toLowerCase().includes(q)) || (s.comment && t(s.comment).toLowerCase().includes(q)))) return true;
      if (filt.inSignals && f.comment && t(f.comment).toLowerCase().includes(q)) return true;
      return false;
    }
    return true;
  });
  const dir = filt.dir || 1;
  const cmp = {
    id: (a, b) => a.id - b.id || naturalCompare(a.netbus, b.netbus),
    name: (a, b) => naturalCompare(a.name, b.name),
    bus: (a, b) => naturalCompare(a.netbus, b.netbus) || a.id - b.id,
    len: (a, b) => a.length - b.length || a.id - b.id,
    period: (a, b) => (a.periodMs || 1e9) - (b.periodMs || 1e9) || a.id - b.id,
  }[filt.sort] || ((a, b) => a.id - b.id);
  out = out.sort((a, b) => dir * cmp(a, b));
  return out.map((f) => ({ f, inherited: inh.has(f.uid) }));
}

function rowHtml({ f, inherited }) {
  const selected = app.route && app.route.parts[1] === f.archvar && app.route.parts[2] === f.netbus && app.route.parts[3] === f.fileBase;
  const snd = f.senders.join(', ') || '?';
  const rcv = f.receivers.length > 3 ? `${f.receivers.slice(0, 3).join(', ')} +${f.receivers.length - 3}` : f.receivers.join(', ');
  return `<a class="frow${selected ? ' selected' : ''}${inherited ? ' inherited' : ''}" href="${esc(frameRoute(f))}${inherited ? `?via=${encodeURIComponent(filt.archvar)}` : ''}" data-key="${esc(f.key)}">
    <span class="c-id mono">${esc(f.idHex)}</span>
    <span class="c-name" title="${esc(f.name)}${f.comment ? ' — ' + esc(t(f.comment)) : ''}">${esc(f.name)}</span>
    <span class="c-bus">${esc(f.netbus)}</span>
    <span class="c-len num">${f.length}</span>
    <span class="c-per">${esc(periodText(f))}</span>
    <span class="c-nodes" title="${esc(f.senders.join(', '))} → ${esc(f.receivers.join(', '))}">${esc(snd)} → ${esc(rcv)}</span>
    <span class="c-badges">${frameBadges(f, { inherited, compact: true })}</span>
  </a>`;
}

function sidebarHtml() {
  const db = app.db;
  const buses = variantBusList(filt.archvar);
  const frames = db.variantFrames.get(filt.archvar) || [];
  const types = [...new Set(frames.map((f) => f.type))].sort();
  const nodes = db.variantNodes.get(filt.archvar) || new Map();
  const usage = db.nodeUsage.get(filt.archvar) || new Map();
  const nodeNames = [...nodes.keys()].filter((n) => usage.has(n)).sort(naturalCompare);
  const v = db.variants.get(filt.archvar);
  return html`<div class="filters">
    <label class="lbl-block">Architecture</label>
    <select id="f-arch">${variantOptions(filt.archvar)}</select>
    ${v ? html`<div class="small muted">${t(v.comment)}${v.years ? ` · ${v.years}` : ''}${v.parent ? html` · parent <a href="#/frames/${v.arch}.${v.parent}">${v.parent}</a>` : ''}</div>` : ''}
    <label class="lbl-block">Search</label>
    <input id="f-q" type="search" placeholder="ID (036, 0x036) or name" value="${filt.q}" autocomplete="off" spellcheck="false">
    <label class="chk small"><input type="checkbox" id="f-insig" ${filt.inSignals ? 'checked' : ''}> also search signals &amp; comments</label>
    <div class="fgroup"><div class="fgroup-h"><span>Buses</span>${filt.buses.length ? html`<a href="#" data-act="bus-all" class="small">all</a>` : ''}</div>
      ${buses.length ? buses.map((b) => html`<label class="chk${b.count ? '' : ' muted'}" title="${busLabel(filt.archvar, b.netbus)}"><input type="checkbox" data-bus="${b.netbus}" ${filt.buses.includes(b.netbus) ? 'checked' : ''}> ${b.netbus} <span class="count">${b.count}</span></label>`) : html`<span class="muted small">no bus</span>`}
    </div>
    <div class="fgroup"><div class="fgroup-h"><span>ECU</span></div>
      <input id="f-ecu" list="f-ecu-list" placeholder="eg. BSI" value="${filt.ecu}" autocomplete="off">
      <datalist id="f-ecu-list">${nodeNames.map((n) => html`<option value="${n}">${t((nodes.get(n) || {}).title)}</option>`)}</datalist>
      <div class="seg-ctl">${['both', 'sender', 'receiver'].map((m) => html`<label><input type="radio" name="ecumode" value="${m}" ${filt.ecuMode === m ? 'checked' : ''}> ${m}</label>`)}</div>
    </div>
    <div class="fgroup"><div class="fgroup-h"><span>Type</span></div>
      ${types.map((ty) => html`<label class="chk"><input type="checkbox" data-type="${ty}" ${filt.types.includes(ty) ? 'checked' : ''}> ${ty}</label>`)}
    </div>
    <div class="fgroup"><div class="fgroup-h"><span>Timing</span></div>
      <select id="f-timing">${[['all', 'all'], ['periodic', 'periodic'], ['event', 'event only'], ['request', 'on request']].map(([k, l]) => html`<option value="${k}" ${filt.timing === k ? 'selected' : ''}>${l}</option>`)}</select>
    </div>
    <div class="fgroup"><div class="fgroup-h"><span>Data</span></div>
      <label class="chk"><input type="checkbox" id="f-conf" ${filt.conflicts ? 'checked' : ''}> has alternatives (conflicts)</label>
      <label class="chk"><input type="checkbox" id="f-warn" ${filt.warnings ? 'checked' : ''}> has data warnings</label>
      ${db.sources.length > 1 ? html`<select id="f-src"><option value="">all sources</option>${db.sources.map((s) => html`<option value="${s.id}" ${filt.source === s.id ? 'selected' : ''}>${s.label}</option>`)}</select>` : ''}
    </div>
    <button class="btn btn-sm" data-act="reset-filters">Reset filters</button>
  </div>`;
}

function listHeader(count, total) {
  const col = (k, label, cls) => html`<span class="${cls} sortable${filt.sort === k ? ' sorted' : ''}" data-sort="${k}">${label}${filt.sort === k ? (filt.dir > 0 ? ' ▲' : ' ▼') : ''}</span>`;
  return html`<div class="flist-top"><span><b>${count}</b> <span class="muted">/ ${total} frames</span></span><span class="spacer"></span>
    <a class="btn btn-sm" href="#/tools/export?arch=${encodeURIComponent(filt.archvar)}" title="DBC / JSON export of this architecture">Export…</a></div>
    <div class="frow fhead">${col('id', 'ID', 'c-id')}${col('name', 'Name', 'c-name')}${col('bus', 'Bus', 'c-bus')}${col('len', 'Len', 'c-len')}${col('period', 'Period', 'c-per')}<span class="c-nodes">Senders → receivers</span><span class="c-badges"></span></div>`;
}

function refreshList(root) {
  const db = app.db;
  const frames = db.variantFrames.get(filt.archvar) || [];
  listItems = filterFrames(frames);
  setHtml($('#flist-head', root), listHeader(listItems.length, frames.length));
  if (!frames.length) {
    const v = db.variants.get(filt.archvar);
    setHtml($('#flist-body', root), emptyState('No frame documented', v && (v.todo || v.status === 'todo') ? 'This architecture variant is still to be documented.' : 'No frame file in buses/ for this architecture variant yet.'));
    vlist = null;
    return;
  }
  if (!vlist || !root.contains(vlist.el)) {
    const body = $('#flist-body', root);
    body.innerHTML = '';
    vlist = new VList(body, { rowHeight: 34, renderRow: (it) => rowHtml(it) });
  }
  vlist.setItems(listItems);
  if (!listItems.length) setHtml($('.vlist-inner', root), html`<div class="empty small">No frame matches the filters.</div>`);
}

function selectedIndex() {
  const r = app.route;
  if (!r || r.parts.length < 4) return -1;
  const key = `${r.parts[1]}/${r.parts[2]}/${r.parts[3]}`;
  return listItems.findIndex((it) => it.f.key === key);
}

function bindSidebar(root) {
  const side = $('#fsidebar', root);
  const upd = () => { saveFilters(); refreshList(root); };
  on(side, 'change', '#f-arch', (ev, el) => { filt.archvar = el.value; filt.buses = []; saveFilters(); location.hash = `#/frames/${el.value}`; });
  on(side, 'input', '#f-q', (ev, el) => { filt.q = el.value; upd(); });
  on(side, 'change', '#f-insig', (ev, el) => { filt.inSignals = el.checked; upd(); });
  on(side, 'change', '[data-bus]', (ev, el) => {
    const b = el.dataset.bus;
    filt.buses = el.checked ? [...new Set([...filt.buses, b])] : filt.buses.filter((x) => x !== b);
    upd();
    const a = $('[data-act=bus-all]', side);
    if (!a && filt.buses.length) setHtml(side, sidebarHtml());
  });
  on(side, 'change', '[data-type]', (ev, el) => {
    const ty = el.dataset.type;
    filt.types = el.checked ? [...new Set([...filt.types, ty])] : filt.types.filter((x) => x !== ty);
    upd();
  });
  on(side, 'input', '#f-ecu', (ev, el) => { filt.ecu = el.value; upd(); });
  on(side, 'change', 'input[name=ecumode]', (ev, el) => { filt.ecuMode = el.value; upd(); });
  on(side, 'change', '#f-timing', (ev, el) => { filt.timing = el.value; upd(); });
  on(side, 'change', '#f-conf', (ev, el) => { filt.conflicts = el.checked; upd(); });
  on(side, 'change', '#f-warn', (ev, el) => { filt.warnings = el.checked; upd(); });
  on(side, 'change', '#f-src', (ev, el) => { filt.source = el.value; upd(); });
  on(side, 'click', '[data-act=bus-all]', (ev) => { ev.preventDefault(); filt.buses = []; saveFilters(); setHtml(side, sidebarHtml()); refreshList(root); });
  on(side, 'click', '[data-act=reset-filters]', () => { const a = filt.archvar; filt = { ...DEFAULT_FILTERS, archvar: a }; saveFilters(); setHtml(side, sidebarHtml()); refreshList(root); });
  on($('#flist-head', root), 'click', '[data-sort]', (ev, el) => {
    const k = el.dataset.sort;
    if (filt.sort === k) filt.dir = -(filt.dir || 1); else { filt.sort = k; filt.dir = 1; }
    upd();
  });
}

/** Router entry: #/frames[/ARCHVAR[/NETBUS/FILE]]?query */
export function renderFrames(root, route) {
  const db = app.db;
  const [, archvar, netbus, file] = route.parts;
  let needFull = !mounted || mounted.db !== db || mounted.root !== root || !root.querySelector('.frames-layout');
  const via = route.query.via && db.variants.has(route.query.via) ? route.query.via : null;
  if (via && via !== filt.archvar) { filt.archvar = via; filt.buses = []; needFull = true; }
  if (!via && archvar && db.variants.has(archvar) && archvar !== filt.archvar) {
    // keep the current variant when the frame is part of its effective set (inherited from a parent)
    const key = netbus && file ? `${archvar}/${netbus}/${file}` : null;
    const eff = db.variantFrames.get(filt.archvar) || [];
    if (!(key && eff.some((f) => f.key === key))) { filt.archvar = archvar; filt.buses = []; needFull = true; }
  }
  if (!filt.archvar || !db.variants.has(filt.archvar) || (!archvar && !via && !(db.variantFrames.get(filt.archvar) || []).length)) {
    // remembered variant unknown (or empty) in the loaded data: use a sensible default
    filt.archvar = defaultVariant(); filt.buses = []; needFull = true;
  }
  if (route.query.bus) { filt.buses = [route.query.bus]; needFull = true; }
  if (route.query.ecu) { filt.ecu = route.query.ecu; filt.ecuMode = route.query.mode || 'both'; needFull = true; }
  if (route.query.q !== undefined && route.query.q !== filt.q) { filt.q = route.query.q; needFull = true; }
  saveFilters();
  const hasDetail = !!(archvar && netbus && file);
  if (needFull) {
    if (vlist) { vlist.destroy(); vlist = null; }
    setHtml(root, html`<div class="frames-layout${hasDetail ? ' has-detail' : ''}">
      <aside class="sidebar" id="fsidebar">${sidebarHtml()}</aside>
      <section class="flist"><div id="flist-head"></div><div class="flist-body" id="flist-body"></div></section>
      <section class="fdetail" id="fdetail"></section>
    </div>`);
    mounted = { root, db };
    bindSidebar(root);
    refreshList(root);
  } else {
    root.querySelector('.frames-layout').classList.toggle('has-detail', hasDetail);
    if (vlist) vlist.paint(true);
  }
  const det = $('#fdetail', root);
  if (hasDetail) {
    const key = `${archvar}/${netbus}/${file}`;
    const versions = db.framesByKey.get(key);
    if (!versions) {
      setHtml(det, emptyState('Frame not found', `No frame ${key} in the loaded sources.`));
    } else {
      renderFrameDetail(det, versions, route);
      const i = selectedIndex();
      if (vlist && i >= 0) vlist.scrollToIndex(i);
    }
  } else {
    setHtml(det, html`<div class="fdetail-placeholder">
      <h3>Select a frame</h3>
      <p class="muted">Pick a frame in the list to see its bit layout, decode or encode payloads and generate code.</p>
      <p class="muted small">Tip: press <kbd>/</kbd> to search anything (frame ID, name, signal, ECU, car code).</p>
    </div>`);
  }
}
