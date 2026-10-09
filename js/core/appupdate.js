// App update detection. Browsers keep serving their cached copy of the explorer's own files (index.html,
// modules, CSS) for a while after a new version is deployed (heuristic HTTP caching), and a normal reload
// does not always revalidate the modules. The files the page actually loaded are fingerprinted at start-up
// from the browser cache, then compared with the copies on the server.

const APP_EXT = /\.(m?js|css|html?)$/i;

/** 32-bit FNV-1a of a string, as 8 hex digits (no crypto.subtle: it needs a secure context). */
export function textHash(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The explorer's own files among the loaded resource URLs: same origin, under the app folder, code or styles
 * (data sources served from the same server are left out), plus the page itself.
 */
export function appFiles(resourceUrls, pageUrl) {
  const page = new URL(pageUrl);
  page.hash = '';
  const base = new URL('.', page);
  const out = new Set([page.href]);
  for (const u of resourceUrls) {
    let url;
    try { url = new URL(u, page); } catch (e) { continue; }
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) continue;
    if (!APP_EXT.test(url.pathname)) continue;
    url.hash = '';
    out.add(url.href);
  }
  return [...out].sort();
}

/**
 * Fingerprint of a list of files: { hash, files: Map(url -> hash | null) }.
 * fetchText(url) returns the text of a file; a failing file is recorded as null and ignored in comparisons.
 */
export async function fingerprint(urls, fetchText) {
  const files = new Map();
  await Promise.all(urls.map(async (u) => {
    try { files.set(u, textHash(await fetchText(u))); } catch (e) { files.set(u, null); }
  }));
  const all = [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([u, h]) => `${u}=${h}`).join('\n');
  return { hash: textHash(all), files };
}

/** Files whose server copy differs from the running one (files that could not be read are skipped). */
export function changedFiles(running, latest) {
  const out = [];
  for (const [u, h] of latest.files) {
    const r = running.files.get(u);
    if (h !== null && r !== null && r !== undefined && r !== h) out.push(u);
  }
  return out.sort();
}
