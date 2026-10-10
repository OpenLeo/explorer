// Lazy diagnostics, per-file cache by content hash and data bundles, against a fake GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { yaml } from './helpers.mjs';
import { loadSource } from '../js/core/sources.js';
import { buildDatabase, diagCount, diagPending, ensureEcuDiag, ensureDtcs, ensureAllDiag, diagEcuKey } from '../js/core/repo.js';
import { isDeferred } from '../js/core/paths.js';
import { makeBundle } from '../tools/make_bundle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MINI = path.join(here, 'fixtures', 'minirepo');
const CFG = { id: 't', kind: 'github', label: 'T', owner: 'o', repo: 'r', branch: 'master', subpath: '' };
const BUNDLES = 'https://bundles.test/';

function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-'));
  fs.cpSync(MINI, dir, { recursive: true, verbatimSymlinks: true });
  // a second ECU model sharing the fault codes of the first one through a symlink
  const m = path.join(dir, 'diag/AEE2004.full/BSI2');
  fs.mkdirSync(m, { recursive: true });
  fs.writeFileSync(path.join(m, 'ecu.yml'), "node: 'BSI'\n");
  fs.symlinkSync('../BSI/dtcs.yml', path.join(m, 'dtcs.yml'));
  return dir;
}

function walk(root, rel = '', out = []) {
  for (const n of fs.readdirSync(path.join(root, rel)).sort()) {
    const r = rel ? `${rel}/${n}` : n;
    const st = fs.lstatSync(path.join(root, r));
    if (st.isDirectory()) walk(root, r, out); else out.push({ path: r, link: st.isSymbolicLink() });
  }
  return out;
}
const content = (root, f) => (f.link ? Buffer.from(fs.readlinkSync(path.join(root, f.path))) : fs.readFileSync(path.join(root, f.path)));
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

function res(status, body) {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body || Buffer.alloc(0);
  return {
    ok: status >= 200 && status < 300, status,
    async text() { return bytes.toString('utf8'); },
    async json() { return JSON.parse(bytes.toString('utf8')); },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

/** fake api.github.com tree + raw.githubusercontent.com (+ a bundles directory); counts the raw downloads */
function fakeGithub(root, bundleDir = null) {
  const calls = { raw: 0 };
  const fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://api.github.com/')) {
      const files = walk(root);
      const tree = files.map((f) => ({ path: f.path, type: 'blob', mode: f.link ? '120000' : '100644', sha: blobSha(content(root, f)), size: content(root, f).length }));
      const sha = crypto.createHash('sha1').update(JSON.stringify(tree)).digest('hex');
      return res(200, JSON.stringify({ sha, tree, truncated: false }));
    }
    if (u.startsWith('https://raw.githubusercontent.com/o/r/master/')) {
      calls.raw++;
      const p = decodeURIComponent(u.slice('https://raw.githubusercontent.com/o/r/master/'.length));
      const f = walk(root).find((x) => x.path === p);
      return f ? res(200, content(root, f)) : res(404);
    }
    if (bundleDir && u.startsWith(`${BUNDLES}o/r/master/`)) {
      const p = path.join(bundleDir, u.slice(`${BUNDLES}o/r/master/`.length));
      return fs.existsSync(p) ? res(200, fs.readFileSync(p)) : res(404);
    }
    return res(404);
  };
  return { fetch, calls };
}

function memCache() {
  const m = new Map();
  return { map: m, async getMany(keys) { return new Map(keys.filter((k) => m.has(k)).map((k) => [k, m.get(k)])); }, async setMany(pairs) { for (const [k, v] of pairs) m.set(k, v); } };
}

const load = (fetch, extra = {}) => loadSource(CFG, { fetch, yaml, defer: isDeferred, ...extra });

