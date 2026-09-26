// Tolerant YAML parsing on top of js-yaml.
// The library is loaded from jsDelivr, with a vendored copy as fallback. In node
// (tests) call setYamlLib() with the vendored module.

let lib = null;
let loading = null;

export const YAML_CDN = 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.mjs';

export function setYamlLib(l) { lib = l && (l.load ? l : l.default); }

export async function getYaml() {
  if (lib) return lib;
  if (!loading) {
    loading = (async () => {
      try {
        const m = await import(/* @vite-ignore */ YAML_CDN);
        setYamlLib(m);
      } catch (e) {
        const m = await import(new URL('../../vendor/js-yaml.mjs', import.meta.url).href);
        setYamlLib(m);
      }
      return lib;
    })();
  }
  return loading;
}

/** Decode bytes as UTF-8, falling back to ISO-8859-1 (with a warning). */
export function decodeText(buf) {
  if (typeof buf === 'string') return { text: buf, issues: [] };
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), issues: [] };
  } catch (e) {
    return {
      text: new TextDecoder('iso-8859-1').decode(bytes),
      issues: [{ level: 'error', msg: 'file is not valid UTF-8 (read as ISO-8859-1)' }],
    };
  }
}

/** Convert js-yaml Date objects (unquoted dates) and other odd scalars to strings. */
function sanitize(v, depth = 0) {
  if (depth > 64) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = sanitize(v[k], depth + 1);
    return o;
  }
  return v;
}

/**
 * Parse YAML text. Never throws. Returns {data, issues:[{level,msg,line}]}
 * Duplicate keys are reported (the last one wins, like PyYAML).
 */
export function parseYaml(textOrBytes, yaml = lib) {
  const { text: t0, issues } = decodeText(textOrBytes);
  let text = t0;
  if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); issues.push({ level: 'warning', msg: 'file starts with a UTF-8 BOM' }); }
  if (!yaml) return { data: null, issues: [...issues, { level: 'error', msg: 'YAML library not loaded' }] };
  let data = null;
  try {
    data = yaml.load(text);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/duplicated mapping key/.test(msg)) {
      issues.push({ level: 'warning', msg: 'duplicate key: ' + msg.split('\n')[0], line: e.mark ? e.mark.line + 1 : null });
      try { data = yaml.load(text, { json: true }); } catch (e2) {
        issues.push({ level: 'error', msg: 'YAML syntax: ' + String(e2.message || e2).split('\n')[0], line: e2.mark ? e2.mark.line + 1 : null });
        data = null;
      }
    } else {
      issues.push({ level: 'error', msg: 'YAML syntax: ' + msg.split('\n')[0], line: e && e.mark ? e.mark.line + 1 : null });
      data = null;
    }
  }
  if (/\t/.test(text) && data === null) issues.push({ level: 'warning', msg: 'tabulation found, use spaces' });
  // keys like 010: are read as decimal 10 (the author usually meant binary)
  const re = /^[ \t]*(0[0-9]+)[ \t]*:/gm;
  let m;
  let n = 0;
  while ((m = re.exec(text)) && n < 5) {
    n++;
    const line = text.slice(0, m.index).split('\n').length;
    issues.push({ level: 'warning', msg: `key '${m[1]}' has a leading zero: read as decimal ${parseInt(m[1], 10)}, write it as hex (0x..)`, line });
  }
  return { data: sanitize(data), issues };
}
