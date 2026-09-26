// OpenLEO Explorer: bootstrap, loading, routing, top bar.

import { html, $, $$, on, setHtml, toast, copyText, download } from './ui/dom.js';
import { app, saveSettings, emit } from './ui/state.js';
import { getBlob } from './ui/widgets.js';
import { loadSource, sourceDefaults, fileListToLocal } from './core/sources.js';
import { idbCache } from './core/cache.js';
import { buildDatabase, search } from './core/repo.js';
import { getYaml } from './core/yamlparse.js';
import { LANGS, esc, debounce } from './core/util.js';
import { renderFrames } from './ui/views/frames.js';
import { renderArchs } from './ui/views/archs.js';
import { renderCars } from './ui/views/cars.js';
import { renderEcus } from './ui/views/ecus.js';
import { renderDiag } from './ui/views/diag.js';
import { renderTools } from './ui/views/tools.js';
import { renderAbout } from './ui/views/about.js';
import { renderSettings } from './ui/views/settings.js';

const VIEWS = {
  frames: renderFrames, arch: renderArchs, cars: renderCars, ecus: renderEcus, diag: renderDiag,
  tools: renderTools, about: renderAbout, settings: renderSettings,
};
const NO_DB_VIEWS = new Set(['about', 'settings']);

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyTheme() {
  const th = app.settings.theme;
  const root = document.documentElement;
  if (th === 'light' || th === 'dark') root.dataset.theme = th; else delete root.dataset.theme;
  const b = $('#theme-btn');
  if (b) { b.textContent = th === 'dark' ? '☾' : th === 'light' ? '☀' : '◐'; b.title = `Theme: ${th} (click to change)`; }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export function parseRoute(hash) {
  let h = String(hash || '').replace(/^#\/?/, '');
  let query = {};
  const qi = h.indexOf('?');
  if (qi >= 0) {
    query = Object.fromEntries(new URLSearchParams(h.slice(qi + 1)));
    h = h.slice(0, qi);
  }
  const parts = h.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch (e) { return p; } });
  if (!parts.length) parts.push('frames');
  return { parts, query, view: parts[0], hash };
}

let renderSeq = 0;
function route() {
  const r = parseRoute(location.hash);
  app.route = r;
  const root = $('#view');
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === r.view));
  closeSearch();
  const fn = VIEWS[r.view];
  if (!fn) { setHtml(root, html`<div class="page"><h2>Not found</h2><p><a href="#/frames">Go to frames</a></p></div>`); return; }
  if (!app.db && !NO_DB_VIEWS.has(r.view)) {
    if (!app.loading) setHtml(root, html`<div class="page"><h2>No data loaded</h2><p>Configure a data source in <a href="#/settings">settings</a>.</p>${app.loadErrors.map((e) => html`<div class="notice danger">${e}</div>`)}</div>`);
    return;
  }
  const seq = ++renderSeq;
  let target = root;
  if (root.dataset.view !== r.view) {
    // fresh element: drops every delegated listener of the previous view
    target = root.cloneNode(false);
    target.dataset.view = r.view;
    root.replaceWith(target);
    window.scrollTo(0, 0);
  }
  try {
    const p = fn(target, r);
    if (p && p.catch) p.catch((e) => showViewError(target, e, seq));
  } catch (e) {
    showViewError(target, e, seq);
  }
}

