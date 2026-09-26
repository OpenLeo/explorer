// Data source loaders: GitHub (API tree + raw files, jsDelivr fallback),
// any HTTP base URL (manifest.json / index.json / directory listing), local folder.
// Every loader returns a "parsed source": { meta, files: [{path, data, issues, link, text}] }.
// UI independent: fetch and the YAML library are injectable (node tests).

import { isRelevant, classify, resolveLink, normPath } from './paths.js';
import { parseYaml, decodeText, getYaml } from './yamlparse.js';
import { mapLimit, fnv1a } from './util.js';

export const DEFAULT_SOURCE = {
  id: 'psa-re', kind: 'github', label: 'PSA-RE', owner: 'prototux', repo: 'PSA-RE', branch: 'master', subpath: '', enabled: true,
};

export const SOURCE_COLORS = ['#2f7dd1', '#d9822b', '#b04ad9', '#2fa66a', '#c9404a', '#6b7a8f'];

/** Build a display label and defaults for a source config. */
export function sourceDefaults(cfg, index = 0) {
  const c = { ...cfg };
  if (!c.id) c.id = `src${index}`;
  if (!c.label) {
    if (c.kind === 'github') c.label = c.repo || 'GitHub';
    else if (c.kind === 'http') c.label = (String(c.url || '').replace(/\/+$/, '').split('/').pop()) || 'HTTP';
    else c.label = c.folderName || 'Local folder';
  }
  if (!c.color) c.color = SOURCE_COLORS[index % SOURCE_COLORS.length];
  return c;
}

export function sourceMeta(cfg) {
  return { id: cfg.id, label: cfg.label, color: cfg.color, kind: cfg.kind };
}

/** Text of a YAML file that is a git symlink stored as a plain file (target path only). */
export function looksLikeLinkText(text) {
  const t = String(text).trim();
  return t.length < 300 && !t.includes('\n') && !t.includes(':') && /^[\w.\-/]+\.ya?ml$/i.test(t) && t.includes('/');
}

class HttpError extends Error {
  constructor(status, url, body) { super(`HTTP ${status} for ${url}`); this.status = status; this.url = url; this.body = body; }
}

async function fetchWithRetry(fetchFn, url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchFn(url, opts);
      if (r.ok) return r;
      if (r.status === 404 || r.status === 401) throw new HttpError(r.status, url);
      if (r.status === 403 || r.status === 429) {
        let body = '';
        try { body = await r.text(); } catch (e) { /* ignore */ }
        throw new HttpError(r.status, url, body);
      }
      last = new HttpError(r.status, url);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 401 || e.status === 403 || e.status === 429)) throw e;
      last = e;
    }
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  throw last;
}

/**
 * Turn raw entries into parsed files.
 * entries: [{path, bytes|text, linkText?}] where linkText is the raw target of a symlink.
 */
