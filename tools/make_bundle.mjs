#!/usr/bin/env node
// Data bundle of a repository: every relevant file parsed once (same parser as the browser), written as gzipped
// JSON parts the explorer downloads in one request each:
//   index.json      {format, parser, commit, tree, built, parts: {core: {file, files, bytes}, diag: {...}}}
//   core.json.gz    architectures, nodes, cars, frames, diag ecu.yml / protocols (loaded at start-up)
//   diag.json.gz    the other diagnostic files (loaded when needed)
// Each file entry: {p: path, s: git blob sha, h: base64 sha256 (jsDelivr hash), d: data, i: issues, t: text, l: link}
// The explorer only uses an entry when its hash matches the file listed by GitHub, so a bundle older than the
// repository is still safe: the files changed since are downloaded one by one.
//
// usage: node tools/make_bundle.mjs <repository dir> <output dir> [--commit SHA] [--tree SHA]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as jsyaml from '../vendor/js-yaml.mjs';
import { setYamlLib, PARSE_VERSION } from '../js/core/yamlparse.js';
import { parseOne, BUNDLE_FORMAT } from '../js/core/sources.js';
import { isRelevant, isDeferred } from '../js/core/paths.js';

setYamlLib(jsyaml);

function walk(root, rel = '', out = []) {
  for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
    if (name === '.git') continue;
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(path.join(root, r));
    if (st.isDirectory()) walk(root, r, out);
    else if (isRelevant(r)) out.push({ path: r, link: st.isSymbolicLink() });
  }
  return out;
}

function gitBlobSha(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { return null; }
}

/** Build the bundle of root into outDir. Returns the index. */
export function makeBundle(root, outDir, { commit = null, tree = null } = {}) {
  commit = commit || git(root, ['rev-parse', 'HEAD']);
  tree = tree || git(root, ['rev-parse', 'HEAD^{tree}']);
  const parts = { core: [], diag: [] };
  for (const f of walk(root)) {
    const abs = path.join(root, f.path);
    const buf = f.link ? Buffer.from(fs.readlinkSync(abs)) : fs.readFileSync(abs);
    const e = { p: f.path, s: gitBlobSha(buf), h: crypto.createHash('sha256').update(buf).digest('base64') };
    const pr = f.link ? { linkText: buf.toString('utf8') } : parseOne(f.path, new Uint8Array(buf));
    if (pr.linkText !== undefined) e.l = pr.linkText;
    else {
      e.d = pr.data;
      if (pr.issues && pr.issues.length) e.i = pr.issues;
      if (pr.text !== undefined) e.t = pr.text;
    }
    parts[isDeferred(f.path) ? 'diag' : 'core'].push(e);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const index = { format: BUNDLE_FORMAT, parser: PARSE_VERSION, commit, tree, built: new Date().toISOString(), parts: {} };
  for (const [name, files] of Object.entries(parts)) {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ files })), { level: 9 });
    const file = `${name}.json.gz`;
    fs.writeFileSync(path.join(outDir, file), gz);
    index.parts[name] = { file, files: files.length, bytes: gz.length };
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const commit = opt('--commit');
  const tree = opt('--tree');
  if (args.length !== 2) {
    console.error('usage: node tools/make_bundle.mjs <repository dir> <output dir> [--commit SHA] [--tree SHA]');
    process.exit(2);
  }
  const t = Date.now();
  const ix = makeBundle(path.resolve(args[0]), path.resolve(args[1]), { commit, tree });
  console.log(`${ix.commit || '?'}: ${Object.entries(ix.parts).map(([n, p]) => `${n} ${p.files} files ${(p.bytes / 1e6).toFixed(1)} MB`).join(', ')} (${Date.now() - t} ms)`);
}
