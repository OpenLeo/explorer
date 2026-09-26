import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { yaml, readRepoEntries, BUSDOC, PSA_RE, exists } from './helpers.mjs';
import { loadSource, parseEntries, parseManifest, looksLikeLinkText, sourceDefaults, fileListToLocal } from '../js/core/sources.js';
import { buildDatabase } from '../js/core/repo.js';
import { resolveLink, classify } from '../js/core/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MINI = path.join(here, 'fixtures', 'minirepo');

function res(status, body, type = 'text/plain') {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300, status,
    async text() { return new TextDecoder().decode(bytes); },
    async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    headers: { get: () => type },
  };
}

/** Fake GitHub + jsDelivr + raw servers backed by a directory on disk. */
function fakeGithub(root, { rateLimited = false } = {}) {
  const calls = [];
  const all = [];
  const walk = (dir, rel) => {
    for (const n of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else all.push({ path: r, abs, link: st.isSymbolicLink() });
    }
  };
  walk(root, '');
  const fetchFn = async (url, opts) => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) {
      if (rateLimited) return res(403, '{"message":"API rate limit exceeded"}');
      return res(200, JSON.stringify({ sha: 'treesha123', truncated: false, tree: all.map((f) => ({ path: f.path, type: 'blob', mode: f.link ? '120000' : '100644', sha: 'x' })) }));
    }
    if (url.startsWith('https://data.jsdelivr.com/v1/package/resolve/')) return res(200, JSON.stringify({ version: 'commitsha456' }));
    if (url.startsWith('https://data.jsdelivr.com/v1/package/gh/')) {
      return res(200, JSON.stringify({ files: all.map((f) => ({ name: '/' + f.path, size: 1 })) }));
    }
    let m = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.*)$/.exec(url) || /^https:\/\/cdn\.jsdelivr\.net\/gh\/[^/]+\/[^@]+@[^/]+\/(.*)$/.exec(url);
    if (m) {
      const p = decodeURIComponent(m[1]);
      const f = all.find((x) => x.path === p);
      if (!f) return res(404, 'not found');
      if (f.link) return res(200, fs.readlinkSync(f.abs)); // git stores the link target as content
      return res(200, new Uint8Array(fs.readFileSync(f.abs)));
    }
    return res(404, 'unknown ' + url);
  };
  return { fetchFn, calls };
}

test('paths and symlink helpers', () => {
  assert.equal(resolveLink('buses/AEE2004.ev/HS.IS/0B6.yml', '../../AEE2004.full/HS.IS/0B6.yml'), 'buses/AEE2004.full/HS.IS/0B6.yml');
  assert.equal(classify('buses/AEE2004.full/HS.IS/0B6_ALT.yml').suffix, 'ALT');
  assert.equal(classify('buses/AEE2004.full/HS.IS/0B6.yml').fileId, 0xB6);
  assert.equal(classify('diag/AEE2004.full/BSI/dids/F190.yml').kind, 'diag_did');
  assert.equal(classify('README.md'), null);
  assert.ok(looksLikeLinkText('../../AEE2004.full/HS.IS/0B6.yml'));
  assert.ok(!looksLikeLinkText('id: 0x036'));
});

test('parseEntries resolves symlinks and chained links', () => {
  const entries = [
    { path: 'buses/A.full/HS.IS/001.yml', text: 'id: 1\nname: X\ntype: can\nlength: 1\nsignals: {}' },
    { path: 'buses/A.ev/HS.IS/001.yml', linkText: '../../A.full/HS.IS/001.yml' },
    { path: 'buses/A.eco/HS.IS/001.yml', linkText: '../../A.ev/HS.IS/001.yml' },
    { path: 'buses/A.eco/HS.IS/002.yml', linkText: '../../A.full/HS.IS/999.yml' },
    { path: 'buses/A.eco/HS.IS/003.yml', text: '../../A.full/HS.IS/001.yml\n' },
  ];
  const files = parseEntries(entries, yaml);
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(by['buses/A.ev/HS.IS/001.yml'].data.id, 1);
  assert.equal(by['buses/A.eco/HS.IS/001.yml'].link, 'buses/A.full/HS.IS/001.yml');
  assert.match(by['buses/A.eco/HS.IS/002.yml'].issues[0].msg, /broken symlink/);
  assert.equal(by['buses/A.eco/HS.IS/003.yml'].link, 'buses/A.full/HS.IS/001.yml', 'link stored as plain text file');
});

