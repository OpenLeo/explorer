// Minimal safe templating: every interpolated value is HTML-escaped unless wrapped with raw().

import { esc } from '../core/util.js';

export class Raw {
  constructor(s) { this.s = String(s); }
  toString() { return this.s; }
}

export const raw = (s) => new Raw(s);

function fmt(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  return esc(v);
}

/** Tagged template: html`<b>${userText}</b>` -> Raw with userText escaped. */
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += fmt(vals[i]) + strings[i + 1];
  return new Raw(out);
}

export function join(list, sep = '') { return new Raw(list.map(fmt).join(fmt(sep))); }

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Set innerHTML from a Raw/string. */
export function setHtml(el, content) { if (el) el.innerHTML = String(content ?? ''); }

/** Delegated event: on(root, 'click', '[data-act=x]', (ev, el) => ...) */
export function on(root, type, selector, fn, opts) {
  const h = (ev) => {
    const el = ev.target && ev.target.closest ? ev.target.closest(selector) : null;
    if (el && root.contains(el)) fn(ev, el);
  };
  root.addEventListener(type, h, opts);
  return () => root.removeEventListener(type, h, opts);
}

export function download(filename, text, type = 'text/plain') {
  try {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) { toast('Download failed: ' + e.message, 'error'); }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Copied to clipboard'); } catch (e2) { toast('Copy failed', 'error'); }
    ta.remove();
  }
}

export function toast(msg, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3200);
}