test('diagnostic files are deferred and loaded on demand', async () => {
  const root = copyRepo();
  const { fetch } = fakeGithub(root);
  const src = await load(fetch);
  assert.ok(src.deferred.includes('diag/AEE2004.full/BSI/dids/F190.yml'));
  assert.ok(src.deferred.includes('diag/AEE2004.full/BSI/dtcs.yml'));
  assert.ok(!src.files.some((f) => isDeferred(f.path)));
  const db = buildDatabase([src]);
  const e = db.diag.ecus.get(diagEcuKey('AEE2004.full', 'BSI', null));
  assert.ok(e && e.ecu, 'ecu.yml is loaded at start-up');
  assert.equal(e.dids.length, 0);
  assert.equal(diagCount(e, 'dids'), 1, 'counted from the listing');
  assert.equal(diagCount(e, 'dtcs'), null, 'unknown until loaded');
  assert.ok(diagPending(db, e));
  await ensureEcuDiag(db, e.key);
  assert.equal(e.dids.length, 1);
  assert.ok(!diagPending(db, e));
  assert.ok(e.dtcs.length > 0);
  // the symlinked fault codes of the second model
  await ensureDtcs(db);
  const e2 = db.diag.ecus.get(diagEcuKey('AEE2004.full', 'BSI2', null));
  assert.equal(e2.dtcs.length, e.dtcs.length);
  assert.ok(!diagPending(db));
  assert.equal(await ensureAllDiag(db), 0);
});

test('per-file cache: an update only downloads the changed files', async () => {
  const root = copyRepo();
  const { fetch, calls } = fakeGithub(root);
  const fileCache = memCache();
  const first = await load(fetch, { fileCache });
  const n = calls.raw;
  assert.ok(n > 5 && n === first.files.length);
  // change one frame: a new revision
  const frame = walk(root).find((f) => f.path.startsWith('buses/') && !f.link).path;
  fs.appendFileSync(path.join(root, frame), '\n# changed\n');
  calls.raw = 0;
  const second = await load(fetch, { fileCache });
  assert.equal(calls.raw, 1, 'only the changed file');
  assert.equal(second.files.length, first.files.length);
  // the deferred files go through the cache too
  const db = buildDatabase([second]);
  await ensureAllDiag(db);
  const before = calls.raw;
  const third = await load(fetch, { fileCache });
  await ensureAllDiag(buildDatabase([third]));
  assert.equal(calls.raw, before, 'nothing downloaded again');
});

test('bundle: files come from the bundle, changed files from GitHub', async () => {
  const root = copyRepo();
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
  const ix = makeBundle(root, bundleDir, { commit: 'c0ffee' });
  assert.ok(ix.parts.core.files > 0 && ix.parts.diag.files > 0);
  const { fetch, calls } = fakeGithub(root, bundleDir);
  const src = await load(fetch, { bundleBase: BUNDLES });
  assert.equal(calls.raw, 0, 'everything from the bundle');
  assert.ok(src.session.bundle);
  const db = buildDatabase([src]);
  await ensureAllDiag(db);
  assert.equal(calls.raw, 0, 'diagnostics from the bundle too');
  const e = db.diag.ecus.get(diagEcuKey('AEE2004.full', 'BSI2', null));
  assert.ok(e.dtcs.length > 0, 'symlink from the bundle');
  // the repository moves on, the bundle does not
  const dids = 'diag/AEE2004.full/BSI/dids/F190.yml';
  fs.appendFileSync(path.join(root, dids), '\n# changed\n');
  const frame = walk(root).find((f) => f.path.startsWith('buses/') && !f.link).path;
  fs.appendFileSync(path.join(root, frame), '\n# changed\n');
  calls.raw = 0;
  const src2 = await load(fetch, { bundleBase: BUNDLES });
  assert.equal(calls.raw, 1, 'the changed frame');
  const db2 = buildDatabase([src2]);
  await ensureAllDiag(db2);
  assert.equal(calls.raw, 2, 'and the changed DID');
  // same data as a load without bundle
  const plain = await load(fakeGithub(root).fetch);
  const db3 = buildDatabase([plain]);
  await ensureAllDiag(db3);
  assert.equal(db2.frames.length, db3.frames.length);
  assert.deepEqual(db2.diag.dtcIndex.map((d) => d.code).sort(), db3.diag.dtcIndex.map((d) => d.code).sort());
});

test('bundle builder: git blob hashes and parsed data', () => {
  const root = copyRepo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
  const ix = makeBundle(root, out);
  const listed = walk(root).filter((f) => !f.path.endsWith('.md') || f.path.startsWith('buses/'));
  const gz = (n) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(out, ix.parts[n].file))).toString());
  const all = [...gz('core').files, ...gz('diag').files];
  for (const e of all) {
    const f = listed.find((x) => x.path === e.p);
    assert.ok(f, e.p);
    assert.equal(e.s, blobSha(content(root, f)), e.p);
  }
  assert.ok(all.some((e) => e.l === '../BSI/dtcs.yml'));
});
