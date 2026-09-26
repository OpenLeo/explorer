// Settings: data sources (GitHub, HTTP URL, local folder, several at once), GitHub token, cache.

import { html, $, on, setHtml, toast } from '../dom.js';
import { app, saveSettings } from '../state.js';
import { sourceDefaults, fileListToLocal, SOURCE_COLORS, DEFAULT_SOURCE } from '../../core/sources.js';
import { idbCache } from '../../core/cache.js';

let work = null; // working copy of the sources

function presets() {
  // repositories next to the explorer folder, on the same server as the page
  let base;
  try { base = new URL('../', location.href).href; } catch (e) { base = `${location.protocol || 'http:'}//${location.hostname || 'localhost'}:8000/`; }
  return [
    { label: 'PSA-RE (GitHub)', cfg: { ...DEFAULT_SOURCE } },
    { label: 'PSA-RE (local HTTP)', cfg: { kind: 'http', url: `${base}PSA-RE/`, label: 'PSA-RE (local)' } },
  ];
}

function newId() { return `src${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`; }

function rowHtml(s, i) {
  const h = app.localHandles.get(s.id);
  let fields;
  if (s.kind === 'github') {
    fields = html`<input data-f="owner" value="${s.owner || ''}" placeholder="owner" size="10"> / <input data-f="repo" value="${s.repo || ''}" placeholder="repo" size="14"> @ <input data-f="branch" value="${s.branch || ''}" placeholder="branch" size="8"> <input data-f="subpath" value="${s.subpath || ''}" placeholder="sub-path (optional)" size="14">`;
  } else if (s.kind === 'http') {
    fields = html`<input class="url" data-f="url" value="${s.url || ''}" placeholder="http://localhost:8000/PSA-RE/">`;
  } else {
    fields = html`<button class="btn btn-sm" data-act="pick" data-i="${i}">Pick folder…</button> <span class="small ${h ? '' : 'muted'}">${h ? `${h.fileList ? h.fileList.length + ' files' : 'folder'} selected${s.folderName ? ' (' + s.folderName + ')' : ''}` : 'no folder selected (needed after each page reload)'}</span>`;
  }
  return html`<div class="srcrow" data-i="${i}">
    <input type="checkbox" data-f="enabled" ${s.enabled !== false ? 'checked' : ''} title="enabled">
    <div>
      <div class="fields"><input type="color" data-f="color" value="${s.color || '#2f7dd1'}" title="badge color"> <input data-f="label" value="${s.label || ''}" placeholder="label" size="16">
        <select data-f="kind">${['github', 'http', 'local'].map((k) => html`<option value="${k}" ${s.kind === k ? 'selected' : ''}>${k === 'github' ? 'GitHub' : k === 'http' ? 'HTTP URL' : 'Local folder'}</option>`)}</select></div>
      <div class="fields" style="margin-top:6px">${fields}</div>
    </div>
    <div class="fields"><button class="btn btn-sm" data-act="up" data-i="${i}" title="Higher priority" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn btn-sm" data-act="down" data-i="${i}" title="Lower priority" ${i === work.length - 1 ? 'disabled' : ''}>↓</button><button class="btn btn-sm danger" data-act="remove" data-i="${i}">Remove</button></div>
  </div>`;
}

function listHtml() {
  return html`${work.length ? work.map(rowHtml) : html`<p class="muted">No source: add one below.</p>`}`;
}

export function renderSettings(root) {
  if (!work) work = app.settings.sources.map((s) => ({ ...s }));
  const fsa = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  setHtml(root, html`<div class="page">
    <h2>Data sources &amp; settings</h2>
    <p class="muted">Sources are merged in this order: when the same frame file exists in several sources, the first one is shown by default and a switch lets you see the others. Everything is tagged with its source.</p>
    ${app.loadErrors.length ? html`<div class="notice danger">${app.loadErrors.map((e) => html`<div>${e}</div>`)}</div>` : ''}
    ${app.sourceNotes.length ? html`<div class="notice">${app.sourceNotes.map((e) => html`<div>${e}</div>`)}</div>` : ''}
    <div class="card"><div id="src-list">${listHtml()}</div>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-act="add" data-kind="github">+ GitHub repository</button>
        <button class="btn" data-act="add" data-kind="http">+ HTTP URL</button>
        <button class="btn" data-act="add" data-kind="local">+ Local folder</button>
        <span class="spacer"></span>
        <select id="preset"><option value="">Add a preset…</option>${presets().map((p, i) => html`<option value="${i}">${p.label}</option>`)}</select>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" data-act="apply">Apply &amp; load</button>
        <button class="btn" data-act="refresh" title="Download everything again (ignore the cache)">Apply &amp; refresh (no cache)</button>
        <button class="btn" data-act="revert">Revert changes</button>
      </div>
    </div>
    <div class="card"><h3>GitHub API token (optional)</h3>
      <p class="muted small">Unauthenticated GitHub API calls are limited to 60 per hour per IP (one call per source load; files are fetched from raw.githubusercontent.com). When the limit is hit the explorer falls back to jsDelivr (which may lag behind the repository by a few hours). A fine-grained token with read-only public access raises the limit. It is stored in this browser only (localStorage) and only sent to api.github.com.</p>
      <div class="row"><input type="password" id="token" value="${app.settings.token || ''}" placeholder="github_pat_…" class="grow" autocomplete="off"><button class="btn" data-act="save-token">Save token</button></div>
    </div>
    <div class="card"><h3>Cache</h3>
      <p class="muted small">Parsed repositories are cached in IndexedDB, keyed by source and commit/tree SHA (or manifest revision): reloading the page is instant until the repository changes.</p>
      <button class="btn" data-act="clear-cache">Clear the cache</button>
    </div>
    <div class="card"><h3>Serving a local repository</h3>
      <p>From the folder containing the repositories: <code>python3 -m http.server 8000</code>, then add <code>http://localhost:8000/PSA-RE/</code> as an HTTP source. For faster loading (and to keep symlinks as links) generate a manifest first: <code>python3 openleo-explorer/tools/make_manifest.py PSA-RE</code>. Without a manifest the explorer walks the directory listings of <code>python3 -m http.server</code>.</p>
      <p class="small muted">Sources can also be given in the page URL: <code>?url=http://localhost:8000/PSA-RE/</code> or <code>?github=owner/repo@branch</code> (repeatable; add <code>&amp;only</code> to ignore the saved sources).</p>
    </div>
    <input type="file" id="dirpick" webkitdirectory directory multiple hidden>
    <p class="muted small">${fsa ? 'Your browser supports the File System Access API: folders are read directly.' : 'Local folders are read with a folder upload dialog (nothing is uploaded anywhere, files are read locally).'}</p>
  </div>`);
  bind(root);
}