export function parseEntries(entries, yaml) {
  const byPath = new Map();
  const files = [];
  const pending = [];
  for (const e of entries) {
    if (e.error) {
      files.push({ path: e.path, data: null, issues: [{ level: 'error', msg: `could not load: ${e.error}` }], link: null });
      continue;
    }
    const c = classify(e.path);
    if (e.linkText !== undefined && e.linkText !== null) { pending.push(e); continue; }
    if (c && c.kind === 'busdoc') {
      const { text } = decodeText(e.bytes !== undefined ? e.bytes : e.text);
      files.push({ path: e.path, data: null, text, issues: [], link: null });
      continue;
    }
    const src = e.bytes !== undefined ? e.bytes : e.text;
    const { text } = decodeText(src);
    if (looksLikeLinkText(text)) { pending.push({ ...e, linkText: text.trim() }); continue; }
    const { data, issues } = parseYaml(src, yaml);
    const f = { path: e.path, data, issues, link: null };
    byPath.set(e.path, f);
    files.push(f);
  }
  // resolve symlinks (possibly chained)
  const linkMap = new Map(pending.map((e) => [e.path, resolveLink(e.path, e.linkText)]));
  for (const e of pending) {
    let target = linkMap.get(e.path);
    let hops = 0;
    while (linkMap.has(target) && hops++ < 10) target = linkMap.get(target);
    const t = byPath.get(target);
    if (t) files.push({ path: e.path, data: t.data, issues: [], link: target, text: t.text });
    else files.push({ path: e.path, data: null, issues: [{ level: 'error', msg: `broken symlink to ${e.linkText}` }], link: target });
  }
  return files;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

function stripSub(path, sub) {
  const s = normPath(sub || '');
  if (!s) return path;
  if (!path.startsWith(s + '/')) return null;
  return path.slice(s.length + 1);
}

/** List a GitHub repo with the tree API. Returns {revision, files:[{path, repoPath, link}]} */
export async function listGithub(cfg, fetchFn) {
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/git/trees/${encodeURIComponent(cfg.branch || 'master')}?recursive=1`;
  const headers = { Accept: 'application/vnd.github+json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const r = await fetchWithRetry(fetchFn, url, { headers });
  const j = await r.json();
  const files = [];
  for (const t of j.tree || []) {
    if (t.type !== 'blob') continue;
    const p = stripSub(t.path, cfg.subpath);
    if (p === null || !isRelevant(p)) continue;
    files.push({ path: p, repoPath: t.path, link: t.mode === '120000', size: t.size });
  }
  return { revision: j.sha, truncated: !!j.truncated, files };
}

/** List through jsDelivr (no GitHub API rate limit). */
export async function listJsdelivr(cfg, fetchFn) {
  const ref = cfg.branch || 'master';
  let revision = ref;
  try {
    const rr = await fetchWithRetry(fetchFn, `https://data.jsdelivr.com/v1/package/resolve/gh/${cfg.owner}/${cfg.repo}@${ref}`, {}, 2);
    const rj = await rr.json();
    if (rj && rj.version) revision = rj.version;
  } catch (e) { /* keep branch name */ }
  const r = await fetchWithRetry(fetchFn, `https://data.jsdelivr.com/v1/package/gh/${cfg.owner}/${cfg.repo}@${revision}/flat`);
  const j = await r.json();
  const files = [];
  for (const f of j.files || []) {
    const full = String(f.name).replace(/^\//, '');
    const p = stripSub(full, cfg.subpath);
    if (p === null || !isRelevant(p)) continue;
    files.push({ path: p, repoPath: full, link: false, size: f.size });
  }
  return { revision, files, jsdelivr: true };
}

async function fetchBytes(fetchFn, url) {
  const r = await fetchWithRetry(fetchFn, url);
  return new Uint8Array(await r.arrayBuffer());
}

// ---------------------------------------------------------------------------
// HTTP base URL
// ---------------------------------------------------------------------------

function baseUrl(u) { return String(u || '').replace(/\/?$/, '/'); }

/** Parse a manifest (array of paths, or {files, symlinks, revision}). */
export function parseManifest(j) {
  const out = { files: [], revision: null };
  const add = (p, target) => {
    const path = normPath(p);
    if (!isRelevant(path)) return;
    out.files.push({ path, repoPath: path, link: false, target: target ? normPath(target) : null });
  };
  if (Array.isArray(j)) { for (const p of j) if (typeof p === 'string') add(p); else if (p && p.path) add(p.path, p.target); return out; }
  if (j && typeof j === 'object') {
    for (const p of j.files || []) if (typeof p === 'string') add(p); else if (p && p.path) add(p.path, p.target);
    if (j.symlinks && typeof j.symlinks === 'object') for (const [p, t] of Object.entries(j.symlinks)) add(p, t);
    out.revision = j.revision || j.sha || j.generated || null;
  }
  return out;
}

/** Crawl python http.server style directory listings (fallback when no manifest). */
export async function crawlListing(base, fetchFn, onProgress) {
  const files = [];
  const seen = new Set();
  const listings = [];
  let rootError = null;
  const visit = async (rel, depth) => {
    if (depth > 5 || seen.has(rel)) return;
    seen.add(rel);
    let html;
    try { html = await (await fetchWithRetry(fetchFn, base + rel, {}, 1)).text(); } catch (e) { if (!rel) rootError = e; return; }
    listings.push(rel + ':' + html.length);
    if (onProgress) onProgress({ phase: 'list', message: `listing ${rel || '/'}` });
    const hrefs = [...html.matchAll(/href="([^"?#]+)"/gi)].map((m) => decodeURIComponent(m[1]));
    const subdirs = [];
    for (const h of hrefs) {
      if (/^(\/|https?:|\.\.)/i.test(h)) continue;
      const p = rel + h;
      if (h.endsWith('/')) {
        const top = p.split('/')[0];
        if (['nodes', 'cars', 'buses', 'diag'].includes(top)) subdirs.push(p);
      } else if (isRelevant(p)) files.push({ path: normPath(p), repoPath: normPath(p), link: false });
    }
    await mapLimit(subdirs, 8, (d) => visit(d, depth + 1));
  };
  await visit('', 0);
  return { files, rootError, revision: fnv1a(listings.sort().join('|') + files.length) };
}

export async function listHttp(cfg, fetchFn, onProgress) {
  const base = baseUrl(cfg.url);
  for (const name of ['manifest.json', 'index.json']) {
    try {
      const r = await fetchFn(base + name);
      if (!r.ok) continue;
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch (e) { continue; }
      const m = parseManifest(j);
      if (!m.files.length) continue;
      return { files: m.files, revision: m.revision ? String(m.revision) : fnv1a(text), manifest: name };
    } catch (e) { /* try next */ }
  }
  const c = await crawlListing(base, fetchFn, onProgress);
  if (!c.files.length) {
    const here = typeof location !== 'undefined' && location.origin ? location.origin : null;
    let other = null;
    try { other = new URL(base).origin; } catch (e) { /* relative url */ }
    if (c.rootError && here && other && here !== other) {
      throw new Error(`cannot read ${base}: the explorer runs on ${here} and the data on ${other}; the browser blocks this unless that server sends CORS headers. `
        + `Serve both from the same server (open ${other}/openleo-explorer/) or serve the data with openleo-explorer/tools/serve.py`);
    }
    if (c.rootError) throw new Error(`cannot read ${base} (${c.rootError.message || c.rootError}): is the server running and the URL correct?`);
    throw new Error(`no manifest.json/index.json and no browsable listing at ${base} (the server must show directory listings, like python3 -m http.server, or the folder needs a manifest.json)`);
  }
  return { ...c, manifest: null };
}

// ---------------------------------------------------------------------------
// Generic loader
// ---------------------------------------------------------------------------

/**
 * Load a source.
 * opts: { fetch, onProgress, cache: {get,set}, force, yaml, concurrency }
 * Local sources need cfg.fileList (array of {path, file}) or cfg.dirHandle.
 */
export async function loadSource(cfg, opts = {}) {
  const fetchFn = opts.fetch || ((...a) => fetch(...a));
  const progress = opts.onProgress || (() => {});
  const yaml = opts.yaml || await getYaml();
  const concurrency = opts.concurrency || 16;
  const meta = sourceMeta(cfg);
  let listing;
  let fileUrl;
  const notes = [];

  if (cfg.kind === 'github') {
    progress({ phase: 'list', message: `listing ${cfg.owner}/${cfg.repo}@${cfg.branch}` });
    try {
      listing = await listGithub(cfg, fetchFn);
      const ref = cfg.branch || 'master';
      fileUrl = (f) => `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${ref}/${f.repoPath.split('/').map(encodeURIComponent).join('/')}`;
      if (listing.truncated) notes.push('GitHub tree listing truncated, some files may be missing');
    } catch (e) {
      notes.push(`GitHub API unavailable (${e.status === 403 || e.status === 429 ? 'rate limited, add a token in settings' : e.message}), using jsDelivr`);
      progress({ phase: 'list', message: 'GitHub API unavailable, using jsDelivr' });
      listing = await listJsdelivr(cfg, fetchFn);
      fileUrl = (f) => `https://cdn.jsdelivr.net/gh/${cfg.owner}/${cfg.repo}@${listing.revision}/${f.repoPath}`;
    }
  } else if (cfg.kind === 'http') {
    progress({ phase: 'list', message: `listing ${cfg.url}` });
    listing = await listHttp(cfg, fetchFn, progress);
    const base = baseUrl(cfg.url);
    fileUrl = (f) => base + f.repoPath.split('/').map(encodeURIComponent).join('/');
  } else if (cfg.kind === 'local') {
    const entries = await readLocal(cfg, progress);
    const files = parseEntries(entries, yaml);
    return { meta, files, revision: 'local', notes };
  } else {
    throw new Error(`unknown source kind ${cfg.kind}`);
  }

  const cacheKey = `${cfg.kind}|${cfg.kind === 'github' ? `${cfg.owner}/${cfg.repo}@${cfg.branch}/${cfg.subpath || ''}` : cfg.url}|${listing.revision}`;
  if (opts.cache && !opts.force) {
    try {
      const hit = await opts.cache.get(cacheKey);
      if (hit && Array.isArray(hit.files)) {
        progress({ phase: 'cache', message: 'loaded from cache', done: hit.files.length, total: hit.files.length });
        return { meta, files: hit.files, revision: listing.revision, notes: [...notes, 'from cache'], fromCache: true, cacheKey };
      }
    } catch (e) { /* cache unavailable */ }
  }

  const list = listing.files;
  const total = list.length;
  progress({ phase: 'fetch', done: 0, total });
  const entries = await mapLimit(list, concurrency, async (f) => {
    if (f.target) {
      // manifest symlink: data comes from the target
      return { path: f.path, linkText: relativeTo(f.path, f.target) };
    }
    try {
      const bytes = await fetchBytes(fetchFn, fileUrl(f));
      if (f.link) return { path: f.path, linkText: decodeText(bytes).text.trim() };
      return { path: f.path, bytes };
    } catch (e) {
      return { path: f.path, error: e.message || String(e) };
    }
  }, (done) => progress({ phase: 'fetch', done, total }));
  // manifest links may point to files not listed: fetch them
  const have = new Set(entries.filter((e) => e.bytes).map((e) => e.path));
  const missing = list.filter((f) => f.target && !have.has(f.target)).map((f) => f.target);
  if (missing.length) {
    const extra = await mapLimit([...new Set(missing)], concurrency, async (p) => {
      try { return { path: p, bytes: await fetchBytes(fetchFn, fileUrl({ repoPath: p })) }; } catch (e) { return null; }
    });
    for (const e of extra) if (e) entries.push({ ...e, hiddenTarget: true });
  }
  progress({ phase: 'parse', message: 'parsing YAML' });
  let files = parseEntries(entries, yaml);
  const hidden = new Set(entries.filter((e) => e.hiddenTarget).map((e) => e.path));
  if (hidden.size) files = files.filter((f) => !hidden.has(f.path) || list.some((l) => l.path === f.path));
  if (opts.cache) {
    try { await opts.cache.set(cacheKey, { files, savedAt: Date.now() }); } catch (e) { /* ignore quota errors */ }
  }
  return { meta, files, revision: listing.revision, notes, cacheKey };
}

/** relative path from a link's directory to a target (both repo paths) */
function relativeTo(linkPath, target) {
  const from = linkPath.split('/').slice(0, -1);
  const to = target.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/');
}

// ---------------------------------------------------------------------------
// Local folder
// ---------------------------------------------------------------------------

/** Build local entries from an <input webkitdirectory> FileList. */
export function fileListToLocal(fileList) {
  const out = [];
  for (const file of Array.from(fileList || [])) {
    const rel = file.webkitRelativePath || file.name;
    const parts = rel.split('/');
    // strip the picked folder name
    const path = parts.length > 1 ? parts.slice(1).join('/') : rel;
    out.push({ path: normPath(path), file });
  }
  // the user may have picked a parent folder: detect the repo root (folder containing architectures.yml)
  const roots = out.filter((e) => /(^|\/)architectures\.ya?ml$/.test(e.path)).map((e) => e.path.replace(/architectures\.ya?ml$/, ''));
  if (roots.length && roots[0] !== '') {
    const root = roots.sort((a, b) => a.length - b.length)[0];
    return out.filter((e) => e.path.startsWith(root)).map((e) => ({ ...e, path: e.path.slice(root.length) }));
  }
  return out;
}

async function walkDirHandle(handle, prefix, out, depth = 0) {
  if (depth > 6) return;
  for await (const [name, h] of handle.entries()) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'directory') {
      const top = p.split('/')[0];
      if (depth === 0 && !['nodes', 'cars', 'buses', 'diag'].includes(top)) continue;
      await walkDirHandle(h, p, out, depth + 1);
    } else if (isRelevant(p)) {
      out.push({ path: p, handle: h });
    }
  }
}

async function readLocal(cfg, progress) {
  let items = [];
  if (cfg.dirHandle) {
    await walkDirHandle(cfg.dirHandle, '', items);
  } else if (cfg.fileList) {
    items = cfg.fileList.filter((e) => isRelevant(e.path));
  } else {
    throw new Error('local folder not selected (pick it again)');
  }
  const total = items.length;
  let done = 0;
  const entries = await mapLimit(items, 32, async (it) => {
    try {
      const file = it.file || await it.handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { path: it.path, bytes };
    } catch (e) {
      return { path: it.path, error: e.message };
    } finally {
      done++;
      progress({ phase: 'fetch', done, total });
    }
  });
  return entries;
}