function showViewError(root, e, seq) {
  if (seq !== renderSeq) return;
  setHtml(root, html`<div class="page"><h2>Something went wrong</h2><p class="muted">This view failed to render. The data may contain something unexpected.</p><pre class="code">${String(e && e.stack || e)}</pre></div>`);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function progressHtml(state) {
  return html`<div class="loading-box">
    <h3>Loading DBMUXEv data…</h3>
    ${state.map((s) => html`<div class="lsrc">
      <div class="lsrc-h"><span class="badge src-badge" style="--c:${s.color}">${s.label}</span> <span class="muted small">${s.msg || ''}</span></div>
      <div class="progress"><div class="bar${s.error ? ' err' : ''}" style="width:${s.total ? Math.round((100 * s.done) / s.total) : s.done ? 100 : 3}%"></div></div>
      <div class="small muted">${s.total ? `${s.done} / ${s.total} files` : ''}${s.error ? html` <span class="err">${s.error}</span>` : ''}</div>
    </div>`)}
  </div>`;
}

export async function loadAll(force = false) {
  if (app.loading) return;
  app.loading = true;
  app.loadErrors = [];
  app.sourceNotes = [];
  const overlay = $('#loading');
  overlay.hidden = false;
  const sources = app.settings.sources.filter((s) => s.enabled !== false);
  const state = sources.map((s) => ({ id: s.id, label: s.label, color: s.color, done: 0, total: 0, msg: 'waiting' }));
  const paint = debounce(() => setHtml(overlay, progressHtml(state)), 30);
  setHtml(overlay, progressHtml(state));
  let yaml;
  try {
    yaml = await getYaml();
  } catch (e) {
    app.loadErrors.push(`Could not load the YAML parser (js-yaml): ${e.message}`);
  }
  const results = await Promise.all(sources.map(async (cfg, i) => {
    const st = state[i];
    try {
      const c = { ...cfg, token: cfg.kind === 'github' ? app.settings.token : undefined };
      if (cfg.kind === 'local') {
        const h = app.localHandles.get(cfg.id);
        if (!h) throw new Error('local folder: pick the folder again in settings (browsers do not keep access after a reload)');
        Object.assign(c, h);
      }
      if (!yaml) throw new Error('no YAML parser');
      const src = await loadSource(c, {
        yaml, cache: idbCache, force,
        onProgress: (p) => { if (p.total !== undefined) { st.done = p.done; st.total = p.total; } st.msg = p.message || p.phase; paint(); },
      });
      st.msg = src.fromCache ? 'from cache' : 'done';
      st.done = st.total || 1;
      paint();
      for (const n of src.notes || []) app.sourceNotes.push(`${cfg.label}: ${n}`);
      return src;
    } catch (e) {
      st.error = e.message || String(e);
      paint();
      app.loadErrors.push(`${cfg.label}: ${st.error}`);
      return null;
    }
  }));
  const ok = results.filter(Boolean);
  if (ok.length) {
    try {
      app.db = buildDatabase(ok);
    } catch (e) {
      app.loadErrors.push(`Failed to index the data: ${e.message}`);
      app.db = null;
    }
  } else {
    app.db = null;
  }
  app.loading = false;
  if (app.db) overlay.hidden = true;
  else setHtml(overlay, html`${progressHtml(state)}<div class="loading-box"><p>No source could be loaded.</p><p><a class="btn" href="#/settings" data-act="close-loading">Open settings</a> <button class="btn" data-act="retry">Retry</button></p></div>`);
  updateStatus();
  emit({ type: 'db' });
  const root = $('#view');
  root.dataset.view = '';
  route();
}

function updateStatus() {
  const box = $('#status');
  const db = app.db;
  if (!db) { setHtml(box, html`<a href="#/settings" class="badge badge-warn">no data</a>`); return; }
  const errs = db.issues.filter((i) => i.level === 'error').length;
  const warns = db.issues.filter((i) => i.level === 'warning').length;
  setHtml(box, html`${db.sources.map((s) => html`<a href="#/settings" class="badge src-badge" style="--c:${s.color}" title="data source">${s.label}</a>`)}
    <span class="muted small" title="${app.sourceNotes.join('\n')}">${db.primaryFrames.length} frames</span>
    ${errs || warns ? html`<a href="#/tools/issues" class="badge badge-warn" title="Data issues found while loading">⚠ ${errs + warns}</a>` : ''}
    ${app.loadErrors.length ? html`<a href="#/settings" class="badge badge-danger" title="${app.loadErrors.join('\n')}">load error</a>` : ''}`);
}

// ---------------------------------------------------------------------------
// Global search
// ---------------------------------------------------------------------------

let searchSel = -1;
let searchResults = [];

function closeSearch() {
  const dd = $('#search-dd');
  if (dd) dd.hidden = true;
  searchSel = -1;
}

function renderSearch(q) {
  const dd = $('#search-dd');
  if (!app.db || !q.trim()) { closeSearch(); return; }
  searchResults = search(app.db, q, 14);
  searchSel = searchResults.length ? 0 : -1;
  const kindLabel = { frame: 'frame', signal: 'signal', ecu: 'ECU', car: 'car', arch: 'arch', dtc: 'DTC', did: 'DID', lid: 'LID' };
  setHtml(dd, html`${searchResults.map((r, i) => html`<a href="${r.route}" class="sr${i === searchSel ? ' sel' : ''}" data-i="${i}"><span class="sr-kind k-${r.kind}">${kindLabel[r.kind] || r.kind}</span><span class="sr-label">${r.label}</span><span class="sr-sub muted">${r.sub}</span></a>`)}
    ${searchResults.length ? '' : html`<div class="sr muted">No result</div>`}
    <a class="sr sr-all" href="#/frames?q=${encodeURIComponent(q)}">Filter the frame list with “${q}”</a>`);
  dd.hidden = false;
}

function bindSearch() {
  const input = $('#gsearch');
  const dd = $('#search-dd');
  input.addEventListener('input', debounce(() => renderSearch(input.value), 80));
  input.addEventListener('focus', () => { if (input.value.trim()) renderSearch(input.value); });
  input.addEventListener('keydown', (ev) => {
    const items = $$('.sr[data-i]', dd);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!items.length) return;
      searchSel = (searchSel + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('sel', i === searchSel));
      items[searchSel].scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const r = searchResults[searchSel >= 0 ? searchSel : 0];
      if (r) { location.hash = r.route; input.blur(); closeSearch(); }
    } else if (ev.key === 'Escape') { closeSearch(); input.blur(); }
  });
  document.addEventListener('click', (ev) => { if (!ev.target.closest('.searchbox')) closeSearch(); });
  dd.addEventListener('click', (ev) => { if (ev.target.closest('a')) { closeSearch(); input.blur(); } });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { ev.preventDefault(); input.focus(); input.select(); }
  });
}