function bind(root) {
  if (root._unbind) root._unbind();
  const list = () => $('#src-list', root);
  const redraw = () => setHtml(list(), listHtml());
  let pickIndex = -1;
  const offs = [
    on(root, 'input', '[data-f]', (ev, el) => {
      const row = el.closest('.srcrow');
      if (!row) return;
      const s = work[+row.dataset.i];
      const f = el.dataset.f;
      if (el.type === 'checkbox') s[f] = el.checked; else s[f] = el.value;
      if (f === 'kind') redraw();
    }),
    on(root, 'change', 'select[data-f=kind]', () => redraw()),
    on(root, 'click', '[data-act]', async (ev, el) => {
      const act = el.dataset.act;
      const i = el.dataset.i !== undefined ? +el.dataset.i : -1;
      if (act === 'add') {
        const kind = el.dataset.kind;
        const base = kind === 'github' ? { owner: 'prototux', repo: 'PSA-RE', branch: 'master' } : kind === 'http' ? { url: '' } : {};
        work.push(sourceDefaults({ id: newId(), kind, ...base, label: kind === 'local' ? 'Local folder' : undefined, color: SOURCE_COLORS[work.length % SOURCE_COLORS.length] }, work.length));
        redraw();
      } else if (act === 'remove') { work.splice(i, 1); redraw(); }
      else if (act === 'up' && i > 0) { [work[i - 1], work[i]] = [work[i], work[i - 1]]; redraw(); }
      else if (act === 'down' && i < work.length - 1) { [work[i + 1], work[i]] = [work[i], work[i + 1]]; redraw(); }
      else if (act === 'pick') {
        pickIndex = i;
        if ('showDirectoryPicker' in window) {
          try {
            const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
            app.localHandles.set(work[i].id, { dirHandle });
            work[i].folderName = dirHandle.name;
            if (!work[i].label || work[i].label === 'Local folder') work[i].label = dirHandle.name;
            redraw();
          } catch (e) { if (e && e.name !== 'AbortError') toast(`Folder access failed: ${e.message}`, 'error'); }
        } else {
          $('#dirpick', root).click();
        }
      } else if (act === 'apply' || act === 'refresh') {
        work = work.map((s, k) => sourceDefaults({ ...s, label: s.label || undefined }, k));
        const bad = work.find((s) => s.enabled !== false && ((s.kind === 'http' && !/^https?:\/\//.test(s.url || '')) || (s.kind === 'github' && (!s.owner || !s.repo))));
        if (bad) { toast(`Source "${bad.label}" is incomplete`, 'error'); return; }
        app.settings.sources = work.map((s) => ({ ...s }));
        saveSettings();
        location.hash = '#/frames';
        app.loadAll(act === 'refresh');
      } else if (act === 'revert') { work = app.settings.sources.map((s) => ({ ...s })); redraw(); }
      else if (act === 'save-token') { app.settings.token = $('#token', root).value.trim(); saveSettings(); toast('Token saved'); }
      else if (act === 'clear-cache') { await idbCache.clear(); toast('Cache cleared'); }
    }),
    on(root, 'change', '#preset', (ev, el) => {
      if (el.value === '') return;
      const p = presets()[+el.value];
      work.push(sourceDefaults({ ...p.cfg, id: newId(), color: SOURCE_COLORS[work.length % SOURCE_COLORS.length] }, work.length));
      el.value = '';
      redraw();
    }),
    on(root, 'change', '#dirpick', (ev, el) => {
      if (pickIndex < 0 || !work[pickIndex]) return;
      const files = fileListToLocal(el.files);
      if (!files.some((f) => f.path === 'architectures.yml')) toast('No architectures.yml found in this folder: is it a DBMUXEv repository?', 'error');
      app.localHandles.set(work[pickIndex].id, { fileList: files });
      const first = el.files[0] && el.files[0].webkitRelativePath ? el.files[0].webkitRelativePath.split('/')[0] : '';
      work[pickIndex].folderName = first;
      if (!work[pickIndex].label || work[pickIndex].label === 'Local folder') work[pickIndex].label = first || 'Local folder';
      el.value = '';
      redraw();
    }),
  ];
  root._unbind = () => offs.forEach((o) => o());
}
