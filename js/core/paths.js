// Repository path conventions (see PSA-RE/tools/validate.py).

export function normPath(p) {
  const parts = [];
  for (const seg of String(p).replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length) parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

export function dirname(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** Resolve a symlink target (relative to the link's directory) to a repo path. */
export function resolveLink(linkPath, target) {
  const t = String(target).trim();
  if (t.startsWith('/')) return normPath(t);
  return normPath((dirname(linkPath) ? dirname(linkPath) + '/' : '') + t);
}

const FRAME_FILE_RE = /^([0-9A-Fa-f]{1,8})(?:_([A-Za-z0-9_]+))?\.ya?ml$/;

/**
 * Classify a repository path.
 * Returns null for irrelevant files, else {kind, ...}
 */
export function classify(path) {
  const p = normPath(path);
  const parts = p.split('/');
  const fn = parts[parts.length - 1];
  const isYml = /\.ya?ml$/i.test(fn);
  if (p === 'architectures.yml' || p === 'architectures.yaml') return { kind: 'architectures' };
  if (parts[0] === 'nodes' && parts.length === 2 && isYml) return { kind: 'nodes', archvar: fn.replace(/\.ya?ml$/i, '') };
  if (parts[0] === 'cars' && parts.length === 2 && isYml) return { kind: 'car', project: fn.replace(/\.ya?ml$/i, '') };
  if (parts[0] === 'buses') {
    if (parts.length === 4 && isYml) {
      const m = FRAME_FILE_RE.exec(fn);
      return {
        kind: 'frame', archDir: parts[1], busDir: parts[2], file: fn,
        fileBase: fn.replace(/\.ya?ml$/i, ''),
        fileId: m ? parseInt(m[1], 16) : null,
        suffix: m && m[2] ? m[2] : null,
        badName: !m || m[1] !== m[1].toUpperCase(),
      };
    }
    if (parts.length === 4 && /\.(md|txt)$/i.test(fn)) return { kind: 'busdoc', archDir: parts[1], busDir: parts[2], file: fn };
    return null;
  }
  if (parts[0] === 'diag' && isYml) {
    if (parts[1] === 'protocols' && parts.length === 3) return { kind: 'diag_protocol', name: fn.replace(/\.ya?ml$/i, '') };
    if (parts.length === 4 && fn === 'ecu.yml') return { kind: 'diag_ecu', archvar: parts[1], node: parts[2] };
    if (parts.length === 4 && fn === 'dtcs.yml') return { kind: 'diag_dtcs', archvar: parts[1], node: parts[2] };
    if (parts.length === 5) {
      const sub = parts[3];
      const map = { dids: 'diag_did', lids: 'diag_lid', routines: 'diag_routine', ioctls: 'diag_ioctl' };
      if (map[sub]) return { kind: map[sub], archvar: parts[1], node: parts[2], file: fn };
    }
    return { kind: 'diag_unknown' };
  }
  return null;
}

/** True when the loader should fetch this path. */
export function isRelevant(path) {
  const c = classify(path);
  return !!c && c.kind !== 'diag_unknown';
}
