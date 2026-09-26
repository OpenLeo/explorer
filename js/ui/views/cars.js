// Cars view: searchable table of car projects, car page with versions, ECUs and expected frames.

import { html, $, on, setHtml } from '../dom.js';
import { app } from '../state.js';
import { store } from '../../core/cache.js';
import { t, emptyState, nodeLink, frameLink, periodText, sourceBadge, busLabel } from '../widgets.js';
import { framesForCarVersion } from '../../core/repo.js';
import { naturalCompare } from '../../core/util.js';

let filt = { q: '', brand: '', arch: '', ...(store.get('carFilters', {}) || {}) };

function carArchs(car) { return [...new Set(car.versions.map((v) => v.architecture))]; }

function archLink(a) {
  if (!a || a === 'none') return html`<span class="muted" title="not multiplexed">none</span>`;
  if (app.db.variants.has(a)) return html`<a href="#/arch/${a}" class="mono">${a}</a>`;
  return html`<span class="mono muted" title="not defined in architectures.yml">${a}</span>`;
}

function matches(car) {
  const q = filt.q.trim().toLowerCase();
  if (filt.brand && !car.brands.includes(filt.brand)) return false;
  if (filt.arch && !carArchs(car).some((a) => a === filt.arch || a.split('.')[0] === filt.arch)) return false;
  if (!q) return true;
  const hay = `${car.project} ${car.codes.map((c) => `${c.code} ${c.names.join(' ')}`).join(' ')} ${car.names.join(' ')} ${car.platform || ''} ${car.years || ''} ${carArchs(car).join(' ')}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function tableRows() {
  const cars = app.db.cars.filter(matches);
  return html`<p class="muted small">${cars.length} / ${app.db.cars.length} projects</p>
    <div class="tablewrap"><table class="tbl">
    <thead><tr><th>Project</th><th>Codes</th><th>Commercial names</th><th>Brand</th><th>Years</th><th>Architecture</th></tr></thead>
    <tbody>${cars.map((c) => html`<tr>
      <td><a href="#/cars/${encodeURIComponent(c.project)}" class="mono"><b>${c.project}</b></a> ${sourceBadge(c.source)}</td>
      <td class="mono small">${c.codes.map((x) => x.code).join(', ')}</td>
      <td>${[...new Set(c.codes.flatMap((x) => x.names).concat(c.names))].join(', ')}</td>
      <td>${c.brands.join(', ')}</td>
      <td>${c.years || [...new Set(c.versions.map((v) => v.years).filter(Boolean))].join(', ')}</td>
      <td>${carArchs(c).map((a, i) => html`${i ? ', ' : ''}${archLink(a)}`)}</td>
    </tr>`)}</tbody></table></div>`;
}

function renderList(root) {
  const db = app.db;
  const brands = [...new Set(db.cars.flatMap((c) => c.brands))].sort();
  const archs = [...new Set(db.cars.flatMap(carArchs))].sort(naturalCompare);
  setHtml(root, html`<div class="page">
    <h2>Cars</h2>
    <p class="muted">PSA project codes (eg. A7 = Peugeot 207, T1 = 206) with their silhouettes codes, commercial names and electronic architecture.</p>
    <div class="filterbar">
      <input type="search" id="car-q" placeholder="Search a code, a name (207, C4, A70…)" value="${filt.q}">
      <select id="car-brand"><option value="">all brands</option>${brands.map((b) => html`<option value="${b}" ${filt.brand === b ? 'selected' : ''}>${b}</option>`)}</select>
      <select id="car-arch"><option value="">all architectures</option>${archs.map((a) => html`<option value="${a}" ${filt.arch === a ? 'selected' : ''}>${a}</option>`)}</select>
    </div>
    <div id="car-table">${tableRows()}</div>
  </div>`);
  if (root._unbind) root._unbind();
  const upd = () => { store.set('carFilters', filt); setHtml($('#car-table', root), tableRows()); };
  const offs = [
    on(root, 'input', '#car-q', (ev, el) => { filt.q = el.value; upd(); }),
    on(root, 'change', '#car-brand', (ev, el) => { filt.brand = el.value; upd(); }),
    on(root, 'change', '#car-arch', (ev, el) => { filt.arch = el.value; upd(); }),
  ];
  root._unbind = () => offs.forEach((o) => o());
}

function renderCar(root, project) {
  const db = app.db;
  const car = db.cars.find((c) => c.project === project);
  if (root._unbind) { root._unbind(); root._unbind = null; }
  if (!car) { setHtml(root, html`<div class="page"><p><a href="#/cars">← Cars</a></p>${emptyState('Unknown car project', project)}</div>`); return; }
  const versions = car.versions.map((v) => {
    const archOk = db.variants.has(v.architecture);
    const nodesByNet = Object.entries(v.nodes);
    const { frames, filtered } = archOk ? framesForCarVersion(db, v) : { frames: [], filtered: false };
    const byBus = new Map();
    for (const f of frames) { if (!byBus.has(f.netbus)) byBus.set(f.netbus, []); byBus.get(f.netbus).push(f); }
    return html`<div class="card">
      <h3>Version <span class="mono">${v.name}</span> — ${archLink(v.architecture)} ${v.years ? html`<span class="muted">${v.years}</span>` : ''}</h3>
      ${v.codes.length ? html`<p class="small">Applies to: <span class="mono">${v.codes.join(', ')}</span></p>` : ''}
      ${v.comment ? html`<p>${t(v.comment)}</p>` : ''}
      ${v.architecture === 'none' ? html`<p class="muted">Not multiplexed: this car has no CAN/VAN multiplexed network (wired electrics, maybe a K-line diagnostic link only).</p>` : ''}
      ${v.architecture !== 'none' && !archOk ? html`<p class="muted">Architecture <span class="mono">${v.architecture}</span> is not documented (partner platform or not defined in architectures.yml).</p>` : ''}
      ${nodesByNet.length ? html`<h4>ECUs per network</h4><div class="tablewrap"><table class="tbl compact"><tbody>${nodesByNet.map(([net, list]) => html`<tr><td class="mono"><b>${net}</b></td><td>${list.map((n, i) => html`${i ? ', ' : ''}${archOk ? nodeLink(v.architecture, n) : n}${v.optional.includes(n) ? html`<sup title="optional: depends on trim/options">opt</sup>` : ''}`)}</td></tr>`)}</tbody></table></div>
        ${v.optional.length ? html`<p class="small muted"><sup>opt</sup> = optional ECU (depends on trim / options).</p>` : ''}` : archOk ? html`<p class="muted">The ECU list of this car is not documented yet${archOk ? ': all frames of the architecture are listed below.' : '.'}</p>` : ''}
      ${archOk ? html`<h4>Frames you should see on this car ${html`<span class="count">${frames.length}</span>`}</h4>
        <p class="small muted">${filtered ? 'Frames of the architecture whose sender is fitted on this car (optional ECUs included).' : 'All frames of the architecture (the fitted ECUs are unknown).'}</p>
        ${[...byBus.entries()].sort((a, b) => naturalCompare(a[0], b[0])).map(([bus, list]) => html`<details ${byBus.size <= 2 ? 'open' : ''}><summary><b class="mono">${busLabel(v.architecture, bus)}</b> <span class="count">${list.length}</span></summary>
          <div class="tablewrap"><table class="tbl compact"><thead><tr><th>ID</th><th>Name</th><th>Len</th><th>Period</th><th>Senders</th></tr></thead><tbody>${list.map((f) => html`<tr><td>${frameLink(f)}</td><td class="mono">${f.name}</td><td class="num">${f.length}</td><td class="small">${periodText(f)}</td><td class="small">${f.senders.join(', ')}</td></tr>`)}</tbody></table></div></details>`)}` : ''}
    </div>`;
  });
  setHtml(root, html`<div class="page">
    <p><a href="#/cars">← Cars</a></p>
    <h2>${car.project} ${sourceBadge(car.source)}</h2>
    <div class="tablewrap"><table class="tbl compact"><thead><tr><th>Code</th><th>Commercial name(s)</th></tr></thead><tbody>${car.codes.map((c) => html`<tr><td class="mono"><b>${c.code}</b></td><td>${c.names.join(' / ')}</td></tr>`)}</tbody></table></div>
    <p class="muted">${car.brands.length ? `Brand: ${car.brands.join(', ')}. ` : ''}${car.years ? `Years: ${car.years}. ` : ''}${car.platform ? `Platform: ${car.platform}. ` : ''}${car.names.length ? `Also known as: ${car.names.join(', ')}.` : ''}</p>
    ${car.comment ? html`<p>${t(car.comment)}</p>` : ''}
    ${versions.length ? versions : emptyState('No version documented')}
  </div>`);
}

export function renderCars(root, route) {
  if (route.parts[1]) renderCar(root, route.parts[1]);
  else renderList(root);
}
