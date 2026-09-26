// Test helpers: read a DBMUXEv repository from disk like the browser loaders do.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsyaml from '../vendor/js-yaml.mjs';
import { setYamlLib } from '../js/core/yamlparse.js';
import { parseEntries } from '../js/core/sources.js';
import { isRelevant } from '../js/core/paths.js';
import { buildDatabase } from '../js/core/repo.js';

setYamlLib(jsyaml);
export const yaml = jsyaml;

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUSDOC = path.resolve(here, '..', '..');
export const PSA_RE = path.join(BUSDOC, 'PSA-RE');

/** Walk a repo, returning loader entries (symlinks as linkText, like the GitHub loader). */
export function readRepoEntries(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        if (isRelevant(r)) out.push({ path: r, linkText: fs.readlinkSync(abs) });
        else if (fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) walk(abs, r);
      } else if (st.isDirectory()) {
        walk(abs, r);
      } else if (isRelevant(r)) {
        out.push({ path: r, bytes: new Uint8Array(fs.readFileSync(abs)) });
      }
    }
  };
  walk(root, '');
  return out;
}

export function loadRepo(root, meta = {}) {
  const entries = readRepoEntries(root);
  const files = parseEntries(entries, jsyaml);
  return { meta: { id: meta.id || path.basename(root).toLowerCase(), label: meta.label || path.basename(root), color: '#888' }, files };
}

export function loadDb(roots) {
  return buildDatabase(roots.map((r) => (typeof r === 'string' ? loadRepo(r) : loadRepo(r.root, r))));
}

export function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }
