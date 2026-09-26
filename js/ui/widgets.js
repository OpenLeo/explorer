// Small reusable UI fragments (return Raw HTML).

import { html, raw } from './dom.js';
import { ml, hex, fmtNum } from '../core/util.js';
import { frameRoute } from '../core/repo.js';
import { app, lang, sourceMetaById } from './state.js';

// ---- text blobs for copy / download buttons ----
const blobs = new Map();
let blobSeq = 0;
export function blob(text) {
  const id = `b${++blobSeq}`;
  blobs.set(id, String(text));
  if (blobs.size > 400) blobs.delete(blobs.keys().next().value);
  return id;
}
export function getBlob(id) { return blobs.get(id); }

export function t(obj) { return ml(obj, lang()); }

export function sourceBadge(id, opts = {}) {
  const s = sourceMetaById(id);
  if (!app.db || (app.db.sources.length < 2 && !opts.always)) return '';
  return html`<span class="badge src-badge" style="--c:${s.color || '#888'}" title="source: ${s.label}">${s.label}</span>`;
}

export function unreleasedBadge() {
  return html`<span class="badge badge-unreleased" title="This ECU was never seen on a production car (released: false)">never released</span>`;
}

export function typeBadge(type) {
  return html`<span class="badge type-${type}">${type}</span>`;
}

export function periodText(f) {
  const parts = [];
  for (const p of f.periods || []) parts.push(`${p} ms`);
  if (f.trigger) parts.push('event');
  if (f.request) parts.push('request');
  return parts.join(' + ') || '—';
}

export function warnBadge(f) {
  if (!f.warnCount) return '';
  const msgs = f.issues.filter((i) => i.level !== 'info').slice(0, 6).map((i) => `${i.level}: ${i.where ? i.where + ': ' : ''}${i.msg}`).join('\n');
  return html`<span class="badge badge-warn" title="${msgs}">⚠ ${f.warnCount}</span>`;
}

/** "AEE2004.full LS.CONF 036" for a symlink target path */
export function linkTargetLabel(f) {
  if (!f.symlinkOf) return '';
  const tgt = app.db && app.db.framesByPath.get(`${f.source}|${f.symlinkOf}`);
  if (tgt) return `${tgt.archvar} ${tgt.netbus} ${tgt.fileBase}`;
  const m = /^buses\/([^/]+)\/([^/]+)\/([^/]+)\.ya?ml$/.exec(f.symlinkOf);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : f.symlinkOf;
}

export function frameBadges(f, opts = {}) {
  const inh = opts.inherited ? html`<span class="badge badge-inh" title="Not redefined in this variant: inherited from ${f.archvar}">↑ ${f.variant}</span>` : '';
  const ovr = f.overrides ? (f.overrideDiff && f.overrideDiff.identical
    ? html`<span class="badge" title="Redefined identically to ${f.overrides.archvar}">= parent</span>`
    : html`<span class="badge badge-chg" title="Changed in this variant compared to ${f.overrides.archvar}">changed</span>`) : '';
  return html`${(f.sources || []).length > 1 ? html`<span class="badge badge-multi" title="Defined in ${f.sources.length} sources: ${f.sources.join(', ')}">${f.sources.length} src</span>` : (opts.compact && app.db && app.db.sources[0] && app.db.sources[0].id === f.source) ? '' : sourceBadge(f.source)}${f.hasAlternatives ? html`<span class="badge badge-alt" title="Has conflicting observations (alternatives)">alt</span>` : ''}${f.hasMux ? html`<span class="badge" title="Multiplexed signals">mux</span>` : ''}${f.symlinkOf ? html`<span class="badge badge-link" title="Same as ${linkTargetLabel(f)} (symbolic link)">≡ ${linkTargetLabel(f).split(' ')[0]}</span>` : f.identicalTo ? html`<span class="badge badge-link" title="Same content as ${f.identicalTo.archvar} ${f.identicalTo.netbus} ${f.identicalTo.fileBase}">≡ ${f.identicalTo.archvar}</span>` : ''}${inh}${ovr}${warnBadge(f)}`;
}

export function frameLink(f, label) {
  return html`<a href="${frameRoute(f)}" class="mono">${label || `${f.idHex}`}</a>`;
}

export function nodeLink(archvar, name, extra = '') {
  const nd = app.db && app.db.variantNodes.get(archvar) && app.db.variantNodes.get(archvar).get(name);
  const cls = nd && nd.pseudo ? 'node-link pseudo' : nd && nd.phantom ? 'node-link phantom' : nd && nd.released === false ? 'node-link unreleased' : 'node-link';
  const title = nd ? (t(nd.title) || nd.pseudo || (nd.phantom ? 'not defined in nodes/' : '')) : '';
  return html`<a class="${cls}" href="#/ecus/${archvar}/${encodeURIComponent(name)}" title="${title}">${name}</a>${extra}`;
}