// ---------------------------------------------------------------------------
// Global delegated actions (copy / download buttons)
// ---------------------------------------------------------------------------

function bindGlobal() {
  on(document, 'click', '[data-copy]', (ev, el) => { const txt = getBlob(el.dataset.copy); if (txt !== undefined) copyText(txt); });
  on(document, 'click', '[data-copyval]', (ev, el) => copyText(el.dataset.copyval));
  on(document, 'click', '[data-download]', (ev, el) => { const txt = getBlob(el.dataset.download); if (txt !== undefined) download(el.dataset.filename || 'export.txt', txt); });
  on(document, 'click', '[data-act=retry]', () => loadAll(false));
  on(document, 'click', '[data-act=close-loading]', () => { $('#loading').hidden = true; });
  on(document, 'click', '[data-act=reload-data]', () => loadAll(false));
  on(document, 'click', '[data-act=refresh-data]', () => loadAll(true));
  $('#theme-btn').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    app.settings.theme = order[(order.indexOf(app.settings.theme) + 1) % order.length];
    saveSettings();
    applyTheme();
  });
  const ls = $('#lang');
  setHtml(ls, html`${LANGS.map((l) => html`<option value="${l}" ${l === app.settings.lang ? 'selected' : ''}>${l.toUpperCase()}</option>`)}`);
  ls.addEventListener('change', () => {
    app.settings.lang = ls.value;
    saveSettings();
    const root = $('#view');
    root.dataset.view = '';
    route();
  });
  $('#refresh-btn').addEventListener('click', () => loadAll(true));
}

/** Sources given in the page URL: ?github=owner/repo@branch[:subpath] and/or ?url=http://... (repeatable) */
function sourcesFromUrl() {
  try {
    const p = new URLSearchParams(location.search);
    const extra = [];
    for (const g of p.getAll('github')) {
      const m = /^([^/]+)\/([^@:]+)(?:@([^:]+))?(?::(.*))?$/.exec(g);
      if (m) extra.push({ kind: 'github', owner: m[1], repo: m[2], branch: m[3] || 'master', subpath: m[4] || '' });
    }
    for (const u of p.getAll('url')) extra.push({ kind: 'http', url: u });
    if (!extra.length) return;
    const list = p.get('only') !== null ? [] : [...app.settings.sources];
    for (const e of extra) {
      const key = e.kind === 'github' ? `${e.owner}/${e.repo}@${e.branch}` : e.url;
      if (list.some((s) => (s.kind === 'github' ? `${s.owner}/${s.repo}@${s.branch}` : s.url) === key)) continue;
      list.push(sourceDefaults({ ...e, id: `url${list.length}` }, list.length));
    }
    app.settings.sources = list.map((s, i) => sourceDefaults(s, i));
  } catch (e) { /* ignore */ }
}

function init() {
  applyTheme();
  bindGlobal();
  bindSearch();
  sourcesFromUrl();
  window.addEventListener('hashchange', route);
  if (matchMedia) {
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme); } catch (e) { /* old browsers */ }
  }
  route();
  loadAll(false);
}

// expose for the settings view
app.loadAll = loadAll;
app.rerender = () => { const root = $('#view'); root.dataset.view = ''; route(); };
app.fileListToLocal = fileListToLocal;

init();
