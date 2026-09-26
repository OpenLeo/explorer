// Generic helpers, UI independent (usable from node tests).

export const LANGS = ['en', 'fr', 'es', 'de', 'it', 'pl', 'ru', 'zh', 'hu', 'pt'];

/** Escape a string for safe injection in HTML text or attribute values. */
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pick a translation from a multilang object ({en, fr, ...}).
 * Fallback order: lang, en, fr, any. Plain strings are returned as is.
 */
export function ml(obj, lang = 'en') {
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (typeof obj !== 'object' || Array.isArray(obj)) return '';
  const pick = (k) => (typeof obj[k] === 'string' && obj[k].trim() !== '' ? obj[k] : null);
  let r = pick(lang);
  if (r !== null) return r;
  const base = lang && lang.split('-')[0];
  if (base && base !== lang) { r = pick(base); if (r !== null) return r; }
  r = pick('en'); if (r !== null) return r;
  r = pick('fr'); if (r !== null) return r;
  for (const k of Object.keys(obj)) {
    if (k === 'unused') continue;
    r = pick(k);
    if (r !== null) return r;
  }
  return '';
}

/** Which language ml() actually used (for "translated from" hints). */
export function mlLang(obj, lang = 'en') {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of [lang, 'en', 'fr', ...Object.keys(obj)]) {
    if (k !== 'unused' && typeof obj[k] === 'string' && obj[k].trim() !== '') return k;
  }
  return null;
}

/** Normalize a multilang field: string -> {en: string}; object -> filtered copy; other -> null */
export function toMl(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() ? { en: v } : null;
  if (typeof v === 'number') return { en: String(v) };
  if (typeof v === 'object' && !Array.isArray(v)) {
    const out = {};
    let n = 0;
    for (const [k, t] of Object.entries(v)) {
      if (k === 'unused') continue;
      if (t === null || t === undefined) continue;
      const s = typeof t === 'string' ? t : String(t);
      if (s.trim() === '') continue;
      out[k] = s;
      n++;
    }
    return n ? out : null;
  }
  return null;
}

export function hex(n, width = 0) {
  if (n === null || n === undefined || n === '') return '';
  if (typeof n === 'bigint') return n.toString(16).toUpperCase().padStart(width, '0');
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  return Math.trunc(n).toString(16).toUpperCase().padStart(width, '0');
}

export function hexByte(b) { return (b & 0xFF).toString(16).toUpperCase().padStart(2, '0'); }

export function bytesToHex(bytes, sep = ' ') {
  return Array.from(bytes || [], hexByte).join(sep);
}

/** Parse "0E 00 1a", "0E001A", "0x0E,0x00" into a Uint8Array. Returns null on error. */
export function parseHexBytes(text) {
  if (text === null || text === undefined) return null;
  let s = String(text).trim();
  if (!s) return new Uint8Array(0);
  s = s.replace(/0x/gi, ' ').replace(/[,;:\-_]/g, ' ');
  const parts = s.split(/\s+/).filter(Boolean);
  let digits;
  if (parts.length > 1 && parts.every((p) => /^[0-9a-f]{1,2}$/i.test(p))) {
    digits = parts.map((p) => p.padStart(2, '0')).join('');
  } else {
    digits = parts.join('');
  }
  if (!/^[0-9a-f]*$/i.test(digits)) return null;
  if (digits.length % 2) return null;
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.substr(i * 2, 2), 16);
  return out;
}

/** Parse an integer given as number, "0x1A", "1A" (hex=true) or "26". */
export function parseIntLoose(v, preferHex = false) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'bigint') return v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^0b[01]+$/i.test(s)) return parseInt(s.slice(2), 2);
  if (preferHex && /^[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^-?[0-9]+$/.test(s)) return parseInt(s, 10);
  return null;
}

export function uniq(arr) { return Array.from(new Set(arr)); }

export function asArray(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

export function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

/** Run async tasks with bounded concurrency. */
export async function mapLimit(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const workers = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        try {
          results[i] = await fn(items[i], i);
        } catch (e) {
          results[i] = { error: e };
        }
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

/** Tiny non cryptographic hash (FNV-1a 32 bit) as hex. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Make a C/DBC identifier out of anything. */
export function ident(s, fallback = 'X') {
  let r = String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!r) r = fallback;
  if (/^[0-9]/.test(r)) r = '_' + r;
  return r;
}

export function fmtNum(v, maxDec = 6) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  const r = Number(v.toFixed(maxDec));
  return String(r);
}

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export function debounce(fn, ms = 150) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Deterministic pleasant color for a string (hsl) */
export function colorFor(str, s = 62, l = 72) {
  let h = 0;
  const t = String(str);
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} ${s}% ${l}%)`;
}

export const PALETTE = [
  '#8ecae6', '#ffb703', '#90be6d', '#f28482', '#b8a1e3', '#f6bd60', '#84dcc6', '#e5989b',
  '#a3c4f3', '#ffd6a5', '#caffbf', '#fdffb6', '#9bf6ff', '#bdb2ff', '#ffc6ff', '#d4a373',
  '#95d5b2', '#ffafcc', '#cdb4db', '#a8dadc',
];
