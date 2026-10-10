// Data source loaders: GitHub (API tree + raw files, jsDelivr fallback),
// any HTTP base URL (manifest.json / index.json / directory listing), local folder.
// Every loader returns a "parsed source": { meta, files: [{path, data, issues, link, text}] }.
// UI independent: fetch and the YAML library are injectable (node tests).

import { isRelevant, classify, resolveLink, normPath } from './paths.js';
import { parseYaml, decodeText, getYaml, PARSE_VERSION } from './yamlparse.js';
import { mapLimit, fnv1a } from './util.js';

export const DEFAULT_SOURCE = {
  id: 'psa-re', kind: 'github', label: 'PSA-RE', owner: 'prototux', repo: 'PSA-RE', branch: 'master', subpath: '', enabled: true,
};

/** Where the data bundles are published (tools/make_bundle.mjs, built by the explorer repository's data-bundle workflow) */
export const DEFAULT_BUNDLE_BASE = 'https://raw.githubusercontent.com/OpenLeo/explorer/data/bundles/';

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
 * Parse one fetched file. Returns {path, data, issues} (plus {text} for the markdown/text notes of a bus directory),
 * or {path, linkText} when the content is a symlink stored as a text file.
 * Used on the main thread, in the parse workers and by the bundle builder (same result everywhere).
 */
export function parseOne(path, src, yaml) {
  const c = classify(path);
  const { text } = decodeText(src);
  if (c && c.kind === 'busdoc') return { path, data: null, text, issues: [] };
  if (looksLikeLinkText(text)) return { path, linkText: text.trim() };
  const { data, issues } = parseYaml(src, yaml);
  return { path, data, issues };
}

/**
 * Turn raw entries into parsed files.
 * entries: [{path, bytes|text|parsed, linkText?}] where linkText is the raw target of a symlink and parsed the result
 * of parseOne. known: optional Map path -> parsed file of earlier batches (symlink targets).
 */