export function nodeList(archvar, list, max = 12) {
  if (!list || !list.length) return html`<span class="muted">—</span>`;
  const shown = list.slice(0, max);
  const more = list.length - shown.length;
  return html`${shown.map((n, i) => html`${i ? ', ' : ''}${nodeLink(archvar, n)}`)}${more > 0 ? html` <span class="muted" title="${list.slice(max).join(', ')}">+${more}</span>` : ''}`;
}

export function codeBlock(code, opts = {}) {
  const id = blob(code);
  return html`<div class="codeblock">
    <div class="codeblock-bar"><span class="muted">${opts.title || ''}</span><span class="spacer"></span>
      <button class="btn btn-sm" data-copy="${id}">Copy</button>
      ${opts.filename ? html`<button class="btn btn-sm" data-download="${id}" data-filename="${opts.filename}">Download</button>` : ''}
    </div>
    <pre class="code ${opts.lang ? 'lang-' + opts.lang : ''}"><code>${code}</code></pre>
  </div>`;
}

export function emptyState(title, body) {
  return html`<div class="empty"><h3>${title}</h3>${body ? html`<p>${body}</p>` : ''}</div>`;
}

export function kv(rows) {
  return html`<dl class="kv">${rows.filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== '').map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

export function valuesList(sig, max = 8) {
  if (!sig.values.length) return '';
  const w = Math.max(1, Math.ceil(sig.width / 4));
  const items = sig.values.slice(0, max).map((v) => html`<span class="val"><code>${sig.width <= 4 ? v.raw.toString(2).padStart(sig.width, '0') : '0x' + hex(v.raw, w)}</code> ${v.unused && !v.text ? html`<i class="muted">unused</i>` : t(v.text)}${v.unused && v.text ? html` <i class="muted">(unused)</i>` : ''}</span>`);
  const more = sig.values.length - max;
  return html`<span class="vals">${items}${more > 0 ? html`<span class="muted">+${more} more</span>` : ''}</span>`;
}

export function physText(sig) {
  const parts = [];
  if (sig.hasFactor || sig.offset) parts.push(`×${fmtNum(sig.factor, 8)}${sig.offset ? (sig.offset > 0 ? ' +' : ' ') + fmtNum(sig.offset, 8) : ''}`);
  if (sig.units) parts.push(sig.units);
  return parts.join(' ');
}

export function tabs(items, active, baseHref) {
  return html`<nav class="subtabs">${items.map((it) => html`<a href="${baseHref(it.id)}" class="${it.id === active ? 'active' : ''}${it.disabled ? ' disabled' : ''}" title="${it.title || ''}">${it.label}${it.count !== undefined ? html` <span class="count">${it.count}</span>` : ''}</a>`)}</nav>`;
}

export function variantOptions(selected, opts = {}) {
  const db = app.db;
  if (!db) return '';
  return html`${opts.all ? html`<option value="" ${!selected ? 'selected' : ''}>${opts.all}</option>` : ''}${db.variantList.map((v) => {
    const n = (db.variantFrames.get(v.key) || []).length;
    if (opts.withFramesOnly && !n && v.key !== selected) return '';
    return html`<option value="${v.key}" ${v.key === selected ? 'selected' : ''}>${v.key}${n ? ` (${n})` : ''}</option>`;
  })}`;
}

/** First variant that has frames (default selection). */
export function defaultVariant() {
  const db = app.db;
  if (!db) return '';
  const pref = ['AEE2004.full', 'AEE2010.full', 'AEE2001.full'];
  for (const p of pref) if ((db.variantFrames.get(p) || []).length) return p;
  const v = db.variantList.find((x) => (db.variantFrames.get(x.key) || []).length);
  return v ? v.key : (db.variantList[0] ? db.variantList[0].key : '');
}

export function busLabel(archvar, netbus) {
  const b = app.db && app.db.variantBuses(archvar).get(netbus);
  if (!b) return netbus;
  const dn = t(b.displayName);
  return `${netbus}${dn ? ' · ' + dn : ''}`;
}

export function busInfo(archvar, netbus) {
  return (app.db && app.db.variantBuses(archvar).get(netbus)) || null;
}

export function protocolBadge(bus) {
  if (!bus) return '';
  return html`<span class="badge proto-${(bus.protocol || '').toLowerCase()}">${bus.protocol || '?'}${bus.bitrate ? ` ${fmtNum(bus.bitrate)} kbit/s` : ''}</span>`;
}

export { raw, html };
