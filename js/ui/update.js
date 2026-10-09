// "A new version is available" bar: compares the explorer files this page runs with the server copies.

import { html, setHtml } from './dom.js';
import { appFiles, fingerprint, changedFiles } from '../core/appupdate.js';

const MIN_INTERVAL = 10 * 60 * 1000; // between automatic checks (tab shown again)
const PERIOD = 30 * 60 * 1000;

const state = { files: [], running: null, latest: null, changed: [], lastCheck: 0, dismissed: null, pending: null };

function fetcher(cache) {
  return async (url) => {
    const r = await fetch(url, { cache, credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  };
}

/** Status for the about page: { running, latest, changed, lastCheck } (hashes are null until known). */
export function updateStatus() {
  return { running: state.running && state.running.hash, latest: state.latest && state.latest.hash, changed: state.changed, files: state.files.length, lastCheck: state.lastCheck };
}

/** Compare with the server now (or reuse a recent check unless force). */
export function checkForUpdate({ force = false } = {}) {
  if (!state.running) return Promise.resolve(null);
  if (state.pending) return state.pending;
  if (!force && state.lastCheck && Date.now() - state.lastCheck < MIN_INTERVAL) return Promise.resolve(updateStatus());
  state.pending = (async () => {
    try {
      // no-cache: revalidated with the server (usually a 304), and the HTTP cache gets the new copies
      state.latest = await fingerprint(state.files, fetcher('no-cache'));
      state.lastCheck = Date.now();
      state.changed = changedFiles(state.running, state.latest);
      if (state.changed.length && state.latest.hash !== state.dismissed) showBar();
      else if (!state.changed.length) hideBar();
      return updateStatus();
    } catch (e) {
      return null;
    } finally {
      state.pending = null;
    }
  })();
  return state.pending;
}

/** Download the new files past the cache, then reload the page. */
export async function applyUpdate() {
  const bar = document.getElementById('update-bar');
  if (bar) setHtml(bar, html`<span>Updating the explorer…</span>`);
  await Promise.all(state.files.map((u) => fetch(u, { cache: 'reload', credentials: 'same-origin' }).catch(() => null)));
  location.reload();
}

function showBar() {
  let bar = document.getElementById('update-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'update-bar';
    bar.className = 'update-bar';
    bar.setAttribute('role', 'status');
    document.body.appendChild(bar);
    bar.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.upd === 'apply') applyUpdate();
      else { state.dismissed = state.latest && state.latest.hash; hideBar(); }
    });
  }
  const n = state.changed.length;
  setHtml(bar, html`<span><b>A new version of the explorer is available.</b> <span class="muted">This page runs an older copy kept by the browser (${n} file${n > 1 ? 's' : ''} changed).</span></span>
    <span class="update-actions"><button class="btn btn-sm primary" data-upd="apply">Update now</button><button class="btn btn-sm" data-upd="later">Later</button></span>`);
}

function hideBar() {
  const bar = document.getElementById('update-bar');
  if (bar) bar.remove();
}

/** Start-up: fingerprint the running files, check right away, then when the tab is shown again and periodically. */
export async function initUpdateCheck() {
  if (typeof fetch !== 'function' || !/^https?:$/.test(location.protocol)) return;
  try {
    const urls = (performance.getEntriesByType('resource') || []).map((e) => e.name);
    state.files = appFiles(urls, location.href);
    // force-cache: the copies the browser has (the ones this page was built from)
    state.running = await fingerprint(state.files, fetcher('force-cache'));
  } catch (e) {
    return;
  }
  checkForUpdate({ force: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
  setInterval(() => { if (!document.hidden) checkForUpdate({ force: true }); }, PERIOD);
}