export function parseEntries(entries, yaml, known = null) {
  const byPath = new Map();
  const files = [];
  const pending = [];
  for (const e of entries) {
    if (e.error) {
      files.push({ path: e.path, data: null, issues: [{ level: 'error', msg: `could not load: ${e.error}` }], link: null });
      continue;
    }
    if (e.linkText !== undefined && e.linkText !== null) { pending.push(e); continue; }
    const p = e.parsed || parseOne(e.path, e.bytes !== undefined ? e.bytes : e.text, yaml);
    if (p.linkText !== undefined && p.linkText !== null) { pending.push({ path: e.path, linkText: p.linkText }); continue; }
    const f = { path: e.path, data: p.data === undefined ? null : p.data, issues: p.issues || [], link: null };
    if (p.text !== undefined) f.text = p.text;
    byPath.set(e.path, f);
    files.push(f);
  }
  // resolve symlinks (possibly chained)
  const linkMap = new Map(pending.map((e) => [e.path, resolveLink(e.path, e.linkText)]));
  for (const e of pending) {
    let target = linkMap.get(e.path);
    let hops = 0;
    while (linkMap.has(target) && hops++ < 10) target = linkMap.get(target);
    const t = byPath.get(target) || (known && known.get(target));
    if (t) files.push({ path: e.path, data: t.data, issues: [], link: t.link || target, text: t.text });
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
    files.push({ path: p, repoPath: t.path, link: t.mode === '120000', size: t.size, sha: t.sha });
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
    files.push({ path: p, repoPath: full, link: false, size: f.size, hash: f.hash || null });
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
// Bundle: the parsed files of a repository revision in a few gzipped JSON files (tools/make_bundle.mjs)
// ---------------------------------------------------------------------------

export const BUNDLE_FORMAT = 1;

async function gunzipJson(buf) {
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  // already decompressed by the browser (server sending Content-Encoding: gzip)
  if (!(head[0] === 0x1F && head[1] === 0x8B)) return JSON.parse(new TextDecoder().decode(buf));
  if (typeof DecompressionStream === 'undefined') throw new Error('no DecompressionStream');
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

/**
 * Bundle of a GitHub source, or null. base: URL of the bundles directory (…/bundles/), the bundle of
 * owner/repo@branch being at <base><owner>/<repo>/<branch>/index.json.
 */
export async function openBundle(base, cfg, fetchFn) {
  if (!base || cfg.kind !== 'github' || cfg.subpath) return null;
  const dir = `${baseUrl(base)}${cfg.owner}/${cfg.repo}/${cfg.branch || 'master'}/`;
  let index;
  try {
    const r = await fetchFn(dir + 'index.json', { cache: 'no-cache' });
    if (!r.ok) return null;
    index = await r.json();
  } catch (e) { return null; }
  if (!index || index.format !== BUNDLE_FORMAT || index.parser !== PARSE_VERSION || !index.parts) return null;
  const parts = new Map();
  return {
    index,
    /** Map path -> bundle entry of a part ('core' or 'diag'), fetched once */
    part(name) {
      if (!parts.has(name)) {
        const info = index.parts[name];
        parts.set(name, (async () => {
          if (!info) return new Map();
          const r = await fetchWithRetry(fetchFn, dir + info.file, {}, 2);
          const j = await gunzipJson(await r.arrayBuffer());
          return new Map((j.files || []).map((e) => [e.p, e]));
        })().catch(() => new Map()));
      }
      return parts.get(name);
    },
  };
}

function bundleParsed(e) {
  if (e.l !== undefined) return { path: e.p, linkText: e.l };
  const out = { path: e.p, data: e.d === undefined ? null : e.d, issues: e.i || [] };
  if (e.t !== undefined) out.text = e.t;
  return out;
}

// ---------------------------------------------------------------------------
// Generic loader
// ---------------------------------------------------------------------------

/**
 * Files of a listed source, loaded on demand: from the bundle (same content hash), the per-file cache (content
 * hash), or the network; symlink targets are loaded with their links. Keeps the parsed files by path.
 */
export class SourceSession {
  constructor({ listing, fileUrl, yaml, fetchFn, concurrency, fileCache, bundle, parse, partOf }) {
    Object.assign(this, { listing, fileUrl, yaml, fetchFn, concurrency, fileCache, bundle, parse, partOf });
    this.byPath = new Map(listing.files.map((f) => [f.path, f]));
    this.parsed = new Map();       // path -> parsed file
    this.inflight = new Map();     // path -> promise of the batch loading it
    this.stats = { bundle: 0, cache: 0, fetched: 0 };
  }

  /** content key of a listed file for the per-file cache, null when unknown */
  key(f) {
    if (f.sha) return `${PARSE_VERSION}:g:${f.sha}`;
    if (f.hash) return `${PARSE_VERSION}:h:${f.hash}`;
    return null;
  }

  /** Load paths (listed paths; link targets come along). Returns the parsed files of the requested paths. */
  async load(paths, progress = () => {}) {
    const want = [...new Set(paths)].filter((p) => !this.parsed.has(p));
    const waits = want.filter((p) => this.inflight.has(p)).map((p) => this.inflight.get(p));
    const todo = want.filter((p) => !this.inflight.has(p));
    if (todo.length) {
      const job = this._load(todo, progress);
      for (const p of todo) this.inflight.set(p, job);
      try { await job; } finally { for (const p of todo) this.inflight.delete(p); }
    }
    await Promise.all(waits);
    return paths.map((p) => this.parsed.get(p)).filter(Boolean);
  }

  async _load(paths, progress) {
    const entries = new Map();     // path -> {path, parsed|linkText|bytes|error}
    const fetchList = [];
    // 1. bundle
    const fromBundle = new Map();
    if (this.bundle) {
      const parts = [...new Set(paths.map((p) => this.partOf(p)))];
      const maps = await Promise.all(parts.map((n) => this.bundle.part(n)));
      for (const m of maps) for (const [k, v] of m) fromBundle.set(k, v);
    }
    const cacheKeys = [];
    for (const p of paths) {
      const f = this.byPath.get(p) || { path: p, repoPath: p };
      if (f.target) { entries.set(p, { path: p, linkText: relativeTo(p, f.target) }); continue; }
      const be = fromBundle.get(p);
      if (be && ((f.sha && be.s === f.sha) || (f.hash && be.h === f.hash) || this.listing.trusted)) {
        entries.set(p, { path: p, parsed: bundleParsed(be) });
        this.stats.bundle++;
        continue;
      }
      const k = this.key(f);
      if (k && this.fileCache) cacheKeys.push([p, k]);
      else fetchList.push(f);
    }
    // 2. per-file cache
    if (cacheKeys.length) {
      let hits = new Map();
      try { hits = (await this.fileCache.getMany(cacheKeys.map((x) => x[1]))) || new Map(); } catch (e) { /* no cache */ }
      for (const [p, k] of cacheKeys) {
        const v = hits.get(k);
        if (v) { entries.set(p, { path: p, parsed: { ...v, path: p } }); this.stats.cache++; } else fetchList.push(this.byPath.get(p));
      }
    }
    // 3. network
    const total = fetchList.length;
    if (total) progress({ phase: 'fetch', done: 0, total });
    const fetched = await mapLimit(fetchList, this.concurrency, async (f) => {
      try {
        const bytes = await fetchBytes(this.fetchFn, this.fileUrl(f));
        if (f.link) return { path: f.path, linkText: decodeText(bytes).text.trim(), f };
        return { path: f.path, bytes, f };
      } catch (e) {
        return { path: f.path, error: e.message || String(e) };
      }
    }, (done) => progress({ phase: 'fetch', done, total }));
    this.stats.fetched += total;
    // 4. parse (workers when available)
    const toParse = fetched.filter((e) => e.bytes);
    if (toParse.length) progress({ phase: 'parse', message: 'parsing YAML' });
    let parsed = null;
    if (this.parse && toParse.length > 50) {
      try { parsed = await this.parse(toParse.map((e) => ({ path: e.path, bytes: e.bytes }))); } catch (e) { parsed = null; }
    }
    if (!parsed) parsed = toParse.map((e) => parseOne(e.path, e.bytes, this.yaml));
    const toCache = [];
    parsed.forEach((pr, i) => {
      const f = toParse[i].f;
      entries.set(pr.path, { path: pr.path, parsed: pr });
      const k = this.key(f);
      if (k) toCache.push([k, stripPath(pr)]);
    });
    for (const e of fetched) {
      if (e.bytes) continue;
      entries.set(e.path, e);
      if (e.linkText !== undefined) { const k = this.key(e.f); if (k) toCache.push([k, { linkText: e.linkText }]); }
    }
    if (toCache.length && this.fileCache) { try { await this.fileCache.setMany(toCache); } catch (e) { /* quota */ } }
    // 5. symlink targets not loaded yet
    const targets = [];
    for (const e of entries.values()) {
      const lt = e.linkText !== undefined ? e.linkText : e.parsed && e.parsed.linkText;
      if (lt === undefined || lt === null) continue;
      let t = resolveLink(e.path, lt);
      if (!this.parsed.has(t) && !entries.has(t)) targets.push(t);
    }
    if (targets.length) await this.load(targets, progress);
    for (const f of parseEntries([...entries.values()], this.yaml, this.parsed)) this.parsed.set(f.path, f);
  }

  /** every listed path */
  paths() { return [...this.byPath.keys()]; }

  /** parsed files of the listed paths loaded so far */
  files() { return [...this.byPath.keys()].filter((p) => this.parsed.has(p)).map((p) => this.parsed.get(p)); }
}

function stripPath(pr) { const { path, ...rest } = pr; return rest; }

/**
 * Load a source.
 * opts: { fetch, onProgress, cache: {get,set}, force, yaml, concurrency,
 *         defer(path) -> true for files to load later (session.load), fileCache: {getMany, setMany} (per-file cache
 *         by content hash), bundleBase (URL of a bundles directory), parse(items) -> parsed items (workers) }
 * Returns { meta, files, revision, notes, fromCache, cacheKey, session, deferred: [paths not loaded yet] }.
 * Local sources need cfg.fileList (array of {path, file}) or cfg.dirHandle.
 */
export async function loadSource(cfg, opts = {}) {
  const fetchFn = opts.fetch || ((...a) => fetch(...a));
  const progress = opts.onProgress || (() => {});
  const yaml = opts.yaml || await getYaml();
  const concurrency = opts.concurrency || 16;
  const defer = opts.defer || (() => false);
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
    return { meta, files, revision: 'local', notes, session: null, deferred: [] };
  } else {
    throw new Error(`unknown source kind ${cfg.kind}`);
  }

  // bundle (GitHub sources): trusted as a whole for its own revision, else file by file (content hash)
  let bundle = null;
  if (opts.bundleBase && cfg.kind === 'github') {
    progress({ phase: 'list', message: 'looking for a bundle' });
    bundle = await openBundle(opts.bundleBase, cfg, fetchFn);
    if (bundle) {
      const ix = bundle.index;
      listing.trusted = !!(listing.revision && (listing.revision === ix.tree || listing.revision === ix.commit));
      notes.push(`bundle of ${String(ix.commit || '').slice(0, 7)}${listing.trusted ? '' : ' (older revision, changed files fetched one by one)'}`);
    }
  }
  const session = new SourceSession({
    listing, fileUrl, yaml, fetchFn, concurrency, fileCache: opts.fileCache || null, bundle, parse: opts.parse || null,
    partOf: (p) => (defer(p) ? 'diag' : 'core'),
  });

  const cacheKey = `${cfg.kind}|${cfg.kind === 'github' ? `${cfg.owner}/${cfg.repo}@${cfg.branch}/${cfg.subpath || ''}` : cfg.url}|${listing.revision}`;
  const now = listing.files.filter((f) => !defer(f.path)).map((f) => f.path);
  if (opts.cache && !opts.force) {
    try {
      const hit = await opts.cache.get(cacheKey);
      if (hit && Array.isArray(hit.files)) {
        for (const f of hit.files) session.parsed.set(f.path, f);
        const missing = now.filter((p) => !session.parsed.has(p));
        if (missing.length) await session.load(missing, progress);
        progress({ phase: 'cache', message: 'loaded from cache', done: now.length, total: now.length });
        const deferred = session.paths().filter((p) => !session.parsed.has(p));
        return { meta, files: session.files(), revision: listing.revision, notes: [...notes, 'from cache'], fromCache: true, cacheKey, session, deferred };
      }
    } catch (e) { /* cache unavailable */ }
  }

  progress({ phase: 'fetch', done: 0, total: now.length });
  await session.load(now, progress);
  const files = session.files();
  if (opts.cache) {
    try { await opts.cache.set(cacheKey, { files, savedAt: Date.now() }); } catch (e) { /* ignore quota errors */ }
  }
  const deferred = session.paths().filter((p) => !session.parsed.has(p));
  if (session.stats.bundle) notes.push(`${session.stats.bundle} file(s) from the bundle, ${session.stats.cache} from the cache, ${session.stats.fetched} downloaded`);
  return { meta, files, revision: listing.revision, notes, cacheKey, session, deferred };
}

/** Save the files a session loaded since (deferred files) in the source cache. */
export async function saveSourceCache(cache, src) {
  if (!cache || !src || !src.session || !src.cacheKey) return;
  try { await cache.set(src.cacheKey, { files: src.session.files(), savedAt: Date.now() }); } catch (e) { /* ignore */ }
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