test('GitHub loader (tree API + raw files, symlinks, cache)', async () => {
  const { fetchFn, calls } = fakeGithub(MINI);
  const store = new Map();
  const cache = { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } };
  const progress = [];
  const cfg = sourceDefaults({ id: 'gh', kind: 'github', owner: 'prototux', repo: 'PSA-RE', branch: 'master' });
  const src = await loadSource(cfg, { fetch: fetchFn, yaml, cache, onProgress: (p) => progress.push(p) });
  assert.equal(src.revision, 'treesha123');
  assert.equal(calls.filter((u) => u.includes('api.github.com')).length, 1, 'one API call');
  const link = src.files.find((f) => f.path === 'buses/AEE2004.ev/HS.IS/0B6.yml');
  assert.equal(link.link, 'buses/AEE2004.full/HS.IS/0B6.yml');
  assert.equal(link.data.name, 'VEHICLE_SPEED');
  assert.ok(progress.some((p) => p.phase === 'fetch' && p.done === p.total));
  const db = buildDatabase([src]);
  assert.ok(db.framesByKey.has('AEE2004.full/HS.IS/0B6'));
  // second load: served from cache, only the tree API is called again
  const n = calls.length;
  const again = await loadSource(cfg, { fetch: fetchFn, yaml, cache });
  assert.equal(again.fromCache, true);
  assert.equal(calls.length, n + 1);
  // force refresh bypasses the cache
  const forced = await loadSource(cfg, { fetch: fetchFn, yaml, cache, force: true });
  assert.ok(!forced.fromCache);
});

test('GitHub rate limited -> jsDelivr fallback', async () => {
  const { fetchFn, calls } = fakeGithub(MINI, { rateLimited: true });
  const cfg = sourceDefaults({ id: 'gh', kind: 'github', owner: 'prototux', repo: 'PSA-RE', branch: 'master' });
  const src = await loadSource(cfg, { fetch: fetchFn, yaml });
  assert.equal(src.revision, 'commitsha456');
  assert.ok(calls.some((u) => u.startsWith('https://cdn.jsdelivr.net/gh/prototux/PSA-RE@commitsha456/')));
  assert.ok(src.notes.some((n) => /jsDelivr/.test(n)));
  const db = buildDatabase([src]);
  assert.equal(db.framesByKey.get('AEE2004.ev/HS.IS/0B6')[0].name, 'VEHICLE_SPEED');
});

test('manifest parsing + make_manifest.py', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'psa-manifest-'));
  const out = path.join(tmp, 'manifest.json');
  execFileSync('python3', [path.join(here, '..', 'tools', 'make_manifest.py'), MINI, '--output', out, '--revision', 'r1']);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(j.revision, 'r1');
  assert.ok(j.files.includes('architectures.yml'));
  assert.equal(j.symlinks['buses/AEE2004.ev/HS.IS/0B6.yml'], 'buses/AEE2004.full/HS.IS/0B6.yml');
  const m = parseManifest(j);
  assert.ok(m.files.find((f) => f.path === 'buses/AEE2004.ev/HS.IS/0B6.yml').target);
  assert.deepEqual(parseManifest(['architectures.yml', 'README.md']).files.map((f) => f.path), ['architectures.yml']);
  fs.rmSync(tmp, { recursive: true });
});

test('HTTP loader with manifest.json', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'psa-manifest-'));
  const man = path.join(tmp, 'manifest.json');
  execFileSync('python3', [path.join(here, '..', 'tools', 'make_manifest.py'), MINI, '--output', man, '--revision', 'r2']);
  const base = 'http://localhost:9999/mini/';
  const fetchFn = async (url) => {
    const rel = decodeURIComponent(url.slice(base.length));
    if (rel === 'manifest.json') return res(200, fs.readFileSync(man, 'utf8'));
    const p = path.join(MINI, rel);
    if (!fs.existsSync(p)) return res(404, '');
    return res(200, new Uint8Array(fs.readFileSync(p)));
  };
  const src = await loadSource(sourceDefaults({ id: 'h', kind: 'http', url: base }), { fetch: fetchFn, yaml });
  assert.equal(src.revision, 'r2');
  const db = buildDatabase([src]);
  assert.equal(db.framesByKey.get('AEE2004.ev/HS.IS/0B6')[0].symlinkOf, 'buses/AEE2004.full/HS.IS/0B6.yml');
  fs.rmSync(tmp, { recursive: true });
});

test('local folder file list (webkitdirectory)', () => {
  const fake = [
    { webkitRelativePath: 'BusDoc/PSA-RE/architectures.yml' },
    { webkitRelativePath: 'BusDoc/PSA-RE/buses/X.full/HS.IS/001.yml' },
    { webkitRelativePath: 'BusDoc/other/file.yml' },
  ];
  const l = fileListToLocal(fake);
  assert.deepEqual(l.map((e) => e.path), ['architectures.yml', 'buses/X.full/HS.IS/001.yml']);
});

test('real HTTP server: load PSA-RE through python http.server directory listings', { skip: !exists(PSA_RE) && 'PSA-RE missing', timeout: 60000 }, async () => {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const srv = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: BUSDOC, stdio: 'ignore' });
  try {
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/`); ok = r.ok; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(ok, 'server started');
    const cfg = sourceDefaults({ id: 'local', kind: 'http', url: `http://127.0.0.1:${port}/PSA-RE/` });
    const src = await loadSource(cfg, { yaml });
    const db = buildDatabase([src]);
    const disk = readRepoEntries(PSA_RE).length;
    assert.equal(src.files.length, disk, 'same file count as on disk');
    assert.ok(db.frames.length > 50);
    assert.ok(db.frames.some((f) => f.archvar === 'AEE2004.full' && f.id === 0x036));
  } finally {
    srv.kill();
  }
});
